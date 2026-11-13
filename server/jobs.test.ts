import test from "node:test";
import assert from "node:assert/strict";
import { exampleLessons } from "../shared/examples.js";
import type { GenerateEvent as AnyGenerateEvent } from "../shared/types.js";
import type { StoredLesson } from "../shared/lesson-v3.js";

type GenerateEvent = AnyGenerateEvent<StoredLesson>;
import { JobRegistry, isCancelled } from "./jobs.js";

const complete = { type: "complete" as const, lesson: exampleLessons[0] };
const stage = (message: string): GenerateEvent => ({ type: "stage", stage: "teach", message });

test("a long job keeps its first and last events and stable indexes for resuming", async () => {
  const jobs = new JobRegistry();
  let finish!: () => void;
  const view = jobs.start({ kind: "generate", title: "閉包" }, async (emit) => {
    for (let index = 0; index < 450; index++) emit(stage(`step ${index}`));
    await new Promise<void>((resolve) => { finish = resolve; });
    return complete;
  });
  assert.equal(jobs.get(view.id)?.message, "step 449", "the latest progress is on the job itself");
  const cursor = jobs.cursor(view.id)!;
  assert.equal(cursor, 450);
  const seen: GenerateEvent[] = [];
  let ended = false;
  jobs.follow(view.id, 0, (event) => seen.push(event), () => { ended = true; });
  assert.equal((seen[0] as { message: string }).message, "step 0");
  assert.equal((seen.at(-1) as { message: string }).message, "step 449");
  assert.ok(seen.length <= 400);
  // Resuming at the cursor replays nothing old, then delivers the outcome.
  const resumed: GenerateEvent[] = [];
  jobs.follow(view.id, cursor, (event) => resumed.push(event), () => {});
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(resumed.map((event) => event.type), ["complete"]);
  assert.equal(ended, true);
  assert.equal(jobs.get(view.id)?.status, "done");
  assert.equal(jobs.get(view.id)?.lessonId, exampleLessons[0].id);
});

test("finished jobs are forgotten after the retention period; failures keep a public message", async () => {
  // Generous margins so a loaded machine cannot purge the job before it is checked.
  const jobs = new JobRegistry(300);
  const view = jobs.start({ kind: "examples", title: "x", lessonId: "a" }, async () => { throw new Error("internal detail with /home/user/secret path"); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = jobs.get(view.id)!;
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(failed.error || "", /secret/);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(jobs.get(view.id), undefined);
  assert.equal(jobs.follow(view.id, 0, () => {}, () => {}), undefined);
});

test("shutdown waits for running jobs, then stops what is left with a clear reason", async () => {
  const jobs = new JobRegistry();
  const quick = jobs.start({ kind: "generate", title: "quick" }, async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return complete; });
  const stuck = jobs.start({ kind: "generate", title: "stuck" }, (_emit, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const started = Date.now();
  await jobs.drain(60);
  assert.ok(Date.now() - started >= 55);
  assert.equal(jobs.get(quick.id)?.status, "done");
  assert.equal(jobs.get(stuck.id)?.status, "failed");
  assert.match(jobs.get(stuck.id)?.error || "", /重新啟動/);
  assert.deepEqual(jobs.running(), []);
  // Nothing running: drain returns at once.
  const again = Date.now();
  await jobs.drain(1000);
  assert.ok(Date.now() - again < 50);
});

test("after its events are pruned, a job's outcome is still known for a day", async () => {
  const jobs = new JobRegistry(10, 1000);
  const view = jobs.start({ kind: "generate", title: "閉包" }, async () => complete);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs.get(view.id), undefined, "events are gone");
  assert.equal(jobs.outcome(view.id)?.status, "done");
  assert.equal(jobs.outcome(view.id)?.lessonId, exampleLessons[0].id);
  assert.equal(jobs.outcome("unknown"), undefined);
});

test("once shutdown begins no job can start, and cancel is told apart from shutdown", async () => {
  const jobs = new JobRegistry();
  const cancelled = jobs.start({ kind: "generate", title: "a" }, (_emit, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const signals: AbortSignal[] = [];
  const stopped = jobs.start({ kind: "generate", title: "b" }, (_emit, signal) => { signals.push(signal); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); });
  jobs.cancel(cancelled.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(jobs.get(cancelled.id)?.status, "cancelled");
  const drained = jobs.drain(20);
  assert.throws(() => jobs.start({ kind: "generate", title: "late" }, async () => complete), /重新啟動/);
  await drained;
  assert.equal(jobs.get(stopped.id)?.status, "failed");
  assert.equal(isCancelled(signals[0]), false, "a shutdown is not a cancel");
});
