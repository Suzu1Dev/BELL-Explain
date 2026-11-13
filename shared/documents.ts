export type DocumentFormat = "pdf" | "docx" | "pptx" | "txt" | "md";
export const DOCUMENT_MAX_MB = 50;
export const DOCUMENT_MAX_BYTES = DOCUMENT_MAX_MB * 1024 * 1024;
/** Stored extracted text; the model receives at most DOCUMENT_CONTEXT_CHARS per lesson. */
export const DOCUMENT_MAX_CHARS = 1_500_000;
/** PDF pages read at upload. */
export const DOCUMENT_MAX_UNITS = 1_000;
export const DOCUMENT_MAX_SLIDES = 200;
export const DOCUMENT_CONTEXT_CHARS = 42_000;
/** Page images sent to the model for one lesson. */
export const DOCUMENT_MAX_VISUAL_PAGES = 8;
/** Pages sent to the model together in one deep-reading call. */
export const DOCUMENT_READING_BATCH = 4;
/** Pages one deep-reading run may cover; more need another run. */
export const DOCUMENT_MAX_READING_PAGES = 120;
export const DOCUMENT_ACCEPT = ".pdf,.docx,.pptx,.txt,.md";

export interface DocumentMetadata {
  id: string;
  name: string;
  format: DocumentFormat;
  mimeType: string;
  size: number;
  sha256: string;
  unitLabel: "page" | "slide" | "section";
  totalUnits: number;
  parsedUnits: number;
  extractedChars: number;
  warnings: string[];
  createdAt: string;
}

/** A PDF bookmark resolved to the page span it covers. */
export interface DocumentOutlineEntry { title: string; depth: number; start: number; end: number; }
/** Inclusive unit range (pages, slides or sections) chosen for one lesson. */
export interface DocumentRange { start: number; end: number; }

export interface DocumentPreview extends DocumentMetadata {
  preview: string;
  outline: DocumentOutlineEntry[];
  /** PDF pages without a text layer, such as scans; they can only be read as page images. */
  imageOnlyUnits: number[];
  /** The PDF opened with a password. The password itself is never stored. */
  encrypted: boolean;
  /**
   * PDF pages whose content is partly visual (figures, formulas drawn as graphics,
   * scans), most visual first; absent until the file has been inspected.
   */
  visualUnits?: number[];
  /** Pages already read by the model (deep reading), whose transcription replaces the text layer. */
  readUnits: number[];
}
/** What a model read on one page: the text in reading order (formulas as LaTeX) and its visuals. */
export interface PageReading {
  page: number;
  text: string;
  visuals: Array<{ kind: "chart" | "diagram" | "table" | "formula" | "photo" | "other"; description: string }>;
  at: string;
}

export interface DocumentSource extends DocumentMetadata {
  selectedUnits: number[];
}
