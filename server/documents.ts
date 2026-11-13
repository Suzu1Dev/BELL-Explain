import { Router, raw, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DOCUMENT_CONTEXT_CHARS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_CHARS,
  DOCUMENT_MAX_MB,
  DOCUMENT_MAX_READING_PAGES,
  DOCUMENT_MAX_VISUAL_PAGES,
  type DocumentFormat,
  type DocumentMetadata,
  type DocumentPreview,
  type DocumentRange,
  type PageReading,
} from "../shared/documents.js";
import type { Source } from "../shared/types.js";
import { AppError } from "./errors.js";
import { inspectPdfPages, parseDocument, PDF_PARSE_TIMEOUT_MS, renderPdfPages, type PageMetrics, type ParsedDocument, type RenderedPage } from "./document-parser.js";
import { logEvent } from "./log.js";

const formats: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
};
const labels = { page: "頁", slide: "張投影片", section: "段" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new AppError(404, "找不到這份原始檔案。若筆記來自雲端同步，請在原先上傳的裝置下載檔案，或重新上傳。");
interface StoredDocument extends Pick<ParsedDocument, "outline" | "imageOnlyUnits" | "encrypted"> {
  version: 1;
  metadata: DocumentMetadata;
  units: ParsedDocument["units"];
  /** Per-page drawing counts of a PDF; absent until inspected. Visual pages are derived from them. */
  metrics?: PageMetrics[];
  /** When inspection last failed, so a broken file is not inspected on every request. */
  visualFailedAt?: string;
}
type DocumentParser = (path: string, format: DocumentFormat, signal: AbortSignal, options?: { password?: string }) => Promise<ParsedDocument>;
type PageRenderer = typeof renderPdfPages;
type PageInspector = typeof inspectPdfPages;
const READINGS_VERSION = 1;
/** The pages one deep reading will read, with their text layer, and how many are left for later. */
export interface ReadingPlan { name: string; pages: Array<{ page: number; text: string }>; more: number }

/** What a template puts on (nearly) every page: the count found on at least 80% of pages. */
function templateLevel(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length * 0.2)] : 0;
}
/**
 * Sizes of the template's pictures (logos, backgrounds, frames). A picture is the
 * template when the PDF reuses the same image on many pages, which pdf.js reports
 * with a shared id; its size then also marks its first, not yet shared, use.
 * Different figures that happen to share a size (charts exported from one tool)
 * are separate images and still count. Without that information, only a size
 * found on nearly every page of a longer file is taken as the template.
 */
function templateSizes(metrics: PageMetrics[]) {
  const count = (values: Iterable<string>, into: Map<string, number>) => { for (const value of new Set(values)) into.set(value, (into.get(value) || 0) + 1); };
  if (metrics.some(page => page.shared)) {
    const ids = new Map<string, number>();
    for (const page of metrics) count(page.shared || [], ids);
    const minimum = Math.max(2, Math.ceil(metrics.length * 0.3));
    return new Set([...ids].filter(([, pages]) => pages + 1 >= minimum).map(([entry]) => entry.slice(entry.lastIndexOf("=") + 1)));
  }
  if (metrics.length < 5) return new Set<string>();
  const sizes = new Map<string, number>();
  for (const page of metrics) count(page.sizes || [], sizes);
  return new Set([...sizes].filter(([, pages]) => pages >= metrics.length * 0.8).map(([size]) => size));
}
const area = (size: string) => size.split("x").reduce((product, side) => product * (Number(side) || 0), 1);
/**
 * Pages worth showing to a model as images, most visual first. A short file has
 * no template to compare with; a longer one is measured against what its
 * template draws on nearly every page, so a logo, frame or a header spread across
 * the line does not count: figures (images not repeated across pages), many extra
 * drawn paths (diagrams), or a few extra paths together with extra gaps inside text
 * lines (formulas drawn as graphics, as PowerPoint exports them).
 */
