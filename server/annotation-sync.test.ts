import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Lesson, LessonAnnotation } from '../shared/types.js';
import { annotationSources } from '../shared/annotations.js';
import { exampleLessons } from '../shared/examples.js';
import { lessonMarkdown } from '../shared/lesson-markdown.js';
import { CloudSyncStore, createCloudApp } from '../cloud/app.js';
import { MAX_ANNOTATIONS } from './lesson-annotations.js';
import { lessonHash, syncLessonSchema, syncOperationSchema, validateSyncDocument } from './sync-protocol.js';
import { SyncService } from './sync.js';
import { LessonStore } from './store.js';

const note = (): Lesson => ({ ...structuredClone(exampleLessons[0]), id: 'annotation-sync-note', connections: [] });
function annotation(lesson: Lesson, overrides: Partial<LessonAnnotation> = {}): LessonAnnotation {
  const source = annotationSources(lesson).find(item => item.text.includes('increment'))!;
  assert.ok(source, 'The test fixture needs an authoritative increment source');
  return {
    id: randomUUID(), term: 'increment', sourceKey: source.key, quote: source.text,
    explanation: 'increment 是每次呼叫時把計數增加一的函式。',
    analogy: '像櫃台的計數器，每按一次就增加一。',
    example: 'counter(); // 1\ncounter(); // 2',
    createdAt: '2026-10-04T01:00:00.000Z',
    ...overrides,
  };
}
function annotatedNote(): Lesson {
  const lesson = note();
  lesson.annotations = [annotation(lesson)];
  return lesson;
}

test('sync preserves legacy notes and every annotation field through schema parsing and hashing', () => {
  const legacy = note();
  const parsedLegacy = syncLessonSchema.parse(legacy);
  assert.deepEqual(parsedLegacy, legacy);
  assert.equal(Object.hasOwn(parsedLegacy, 'annotations'), false);
  const lesson = annotatedNote();
  const parsed = syncLessonSchema.parse(lesson);
  assert.deepEqual(parsed, lesson);
  assert.notEqual(lessonHash(lesson), lessonHash(legacy));
  const originalHash = lessonHash(lesson);
  const changed = structuredClone(lesson);
  changed.annotations![0].explanation += '這段說明已補充。';
  assert.notEqual(lessonHash(changed), originalHash);
  assert.equal(lessonHash({ ...lesson, updatedAt: '2026-10-05T00:00:00.000Z' }), originalHash);
  const document = { id: lesson.id, revision: 1, hash: originalHash, lesson };
  assert.deepEqual(validateSyncDocument(document).lesson, lesson);
  assert.throws(() => validateSyncDocument({ ...document, lesson: changed }), /content hash/);
  assert.deepEqual(syncOperationSchema.parse({ operationId: randomUUID(), id: lesson.id, baseRevision: 0, lesson }).lesson, lesson);
  const noExample = annotatedNote();
  delete noExample.annotations![0].example;
  assert.deepEqual(syncLessonSchema.parse(noExample), noExample);
});

test('sync rejects malformed, duplicate and ungrounded annotations without discarding the field', () => {
  const lesson = annotatedNote();
  const entry = lesson.annotations![0];
  const invalid: Partial<LessonAnnotation>[] = [
    { id: '' }, { id: 'x'.repeat(121) },
    { term: '   ' }, { term: 'x'.repeat(161) },
    { explanation: ' ' }, { explanation: 'x'.repeat(3001) },
    { analogy: '' }, { analogy: 'x'.repeat(1501) },
    { example: ' ' }, { example: 'x'.repeat(4001) },
    { sourceKey: 'not-an-authoritative-source' }, { sourceKey: 'x'.repeat(201) },
    { quote: 'increment is fabricated context.' }, { quote: 'x'.repeat(4001) },
    { term: 'a-term-not-in-the-quote' }, { createdAt: 'yesterday' },
  ];
  for (const change of invalid)
    assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: [{ ...entry, ...change }] }).success, false, JSON.stringify(change));
  assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: [entry, { ...entry, term: 'count' }] }).success, false, 'Repeated annotation id');
  assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: [entry, { ...entry, id: randomUUID() }] }).success, false, 'Repeated exact source/term');
  assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: [entry, { ...entry, id: randomUUID(), term: 'count' }] }).success, true, 'Different terms in one source are valid');
  const otherSource = annotationSources(lesson).find(item => item.key !== entry.sourceKey && item.text.includes(entry.term))!;
  assert.ok(otherSource);
  const other = { ...entry, id: randomUUID(), sourceKey: otherSource.key, quote: otherSource.text };
  assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: [entry, other] }).success, true, 'The same term in distinct sources is valid');
  const ambiguous = structuredClone(lesson);
  ambiguous.sections[1].id = ambiguous.sections[0].id;
  assert.equal(syncLessonSchema.safeParse(ambiguous).success, false, 'Annotations cannot refer to ambiguous duplicated section ids');
});

