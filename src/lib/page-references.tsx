import type { ReactNode } from "react";
import { formatOpenInPdfTitle } from "../copy/practical-search";

/** Matches Chinese page citations (single pages and spans) and "p. 12" / "pp. 3-4" / "page 9". */
const PAGE_REFERENCE = /\u7b2c\s*(\d{1,5})(?:\s*[–—\-~\uff5e\u81f3\u5230]\s*(?:\u7b2c\s*)?(\d{1,5}))?\s*\u9801|\b(?:pp?\.|pages?)\s*(\d{1,5})(?:\s*[–—-]\s*(\d{1,5}))?/gi;

export interface PageRange { start: number; end: number; }
/** Page ranges cited in the text as written, clamped to the document and in reading order of their start. */
export function citedRanges(text: string, pages: number): PageRange[] {
  const ranges = new Map<string, PageRange>();
  for (const match of text.matchAll(PAGE_REFERENCE)) {
    const start = Number(match[1] || match[3]);
    const end = Math.min(pages, Math.max(start, Number(match[2] || match[4] || start)));
    if (start >= 1 && start <= pages) ranges.set(`${start}-${end}`, { start, end });
  }
  return [...ranges.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}
/** Every page the ranges cover, or none when they cover more than `limit` pages to stay a useful marker. */
export function markedPages(ranges: PageRange[], limit = 12): number[] {
  const pages = new Set<number>();
  for (const range of ranges) for (let page = range.start; page <= range.end && pages.size <= limit; page++) pages.add(page);
  return pages.size > limit ? [] : [...pages].sort((a, b) => a - b);
}

/**
 * Turns page citations into links that open the page beside the explanation.
 * The text content is unchanged, so reading-annotation offsets still match.
 */
export function linkPages(text: string, pages: number, onPage: (page: number) => void): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PAGE_REFERENCE)) {
    const page = Number(match[1] || match[3]);
    if (!(page >= 1 && page <= pages)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<span key={match.index} className="page-ref" role="link" tabIndex={0} title={formatOpenInPdfTitle(page)}
      onClick={event => {
        event.stopPropagation();
        // Selecting text to ask about it must not jump the PDF.
        if (window.getSelection()?.isCollapsed !== false) onPage(page);
      }}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); onPage(page); } }}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