export function visualPages(metrics: PageMetrics[], imageOnly: number[] = []): Array<{ page: number; score: number }> {
  // A few pages are too few to tell a template from content: compare drawings with the
  // plainest page, and count a page full of drawings as a diagram on its own.
  const template = metrics.length >= 5;
  const level = (values: number[]) => (template ? templateLevel(values) : Math.min(...values));
  const repeated = templateSizes(metrics);
  const imageLevel = level(metrics.map(page => page.images));
  const paths = level(metrics.map(page => page.paths));
  const gaps = level(metrics.map(page => page.gaps));
  const scored = metrics.flatMap(page => {
    // Small images are bullets and icons; sizes repeated across pages belong to the template.
    const figures = page.sizes ? page.sizes.filter(size => !repeated.has(size) && area(size) >= 4_096).length : Math.max(0, page.images - imageLevel);
    const extraPaths = Math.max(0, page.paths - paths, !template && page.paths >= 40 ? page.paths : 0);
    // Ruled tables also leave gaps between cells; a few are enough to suspect a formula.
    const extraGaps = Math.min(3, Math.max(0, page.gaps - gaps));
    const formula = extraPaths >= 4 && extraGaps > 0;
    if (!figures && extraPaths < 15 && !formula) return [];
    // A figure only a model can read outweighs a formula or a ruled table.
    return [{ page: page.page, score: figures * 60 + Math.min(extraPaths, 60) + (formula ? 15 + extraGaps * 3 : 0) }];
  });
  // Pages without a text layer can only be read visually.
  for (const page of imageOnly) if (!scored.some(item => item.page === page)) scored.push({ page, score: 1000 });
  return scored.sort((a, b) => b.score - a.score || a.page - b.page);
}
/** Visual pages of a stored PDF, within its parsed pages; undefined until it has been inspected. */
function visualOf(document: StoredDocument) {
  if (!document.metrics) return undefined;
  const parsed = document.metadata.parsedUnits;
  return visualPages(document.metrics.filter(page => page.page <= parsed), (document.imageOnlyUnits || []).filter(page => page <= parsed));
}
/** A read page with nothing on it (blank, or only decoration) adds nothing to a lesson. */
const emptyReading = (reading: PageReading) => !reading.text.trim() && !reading.visuals.length;
export interface DocumentLessonOptions {
  question: string;
  range?: DocumentRange;
  /** Attach rendered PDF pages (scans, figures) for providers that read images. */
  visual?: boolean;
  /** Needed to render an encrypted PDF; used for this call only and never stored. */
  password?: string;
}
const tooLarge = () => new AppError(413, `檔案過大，請上傳 ${DOCUMENT_MAX_MB} MB 以內的檔案。`);

function documentName(input: string): { name: string; format: DocumentFormat } {
  // The name is for display only; all disk paths use generated IDs and a fixed extension.
  const name = input.replace(/\\/g, "/").split("/").pop()!.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().normalize("NFC");
  if (!name || name.length > 255) throw new AppError(400, "請提供有效的檔名（最多 255 字）。");
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (!name.includes(".") || !Object.hasOwn(formats, extension)) throw new AppError(415, "目前支援 PDF、DOCX、PPTX、TXT 與 Markdown（.md）檔案。");
  return { name, format: extension as DocumentFormat };
}
function marker(unitLabel: DocumentMetadata["unitLabel"], number: number) {
  return `[第 ${number} ${labels[unitLabel]}]`;
}
function plainText(document: StoredDocument) {
  return document.units.filter(unit => unit.text.trim()).map(unit => `${marker(document.metadata.unitLabel, unit.number)}\n${unit.text}`).join("\n\n");
}
/** Warnings stored by earlier releases that no longer describe what BELL does with the file. */
const LEGACY_WARNINGS: Record<string, string> = {
  "PDF 目前擷取文字層；掃描圖片、圖表與公式的視覺內容不會自動辨識，多欄版面的閱讀順序也可能需要對照原檔。":
    "這份 PDF 以舊版解析，文字未依版面重組（重新上傳可改善）；掃描頁、圖表與公式可在解說時以頁面影像交給模型閱讀，或先深度解析。",
};
const currentWarnings = (warnings: string[]) => warnings.map(warning => LEGACY_WARNINGS[warning] ?? warning);

