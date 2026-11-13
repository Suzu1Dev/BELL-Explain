import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exampleLessons } from "../shared/examples.js";
import type { GenerateEvent } from "../shared/types.js";
import { createApp, type AppOptions } from "./app.js";
import type { ChatCall, ChatProgress } from "./ai.js";
import { AppError, publicError } from "./errors.js";
import { taskDeadline, withGenerationProgress } from "./generation-progress.js";
import { JobRegistry } from "./jobs.js";
import { liveTeachingSchema } from "./schema.js";
import { LessonStore } from "./store.js";
import { withExample } from "./test-helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

test("a silent model still produces timed stage heartbeats without inventing output", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const gate = deferred<unknown>();
  const events: GenerateEvent[] = [];
  const run = withGenerationProgress(async () => gate.promise, event => events.push(event))(
    "分析代理", "instruction", { source: "source text" }, new AbortController().signal,
  );
  t.mock.timers.tick(4999);
  assert.equal(events.length, 0);
  t.mock.timers.tick(1);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "stage", stage: "analyze", message: "分析代理正在等候模型回應（已進行 5 秒）。",
  });
  t.mock.timers.tick(5000);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "stage");
  if (events[1].type === "stage") assert.match(events[1].message, /10 秒/);
  assert.doesNotMatch(JSON.stringify(events), /已接收|source text|instruction/);
  gate.resolve({ done: true });
  assert.deepEqual(await run, { done: true });
});

test("thinking and writing progress reflects reported metadata while keeping model content private", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const gate = deferred<unknown>();
  const events: GenerateEvent[] = [];
  const forwarded: ChatProgress[] = [];
  let progress!: (value: ChatProgress) => void;
  const rawText = "PRIVATE_REASONING_AND_UNFINISHED_JSON_7c92";
  const run = withGenerationProgress(async (_role, _instruction, _data, _signal, onProgress) => {
    progress = onProgress!;
    return gate.promise;
  }, event => events.push(event))(
    "教學代理", rawText, { content: rawText }, new AbortController().signal,
    value => forwarded.push(value),
  );
  progress({ phase: "thinking", outputChars: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "stage");
  if (events[0].type === "stage") assert.match(events[0].message, /正在思考與規劃內容/);
  progress({ phase: "writing", outputChars: 1234 });
  assert.equal(events.length, 2);
  if (events[1].type === "stage") assert.match(events[1].message, /已接收 1,234 字元/);
  progress({ phase: "writing", outputChars: 1300 });
  assert.equal(events.length, 2, "same-phase updates are throttled until the next heartbeat");
  t.mock.timers.tick(5000);
  if (events[2].type === "stage") assert.match(events[2].message, /已接收 1,300 字元/);
  assert.deepEqual(forwarded, [
    { phase: "thinking", outputChars: 0 },
    { phase: "writing", outputChars: 1234 },
    { phase: "writing", outputChars: 1300 },
  ]);
  assert.ok(events.every(event => event.type === "stage" && event.stage === "teach"));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING|UNFINISHED_JSON/);
  gate.resolve({ text: rawText });
  await run;
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING|UNFINISHED_JSON/);
});

test("heartbeats distinguish recent model activity from waiting for its next response", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const gate = deferred<unknown>();
  const events: GenerateEvent[] = [];
  let activity!: (value: ChatProgress) => void;
  const run = withGenerationProgress(async (_role, _instruction, _data, _signal, onProgress) => {
    activity = onProgress!;
    return gate.promise;
  }, event => events.push(event))("教學代理", "", {}, new AbortController().signal);
  activity({ phase: "thinking", outputChars: 0 });
  t.mock.timers.tick(35_000);
  assert.match(JSON.stringify(events.at(-1)), /仍在等候模型的下一次回應/);
  assert.doesNotMatch(JSON.stringify(events.at(-1)), /正在思考/);
  activity({ phase: "writing", outputChars: 100 });
  assert.match(JSON.stringify(events.at(-1)), /正在產生解說，已接收 100/);
  t.mock.timers.tick(35_000);
  assert.match(JSON.stringify(events.at(-1)), /仍在等候模型的下一次回應，已接收 100/);
  gate.resolve({ done: true });
  await run;
});

