import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { annotationSources } from "../shared/annotations.js";
import { exampleLessons } from "../shared/examples.js";
import { isLessonV3 } from "../shared/lesson-v3.js";
import type { AnnotationRequest, GenerateEvent, Lesson, LessonAnnotation } from "../shared/types.js";
import { createApp, type AppOptions } from "./app.js";
import type { ChatCall } from "./ai.js";
import { annotationRequestSchema, annotationOutputSchema, annotationTarget, explainAnnotation, mergeAnnotation, MAX_ANNOTATIONS, MAX_ANNOTATED_LESSON_BYTES } from "./lesson-annotations.js";
import type { ProviderService } from "./provider-router.js";
import type { KnowledgeService } from "./knowledge.js";
import type { SyncService } from "./sync.js";
import { syncLessonSchema } from "./sync-protocol.js";
import { LessonStore } from "./store.js";
import { withExample } from "./test-helpers.js";

const selection: AnnotationRequest = { term: "BFS", sourceKey: "summary", quote: "BFS uses a queue." };
const output = { explanation: "BFS 會逐層查看相鄰的狀態。", analogy: "像先拜訪同一樓層，再前往下一層。", example: "queue.push(start);" };
function note(): Lesson {
  return { ...structuredClone(exampleLessons[0]), id: "annotation-test-note", isDemo: false, connections: [], summary: "BFS uses a queue. DFS uses a stack.", updatedAt: "2026-10-04T00:00:00.000Z" };
}
function annotation(overrides: Partial<LessonAnnotation> = {}): LessonAnnotation {
  return { id: randomUUID(), ...selection, ...output, createdAt: "2026-10-04T00:00:00.000Z", ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
async function setup(t: TestContext, overrides: Partial<AppOptions> = {}, seed = note()) {
  const store = new LessonStore(":memory:", [seed]);
  const server = createServer(createApp({ store, examples: exampleLessons, config: { apiKey: "local-test", model: "selected-model", baseUrl: "http://127.0.0.1:1/v1" }, chat: async () => output, progressIntervalMs: 10, ...overrides }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}/api${path}`, { ...init, signal: init.signal || t.signal, headers: { "content-type": "application/json", ...init.headers } });
  const post = (body: unknown = selection) => api(`/lessons/${seed.id}/annotations`, { method: "POST", body: JSON.stringify(body) });
  return { store, api, post };
}
async function events(response: Response): Promise<GenerateEvent[]> {
  return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as GenerateEvent);
}
function complete(items: GenerateEvent[]): Lesson {
  const last = items.at(-1);
  assert.equal(last?.type, "complete", JSON.stringify(items));
  if (last?.type !== "complete") throw new Error("Expected completion");
  assert.ok(!isLessonV3(last.lesson));
  return last.lesson;
}

test("authoritative annotation sources expose all guided fields with deterministic keys, excluding raw source", () => {
  const lesson = withExample(note());
  const list = annotationSources(lesson);
  assert.deepEqual(list, annotationSources(structuredClone(lesson)));
  assert.equal(new Set(list.map(source => source.key)).size, list.length);
  assert.equal(list[0].key, "summary");
  const section = lesson.sections.find(part => part.codeExample)!;
  for (const suffix of ["heading", "body", "analogy", "code", "example-title", "example-scenario", "example-environment", "example-output", "example-application", "example-walkthrough:0", "concept:0"]) {
    assert.ok(list.some(source => source.key === `${section.id}:${suffix}`), suffix);
  }
  assert.ok(list.every(source => !source.key.startsWith("source")));
  assert.equal(annotationTarget(lesson, selection), lesson.summary);
  assert.throws(() => annotationTarget(lesson, { ...selection, sourceKey: `${section.id}:body` }), /段落不符/);
  assert.throws(() => annotationTarget(lesson, { ...selection, quote: "BFS: invented context" }), /段落不符/);
  assert.throws(() => annotationTarget(lesson, { ...selection, term: "missing" }), /段落不符/);
});

test("annotation request and model output reject unbounded, empty, malformed and control-character values", () => {
  assert.deepEqual(annotationRequestSchema.parse({ ...selection, term: "  BFS  ", quote: "  BFS uses a queue.  " }), selection);
  for (const change of [{ term: " " }, { term: "x".repeat(161) }, { quote: "x".repeat(4001) }, { sourceKey: "x".repeat(201) }, { quote: "BFS\u0000" }, { unexpected: "ignored?" }]) {
    assert.equal(annotationRequestSchema.safeParse({ ...selection, ...change }).success, false);
  }
  for (const value of [{ explanation: "valid" }, { ...output, explanation: "x".repeat(3001) }, { ...output, analogy: " " }, { ...output, example: "x".repeat(4001) }, { ...output, html: "<script>" }]) {
    assert.equal(annotationOutputSchema.safeParse(value).success, false);
  }
});

test("annotation explanation uses one scoped call and never forwards client-supplied context outside its source", async () => {
  const calls: unknown[][] = [];
  const lesson = note();
  const result = await explainAnnotation(lesson, selection, async (...args) => { calls.push(args); return output; }, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "詞句教學代理");
  const data = calls[0][2] as { authoritativeContext: string; quote: string; term: string };
  assert.equal(data.authoritativeContext, lesson.summary);
  assert.equal(data.term, selection.term);
  assert.equal(data.quote, selection.quote);
  assert.match(calls[0][1] as string, /120–300/);
  assert.equal(result.sourceKey, selection.sourceKey);
  assert.equal(result.explanation, output.explanation);
  assert.ok(result.id);
  await assert.rejects(() => explainAnnotation(lesson, { ...selection, quote: "BFS from another source" }, async () => { throw new Error("must not call"); }, new AbortController().signal), /段落不符/);
});

test("merge preserves latest favorites and annotations, rejects changed/deleted sources, and advances future timestamps", () => {
  const original = note();
  const existing = annotation({ term: "DFS", quote: "DFS uses a stack." });
  const current = { ...original, favorite: true, updatedAt: "2099-01-01T00:00:00.000Z", annotations: [existing] };
  const incoming = annotation();
  const result = mergeAnnotation(original, current, selection, incoming);
  assert.equal(result.changed, true);
  assert.equal(result.lesson.favorite, true);
  assert.deepEqual(result.lesson.annotations, [existing, incoming]);
  assert.equal(result.lesson.updatedAt, "2099-01-01T00:00:00.001Z");
  const cached = mergeAnnotation(original, result.lesson, selection, annotation());
  assert.equal(cached.changed, false);
  assert.deepEqual(cached.lesson, result.lesson);
  assert.throws(() => mergeAnnotation(original, undefined, selection, incoming), /變更或刪除/);
  assert.throws(() => mergeAnnotation(original, { ...current, summary: current.summary + " changed" }, selection, incoming), /變更或刪除/);
  assert.throws(() => mergeAnnotation(original, { ...current, createdAt: "2099-01-01T00:00:00.000Z" }, selection, incoming), /變更或刪除/);
});

test("annotated-note UTF-8 capacity is enforced before saving and by sync, while legacy notes remain compatible", () => {
  const original = note();
  original.source.content = "測".repeat(610_000);
  assert.ok(Buffer.byteLength(JSON.stringify(original), "utf8") > MAX_ANNOTATED_LESSON_BYTES);
  assert.equal(syncLessonSchema.safeParse(original).success, true);
  assert.throws(() => mergeAnnotation(original, original, selection, annotation()), /可同步的容量/);
  assert.equal(syncLessonSchema.safeParse({ ...original, annotations: [annotation()] }).success, false);
});

test("HTTP generation uses the selected provider without overrides, persists before complete and calls knowledge/sync hooks", async t => {
  const factoryArgs: unknown[][] = [];
  const indexed: Lesson[] = [];
  const synced: Lesson[] = [];
  let modelCalls = 0;
  const provider = {
    status: async () => ({ configured: true, model: "user-chosen-model", effort: "ultra", speed: "fast" }),
    createChat: async (...args: unknown[]) => { factoryArgs.push(args); return async () => { modelCalls++; return output; }; },
  } as unknown as ProviderService;
  const { post, store } = await setup(t, { chat: undefined, provider, knowledge: { upsertLesson: (lesson: Lesson) => indexed.push(lesson) } as unknown as KnowledgeService, sync: { updatedLesson: (lesson: Lesson) => synced.push(lesson) } as unknown as SyncService });
  const response = await post();
  assert.equal(response.status, 200);
  const lesson = complete(await events(response));
  assert.equal(modelCalls, 1);
  assert.equal(factoryArgs.length, 1);
  assert.equal(factoryArgs[0].length, 1, "no model, effort or speed override may be supplied");
  assert.ok(factoryArgs[0][0] instanceof AbortSignal);
  assert.deepEqual(store.get(lesson.id), lesson);
  assert.equal(lesson.annotations?.length, 1);
  assert.equal(indexed.length, 1);
  assert.equal(synced.length, 1);
  assert.deepEqual(indexed[0].annotations, lesson.annotations);
});

test("HTTP duplicate cache works without configured AI and does not mutate timestamps or call a model", async t => {
  const seed = { ...note(), annotations: [annotation()] };
  let calls = 0;
  const { post, store } = await setup(t, { config: { apiKey: "", model: "", baseUrl: "http://127.0.0.1:1" }, chat: async () => { calls++; return output; } }, seed);
  const lesson = complete(await events(await post()));
  assert.deepEqual(lesson, store.get(seed.id));
  assert.equal(lesson.updatedAt, seed.updatedAt);
  assert.equal(lesson.annotations?.length, 1);
  assert.equal(calls, 0);
  const unavailable = await post({ ...selection, term: "DFS", quote: "DFS uses a stack." });
  assert.equal(unavailable.status, 503);
});

test("HTTP rejects cross-source requests, invalid output, excessive count and missing notes without changing saved data", async t => {
  let calls = 0;
  const { post, store, api } = await setup(t, { chat: async () => { calls++; return { explanation: "missing analogy" }; } });
  for (const request of [{ ...selection, sourceKey: "source.content" }, { ...selection, quote: "BFS does not match" }, { ...selection, term: "x".repeat(161) }]) {
    assert.equal((await post(request)).status, 400);
  }
  assert.equal(calls, 0);
  const failed = await events(await post());
  assert.equal(failed.at(-1)?.type, "error");
  assert.equal(store.getRaw(note().id)?.annotations, undefined);
  const full = note();
  full.annotations = Array.from({ length: MAX_ANNOTATIONS }, (_, index) => annotation({ term: `term-${index}` }));
  store.save(full);
  assert.equal((await post()).status, 409);
  assert.equal(calls, 1);
  store.delete(full.id);
  assert.equal((await post()).status, 404);
  assert.equal((await api(`/lessons/${full.id}/annotations/missing`, { method: "DELETE" })).status, 404);
});

test("HTTP annotation completion merges racing favorites and another annotation without losing either", { timeout: 5000 }, async t => {
  const gate = deferred<unknown>();
  const started = deferred<void>();
  const { post, api, store } = await setup(t, { chat: async (_role, _instruction, _data, signal) => { started.resolve(); return waitFor(gate.promise, signal); } });
  const response = await post();
  await started.promise;
  const favoriteResponse = await api(`/lessons/${note().id}`, { method: "PATCH", body: JSON.stringify({ favorite: true }) });
  assert.equal(favoriteResponse.status, 200);
  const other = annotation({ term: "DFS", quote: "DFS uses a stack." });
  const latest = store.getRaw(note().id)!;
  store.save({ ...latest, annotations: [other], updatedAt: "2099-01-01T00:00:00.000Z" });
  gate.resolve(output);
  const lesson = complete(await events(response));
  assert.equal(lesson.favorite, true);
  assert.deepEqual(lesson.annotations?.[0], other);
  assert.equal(lesson.annotations?.[1].term, "BFS");
  assert.equal(lesson.updatedAt, "2099-01-01T00:00:00.001Z");
});

for (const mutation of ["text", "delete"] as const) {
  test(`HTTP rejects ${mutation} during annotation work and never overwrites or resurrects the note`, { timeout: 5000 }, async t => {
    const gate = deferred<unknown>();
    const started = deferred<void>();
    const { post, store } = await setup(t, { chat: async (_role, _instruction, _data, signal) => { started.resolve(); return waitFor(gate.promise, signal); } });
    const response = await post();
    await started.promise;
    if (mutation === "delete") store.delete(note().id);
    else store.save({ ...store.getRaw(note().id)!, summary: "BFS uses a queue. The paragraph has now changed." });
    gate.resolve(output);
    const result = await events(response);
    assert.equal(result.at(-1)?.type, "error");
    assert.ok(result.every(event => event.type !== "complete"));
    assert.equal(store.getRaw(note().id)?.annotations, undefined);
    if (mutation === "delete") assert.equal(store.getRaw(note().id), undefined);
    else assert.match((store.getRaw(note().id) as Lesson).summary, /now changed/);
  });
}

test("HTTP duplicate in-flight terms are refused, and term explanations have their own two slots", { timeout: 5000 }, async t => {
  const gate = deferred<unknown>();
  let calls = 0;
  const { post, api } = await setup(t, { chat: async (_role, _instruction, _data, signal) => { calls++; return waitFor(gate.promise, signal); } });
  const first = await post();
  assert.equal((await post()).status, 429);
  const second = await post({ ...selection, term: "DFS", quote: "DFS uses a stack." });
  assert.equal((await post({ ...selection, term: "queue" })).status, 429, "a third term waits");
  assert.equal(calls, 2);
  // A lesson is not blocked by explanations in progress; cancel it once it has started.
  const generated = await api("/generate", { method: "POST", body: JSON.stringify({ kind: "code", depth: "beginner", content: "let value = 1;" }) });
  assert.equal(generated.status, 200);
  const reader = generated.body!.getReader();
  const { id } = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]) as { id: string };
  assert.equal((await api(`/jobs/${id}`, { method: "DELETE" })).status, 204);
  await reader.cancel();
  gate.resolve(output);
  const [a, b] = await Promise.all([events(first), events(second)]);
  assert.equal(complete(a).annotations?.length, 1);
  assert.equal(complete(b).annotations?.length, 2);
});

test("HTTP annotation timeouts are explicit, preserve the note and release both job and concurrency slots", { timeout: 5000 }, async t => {
  const { post, store } = await setup(t, { annotationTimeoutMs: 35, chat: async (_role, _instruction, _data, signal) => waitFor(new Promise(() => {}), signal) });
  const before = store.getRaw(note().id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await post();
    assert.equal(response.status, 200);
    const result = await events(response);
    const error = result.at(-1);
    assert.equal(error?.type, "error");
    if (error?.type === "error") assert.match(error.message, /等待上限/);
    assert.ok(result.every(event => event.type !== "complete"));
    assert.deepEqual(store.getRaw(note().id), before);
  }
});

test("HTTP client cancellation aborts annotation work and keeps the original note", { timeout: 5000 }, async t => {
  const aborted = deferred<void>();
  const { post, store } = await setup(t, { chat: async (_role, _instruction, _data, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return waitFor(new Promise(() => {}), signal);
  } });
  const before = store.getRaw(note().id);
  const response = await post();
  await response.body?.cancel();
  await aborted.promise;
  assert.deepEqual(store.getRaw(note().id), before);
});

test("DELETE annotation returns the latest note, preserves other data and updates hooks with monotonic time", async t => {
  const seed = { ...note(), favorite: true, annotations: [annotation(), annotation({ term: "DFS", quote: "DFS uses a stack." })], updatedAt: "2099-01-01T00:00:00.000Z" };
  const indexed: Lesson[] = [];
  const synced: Lesson[] = [];
  const { api, store } = await setup(t, { knowledge: { upsertLesson: (lesson: Lesson) => indexed.push(lesson) } as unknown as KnowledgeService, sync: { updatedLesson: (lesson: Lesson) => synced.push(lesson) } as unknown as SyncService }, seed);
  const path = `/lessons/${seed.id}/annotations/${seed.annotations[0].id}`;
  const response = await api(path, { method: "DELETE" });
  assert.equal(response.status, 200);
  const lesson = await response.json() as Lesson;
  assert.equal(lesson.favorite, true);
  assert.deepEqual(lesson.sections, seed.sections);
  assert.deepEqual(lesson.annotations, [seed.annotations[1]]);
  assert.equal(lesson.updatedAt, "2099-01-01T00:00:00.001Z");
  assert.deepEqual(store.get(lesson.id), lesson);
  assert.equal(indexed.length, 1);
  assert.equal(synced.length, 1);
  assert.equal((await api(path, { method: "DELETE" })).status, 404);
});
