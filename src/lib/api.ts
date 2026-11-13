import type {
  AppConfig,
  GenerateEvent,
  GenerateRequest,
  JobView,
  AnnotationRequest,
  Depth,
} from "../../shared/types";
import { lessonMarkdown, type MarkdownRelation } from "../../shared/lesson-markdown";
import type { DocumentPreview } from "../../shared/documents";
import type { StoredLesson } from "../../shared/lesson-v3";
import type { CheckAttempt, CheckEvent, CheckVerdict, CheckResult, ReviewCardView, ReviewSummary, SelfCheckItem, RecallAnswer, RecallState } from "../../shared/learning";
import type { SuiteManifest } from "./suite";
import { annotationCardCopy } from "../copy/annotation-card";
import { explainApiErrors } from "../copy/explain-client-errors";

type ClientGenerateEvent = GenerateEvent<StoredLesson>;

/** An API failure that keeps the HTTP status, e.g. 423 for a PDF that needs a password. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "ApiError"; }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || explainApiErrors().serviceUnavailable, response.status, typeof body.code === "string" ? body.code : undefined);
  }
  return response.json();
}

export const api = {
  config: () => request<AppConfig>("/config"),
  suiteManifest: () => request<SuiteManifest>("/suite/manifest"),
  lessons: () => request<StoredLesson[]>("/lessons"),
  uploadDocument: (file: File, signal: AbortSignal, password?: string) =>
    request<DocumentPreview>("/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Document-Name": encodeURIComponent(file.name),
        ...(password ? { "X-Document-Password": encodeURIComponent(password) } : {}),
      },
      body: file,
      signal,
    }),
  document: async (id: string, signal?: AbortSignal): Promise<DocumentPreview | null> => {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { signal });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || explainApiErrors().sourceCheckFailed);
    }
    return response.json();
  },
  removeDocument: async (id: string) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
    // Files already used by a note must remain available to that note.
    if (!response.ok && response.status !== 404 && response.status !== 409)
      throw new Error(explainApiErrors().unusedUploadRemoveFailed);
  },
  downloadDocument: async (id: string, name: string) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}/file`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || explainApiErrors().sourceMissingOnServer);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  favorite: (id: string, favorite: boolean) =>
    request<StoredLesson>(`/lessons/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite }),
    }),
  remove: async (id: string) => {
    const response = await fetch(`/api/lessons/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(explainApiErrors().deleteNoteFailed);
  },
  removeAnnotation: (id: string, annotationId: string) =>
    request<StoredLesson>(`/lessons/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotationId)}`, {
      method: "DELETE",
    }),
  checks: (id: string) => request<SelfCheckItem[]>(`/lessons/${encodeURIComponent(id)}/checks`),
  /** Self-assessment against an answer the model already wrote: no model call. */
  selfCheck: (id: string, index: number, answer: string, verdict: CheckVerdict) =>
    request<CheckAttempt>(`/lessons/${encodeURIComponent(id)}/checks/${index}/self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer, verdict }),
    }),
  jobs: () => request<JobView[]>("/jobs"),
  /** A job's state, or how it ended up to a day after its events are gone; null if unknown. */
  job: async (id: string): Promise<JobView | null> => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(explainApiErrors().jobStatusUnavailable, response.status);
    return response.json();
  },
  /** Stops a lesson or example job; closing the page no longer does. */
  cancelJob: async (id: string) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new ApiError(explainApiErrors().cancelJobFailed, response.status);
  },
  recall: (lessonId: string) => request<RecallState[]>(`/lessons/${encodeURIComponent(lessonId)}/recall`),
  rateRecall: (lessonId: string, stepId: string, rating: RecallAnswer) => request<RecallState>(`/lessons/${encodeURIComponent(lessonId)}/recall/${encodeURIComponent(stepId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  }),
  reviewSummary: () => request<ReviewSummary>("/review/summary"),
  reviewDue: () => request<ReviewCardView[]>("/review/due"),
  reviewRate: (id: string, rating: 1 | 2 | 3 | 4) =>
    request<{ due: string }>(`/review/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    }),
};

/** Asks the model to grade an answer; resolves with the graded result. */
export async function checkAnswer(
  id: string,
  index: number,
  answer: string,
  signal: AbortSignal,
  onStage: (message: string) => void,
): Promise<CheckResult> {
  let result: CheckResult | undefined;
  await streamEvents<CheckEvent>(`/api/lessons/${encodeURIComponent(id)}/checks/${index}`, { answer }, signal, (event) => {
    if (event.type === "stage") onStage(event.message);
    if (event.type === "checked") result = event.result;
  }, "checked", explainApiErrors().selfCheckInterrupted, explainApiErrors().selfCheckStartFailed);
  return result!;
}

export async function explainSelection(
  id: string,
  input: AnnotationRequest,
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
  incompleteMessage = annotationCardCopy().streamInterruptedError,
) {
  return streamGeneration(
    `/api/lessons/${encodeURIComponent(id)}/annotations`, input, signal, onEvent,
    incompleteMessage,
  );
}

export async function generate(
  input: GenerateRequest,
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
) {
  return followJob(() => post("/api/generate", input, signal), signal, onEvent);
}

export async function reformatLesson(
  id: string,
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
  depth?: Depth,
) {
  return followJob(() => post(`/api/lessons/${encodeURIComponent(id)}/reformat`, depth ? { depth } : {}, signal), signal, onEvent);
}

export async function enhanceExamples(
  id: string,
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
) {
  return followJob(() => post(`/api/lessons/${encodeURIComponent(id)}/examples`, {}, signal), signal, onEvent);
}

/** Starts (or joins) a deep reading of a PDF's figure, formula and scanned pages. */
export async function readDocument(
  id: string,
  options: { range?: { start: number; end: number }; password?: string; redo?: boolean },
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
) {
  return followJob(() => post(`/api/documents/${encodeURIComponent(id)}/readings`, options, signal), signal, onEvent);
}

/** Follows a job already running on the server, e.g. one started before a reload or on another device. */
export function resumeJob(id: string, signal: AbortSignal, onEvent: (event: ClientGenerateEvent) => void) {
  return followJob(() => fetch(`/api/jobs/${encodeURIComponent(id)}/events?from=0`, { signal }), signal, onEvent, id);
}

const post = (endpoint: string, input: unknown, signal: AbortSignal) => fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
  signal,
});
/**
 * The job reported failure, or its outcome cannot be known; unlike a dropped
 * connection, this is not retried. `unknown` means the lesson may well have been
 * saved: check the library rather than tell the learner nothing was kept.
 */
export class JobFailure extends Error {
  /** `code`: why the server refused to start, e.g. "no_model" when no AI is connected. */
  constructor(message: string, readonly unknown = false, readonly status?: number, readonly code?: string) { super(message); this.name = "JobFailure"; }
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * Reads a job's event stream to its outcome. When the connection drops (a phone
 * locking, a network change), it reconnects and asks only for the events it
 * missed; the job keeps running on the server meanwhile. Aborting `signal`
 * stops following, not the job — use api.cancelJob for that.
 */
async function followJob(
  open: () => Promise<Response>,
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
  knownId?: string,
) {
  let id = knownId;
  let seen = 0;
  let failures = 0;
  let opened = false;
  for (;;) {
    try {
      // The first request starts (or resumes) the job; later ones pick up where the stream broke.
      const response = opened && id
        ? await fetch(`/api/jobs/${encodeURIComponent(id)}/events?from=${seen}`, { signal })
        : await open();
      opened = true;
      if (response.status === 404 && id) throw new JobFailure(explainApiErrors().jobOutcomeUnknown, true);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        // Before the job exists, a refusal (busy, not configured) is final.
        if (!id || response.status < 500) throw new JobFailure(body.error || explainApiErrors().explainStartFailed, false, response.status, typeof body.code === "string" ? body.code : undefined);
        throw new Error(body.error || explainApiErrors().connectionInterruptedRetry);
      }
      let finished = false;
      try {
        await readLines(response, signal, (event) => {
          if (event.type === "job") { id = event.id; onEvent(event); return; }
          if (event.type === "error") throw new JobFailure(event.message, false, event.status);
          seen++;
          failures = 0;
          onEvent(event);
          if (event.type === "complete" || event.type === "read") finished = true;
        });
      } catch (error) {
        // A connection cut right after the outcome arrived changes nothing.
        if (!finished) throw error;
      }
      if (finished) return;
      throw new Error(explainApiErrors().connectionLostShort);
    } catch (error) {
      if (signal.aborted || error instanceof JobFailure) throw error;
      if (!id) throw new JobFailure(explainApiErrors().explainStartUncertain, true);
      if (++failures > 30) throw new JobFailure(explainApiErrors().jobStatusLostReload, true);
      await pause(Math.min(1000 * failures, 10_000), signal);
    }
  }
}

async function readLines(response: Response, signal: AbortSignal, handle: (event: ClientGenerateEvent) => void) {
  if (!response.body) throw new Error(explainApiErrors().streamBodyUnsupported);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const line = (text: string) => { if (text.trim()) handle(JSON.parse(text) as ClientGenerateEvent); };
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const text of lines) line(text);
    }
    buffer += decoder.decode();
    line(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function streamGeneration(
  endpoint: string,
  input: unknown,
  signal: AbortSignal,
  onEvent: (event: ClientGenerateEvent) => void,
  incompleteMessage = explainApiErrors().generationInterrupted,
) {
  return streamEvents(endpoint, input, signal, onEvent, "complete", incompleteMessage, explainApiErrors().explainStartFailed);
}

/** Reads a newline-delimited JSON event stream; an "error" event or a stream without `finalType` throws. */
async function streamEvents<T extends { type: string }>(
  endpoint: string,
  input: unknown,
  signal: AbortSignal,
  onEvent: (event: T) => void,
  finalType: T["type"],
  incompleteMessage: string,
  startMessage: string,
) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || startMessage, response.status, typeof body.code === "string" ? body.code : undefined);
  }
  if (!response.body) throw new Error(explainApiErrors().streamBodyUnsupported);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as T & { message?: string };
    if (event.type === "error") throw new Error(event.message);
    if (event.type === finalType) completed = true;
    onEvent(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handle(line);
    }
    buffer += decoder.decode();
    handle(buffer);
    if (!completed) throw new Error(incompleteMessage);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function exportLesson(lesson: StoredLesson, related: MarkdownRelation[] = []) {
  const content = lessonMarkdown(lesson, related);
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${lesson.title.replace(/[/\\:*?"<>|]/g, "-")}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
