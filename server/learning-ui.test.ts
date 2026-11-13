import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { exampleLessons } from "../shared/examples.js";
import { lessonMarkdown } from "../shared/lesson-markdown.js";
import type { GenerateEvent, Lesson } from "../shared/types.js";
import { relatedNotes } from "../src/lib/related-notes.js";
import { createApp } from "./app.js";
import type { ChatCall } from "./ai.js";
import { teachingSchema } from "./schema.js";
import { LessonStore } from "./store.js";
import { syncLessonSchema } from "./sync-protocol.js";
import { withExample } from "./test-helpers.js";

const [first, second, third] = exampleLessons;
const note = (lesson: Lesson, patch: Partial<Lesson>): Lesson => ({ ...structuredClone(lesson), isDemo: false, ...patch });

test("related notes list curated links both ways and follow-ups, with reasons", () => {
  const a = note(first, { id: "a", connections: [{ targetId: "b", sectionId: second.sections[1].id, reason: "同樣保存狀態" }] });
  const b = note(second, { id: "b", connections: [] });
  const c = note(third, { id: "c", connections: [{ targetId: "b", sectionId: second.sections[0].id, reason: "延伸到非同步" }], parentLessonId: "b" });
  const fromB = relatedNotes(b, [a, b, c]);
  assert.deepEqual(fromB.map(item => [item.kind, item.lessonId]), [["continued-by", "c"], ["linked-from", "a"]]);
  assert.match(fromB[1].section!, /關聯到本篇/);
  assert.equal(fromB[1].reason, "同樣保存狀態");
  const fromC = relatedNotes(c, [a, b, c]);
  assert.deepEqual(fromC.map(item => [item.kind, item.lessonId, item.sectionId]), [["continues", "b", undefined], ["links-to", "b", second.sections[0].id]]);
  // Links to deleted notes or sections are ignored.
  assert.deepEqual(relatedNotes(note(first, { id: "x", connections: [{ targetId: "gone", sectionId: "s", reason: "?" }] }), [a]), []);
});

test("Markdown export lists related notes when given", () => {
  const markdown = lessonMarkdown(first, [{ title: "Event Loop", label: "延伸閱讀", reason: "同樣討論回呼" }]);
  assert.match(markdown, /## 相關筆記\n\n- 延伸閱讀《Event Loop》：同樣討論回呼/);
  assert.doesNotMatch(lessonMarkdown(first), /## 相關筆記/);
});

test("the sync schema keeps the follow-up parent link", () => {
  const lesson = { ...withExample(note(first, { id: "child", parentLessonId: "parent-1" })), visual: { ...structuredClone(first.visual), kind: "flow" as const } };
  assert.equal((syncLessonSchema.parse(lesson) as Lesson).parentLessonId, "parent-1");
});

async function server(store: LessonStore, chat?: ChatCall) {
  const app = createApp({ store, examples: exampleLessons, config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "m" }, chat });
  const instance = createServer(app);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, close: async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); } };
}
const headers = { host: "127.0.0.1:3001", "content-type": "application/json" };

test("a follow-up continues from its parent note and records the link", async t => {
  const store = new LessonStore(":memory:", exampleLessons);
  const parent = note(first, { id: "parent-1", title: "閉包入門", summary: "函式記得建立時的環境。" });
  store.save(parent);
  const calls: Array<{ role: string; instruction: string; data: Record<string, unknown> }> = [];
  const teaching = () => teachingSchema.parse(withExample({ ...structuredClone(first), visual: { ...structuredClone(first.visual), kind: "flow", scene: { layout: "flow", edges: [], groups: [] } } }));
  const chat: ChatCall = async (role, instruction, data) => {
    calls.push({ role, instruction, data: data as Record<string, unknown> });
    return role.includes("分析") ? { title: "延伸", scope: "s", keyConcepts: ["閉包"], explanationPlan: ["一", "二"], caveats: [] } : role.includes("整理") ? { category: "JavaScript", tags: ["閉包"], connections: [] } : teaching();
  };
  const { base, close } = await server(store, chat);
  t.after(async () => { await close(); store.close(); });
  const run = async (parentLessonId: string) => {
    const response = await fetch(`${base}/api/generate`, { method: "POST", headers, body: JSON.stringify({ kind: "concept", content: "閉包的記憶體何時釋放？", depth: "intermediate", question: "何時釋放", parentLessonId }) });
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as GenerateEvent);
    return events.find(event => event.type === "complete") as Extract<GenerateEvent, { type: "complete" }>;
  };
  const done = await run("parent-1");
  assert.equal(done.lesson.parentLessonId, "parent-1");
  const analyst = calls.find(call => call.role === "分析代理")!;
  assert.deepEqual(analyst.data.continuesFrom, { title: "閉包入門", summary: "函式記得建立時的環境。" });
  assert.match(analyst.instruction, /不要重講該筆記已說明的基礎/);
  assert.equal(store.getRaw(done.lesson.id)?.parentLessonId, "parent-1");
  // An unknown parent is ignored rather than failing the lesson.
  calls.length = 0;
  const orphan = await run("missing-note");
  assert.equal(orphan.lesson.parentLessonId, undefined);
  assert.equal(calls.find(call => call.role === "分析代理")!.data.continuesFrom, undefined);
});

test("the library revalidates with ETags, APIs stay uncached, JSON is gzipped and progress streams are not", async t => {
  const store = new LessonStore(":memory:", exampleLessons);
  const { base, close } = await server(store);
  t.after(async () => { await close(); store.close(); });
  const library = await fetch(`${base}/api/lessons`, { headers: { ...headers, "accept-encoding": "gzip" } });
  assert.equal(library.headers.get("cache-control"), "no-cache");
  assert.equal(library.headers.get("content-encoding"), "gzip");
  const etag = library.headers.get("etag")!;
  assert.ok(etag);
  // fetch() adds Cache-Control: no-cache to manual conditional requests; a browser revalidation does not.
  const { get } = await import("node:http");
  const revalidated = await new Promise<number>((resolve, reject) => get(`${base}/api/lessons`, { headers: { host: headers.host, "if-none-match": etag } }, response => { response.resume(); resolve(response.statusCode!); }).on("error", reject));
  assert.equal(revalidated, 304);
  assert.equal((await fetch(`${base}/api/config`, { headers })).headers.get("cache-control"), "no-store");
  // Curated examples stream NDJSON without compression even when the client accepts gzip.
  const stream = await fetch(`${base}/api/generate`, { method: "POST", headers: { ...headers, "accept-encoding": "gzip" }, body: JSON.stringify({ kind: "code", content: "", depth: "beginner", exampleId: "demo-closure" }) });
  assert.equal(stream.headers.get("content-encoding"), null);
  assert.match(await stream.text(), /"type":"complete"/);
  // Compressed bodies decode to the same JSON.
  const raw = await new Promise<Buffer>((resolve, reject) => {
    import("node:http").then(({ get }) => get(`${base}/api/lessons`, { headers: { ...headers, "accept-encoding": "gzip" } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve(Buffer.concat(chunks))); response.on("error", reject);
    }).on("error", reject));
  });
  assert.equal(JSON.parse(gunzipSync(raw).toString("utf8")).length, exampleLessons.length);
});
