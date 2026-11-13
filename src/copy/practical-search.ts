import strings from "./practical-search-strings.json" with { type: "json" };

export type PracticalSearchLocale = "zh-TW" | "en";
export type PracticalExampleCopy = (typeof strings)["zh-TW"]["practicalExample"];
export type SemanticSearchCopy = (typeof strings)["zh-TW"]["semanticSearch"];
export type PageReferencesCopy = (typeof strings)["zh-TW"]["pageReferences"];

export function resolvePracticalSearchLocale(): PracticalSearchLocale {
  if (typeof window === "undefined") return "zh-TW";
  const param = new URLSearchParams(window.location.search).get("lang");
  if (param === "en") return "en";
  if (param === "zh-TW") return "zh-TW";
  if (typeof document !== "undefined" && document.documentElement?.lang?.toLowerCase().startsWith("en")) return "en";
  return "zh-TW";
}

function bundle(locale = resolvePracticalSearchLocale()) {
  return strings[locale];
}

export function practicalExampleCopy(locale = resolvePracticalSearchLocale()): PracticalExampleCopy {
  return bundle(locale).practicalExample;
}

export function semanticSearchCopy(locale = resolvePracticalSearchLocale()): SemanticSearchCopy {
  return bundle(locale).semanticSearch;
}

export function pageReferencesCopy(locale = resolvePracticalSearchLocale()): PageReferencesCopy {
  return bundle(locale).pageReferences;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export function formatPracticalLineLabel(startLine: number, endLine: number, locale = resolvePracticalSearchLocale()): string {
  const copy = practicalExampleCopy(locale);
  return startLine === endLine
    ? fill(copy.lineSingle, { line: startLine })
    : fill(copy.lineRange, { startLine, endLine });
}

export function formatPracticalCurrentFocus(lines: string, locale = resolvePracticalSearchLocale()): string {
  return fill(practicalExampleCopy(locale).currentFocus, { lines });
}

export function formatPracticalStepButtonAria(step: number, lines: string, locale = resolvePracticalSearchLocale()): string {
  return fill(practicalExampleCopy(locale).stepButtonAria, { step, lines });
}

export function formatSimilarityBadge(score: number | string, locale = resolvePracticalSearchLocale()): string {
  const formatted = typeof score === "number" ? score.toFixed(2) : score;
  return fill(semanticSearchCopy(locale).similarityBadge, { score: formatted });
}

export function formatAnnotationTitleSuffix(term: string, locale = resolvePracticalSearchLocale()): string {
  return fill(semanticSearchCopy(locale).annotationTitleSuffix, { term });
}

export function formatDocumentTitleSuffix(name: string, locale = resolvePracticalSearchLocale()): string {
  return fill(semanticSearchCopy(locale).documentTitleSuffix, { name });
}

const INDEXED_ANNOTATION_PREFIX = strings["zh-TW"].semanticSearch.annotationTitleSuffix.replace("{term}", "");
const INDEXED_DOCUMENT_PREFIX = strings["zh-TW"].semanticSearch.documentTitleSuffix.replace("{name}", "");
const INDEXED_FALLBACK_WARNING = strings["zh-TW"].semanticSearch.semanticFallbackWarning;

export interface ParsedLessonChunkTitle {
  baseTitle: string;
  suffix: string | null;
}

export function parseLessonChunkTitle(title: string, locale = resolvePracticalSearchLocale()): ParsedLessonChunkTitle {
  const annotationAt = title.indexOf(INDEXED_ANNOTATION_PREFIX);
  const documentAt = title.indexOf(INDEXED_DOCUMENT_PREFIX);
  const useAnnotation = annotationAt >= 0 && (documentAt < 0 || annotationAt <= documentAt);
  const useDocument = documentAt >= 0 && (annotationAt < 0 || documentAt < annotationAt);
  if (useAnnotation) {
    const baseTitle = title.slice(0, annotationAt);
    const term = title.slice(annotationAt + INDEXED_ANNOTATION_PREFIX.length);
    return { baseTitle, suffix: formatAnnotationTitleSuffix(term, locale) };
  }
  if (useDocument) {
    const baseTitle = title.slice(0, documentAt);
    const name = title.slice(documentAt + INDEXED_DOCUMENT_PREFIX.length);
    return { baseTitle, suffix: formatDocumentTitleSuffix(name, locale) };
  }
  return { baseTitle: title, suffix: null };
}

export function localizeSemanticWarning(warning: string | undefined, locale = resolvePracticalSearchLocale()): string | undefined {
  if (!warning) return warning;
  if (warning === INDEXED_FALLBACK_WARNING) {
    return semanticSearchCopy(locale).semanticFallbackWarning;
  }
  return warning;
}

export function formatOpenInPdfTitle(page: number, locale = resolvePracticalSearchLocale()): string {
  return fill(pageReferencesCopy(locale).openInPdfTitle, { page });
}
