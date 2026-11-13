import { randomUUID } from "node:crypto";
import type { GenerateEvent as AnyGenerateEvent, JobKind, JobView } from "../shared/types.js";
import type { StoredLesson } from "../shared/lesson-v3.js";

type GenerateEvent = AnyGenerateEvent<StoredLesson>;
import { AppError, publicError } from "./errors.js";
import { logEvent } from "./log.js";

/** Finished jobs keep their events this long, so a browser that reconnects can replay them. */
export const JOB_RETENTION_MS = 15 * 60_000;
/**
 * After that, a small record of how each job ended is kept this long, so a
 * phone that slept for hours still learns that its lesson was saved.
 */
export const OUTCOME_RETENTION_MS = 24 * 60 * 60_000;
const MAX_OUTCOMES = 200;
/** Progress lines kept for replay; older ones are dropped, the outcome never is. */
const MAX_EVENTS = 400;

type Listener = (event: GenerateEvent) => void;
interface Job {
  view: JobView;
  events: GenerateEvent[];
  /** Events dropped from the front, so indexes stay stable for clients. */
  dropped: number;
  listeners: Set<Listener>;
  controller: AbortController;
  done: Promise<void>;
}
/** A job ends with a saved lesson or, for deep reading, the pages it read. */
type Outcome = Extract<GenerateEvent, { type: "complete" } | { type: "read" }>;
type Run = (emit: (event: GenerateEvent) => void, signal: AbortSignal) => Promise<Outcome>;
const ends = (event: GenerateEvent) => event.type === "complete" || event.type === "read" || event.type === "error";