for (const outcome of ["success", "throw", "abort"] as const) {
  test(`progress interval is cleared after ${outcome} and never emits again`, async t => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    const clear = t.mock.method(globalThis, "clearInterval");
    const controller = new AbortController();
    const gate = deferred<unknown>();
    const events: GenerateEvent[] = [];
    const forwarded: ChatProgress[] = [];
    let lateProgress!: (value: ChatProgress) => void;
    const run = withGenerationProgress(
      async (_role, _instruction, _data, signal, onProgress) => {
        lateProgress = onProgress!;
        return untilAbort(gate.promise, signal);
      },
      event => events.push(event),
    )("知識整理代理", "", {}, controller.signal, value => forwarded.push(value));
    t.mock.timers.tick(5000);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "stage");
    if (events[0].type === "stage") assert.equal(events[0].stage, "organize");
    if (outcome === "success") {
      gate.resolve({ done: true });
      await run;
    } else {
      const error = outcome === "abort" ? new DOMException("Cancelled", "AbortError") : new Error("Provider failed");
      const rejected = assert.rejects(run, received => received === error);
      if (outcome === "abort") controller.abort(error);
      else gate.reject(error);
      await rejected;
    }
    assert.equal(clear.mock.callCount(), 1, "cleanup must release the interval, including after abort");
    const count = events.length;
    lateProgress({ phase: "writing", outputChars: 999 });
    assert.equal(events.length, count, "a late adapter callback must not revive a finished stage");
    assert.equal(forwarded.length, 0, "late metadata must not reach outer listeners either");
    t.mock.timers.tick(60_000);
    assert.equal(events.length, count);
  });
}

test("task deadlines preserve cancellation reasons, expire explicitly, and are disposable", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const complete = taskDeadline(new AbortController().signal, 100, "expired");
  complete.dispose();
  t.mock.timers.tick(100);
  assert.equal(complete.signal.aborted, false, "a completed task must not time out later");

  const parent = new AbortController();
  const cancelled = taskDeadline(parent.signal, 100, "expired");
  const cancellation = new DOMException("User cancelled", "AbortError");
  parent.abort(cancellation);
  assert.equal(cancelled.signal.reason, cancellation);
  cancelled.dispose();

  const timedOut = taskDeadline(new AbortController().signal, 100, "整體等待上限已到，筆記尚未儲存。");
  t.mock.timers.tick(99);
  assert.equal(timedOut.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.ok(timedOut.signal.reason instanceof AppError);
  assert.equal(timedOut.signal.reason.status, 504);
  assert.equal(publicError(timedOut.signal.reason), "整體等待上限已到，筆記尚未儲存。");
  timedOut.dispose();
  assert.equal(publicError(cancellation), "這次工作已取消。");
  const providerTimeout = publicError(new DOMException("PRIVATE_PROVIDER_DETAIL", "TimeoutError"));
  assert.match(providerTimeout, /超過時間/);
  assert.doesNotMatch(providerTimeout, /取消|PRIVATE_PROVIDER_DETAIL/);
});

const input = { kind: "code", content: "const answer = 42;", depth: "beginner" };
const analysis = { title: "學習閉包", scope: "貼上的程式", keyConcepts: ["閉包"], explanationPlan: ["了解外層環境", "觀察重複呼叫"], caveats: [] };
const curation = { category: "JavaScript", tags: ["閉包"], connections: [] };
function teaching() {
  const fixture = structuredClone(exampleLessons[0]);
  return liveTeachingSchema.parse(withExample({
    ...fixture,
    visual: { ...fixture.visual, kind: "flow", scene: { layout: "flow", edges: [], groups: [] } },
  }));
}

