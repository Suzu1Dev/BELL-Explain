import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exampleLessons } from "../shared/examples.js";
import { isLessonV3 } from "../shared/lesson-v3.js";
import type { CodeExample, GenerateEvent, Lesson } from "../shared/types.js";
import { createApp, type AppOptions } from "./app.js";
import type { ChatCall } from "./ai.js";
import { addLessonExamples, exampleAdditionsSchema } from "./lesson-examples.js";
import { liveTeachingSchema, teachingSchema } from "./schema.js";
import { LessonStore } from "./store.js";

const code = "const prices = [30, 50];\nconst total = prices.reduce((sum, price) => sum + price, 0);\nconsole.log(total);";
function metadata(): CodeExample {
  return {
    title: "計算購物清單總額",
    scenario: "結帳前，要知道清單內商品一共多少錢。",
    environment: "JavaScript；可放入瀏覽器主控台，無額外套件。",
    walkthrough: [
      { startLine: 1, endLine: 2, explanation: "先列出商品價格，再從零開始逐項累加，避免另外維護容易漏算的總額。" },
      { startLine: 3, endLine: 3, explanation: "把最後累計的金額印出，便能對照清單確認 reduce 的結果。" },
    ],
    expectedOutput: "依程式推導，會顯示 80。",
    application: "可用於購物清單小計；正式結帳還要處理折扣、稅金與幣別。",
  };
}
function note(): Lesson {
  const result = structuredClone(exampleLessons[0]);
  result.id = "lesson-needs-examples";
  result.isDemo = false;
  result.favorite = false;
  result.connections = [];
  result.updatedAt = "2024-01-01T00:00:00.000Z";
  for (const section of result.sections) {
    section.code = "";
    section.language = "";
    delete section.codeExample;
  }
  return result;
}
function addition(sectionId: string) {
  return { sectionId, code, language: "javascript", codeExample: metadata() };
}
function parseEvents(text: string): GenerateEvent[] {
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function delayedChat(output: unknown) {
  const started = deferred();
  const released = deferred();
  const chat: ChatCall = async (_role, _instructions, _data, signal) => {
    started.resolve();
    await released.promise;
    signal.throwIfAborted();
    return output;
  };
  return { chat, started: started.promise, release: released.resolve };
}
async function setup(
  t: TestContext,
  chat: ChatCall,
  initial = note(),
  config: AppOptions["config"] = { apiKey: "test-only", model: "fake-model", baseUrl: "https://example.invalid/v1" },
) {
  const store = new LessonStore(":memory:");
  store.save(initial);
  const server = createServer(createApp({
    store,
    examples: exampleLessons,
    config,
    chat,
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const request = (path: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const enhance = (body: unknown = {}) => request(`/api/lessons/${initial.id}/examples`, { method: "POST", body: JSON.stringify(body) });
  return { store, request, enhance };
}

test("legacy teaching remains valid while new teaching requires at least one complete code case", () => {
  const legacy = note();
  assert.equal(teachingSchema.safeParse(legacy).success, true);
  legacy.visual = { ...legacy.visual, kind: "flow", scene: { layout: "flow", edges: [], groups: [] } };
  assert.equal(teachingSchema.safeParse(legacy).success, true);
  assert.equal(liveTeachingSchema.safeParse(legacy).success, false);
  Object.assign(legacy.sections[0], { code, language: "javascript", codeExample: metadata() });
  assert.equal(liveTeachingSchema.safeParse(legacy).success, true);
});

test("case validation rejects zero, reversed, and nonexistent lines plus empty code or language", async () => {
  const invalid = [
    (value: ReturnType<typeof addition>) => { value.codeExample.walkthrough[0].startLine = 0; },
    (value: ReturnType<typeof addition>) => { value.codeExample.walkthrough[0].startLine = 3; value.codeExample.walkthrough[0].endLine = 1; },
    (value: ReturnType<typeof addition>) => { value.codeExample.walkthrough[1].endLine = 4; },
    (value: ReturnType<typeof addition>) => { value.code = "   "; },
    (value: ReturnType<typeof addition>) => { value.language = "   "; },
  ];
  for (const mutate of invalid) {
    const lesson = note();
    const item = addition(lesson.sections[0].id);
    mutate(item);
    // Line numbers are checked after merging, against the code the note will keep.
    await assert.rejects(addLessonExamples(note(), async () => ({ examples: [item] }), new AbortController().signal), /原筆記尚未變更/);
    Object.assign(lesson.sections[0], { code: item.code, language: item.language, codeExample: item.codeExample });
    assert.equal(teachingSchema.safeParse(lesson).success, false);
  }
});

test("adding a case preserves original prose, visual, identity, and existing code", async () => {
  const original = note();
  original.sections[0].code = code;
  original.sections[0].language = "javascript";
  const snapshot = structuredClone(original);
  const result = await addLessonExamples(original, async () => ({ examples: [addition(original.sections[0].id)] }), new AbortController().signal);
  const expected = structuredClone(snapshot);
  expected.sections[0].codeExample = metadata();
  expected.updatedAt = result.updatedAt;
  assert.deepEqual(result, expected);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(result.visual, snapshot.visual);
  assert.equal(result.sections[0].body, snapshot.sections[0].body);
});

test("case generation cannot target an unknown or already enriched section, and existing code is kept as written", async () => {
  const original = note();
  Object.assign(original.sections[1], { code, language: "javascript", codeExample: metadata() });
  original.sections[0].code = code;
  original.sections[0].language = "javascript";
  const snapshot = structuredClone(original);
  const outputs = [
    { examples: [addition("nonexistent-section")] },
    { examples: [addition(original.sections[1].id)] },
    { examples: [addition(original.sections[0].id), addition(original.sections[0].id)] },
  ];
  for (const output of outputs) {
    await assert.rejects(addLessonExamples(original, async () => output, new AbortController().signal), /原筆記尚未變更/);
    assert.deepEqual(original, snapshot);
  }
  // An explanation written for rewritten code would not match the original, so it is refused.
  for (const item of [{ ...addition(original.sections[0].id), code: code.replace("30, 50", "10, 20") }, { ...addition(original.sections[0].id), language: "typescript" }]) {
    await assert.rejects(addLessonExamples(original, async () => ({ examples: [item] }), new AbortController().signal), /改寫了既有程式碼/);
    assert.deepEqual(original, snapshot);
  }
  // Omitting the code, or repeating it with only trailing-space differences, keeps the original.
  for (const item of [{ ...addition(original.sections[0].id), code: undefined, language: undefined }, { ...addition(original.sections[0].id), code: code.replace(/\n/g, "  \n"), language: "javascript" }]) {
    const result = await addLessonExamples(original, async () => ({ examples: [item] }), new AbortController().signal);
    assert.equal(result.sections[0].code, code);
    assert.equal(result.sections[0].language, "javascript");
    assert.ok(result.sections[0].codeExample);
    assert.deepEqual(original, snapshot);
  }
});

test("an aborted case generation never returns changes after the model response", async () => {
  const original = note();
  const delayed = delayedChat({ examples: [addition(original.sections[0].id)] });
  const controller = new AbortController();
  const result = addLessonExamples(original, delayed.chat, controller.signal);
  await delayed.started;
  controller.abort();
  delayed.release();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(original.sections[0].codeExample, undefined);
});

test("the case endpoint commits validated content before emitting completion", async t => {
  const original = note();
  const { store, enhance } = await setup(t, async () => ({ examples: [addition(original.sections[0].id)] }), original);
  const writes = t.mock.method(store, "save");
  const response = await enhance();
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  const complete = events.at(-1);
  assert.equal(complete?.type, "complete");
  if (complete?.type !== "complete") throw new Error("Missing completion");
  assert.ok(!isLessonV3(complete.lesson));
  assert.deepEqual(store.getRaw(original.id), complete.lesson);
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(complete.lesson.sections[0].codeExample, metadata());
  assert.equal(complete.lesson.sections[0].body, original.sections[0].body);
  assert.deepEqual(complete.lesson.visual, original.visual);
});

test("invalid case responses never mutate stored notes or emit completion", async t => {
  const original = note();
  let output: unknown;
  const { store, enhance } = await setup(t, async () => output, original);
  const writes = t.mock.method(store, "save");
  const badLines = addition(original.sections[0].id);
  badLines.codeExample.walkthrough[1].endLine = 99;
  for (const invalid of [{ examples: [] }, { examples: [badLines] }, { examples: [addition("other-note-section")] }]) {
    output = invalid;
    const response = await enhance();
    const events = parseEvents(await response.text());
    assert.equal(events.at(-1)?.type, "error");
    assert.ok(events.every(event => event.type !== "complete"));
    assert.deepEqual(store.getRaw(original.id), original);
  }
  assert.equal(writes.mock.callCount(), 0);
});

test("partially enriched notes return saved content without a configured model or any mutation", async t => {
  const original = note();
  Object.assign(original.sections[0], { code, language: "javascript", codeExample: metadata() });
  assert.ok(original.sections.some(section => !section.codeExample));
  let calls = 0;
  const { store, enhance } = await setup(
    t,
    async () => { calls++; throw new Error("A no-op must not call the model"); },
    original,
    { apiKey: "", model: "", baseUrl: "https://example.invalid/v1" },
  );
  const writes = t.mock.method(store, "save");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await enhance();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/x-ndjson/);
    assert.deepEqual(parseEvents(await response.text()), [{ type: "complete", lesson: original }]);
    assert.deepEqual(store.getRaw(original.id), original);
  }
  assert.equal(calls, 0);
  assert.equal(writes.mock.callCount(), 0);
});

test("a favorite change during generation survives the case commit and a duplicate request joins the running job", async t => {
  const original = note();
  const delayed = delayedChat({ examples: [addition(original.sections[0].id)] });
  const { store, request, enhance } = await setup(t, delayed.chat, original);
  t.after(delayed.release);
  const response = await enhance();
  await delayed.started;
  assert.deepEqual(store.getRaw(original.id), original);
  // A second request for the same note follows the job already running instead of starting another.
  const duplicate = await enhance();
  assert.equal(duplicate.status, 200);
  const duplicateText = duplicate.text();
  // Another note waits its turn: one note gets cases at a time.
  store.save({ ...note(), id: "another-note" });
  assert.equal((await request("/api/lessons/another-note/examples", { method: "POST", body: "{}" })).status, 429);
  const favorite = await request(`/api/lessons/${original.id}`, { method: "PATCH", body: JSON.stringify({ favorite: true }) });
  assert.equal(favorite.status, 200);
  assert.equal((await favorite.json()).favorite, true);
  delayed.release();
  const events = parseEvents(await response.text());
  const complete = events.at(-1);
  assert.equal(complete?.type, "complete");
  const joined = parseEvents(await duplicateText);
  assert.deepEqual(joined[0], events[0], "both streams follow the same job");
  assert.equal(joined.at(-1)?.type, "complete");
  assert.equal(store.getRaw(original.id)?.favorite, true);
  assert.deepEqual((store.getRaw(original.id) as Lesson | undefined)?.sections[0].codeExample, metadata());
});

test("deleting or editing a note during generation prevents stale cases from overwriting it", async t => {
  for (const mutation of ["delete", "section", "source"] as const) {
    await t.test(mutation, async child => {
      const original = note();
      const delayed = delayedChat({ examples: [addition(original.sections[0].id)] });
      const { store, request, enhance } = await setup(child, delayed.chat, original);
      child.after(delayed.release);
      const response = await enhance();
      await delayed.started;
      let edited: Lesson | undefined;
      if (mutation === "delete") {
        assert.equal((await request(`/api/lessons/${original.id}`, { method: "DELETE" })).status, 204);
      } else {
        edited = structuredClone(original);
        if (mutation === "section") edited.sections[0].body = "生成等待中，使用者更新了這一段。";
        else edited.source.content = "生成等待中，同步取得了新來源。";
        store.save(edited);
      }
      delayed.release();
      const events = parseEvents(await response.text());
      const error = events.at(-1);
      assert.equal(error?.type, "error");
      if (error?.type !== "error") throw new Error("Missing conflict error");
      assert.match(error.message, /已更新或刪除/);
      assert.ok(events.every(event => event.type !== "complete"));
      assert.deepEqual(store.getRaw(original.id), edited);
    });
  }
});

test("case endpoint rejects malformed requests, missing notes, and curated notes before model invocation", async t => {
  let calls = 0;
  const { store, request, enhance } = await setup(t, async () => { calls++; return {}; });
  assert.equal((await enhance({ replace: true })).status, 400);
  assert.equal((await request("/api/lessons/missing/examples", { method: "POST", body: "{}" })).status, 404);
  const curated = structuredClone(exampleLessons[0]);
  Object.assign(curated.sections[0], { code, language: "javascript", codeExample: metadata() });
  store.save(curated);
  assert.equal((await request(`/api/lessons/${curated.id}/examples`, { method: "POST", body: "{}" })).status, 400);
  assert.equal(calls, 0);
});