test('sync annotation limit accepts the maximum and rejects a larger note', () => {
  const lesson = note();
  lesson.summary = Array.from({ length: MAX_ANNOTATIONS + 1 }, (_, index) => `token_${index}`).join(' ');
  const source = annotationSources(lesson).find(item => item.text === lesson.summary)!;
  assert.ok(source);
  const entries = Array.from({ length: MAX_ANNOTATIONS + 1 }, (_, index) => annotation(lesson, {
    sourceKey: source.key, term: `token_${index}`, quote: lesson.summary,
  }));
  assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: entries.slice(0, MAX_ANNOTATIONS) }).success, true);
  assert.equal(syncLessonSchema.safeParse({ ...lesson, annotations: entries }).success, false);
});

test('local sync uploads, downloads, updates and durably stores annotations without changing old notes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bell-annotation-sync-'));
  const token = 'annotation-sync-local-test-token-32-characters';
  const cloud = new CloudSyncStore(join(directory, 'cloud.sqlite'));
  const server = createServer(createCloudApp({ store: cloud, token }));
  const stores: LessonStore[] = [];
  const clients: SyncService[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const store of stores) store.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    cloud.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a = new LessonStore(join(directory, 'a-lessons.sqlite'));
  const b = new LessonStore(join(directory, 'b-lessons.sqlite'));
  stores.push(a, b);
  const aSync = new SyncService({ path: join(directory, 'a-sync.sqlite'), lessons: a, intervalMs: 60_000 });
  const bSync = new SyncService({ path: join(directory, 'b-sync.sqlite'), lessons: b, intervalMs: 60_000 });
  clients.push(aSync, bSync);
  const legacy = { ...note(), id: 'legacy-without-annotations' };
  const lesson = annotatedNote();
  a.save(legacy);
  a.save(lesson);
  await aSync.configure({ remoteUrl, token, uploadExisting: true });
  await bSync.configure({ remoteUrl, token, uploadExisting: true });
  assert.deepEqual(b.get(lesson.id), lesson);
  assert.deepEqual(b.get(legacy.id), legacy);
  assert.equal(Object.hasOwn(b.get(legacy.id)!, 'annotations'), false);
  const changed = structuredClone(b.get(lesson.id)!);
  changed.annotations![0].explanation += '不同計數器各自保留狀態。';
  b.save(changed);
  bSync.updatedLesson(changed);
  await bSync.sync();
  await aSync.sync();
  assert.deepEqual(a.get(lesson.id), changed);
  assert.deepEqual(cloud.pull(0).changes.at(-1)?.document.lesson?.annotations, changed.annotations);
  assert.equal(aSync.status().pending, 0);
  assert.equal(bSync.status().conflicts, 0);
  const reopened = new LessonStore(join(directory, 'a-lessons.sqlite'));
  try { assert.deepEqual(reopened.get(lesson.id)?.annotations, changed.annotations); }
  finally { reopened.close(); }
});

test('Markdown exports annotation content literally, including embedded fences and absent examples', () => {
  const lesson = note();
  const content = 'increment\n```js\nconsole.log("````");\n```\n# A literal heading\n<img src="example" />';
  lesson.sections[0].code = content;
  const source = annotationSources(lesson).find(item => item.text === content)!;
  assert.ok(source);
  const entry = annotation(lesson, {
    term: 'increment', sourceKey: source.key, quote: content,
    explanation: '說明文字\n```text\n**保持原樣**\n```',
    analogy: '比喻包含 `符號` 與\n第二行。',
    example: '```js\nconst value = "````";\n```',
  });
  lesson.annotations = [entry];
  const markdown = lessonMarkdown(lesson);
  assert.match(markdown, /## 詞彙解說筆記/);
  for (const value of [entry.term, entry.sourceKey, entry.quote, entry.explanation, entry.analogy, entry.example!, entry.createdAt])
    assert.ok(markdown.includes(value), `Export should contain ${value}`);
  assert.ok(markdown.includes(`\`\`\`\`\`text\n${entry.quote}\n\`\`\`\`\``));
  assert.ok(markdown.includes(`\`\`\`\`text\n${entry.explanation}\n\`\`\`\``));
  assert.ok(markdown.includes(`\`\`\`\`\`text\n${entry.example}\n\`\`\`\`\``));
  assert.ok(markdown.includes(lesson.sections[0].code));
  delete entry.example;
  const withoutExample = lessonMarkdown(lesson).split('## 詞彙解說筆記')[1];
  assert.doesNotMatch(withoutExample, /\*\*範例\*\*/);
  delete lesson.annotations;
  assert.doesNotMatch(lessonMarkdown(lesson), /## 詞彙解說筆記/);
});