async function serve(t: TestContext, overrides: Pick<AppOptions, "chat"> & Partial<AppOptions>) {
  const store = new LessonStore(":memory:", exampleLessons);
  const server = createServer(createApp({
    store, examples: exampleLessons,
    config: { apiKey: "local-test-only", baseUrl: "http://127.0.0.1:1/v1", model: "mock-model" },
    progressIntervalMs: 10,
    ...overrides,
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const save = t.mock.method(store, "save");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const generate = () => fetch(`${base}/generate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(input), signal: t.signal,
  });
  return { store, save, generate, base };
}

async function* streamedEvents(response: Response): AsyncGenerator<GenerateEvent> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as GenerateEvent;
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as GenerateEvent;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function untilEvent(stream: AsyncGenerator<GenerateEvent>, predicate: (event: GenerateEvent) => boolean, seen: GenerateEvent[]): Promise<GenerateEvent> {
  while (true) {
    const event = await stream.next();
    assert.equal(event.done, false, "stream ended before the expected progress event");
    seen.push(event.value);
    if (predicate(event.value)) return event.value;
  }
}

test("HTTP generation delivers live progress before completion and commits only after all roles finish", { timeout: 5000 }, async t => {
  const gates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  let calls = 0;
  const chat: ChatCall = async (_role, _instruction, _data, signal, progress) => {
    const index = calls++;
    if (index === 1) progress?.({ phase: "writing", outputChars: 42 });
    if (index === 2) progress?.({ phase: "thinking", outputChars: 0 });
    return untilAbort(gates[index].promise, signal);
  };
  const { store, save, generate } = await serve(t, { chat });
  const response = await generate();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/x-ndjson/);
  const stream = streamedEvents(response);
  t.after(() => stream.return(undefined));
  const seen: GenerateEvent[] = [];
  await untilEvent(stream, event => event.type === "stage" && event.stage === "analyze" && event.message.includes("正在等候模型回應"), seen);
  assert.equal(calls, 1);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(store.list().length, exampleLessons.length);

  gates[0].resolve(analysis);
  await untilEvent(stream, event => event.type === "stage" && event.stage === "teach" && event.message.includes("已接收 42 字元"), seen);
  assert.equal(save.mock.callCount(), 0);
  gates[1].resolve(teaching());
  await untilEvent(stream, event => event.type === "stage" && event.stage === "organize" && event.message.includes("正在思考"), seen);
  assert.equal(save.mock.callCount(), 0, "even the teaching output is not a complete saved note");
  gates[2].resolve(curation);
  const complete = await untilEvent(stream, event => event.type === "complete", seen);
  assert.equal(complete.type, "complete");
  if (complete.type !== "complete") throw new Error("Expected completion");
  assert.equal(calls, 3);
  assert.equal(save.mock.callCount(), 1);
  assert.equal(store.list().length, exampleLessons.length + 1);
  assert.deepEqual(store.get(complete.lesson.id), complete.lesson);
  assert.equal((await stream.next()).done, true);
  assert.equal(seen[0].type, "job", "the stream starts with the job id to follow it again");
  assert.ok(seen.slice(1, -1).every(event => event.type === "stage"));
});

test("a dropped connection does not stop a lesson: it finishes, is listed, and replays to a new follower", { timeout: 5000 }, async t => {
  const gates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  let calls = 0;
  const signals: AbortSignal[] = [];
  const chat: ChatCall = async (_role, _instruction, _data, signal) => { signals.push(signal); return untilAbort(gates[calls++].promise, signal); };
  const { store, generate, base } = await serve(t, { chat });
  const response = await generate();
  const stream = streamedEvents(response);
  const first = (await stream.next()).value as GenerateEvent;
  assert.equal(first.type, "job");
  const id = first.type === "job" ? first.id : "";
  // The phone locks: the browser drops the stream.
  await stream.return(undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(signals[0].aborted, false, "disconnecting must not cancel the model call");
  const running = await (await fetch(`${base}/jobs`)).json();
  assert.equal(running.find((job: { id: string }) => job.id === id)?.status, "running");
  gates[0].resolve(analysis);
  gates[1].resolve(teaching());
  gates[2].resolve(curation);
  // Following again from the start replays every event and ends with the saved note.
  const replay: GenerateEvent[] = [];
  for await (const event of streamedEvents(await fetch(`${base}/jobs/${id}/events?from=0`))) replay.push(event);
  assert.equal(replay[0].type, "job");
  const done = replay.at(-1)!;
  assert.equal(done.type, "complete");
  if (done.type !== "complete") throw new Error("Expected completion");
  assert.deepEqual(store.get(done.lesson.id), done.lesson);
  const listed = (await (await fetch(`${base}/jobs`)).json()).find((job: { id: string }) => job.id === id);
  assert.equal(listed.status, "done");
  assert.equal(listed.lessonId, done.lesson.id);
  // Resuming from the last seen index sends only what was missed.
  const tail: GenerateEvent[] = [];
  for await (const event of streamedEvents(await fetch(`${base}/jobs/${id}/events?from=${replay.length - 2}`))) tail.push(event);
  assert.deepEqual(tail.map(event => event.type), ["job", "complete"]);
  assert.equal((await fetch(`${base}/jobs/not-a-job/events`)).status, 404);
  assert.equal((await (await fetch(`${base}/jobs/${id}`)).json()).status, "done");
});

test("a device that reconnects after the events are gone still gets the saved lesson", { timeout: 5000 }, async t => {
  const jobs = new JobRegistry(20);
  let calls = 0;
  const { generate, base } = await serve(t, { jobs, chat: async () => [analysis, teaching(), curation][calls++] });
  const all: GenerateEvent[] = [];
  for await (const event of streamedEvents(await generate())) all.push(event);
  const id = all[0].type === "job" ? all[0].id : "";
  const saved = all.at(-1)!;
  await new Promise(resolve => setTimeout(resolve, 40));
  const late: GenerateEvent[] = [];
  for await (const event of streamedEvents(await fetch(`${base}/jobs/${id}/events?from=7`))) late.push(event);
  assert.deepEqual(late.map(event => event.type), ["job", "complete"]);
  if (late[1].type === "complete" && saved.type === "complete") assert.equal(late[1].lesson.id, saved.lesson.id);
  assert.equal((await (await fetch(`${base}/jobs/${id}`)).json()).status, "done");
});

test("an explicit cancel stops the lesson, saves nothing and frees its slot", { timeout: 5000 }, async t => {
  const aborted = deferred<void>();
  const chat: ChatCall = async (_role, _instruction, _data, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return untilAbort(new Promise<unknown>(() => {}), signal);
  };
  const { store, generate, base } = await serve(t, { chat });
  for (let attempt = 0; attempt < 3; attempt++) {
    const stream = streamedEvents(await generate());
    const first = (await stream.next()).value as GenerateEvent;
    const id = first.type === "job" ? first.id : "";
    assert.equal((await fetch(`${base}/jobs/${id}`, { method: "DELETE" })).status, 204);
    const seen: GenerateEvent[] = [];
    const end = await untilEvent(stream, event => event.type === "error", seen);
    if (end.type === "error") assert.match(end.message, /已取消/);
    assert.equal((await fetch(`${base}/jobs`).then(r => r.json())).find((job: { id: string }) => job.id === id)?.status, "cancelled");
  }
  await aborted.promise;
  assert.equal(store.list().length, exampleLessons.length);
  assert.equal((await fetch(`${base}/jobs/unknown`, { method: "DELETE" })).status, 404);
});

test("HTTP overall timeout reports an explicit error, saves nothing, and releases the generation slot", { timeout: 5000 }, async t => {
  const signals: AbortSignal[] = [];
  const { store, save, generate } = await serve(t, {
    generationTimeoutMs: 50,
    chat: async (_role, _instruction, _data, signal) => {
      signals.push(signal);
      return untilAbort(new Promise<unknown>(() => {}), signal);
    },
  });
  // The third accepted request proves previous failures released the two-slot cap.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await generate();
    assert.equal(response.status, 200, `generation slot leaked after timeout ${attempt}`);
    const events: GenerateEvent[] = [];
    for await (const event of streamedEvents(response)) events.push(event);
    const error = events.at(-1);
    assert.equal(error?.type, "error");
    if (error?.type === "error") {
      assert.match(error.message, /整體等待上限/);
      assert.match(error.message, /尚未儲存/);
      assert.doesNotMatch(error.message, /已取消/);
    }
    assert.ok(events.every(event => event.type !== "complete"));
    assert.equal(save.mock.callCount(), 0);
    assert.equal(store.list().length, exampleLessons.length);
  }
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted && signal.reason instanceof AppError));
});

test("following a job while the server shuts down still delivers the job line and its outcome", { timeout: 5000 }, async t => {
  const jobs = new JobRegistry();
  const gate = deferred<unknown>();
  let calls = 0;
  const { generate, base } = await serve(t, { jobs, chat: async (_role, _instruction, _data, signal) => untilAbort(calls++ === 0 ? gate.promise : Promise.resolve([analysis, teaching(), curation][calls - 1]), signal) });
  const first = (await streamedEvents(await generate()).next()).value as GenerateEvent;
  const id = first.type === "job" ? first.id : "";
  const drained = jobs.drain(2000);
  const response = await fetch(`${base}/jobs/${id}/events?from=0`);
  assert.equal(response.headers.get("connection"), "close");
  gate.resolve(analysis);
  const events: GenerateEvent[] = [];
  for await (const event of streamedEvents(response)) events.push(event);
  await drained;
  assert.equal(events[0].type, "job");
  assert.equal(events.at(-1)?.type, "complete");
});
