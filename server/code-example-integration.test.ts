import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exampleLessons } from "../shared/examples.js";
import { lessonMarkdown } from "../shared/lesson-markdown.js";
import type { GenerateEvent, Lesson } from "../shared/types.js";
import { enhanceExamples, generate } from "../src/lib/api.js";
import { CloudSyncStore, createCloudApp } from "../cloud/app.js";
import { KnowledgeService, type EmbeddingProvider } from "./knowledge.js";
import { SyncService } from "./sync.js";
import { lessonHash } from "./sync-protocol.js";

function exampleNote(): Lesson {
  const note = structuredClone(exampleLessons[0]);
  note.id = "code-case-integration";
  note.connections = [];
  note.sections[0] = {
    ...note.sections[0],
    code: "const prices = [30, 50];\nconst total = prices.reduce((sum, price) => sum + price, 0);\nconsole.log(total);",
    language: "javascript",
    codeExample: {
      title: "checkout_case_title",
      scenario: "shopping_scenario_context",
      environment: "node_runtime_environment",
      walkthrough: [
        { startLine: 1, endLine: 2, explanation: "accumulation_walkthrough：依序把商品金額加到總額。" },
        { startLine: 3, endLine: 3, explanation: "observable_result_walkthrough：顯示計算後的金額。" },
      ],
      expectedOutput: "expected_total_result: 80",
      application: "cart_application_context",
    },
  };
  return note;
}

test("code case metadata is searchable and changes invalidate semantic vectors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-case-index-"));
  const provider: EmbeddingProvider = {
    model: "code-case-test-vector-v1",
    embed: async texts => texts.map(text => /shopping_scenario_context|購物實務/.test(text) ? [1, 0] : [0, 1]),
  };
  const service = new KnowledgeService({ dbPath: join(directory, "index.sqlite"), cacheDir: join(directory, "cache"), embeddingProvider: provider });
  try {
    const note = exampleNote();
    service.upsertLesson(note);
    await service.waitForIdle();
    for (const marker of ["checkout_case_title", "shopping_scenario_context", "node_runtime_environment", "accumulation_walkthrough", "observable_result_walkthrough", "expected_total_result", "cart_application_context"]) {
      const results = await service.search(marker, { kind: "lesson" });
      assert.ok(results.results.some(result => result.ownerId === note.id && result.text.includes(marker)), marker);
    }
    const semantic = await service.search("購物實務");
    assert.equal(semantic.mode, "hybrid");
    assert.equal(semantic.results[0].sectionId, note.sections[0].id);
    assert.equal(semantic.results[0].lexicalScore, 0);
    assert.ok(semantic.results[0].semanticScore! > 0.99);
    note.sections[0].codeExample!.scenario = "refund_scenario_context";
    service.upsertLesson(note);
    await service.waitForIdle();
    assert.equal((await service.search("購物實務")).results.length, 0);
    assert.ok((await service.search("refund_scenario_context")).results.some(result => result.text.includes("refund_scenario_context")));
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("index reconciliation upgrades old section text even when the note content has not changed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-case-reindex-"));
  const dbPath = join(directory, "index.sqlite");
  const cacheDir = join(directory, "cache");
  let service: KnowledgeService | undefined;
  try {
    const note = exampleNote();
    service = new KnowledgeService({ dbPath, cacheDir });
    service.upsertLesson(note);
    await service.close();
    service = undefined;
    const oldSignature = createHash("sha256").update(JSON.stringify([note.title, note.summary, note.tags, note.sections])).digest("hex");
    const database = new DatabaseSync(dbPath);
    database.prepare("UPDATE knowledge_meta SET value=? WHERE key=?").run(oldSignature, `lesson:${note.id}`);
    database.prepare("UPDATE knowledge_chunks SET text='old section without case metadata' WHERE owner_id=?").run(note.id);
    database.close();
    service = new KnowledgeService({ dbPath, cacheDir });
    assert.equal((await service.search("cart_application_context")).results.length, 0);
    service.reconcileLessons([note]);
    assert.ok((await service.search("cart_application_context")).results.some(result => result.text.includes("cart_application_context")));
  } finally {
    await service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Markdown export preserves the complete code case and nested code fences", () => {
  const note = exampleNote();
  note.sections[0].code += '\nconsole.log("```");';
  note.source.content = "An article with a nested fence:\n```js\nconst example = 1;\n```";
  const markdown = lessonMarkdown(note);
  const example = note.sections[0].codeExample!;
  for (const text of [example.title, example.scenario, example.environment, example.application, example.expectedOutput, ...example.walkthrough.map(step => step.explanation)]) assert.ok(markdown.includes(text));
  assert.match(markdown, /第 1–2 行/);
  assert.match(markdown, /第 3 行/);
  assert.match(markdown, /預期輸出（依程式推導，未執行）/);
  assert.ok(markdown.includes(`\`\`\`\`javascript\n${note.sections[0].code}\n\`\`\`\``));
  assert.ok(markdown.includes(`\`\`\`\`text\n${note.source.content}\n\`\`\`\``));
  const legacy = structuredClone(note);
  for (const section of legacy.sections) delete section.codeExample;
  assert.ok(lessonMarkdown(legacy).includes(legacy.sections[0].code));
  assert.doesNotMatch(lessonMarkdown(legacy), /小完整案例：/);
});