function preview(document: StoredDocument, readings: Map<number, PageReading> = new Map()): DocumentPreview {
  const text = plainText(document);
  return { ...document.metadata, warnings: currentWarnings(document.metadata.warnings), preview: text.slice(0, 6_000) + (text.length > 6_000 ? "\n\n…預覽僅顯示前 6,000 字；解說會依全文與問題選取內容。" : ""),
    // Uploads before outlines were cut to the parsed pages may hold bookmarks past them.
    outline: (document.outline || []).filter(entry => entry.start <= document.metadata.parsedUnits)
      .map(entry => ({ ...entry, end: Math.min(entry.end, document.metadata.parsedUnits) })),
    imageOnlyUnits: document.imageOnlyUnits || [], encrypted: !!document.encrypted,
    ...(visualOf(document) ? { visualUnits: visualOf(document)!.map(item => item.page) } : {}),
    readUnits: [...readings.keys()].filter(page => page <= document.metadata.parsedUnits).sort((a, b) => a - b) };
}
const VISUAL_LABELS: Record<PageReading["visuals"][number]["kind"], string> = { chart: "圖表", diagram: "示意圖", table: "表格", formula: "公式", photo: "圖片", other: "圖像" };
/** A read page's text for lessons: the model's transcription followed by what its visuals show. */
function readingText(reading: PageReading): string {
  const visuals = reading.visuals.map(item => `- ${VISUAL_LABELS[item.kind]}：${item.description}`);
  return [reading.text.trim(), visuals.length ? `［本頁圖表與公式說明（深度解析）］\n${visuals.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
function unitRanges(numbers: number[]) {
  const ranges: string[] = [];
  for (let index = 0; index < numbers.length;) {
    const start = numbers[index];
    let end = start;
    while (index + 1 < numbers.length && numbers[index + 1] === end + 1) end = numbers[++index];
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
    index++;
  }
  const result = ranges.join("、");
  return result.length <= 800 ? result : `${ranges.slice(0, 30).join("、")} 等；完整位置以來源文字標記為準`;
}
function searchTerms(question: string) {
  const tokens = question.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  const terms = tokens.flatMap(token => /\p{Script=Han}/u.test(token) && token.length > 4
    ? [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))]
    : [token]);
  return [...new Set(terms)].slice(0, 80);
}
type ContextBlock = { number: number; text: string };
function inRange(number: number, range?: DocumentRange) { return !range || (number >= range.start && number <= range.end); }
function selectContext(document: StoredDocument, question: string, range?: DocumentRange): { blocks: ContextBlock[]; partial: boolean } {
  const units = document.units.filter(unit => unit.text.trim() && inRange(unit.number, range));
  const complete = units.map(unit => `${marker(document.metadata.unitLabel, unit.number)}\n${unit.text}`).join("\n\n");
  if (complete.length <= DOCUMENT_CONTEXT_CHARS) return { blocks: units.map(unit => ({ number: unit.number, text: unit.text })), partial: false };
  const terms = searchTerms(question);
  const ranked = units.map((unit, index) => {
    const text = unit.text.toLowerCase();
    const matches = terms.map(term => ({ term, at: text.indexOf(term) })).filter(match => match.at >= 0);
    return { index, score: matches.reduce((sum, match) => sum + Math.min(match.term.length, 12), 0), at: matches.sort((a, b) => b.term.length - a.term.length)[0]?.at ?? 0 };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Set<number>([0, Math.floor((units.length - 1) / 2), units.length - 1]);
  // Keep context from the beginning, middle, and end alongside focus matches.
  for (const candidate of ranked.filter(item => item.score > 0).slice(0, 6)) selected.add(candidate.index);
  for (let index = 0; selected.size < Math.min(12, units.length) && index < 12; index++) selected.add(Math.round(index * (units.length - 1) / 11));
  const indices = [...selected].sort((a, b) => a - b);
  const perUnit = Math.floor((DOCUMENT_CONTEXT_CHARS - 1_000) / indices.length);
  const byIndex = new Map(ranked.map(item => [item.index, item]));
  const excerpt = (index: number, limit: number) => {
    const unit = units[index];
    let text = unit.text;
    if (text.length > limit) {
      const match = byIndex.get(index)!;
      if (match.score > 0) {
        const start = Math.max(0, Math.min(text.length - limit, match.at - Math.floor(limit / 3)));
        text = `${start > 0 ? "［此前內容略］\n" : ""}${text.slice(start, start + limit)}${start + limit < unit.text.length ? "\n［此後內容略］" : ""}`;
      } else {
        const part = Math.max(1, Math.floor(limit / 3));
        const middle = Math.floor((text.length - part) / 2);
        text = `${text.slice(0, part)}\n［中間內容略］\n${text.slice(middle, middle + part)}\n［中間內容略］\n${text.slice(-part)}`;
      }
    }
    return { number: unit.number, text };
  };
  const size = (block: ContextBlock) => marker(document.metadata.unitLabel, block.number).length + 1 + block.text.length;
  const excerpts = new Map(indices.map(index => [index, excerpt(index, perUnit)]));
  let remaining = DOCUMENT_CONTEXT_CHARS - [...excerpts.values()].reduce((sum, value) => sum + size(value) + 2, 0);
  // Paragraphs can be much shorter than pages. Fill unused space with more
  // focused passages and evenly spread intervals instead of sending 12 tiny lines.
  const candidates = ranked.filter(item => item.score > 0).slice(6, 40).map(item => item.index);
  const intervals: Array<[number, number]> = [[0, units.length - 1]];
  for (let position = 0; position < intervals.length; position++) {
    const [left, right] = intervals[position];
    if (right - left <= 1) continue;
    const middle = Math.floor((left + right) / 2);
    candidates.push(middle);
    intervals.push([left, middle], [middle, right]);
  }
  for (const index of candidates) {
    if (excerpts.has(index) || remaining < 100) continue;
    const value = excerpt(index, Math.max(1, Math.min(perUnit, remaining - 80)));
    if (size(value) + 2 <= remaining) {
      excerpts.set(index, value);
      remaining -= size(value) + 2;
    }
  }
  return { blocks: [...excerpts.entries()].sort(([a], [b]) => a - b).map(([, block]) => block), partial: true };
}

export class DocumentService {
  private readonly directory: string;
  private readonly parser: DocumentParser;
  private readonly renderer: PageRenderer;
  private readonly inspector: PageInspector;
  private readonly jobs = new Map<AbortController, Promise<void>>();
  /** One write at a time per document; readings and lazy inspection both rewrite files. */
  private readonly writes = new Map<string, Promise<unknown>>();
  /** Background inspections of older files: one at a time, stoppable per file and with the service. */
  private readonly background = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stopping = new AbortController();
  private readonly leases = new Map<string, number>();
  private readonly deleting = new Set<string>();
  private closed = false;
  private readonly inspectTimeoutMs: number;
  constructor(options: { directory: string; parser?: DocumentParser; renderer?: PageRenderer; inspector?: PageInspector; inspectTimeoutMs?: number }) {
    this.directory = resolve(options.directory);
    this.parser = options.parser || parseDocument;
    this.renderer = options.renderer || renderPdfPages;
    this.inspector = options.inspector || inspectPdfPages;
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? PDF_PARSE_TIMEOUT_MS;
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(id) || Promise.resolve()).catch(() => {}).then(work);
    this.writes.set(id, next);
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id); }).catch(() => {});
    return next;
  }
  /** Replaces a stored file without leaving a half-written copy behind. */
  private async replace(id: string, name: string, value: unknown) {
    const path = join(this.directoryFor(id), name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  private async inspect(path: string, document: StoredDocument, signal: AbortSignal, password?: string) {
    try {
      return await this.inspector(path, signal, { password, limit: document.metadata.parsedUnits });
    } catch (error) {
      signal.throwIfAborted();
      // A missing or wrong password is the caller's to fix, not a property of the file.
      if (error instanceof AppError && error.status === 423) throw error;
      // Without the analysis, page images fall back to the renderer's own choice.
      logEvent("document.inspect_failed", { id: document.metadata.id, status: error instanceof AppError ? error.status : undefined });
      return undefined;
    }
  }
  /**
   * Inspects a PDF stored before visual analysis existed, once, and keeps the
   * result; a failed inspection is retried at most daily.
   */
  private async withVisual(id: string, document: StoredDocument, signal: AbortSignal, password?: string): Promise<StoredDocument> {
    const recent = (value: StoredDocument) => !!value.visualFailedAt && Date.now() - Date.parse(value.visualFailedAt) < 86_400_000;
    if (document.metadata.format !== "pdf" || document.metrics || recent(document) || (document.encrypted && !password)) return document;
    return this.serial(id, async () => {
      const current = await this.read(id);
      if (current.metrics || recent(current)) return current;
      const metrics = await this.inspect(join(this.directoryFor(id), "original.pdf"), current, signal, password);
      signal.throwIfAborted();
      const updated: StoredDocument = metrics ? { ...current, metrics, visualFailedAt: undefined } : { ...current, visualFailedAt: new Date().toISOString() };
      await this.replace(id, "document.json", updated);
      return updated;
    });
  }
  async readings(id: string): Promise<Map<number, PageReading>> {
    try {
      const value = JSON.parse(await readFile(join(this.directoryFor(id), "readings.json"), "utf8")) as { version: number; pages: PageReading[] };
      if (value.version !== READINGS_VERSION || !Array.isArray(value.pages)) return new Map();
      return new Map(value.pages.map(page => [page.page, page]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      // A damaged readings file only loses the transcriptions; the document stays usable.
      logEvent("document.readings_unreadable", { id });
      return new Map();
    }
  }
  /** Adds (or replaces) page readings; each batch is saved as soon as it is read. */
  async saveReadings(id: string, pages: PageReading[]): Promise<void> {
    if (!pages.length) return;
    await this.serial(id, async () => {
      await this.read(id);
      const current = await this.readings(id);
      for (const page of pages) current.set(page.page, page);
      await this.replace(id, "readings.json", { version: READINGS_VERSION, pages: [...current.values()].sort((a, b) => a.page - b.page) });
    });
  }
  /**
   * Pages a deep reading should cover: pages without a text layer and visual
   * pages, within the range, skipping pages already read unless `redo`.
   */
  async readingPlan(id: string, options: { range?: DocumentRange; password?: string; redo?: boolean }, signal: AbortSignal): Promise<ReadingPlan> {
    let document = await this.read(id);
    if (document.metadata.format !== "pdf") throw new AppError(400, "深度解析只適用於 PDF。");
    if (document.encrypted && !options.password) throw new AppError(423, "這份 PDF 有密碼保護，請先輸入密碼再深度解析。密碼只用於這次讀取，不會儲存。");
    const range = options.range;
    if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end > document.metadata.parsedUnits))
      throw new AppError(400, `深度解析範圍必須在第 1–${document.metadata.parsedUnits} 頁之間，且起點不大於終點。`);
    document = await this.withVisual(id, document, signal, options.password);
    const read = options.redo ? new Map<number, PageReading>() : await this.readings(id);
    const candidates = [...new Set([...(document.imageOnlyUnits || []), ...(visualOf(document) || []).map(item => item.page)])]
      .filter(page => page <= document.metadata.parsedUnits && inRange(page, range) && !read.has(page)).sort((a, b) => a - b);
    const chosen = candidates.slice(0, DOCUMENT_MAX_READING_PAGES);
    const texts = new Map(document.units.map(unit => [unit.number, unit.text]));
    return { name: document.metadata.name, pages: chosen.map(page => ({ page, text: texts.get(page) || "" })), more: candidates.length - chosen.length };
  }
  /** Renders pages for deep reading at a size where formulas and small labels stay legible. */
  async renderPages(id: string, pages: number[], signal: AbortSignal, password?: string): Promise<RenderedPage[]> {
    return this.renderer(join(this.directoryFor(id), "original.pdf"), { required: pages, candidates: [], limit: pages.length }, signal, { password, maxEdge: 1600 });
  }
  private directoryFor(id: string) {
    if (!UUID.test(id)) throw new AppError(400, "檔案識別碼格式不正確。");
    return join(this.directory, id);
  }
  async upload(name: string, input: Buffer | ((signal: AbortSignal) => Promise<Buffer>), externalSignal: AbortSignal, options: { password?: string } = {}): Promise<DocumentPreview> {
    const file = documentName(name);
    if (this.closed) throw new AppError(503, "檔案服務正在重新啟動，請稍後重試。");
    if (this.jobs.size >= 2) throw new AppError(429, "目前已有兩份檔案正在處理，請稍後再上傳。");
    const controller = new AbortController();
    let finished!: () => void;
    this.jobs.set(controller, new Promise<void>(resolve => { finished = resolve; }));
    const started = Date.now();
    const signal = AbortSignal.any([externalSignal, controller.signal, AbortSignal.timeout(240_000)]);
    let directory: string | undefined;
    try {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(input) ? input : await input(signal);
      signal.throwIfAborted();
      if (bytes.length > DOCUMENT_MAX_BYTES) throw tooLarge();
      if (!bytes.length) throw new AppError(422, "這份檔案是空的，請選擇有內容的檔案。");
      const id = randomUUID();
      directory = this.directoryFor(id);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, `original.${file.format}`);
      await writeFile(path, bytes, { mode: 0o600, flag: "wx", signal });
      const parsed = await this.parser(path, file.format, signal, options.password ? { password: options.password } : undefined);
      signal.throwIfAborted();
      if (!parsed.units.some(unit => unit.text.trim()) && !parsed.imageOnlyUnits?.length) throw new AppError(422, "無法擷取這份檔案的文字。若是掃描講義，請先進行 OCR 辨識後再上傳。");
      if (parsed.units.reduce((sum, unit) => sum + unit.text.length, 0) > DOCUMENT_MAX_CHARS) throw new AppError(422, "檔案解析結果超過文字上限，請將文件分成較小的檔案。");
      const metadata: DocumentMetadata = {
        id, name: file.name, format: file.format, mimeType: formats[file.format], size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        unitLabel: parsed.unitLabel, totalUnits: parsed.totalUnits, parsedUnits: parsed.parsedUnits,
        extractedChars: parsed.extractedChars, warnings: parsed.warnings.slice(0, 30).map(warning => warning.slice(0, 2_000)), createdAt: new Date().toISOString(),
      };
      const document: StoredDocument = { version: 1, metadata, units: parsed.units,
        ...(file.format === "pdf" ? { outline: (parsed.outline || []).slice(0, 500), imageOnlyUnits: (parsed.imageOnlyUnits || []).slice(0, 10_000), encrypted: !!parsed.encrypted } : {}) };
      // Inspection is optional: it gets what is left of the upload budget, and a
      // timeout only leaves it to be done later; the parsed file is still stored.
      const left = 240_000 - (Date.now() - started);
      if (file.format === "pdf" && left > 15_000) {
        const budget = AbortSignal.any([externalSignal, controller.signal, AbortSignal.timeout(Math.min(this.inspectTimeoutMs, left - 10_000))]);
        try {
          const metrics = await this.inspect(path, document, budget, options.password);
          if (metrics) document.metrics = metrics;
          else document.visualFailedAt = new Date().toISOString();
        } catch (error) {
          if (externalSignal.aborted || controller.signal.aborted) throw error;
          logEvent("document.inspect_deferred", { id, reason: error instanceof Error ? error.name : "unknown" });
        }
      }
      await writeFile(join(directory, "document.json"), JSON.stringify(document), { mode: 0o600, flag: "wx", signal });
      signal.throwIfAborted();
      return preview(document);
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (signal.aborted && signal.reason?.name === "TimeoutError") throw new AppError(408, "讀取檔案超過時間。請將大型文件拆成較小的檔案後重試。");
      throw error;
    } finally { this.jobs.delete(controller); finished(); }
  }
  private async read(id: string): Promise<StoredDocument> {
    const directory = this.directoryFor(id);
    try {
      const path = join(directory, "document.json");
      const info = await stat(path);
      if (info.size > 12_000_000) throw new Error("oversized document metadata");
      const result = JSON.parse(await readFile(path, "utf8")) as StoredDocument;
      if (result.version !== 1 || result.metadata?.id !== id || !Object.hasOwn(formats, result.metadata.format) || !Array.isArray(result.units)) throw new Error("invalid stored document");
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw unavailable();
      throw new AppError(500, "無法讀取已儲存的檔案內容，請重新上傳這份文件。");
    }
  }
  /** A file stored before visual analysis is inspected in the background; the preview never waits for it. */
  async get(id: string): Promise<DocumentPreview> {
    const document = await this.read(id);
    if (document.metadata.format === "pdf" && !document.metrics && !document.encrypted && !this.background.has(id) && !this.closed && this.background.size < 4) {
      const controller = new AbortController();
      this.background.set(id, controller);
      const signal = AbortSignal.any([controller.signal, this.stopping.signal]);
      this.queue = this.queue.then(() => signal.aborted || this.deleting.has(id) ? undefined : this.withVisual(id, document, signal))
        .catch(() => undefined).finally(() => this.background.delete(id));
    }
    return preview(document, await this.readings(id));
  }
  async text(id: string): Promise<string> { return plainText(await this.read(id)); }
  async file(id: string): Promise<{ path: string; name: string; mimeType: string }> {
    const document = await this.read(id);
    const path = join(this.directoryFor(id), `original.${document.metadata.format}`);
    try { await stat(path); } catch { throw unavailable(); }
    return { path, name: document.metadata.name, mimeType: document.metadata.mimeType };
  }
  acquire(id: string): () => void {
    this.directoryFor(id);
    if (this.deleting.has(id)) throw new AppError(409, "這份檔案正在移除，請重新上傳後再產生解說。");
    this.leases.set(id, (this.leases.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.leases.get(id) || 1) - 1;
      if (remaining > 0) this.leases.set(id, remaining);
      else this.leases.delete(id);
    };
  }
  /**
   * Removes an unused upload. Work that may be stopped for it (a deep reading)
   * is listed by `stoppable` and stopped by `stop`; any other use refuses the
   * removal before anything is stopped. While stopping, the file takes no new
   * leases, and `isReferenced` is asked again at the end, so a lesson that was
   * saved meanwhile keeps its file.
   */
  async remove(id: string, options: { stoppable?: () => number; stop?: () => Promise<void>; isReferenced?: () => boolean } = {}): Promise<void> {
    const directory = this.directoryFor(id);
    if (this.deleting.has(id)) throw new AppError(409, "這份檔案正在移除，請稍後再試。");
    if ((this.leases.get(id) || 0) > (options.stoppable?.() ?? 0)) throw new AppError(409, "這份檔案正在產生解說，請等工作完成後再移除。");
    this.deleting.add(id);
    try {
      this.background.get(id)?.abort();
      if (this.leases.has(id)) await options.stop?.();
      if (this.leases.has(id)) throw new AppError(409, "這份檔案正在產生解說，請等工作完成後再移除。");
      if (options.isReferenced?.()) throw new AppError(409, "這份檔案已用於筆記，不能從上傳區移除。請先刪除相關筆記。");
      // A missing file is reported; one that can no longer be read can still be removed.
      await this.read(id).catch(error => { if (error instanceof AppError && error.status === 404) throw error; });
      await this.serial(id, () => rm(directory, { recursive: true, force: true }));
    } finally { this.deleting.delete(id); }
  }
  async sourceForDocument(id: string, question: string, signal: AbortSignal, range?: DocumentRange): Promise<Source> {
    return (await this.lessonInput(id, { question, range }, signal)).source;
  }
  /** Selects the lesson source text and, when requested, page images of the chosen PDF range. */
  async lessonInput(id: string, options: DocumentLessonOptions, signal: AbortSignal,
    onStage?: (message: string) => void): Promise<{ source: Source; images: RenderedPage[] }> {
    signal.throwIfAborted();
    const stored = await this.read(id);
    signal.throwIfAborted();
    const metadata = stored.metadata;
    const label = labels[metadata.unitLabel];
    const range = options.range;
    if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end > metadata.parsedUnits))
      throw new AppError(400, `解說範圍必須在第 1–${metadata.parsedUnits} ${label}之間，且起點不大於終點。`);
    const withVisual = options.visual ? await this.withVisual(id, stored, signal, options.password) : stored;
    // Read pages stand in for their text layer (and scans gain text), so choosing
    // pages by the question also finds what figures and formulas show.
    const readings = new Map([...(await this.readings(id))].filter(([page]) => page <= metadata.parsedUnits));
    const units = new Map(withVisual.units.map(unit => [unit.number, unit]));
    // A blank read page keeps whatever text layer it had (often none).
    for (const [page, reading] of readings) if (!emptyReading(reading)) units.set(page, { number: page, text: readingText(reading) });
    const document: StoredDocument = { ...withVisual, units: [...units.values()].sort((a, b) => a.number - b.number) };
    const selected = selectContext(document, options.question, range);
    // A page whose reading came back blank is still shown as an image: the model may simply have missed it.
    const transcribed = (page: number) => readings.has(page) && !emptyReading(readings.get(page)!);
    const imageOnly = (document.imageOnlyUnits || []).filter(number => inRange(number, range) && !transcribed(number));
    const notes: string[] = [];
    let images: RenderedPage[] = [];
    if (options.visual && metadata.format === "pdf") {
      if (document.encrypted && !options.password) notes.push("這份 PDF 有密碼保護，這次未提供密碼，因此沒有附上頁面影像。");
      else {
        const chosen = new Set(selected.blocks.map(block => block.number));
        // The image budget goes to unread visual pages the lesson uses, most visual first;
        // without an analysis the renderer chooses by itself.
        const visual = visualOf(document)?.filter(item => chosen.has(item.page) && !transcribed(item.page));
        onStage?.("正在把含圖表或掃描內容的頁面轉成影像。");
        images = await this.renderer(join(this.directoryFor(id), "original.pdf"),
          visual
            ? { required: imageOnly, candidates: visual.map(item => item.page), limit: DOCUMENT_MAX_VISUAL_PAGES, ranked: true }
            : { required: imageOnly, candidates: [...chosen].filter(page => !transcribed(page)), limit: DOCUMENT_MAX_VISUAL_PAGES },
          signal, { password: options.password });
        signal.throwIfAborted();
        const skipped = imageOnly.filter(number => !images.some(image => image.page === number));
        if (skipped.length) notes.push(`範圍內另有 ${skipped.length} 頁沒有文字層，超過單次 ${DOCUMENT_MAX_VISUAL_PAGES} 頁影像上限而未閱讀。`);
        const unseen = (visual || []).filter(item => !images.some(image => image.page === item.page) && !imageOnly.includes(item.page));
        if (unseen.length) notes.push(`這次使用的頁面中另有 ${unseen.length} 頁含圖表或公式（第 ${unitRanges(unseen.map(item => item.page).sort((a, b) => a - b))} 頁），超過單次 ${DOCUMENT_MAX_VISUAL_PAGES} 頁影像上限，只依文字層；可先深度解析這份檔案。`);
      }
    } else if (imageOnly.length) notes.push(`範圍內有 ${imageOnly.length} 頁沒有文字層，這次未附頁面影像，因此未閱讀這些頁面。`);
    const blocks = [...selected.blocks];
    for (const image of images) if (!blocks.some(block => block.number === image.page))
      blocks.push({ number: image.page, text: "（此頁沒有可擷取的文字層，內容請依附上的同頁影像閱讀。）" });
    blocks.sort((a, b) => a.number - b.number);
    if (!blocks.length) throw new AppError(422, imageOnly.length
      ? "所選範圍的頁面沒有文字層。請開啟「附上頁面影像」並使用 Codex、Claude Code 或 Antigravity，或選擇其他範圍。"
      : "所選範圍沒有可擷取的文字，請選擇其他範圍。");
    const selectedUnits = blocks.map(block => block.number);
    // Only pages this lesson actually uses, and that had something to transcribe.
    const readPages = selectedUnits.filter(page => readings.has(page) && !emptyReading(readings.get(page)!));
    const incomplete = selected.partial || metadata.parsedUnits < metadata.totalUnits || !!range;
    const scope = [
      `檔案「${metadata.name}」：共 ${metadata.totalUnits} ${label}，已解析 ${metadata.parsedUnits} ${label}，擷取 ${metadata.extractedChars.toLocaleString("en-US")} 字。`,
      range ? `依使用者指定只解說第 ${range.start}–${range.end} ${label}。` : "",
      `此次解說使用 ${selectedUnits.length} ${label}（${unitRanges(selectedUnits)}）。`,
      selected.partial ? "已依提問與範圍內前、中、後段選取節錄；不能視為完整逐頁閱讀。" : "此次解說使用範圍內全部已擷取的文字。",
      images.length
        ? `另附 ${images.length} 頁頁面影像（第 ${unitRanges(images.map(image => image.page))} 頁），供模型閱讀圖表、公式與掃描內容；影像只用於這次解說，未保存。`
        : "",
      readPages.length
        ? `第 ${unitRanges(readPages)} 頁使用深度解析的模型轉寫（含圖表與公式說明），可能有辨識錯誤，重要數值請對照原檔。`
        : "",
      !images.length && !readPages.length ? "僅解析可擷取的文字，未理解圖片、圖表的視覺內容。" : "",
      ...notes,
      metadata.warnings.length ? `解析提醒：${currentWarnings(metadata.warnings).join("；")}` : "",
    ].filter(Boolean).join("");
    const content = blocks.map(block => `${marker(metadata.unitLabel, block.number)}\n${block.text}`).join("\n\n");
    return {
      source: { kind: "document", label: metadata.name, content, scope: scope.slice(0, 20_000), truncated: incomplete || metadata.warnings.length > 0, fetchedAt: metadata.createdAt, document: { ...metadata, selectedUnits } },
      images,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stopping.abort(new DOMException("文件服務已停止", "AbortError"));
    await this.queue;
    const pending = [...this.jobs.values()];
    for (const controller of this.jobs.keys()) controller.abort(new DOMException("文件服務已停止", "AbortError"));
    await Promise.all(pending);
  }
}

const rawUpload = raw({ type: "application/octet-stream", limit: DOCUMENT_MAX_BYTES, inflate: false });
function readUpload(req: Request, res: Response, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      // Stop a timed-out raw-body reader before releasing the admission slot.
      // Flush the timeout response before closing this connection when possible.
      if (!req.destroyed && !res.headersSent) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
        res.status(signal.reason?.name === "TimeoutError" ? 408 : 503).json({ error: signal.reason?.name === "TimeoutError" ? "讀取檔案超過時間，請重新上傳。" : "檔案上傳已中斷，請稍後重試。" });
      } else if (!req.destroyed) req.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    rawUpload(req, res, error => {
      signal.removeEventListener("abort", abort);
      if (error) {
        reject((error as { type?: string }).type === "entity.too.large" ? tooLarge() : new AppError(400, "檔案上傳中斷或格式不正確，請重新上傳。"));
      } else if (!Buffer.isBuffer(req.body)) reject(new AppError(400, "請以檔案上傳方式提供內容。"));
      else resolve(req.body);
    });
  });
}
export function createDocumentRouter(service: DocumentService, isReferenced: (id: string) => boolean,
  hooks: {
    /** Leases held by work that may be stopped to remove an unused upload (deep readings). */
    stoppable?: (id: string) => number;
    /** Stops that work and waits for it to let go of the file. */
    stop?: (id: string) => Promise<void>;
  } = {}) {
  const router = Router();
  router.post("/documents", async (req, res) => {
    if (!req.is("application/octet-stream") || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) throw new AppError(415, "請使用檔案上傳，暫不接受壓縮的 HTTP 上傳內容。");
    if (Number(req.headers["content-length"] || 0) > DOCUMENT_MAX_BYTES) throw tooLarge();
    let name: string;
    let password: string | undefined;
    try {
      name = decodeURIComponent(req.get("X-Document-Name") || "");
      // Sent only when retrying a password-protected PDF; passed to the decoder over IPC, never stored.
      const header = req.get("X-Document-Password");
      password = header ? decodeURIComponent(header) : undefined;
    } catch { throw new AppError(400, "檔名或密碼格式不正確，請重新選擇檔案。"); }
    if (password !== undefined && (!password || password.length > 256)) throw new AppError(400, "PDF 密碼長度必須為 1–256 字元。");
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new DOMException("上傳已取消", "AbortError")); };
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const document = await service.upload(name, signal => readUpload(req, res, signal), controller.signal, { password });
      if (!controller.signal.aborted) res.status(201).json(document);
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });
  router.get("/documents/:id", async (req, res) => { res.json(await service.get(req.params.id)); });
  router.get("/documents/:id/text", async (req, res) => { res.type("text/plain").send(await service.text(req.params.id)); });
  router.get("/documents/:id/file", async (req, res, next) => {
    const file = await service.file(req.params.id);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", file.mimeType);
    // Private to this server; revalidated with ETag / Last-Modified instead of re-downloading.
    res.setHeader("Cache-Control", "private, no-cache");
    res.download(file.path, file.name, { cacheControl: false }, error => { if (error) next(error); });
  });
  router.delete("/documents/:id", async (req, res) => {
    const id = req.params.id;
    if (isReferenced(id)) throw new AppError(409, "這份檔案已用於筆記，不能從上傳區移除。請先刪除相關筆記。");
    await service.remove(id, { stoppable: () => hooks.stoppable?.(id) ?? 0, stop: () => hooks.stop?.(id) ?? Promise.resolve(), isReferenced: () => isReferenced(id) });
    res.status(204).end();
  });
  return router;
}