/**
 * Model work that outlives the request that started it. A dropped connection
 * (a phone locking, Tailscale reconnecting) no longer cancels a lesson: the job
 * keeps running, its events are kept, and any browser can follow it again.
 * Only an explicit cancel, its deadline or shutdown stops it. Kept in memory:
 * a restart loses running jobs, which then report as unknown.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly outcomes = new Map<string, JobView>();
  /** Set once shutdown begins: no new job may start. */
  private closing = false;
  constructor(private readonly retentionMs = JOB_RETENTION_MS, private readonly outcomeMs = OUTCOME_RETENTION_MS) {}
  get shuttingDown(): boolean { return this.closing; }

  running(kind?: JobKind): JobView[] {
    return [...this.jobs.values()].filter((job) => job.view.status === "running" && (!kind || job.view.kind === kind)).map((job) => ({ ...job.view }));
  }
  list(): JobView[] {
    this.prune();
    return [...this.jobs.values()].map((job) => ({ ...job.view })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  get(id: string): JobView | undefined {
    this.prune();
    const job = this.jobs.get(id);
    return job && { ...job.view };
  }
  /** How a job ended once its events are gone; undefined if it is still live or unknown. */
  outcome(id: string): JobView | undefined {
    this.prune();
    const view = this.outcomes.get(id);
    return view && { ...view };
  }

  start(meta: { kind: JobKind; title: string; lessonId?: string; documentId?: string }, run: Run): JobView {
    if (this.closing) throw new AppError(503, "伺服器正在重新啟動，請稍後再開始。");
    this.prune();
    const id = randomUUID();
    const controller = new AbortController();
    const job: Job = {
      view: { id, kind: meta.kind, title: meta.title, lessonId: meta.lessonId, documentId: meta.documentId, status: "running", startedAt: new Date().toISOString() },
      events: [],
      dropped: 0,
      listeners: new Set(),
      controller,
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    const emit = (event: GenerateEvent) => {
      if (job.view.status !== "running") return;
      if (event.type === "stage") { job.view.stage = event.stage; job.view.message = event.message; }
      this.push(job, event);
    };
    job.done = (async () => {
      try {
        const outcome = await run(emit, controller.signal);
        job.view.status = "done";
        if (outcome.type === "complete") job.view.lessonId = outcome.lesson.id;
        else job.view.pagesRead = outcome.pages;
        this.finish(job, outcome);
      } catch (error) {
        const cancelled = isCancelled(controller.signal);
        job.view.status = cancelled ? "cancelled" : "failed";
        const reason = controller.signal.reason;
        const message = !cancelled ? publicError(error) : reason !== CANCELLED && reason instanceof JobCancel ? reason.message : "這次工作已取消，尚未儲存不完整的筆記。";
        job.view.error = message;
        this.finish(job, { type: "error", message, ...(error instanceof AppError ? { status: error.status } : {}) });
      }
    })();
    return { ...job.view };
  }
  private push(job: Job, event: GenerateEvent) {
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) {
      // Drop the oldest progress line after the first; the outcome is never dropped.
      const index = job.events.findIndex((item, position) => position > 0 && item.type === "stage");
      if (index > 0) { job.events.splice(index, 1); job.dropped++; }
    }
    for (const listener of job.listeners) listener(event);
  }
  private finish(job: Job, event: GenerateEvent) {
    job.view.finishedAt = new Date().toISOString();
    this.push(job, event);
    job.listeners.clear();
    logEvent("job.finished", { id: job.view.id, kind: job.view.kind, status: job.view.status, ms: Date.parse(job.view.finishedAt) - Date.parse(job.view.startedAt) });
  }

  /**
   * Replays events from index `from` and then follows live ones. The listener
   * sees the outcome last; `onEnd` runs once it has been delivered.
   */
  follow(id: string, from: number, listener: Listener, onEnd: () => void): (() => void) | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const start = Math.max(0, from - job.dropped);
    for (const event of job.events.slice(start)) listener(event);
    if (job.view.status !== "running") { onEnd(); return () => {}; }
    const live: Listener = (event) => {
      listener(event);
      if (ends(event)) onEnd();
    };
    job.listeners.add(live);
    return () => job.listeners.delete(live);
  }
  /** Index of the next event, so a client that has seen everything can resume from it. */
  cursor(id: string): number | undefined {
    const job = this.jobs.get(id);
    return job ? job.dropped + job.events.length : undefined;
  }

  /** Resolves once the job has ended, whatever the outcome. */
  settled(id: string): Promise<void> {
    return this.jobs.get(id)?.done ?? Promise.resolve();
  }
  /** Stops a running job; `message` replaces the usual cancellation text, e.g. when its file is removed. */
  cancel(id: string, message?: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.view.status !== "running") return false;
    job.controller.abort(message ? new JobCancel(message) : CANCELLED);
    return true;
  }
  /** Refuses new jobs, waits for running ones to finish, up to `timeoutMs`, then stops the rest. */
  async drain(timeoutMs: number): Promise<void> {
    this.closing = true;
    const running = [...this.jobs.values()].filter((job) => job.view.status === "running");
    if (!running.length) return;
    logEvent("job.drain", { running: running.length, timeoutMs });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((job) => job.done)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
    for (const job of running) if (job.view.status === "running") job.controller.abort(new AppError(503, "伺服器正在重新啟動，這次工作沒有完成，尚未儲存不完整的筆記。請稍後重試。"));
    await Promise.race([Promise.all(running.map((job) => job.done)), new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
  }
  private prune() {
    const now = Date.now();
    for (const [id, job] of this.jobs)
      if (job.view.finishedAt && Date.parse(job.view.finishedAt) < now - this.retentionMs) {
        this.jobs.delete(id);
        this.outcomes.set(id, { ...job.view });
      }
    for (const [id, view] of this.outcomes)
      if (Date.parse(view.finishedAt!) < now - this.outcomeMs || this.outcomes.size > MAX_OUTCOMES) this.outcomes.delete(id);
  }
}
/** A deliberate stop, as opposed to a deadline or shutdown. */
class JobCancel extends DOMException {
  constructor(message: string) { super(message, "AbortError"); }
}
const CANCELLED = new JobCancel("這次工作已取消。");
/** Whether a job's signal was aborted by a deliberate stop (the learner, or removing its file), not its deadline or shutdown. */
export const isCancelled = (signal: AbortSignal) => signal.aborted && signal.reason instanceof JobCancel;