test("generation and case enhancement share the streaming contract and reject incomplete responses", async t => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const expected: GenerateEvent[] = [
    { type: "stage", stage: "teach", message: "正在加入白話程式案例" },
    { type: "complete", lesson: exampleNote() },
  ];
  let incomplete = false;
  t.mock.method(globalThis, "fetch", async (input: string, options?: RequestInit) => {
    calls.push({ url: input, options });
    const bytes = new TextEncoder().encode((incomplete ? expected.slice(0, 1) : expected).map(event => JSON.stringify(event)).join("\n"));
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 43) controller.enqueue(bytes.slice(offset, offset + 43));
        controller.close();
      },
    }));
  });
  const signal = new AbortController().signal;
  const generated: GenerateEvent[] = [];
  await generate({ kind: "concept", content: "陣列加總", depth: "beginner" }, signal, event => generated.push(event));
  const enhanced: GenerateEvent[] = [];
  await enhanceExamples("note/one", signal, event => enhanced.push(event));
  assert.deepEqual(generated, expected);
  assert.deepEqual(enhanced, expected);
  assert.equal(calls[0].url, "/api/generate");
  assert.equal(calls[1].url, "/api/lessons/note%2Fone/examples");
  assert.equal(calls[1].options?.method, "POST");
  assert.equal(calls[1].options?.body, "{}");
  assert.equal(calls[1].options?.signal, signal);
  // A stream that breaks before the job is known cannot be resumed.
  incomplete = true;
  await assert.rejects(enhanceExamples("note", signal, () => {}), /連線中斷/);
});

test("a job stream that breaks resumes from the events already seen", async t => {
  const stage: GenerateEvent = { type: "stage", stage: "teach", message: "正在加入白話程式案例" };
  const done: GenerateEvent = { type: "complete", lesson: exampleNote() };
  const urls: string[] = [];
  const body = (events: GenerateEvent[]) => new Response(events.map(event => JSON.stringify(event)).join("\n"));
  // One mock for the whole test: mocking the same method again would not restore cleanly.
  let respond = (input: string) => urls.length === 1 ? body([{ type: "job", id: "job-1" }, stage]) : body([{ type: "job", id: "job-1" }, done]);
  t.mock.method(globalThis, "fetch", async (input: string) => { urls.push(input); return respond(input); });
  // The first connection drops after one progress line; the second sends the rest.
  const seen: GenerateEvent[] = [];
  await generate({ kind: "concept", content: "陣列加總", depth: "beginner" }, new AbortController().signal, event => seen.push(event));
  assert.deepEqual(urls, ["/api/generate", "/api/jobs/job-1/events?from=1"]);
  assert.deepEqual(seen.filter(event => event.type !== "job"), [stage, done]);
  // An error event is the job's outcome and is not retried.
  urls.length = 0;
  respond = () => body([{ type: "job", id: "job-2" }, { type: "error", message: "模型拒絕了這次請求" }]);
  await assert.rejects(generate({ kind: "concept", content: "x", depth: "beginner" }, new AbortController().signal, () => {}), /模型拒絕/);
  assert.equal(urls.length, 1);
  // A job the server no longer knows (it restarted) ends the wait with a clear message.
  urls.length = 0;
  respond = () => urls.length === 1 ? body([{ type: "job", id: "job-3" }]) : new Response("{}", { status: 404 });
  await assert.rejects(generate({ kind: "concept", content: "x", depth: "beginner" }, new AbortController().signal, () => {}), /重新啟動/);
});

class LocalNotes {
  private data = new Map<string, Lesson>();
  list() { return [...this.data.values()].map(note => structuredClone(note)); }
  get(id: string) { const note = this.data.get(id); return note ? structuredClone(note) : undefined; }
  save(note: Lesson) { this.data.set(note.id, structuredClone(note)); }
  delete(id: string) { return this.data.delete(id); }
}

test("cloud round-trip preserves code cases and detects metadata-only changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bell-case-sync-"));
  const token = "code-case-test-token-with-at-least-thirty-two-characters";
  const cloud = new CloudSyncStore(join(directory, "cloud.sqlite"));
  const server = createServer(createCloudApp({ store: cloud, token }));
  const notesA = new LocalNotes();
  const notesB = new LocalNotes();
  const a = new SyncService({ path: join(directory, "a.sqlite"), lessons: notesA, intervalMs: 60_000 });
  const b = new SyncService({ path: join(directory, "b.sqlite"), lessons: notesB, intervalMs: 60_000 });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const note = exampleNote();
    notesA.save(note);
    await a.configure({ remoteUrl, token, uploadExisting: true });
    await b.configure({ remoteUrl, token, uploadExisting: true });
    assert.deepEqual(notesB.get(note.id), note);
    const changed = structuredClone(note);
    changed.sections[0].codeExample!.expectedOutput = "80（共兩項商品）";
    assert.notEqual(lessonHash(changed), lessonHash(note));
    notesB.save(changed);
    b.updatedLesson(changed);
    await b.sync();
    await a.sync();
    assert.deepEqual(notesA.get(note.id), changed);
    assert.equal(cloud.pull(0).changes.length, 2);
    assert.equal(a.status().pending, 0);
    assert.equal(b.status().conflicts, 0);
  } finally {
    await a.close();
    await b.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    cloud.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
