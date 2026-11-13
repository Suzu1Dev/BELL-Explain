import { fork } from "node:child_process";
import { stat } from "node:fs/promises";
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_CHARS, DOCUMENT_MAX_MB, DOCUMENT_MAX_UNITS, type DocumentFormat, type DocumentOutlineEntry } from "../shared/documents.js";
import { AppError } from "./errors.js";

export interface ParsedDocument {
  units: Array<{ number: number; text: string }>;
  unitLabel: "page" | "slide" | "section";
  totalUnits: number;
  parsedUnits: number;
  extractedChars: number;
  warnings: string[];
  outline?: DocumentOutlineEntry[];
  imageOnlyUnits?: number[];
  encrypted?: boolean;
}
export interface RenderedPage { page: number; mimeType: string; data: string; width: number; height: number; }
/**
 * Drawing counts of one PDF page, used to tell figure and formula pages from plain
 * text. `sizes` lists each image's pixel size ("640x480"), so a logo repeated on
 * every page can be told from a figure.
 */
export interface PageMetrics {
  page: number; images: number; paths: number; gaps: number; sizes?: string[];
  /** Images pdf.js shares between pages, as "objectId=640x480": the same picture reused, such as a logo. */
  shared?: string[];
}
export type WorkerRequest =
  | { command: "parse"; path: string; format: DocumentFormat; password?: string }
  | { command: "render"; path: string; required: number[]; candidates: number[]; limit: number; maxEdge: number; password?: string;
      /** Candidates are already ranked by the caller: take them in order instead of re-scoring. */
      ranked?: boolean }
  | { command: "inspect"; path: string; password?: string; limit?: number };
export { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_CHARS };
export const DOCUMENT_MAX_PAGES = DOCUMENT_MAX_UNITS;
export const DOCUMENT_PARSE_TIMEOUT_MS = 30_000;
/** Up to 1,000 PDF pages are laid out, so PDFs get a longer bound. */
export const PDF_PARSE_TIMEOUT_MS = 120_000;
export const PDF_RENDER_TIMEOUT_MS = 60_000;

/** A separate process keeps document decoding and malformed-file failures off the API event loop. */
function runWorker<T>(request: WorkerRequest, signal: AbortSignal, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = fork(new URL("./document-worker.ts", import.meta.url), [], {
      execArgv: ["--import", "tsx", "--max-old-space-size=512", "--disable-proto=throw"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      // The decoder does not need provider credentials or the user's shell environment.
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8", NODE_ENV: "production" },
      serialization: "json",
    });
    let result: T | undefined;
    let failure: unknown;
    let settled = false;
    const terminate = (error: unknown) => {
      if (settled || failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const abort = () => terminate(signal.reason || new DOMException("已取消文件處理。", "AbortError"));
    const timer = setTimeout(() => terminate(new AppError(422, timeoutMessage)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    // Abort may arrive between the initial check and listener registration.
    if (signal.aborted) abort();
    child.on("message", (message: unknown) => {
      if (failure || !message || typeof message !== "object") return;
      const value = message as { result?: T; error?: { status: number; message: string } };
      if (value.error) failure = new AppError(value.error.status, value.error.message);
      else if (value.result) result = value.result;
    });
    child.once("error", error => { failure ||= new AppError(500, `無法啟動文件解析程序：${error.message}`); });
    child.once("spawn", () => { child.send(request, error => { if (error) terminate(new AppError(500, "無法傳送文件處理指令。")); }); });
    child.once("close", () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new AppError(422, "文件內容過於複雜或已損毀，解析程序未能完成。請分段或重新匯出文件後重試。"));
    });
  });
}
async function checkFile(path: string) {
  const info = await stat(path).catch(() => { throw new AppError(422, "找不到上傳的檔案，請重新上傳。"); });
  if (!info.isFile() || info.size === 0) throw new AppError(422, "檔案是空的，請選擇包含內容的文件。");
  if (info.size > DOCUMENT_MAX_BYTES) throw new AppError(413, `檔案大小超過 ${DOCUMENT_MAX_MB} MB，請拆成較小的文件再上傳。`);
}
export async function parseDocument(path: string, format: DocumentFormat, signal: AbortSignal,
  options: { timeoutMs?: number; password?: string } = {}): Promise<ParsedDocument> {
  signal.throwIfAborted();
  if (!["pdf", "docx", "pptx", "txt", "md"].includes(format)) throw new AppError(422, "不支援這個檔案格式。請上傳 PDF、DOCX、PPTX、TXT 或 Markdown。");
  await checkFile(path);
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? (format === "pdf" ? PDF_PARSE_TIMEOUT_MS : DOCUMENT_PARSE_TIMEOUT_MS);
  return runWorker<ParsedDocument>({ command: "parse", path, format, password: options.password }, signal, timeoutMs,
    `文件解析超過 ${Math.round(timeoutMs / 1000)} 秒。請將文件分段，或匯出成可選取文字的 PDF 後重試。`);
}
/** Counts images, drawn paths and wide gaps inside text lines on each PDF page. */
export async function inspectPdfPages(path: string, signal: AbortSignal, options: { timeoutMs?: number; password?: string; limit?: number } = {}): Promise<PageMetrics[]> {
  signal.throwIfAborted();
  await checkFile(path);
  return runWorker<PageMetrics[]>({ command: "inspect", path, password: options.password, limit: options.limit }, signal, options.timeoutMs ?? PDF_PARSE_TIMEOUT_MS,
    "檢查 PDF 圖表頁面超過時間，可直接解說或稍後再試。");
}
/** Renders up to `limit` PDF pages: every required page first, then candidates that contain images or drawings. */
export async function renderPdfPages(path: string, pages: { required: number[]; candidates: number[]; limit: number; ranked?: boolean }, signal: AbortSignal,
  options: { timeoutMs?: number; password?: string; maxEdge?: number } = {}): Promise<RenderedPage[]> {
  signal.throwIfAborted();
  await checkFile(path);
  return runWorker<RenderedPage[]>({ command: "render", path, ...pages, maxEdge: options.maxEdge ?? 1400, password: options.password }, signal,
    options.timeoutMs ?? PDF_RENDER_TIMEOUT_MS, "產生頁面影像超過時間，請縮小解說頁數範圍後重試。");
}
