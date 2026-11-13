import { Fragment, useEffect, useState, type ReactNode } from "react";
import { findBold, findInline, proseBlocks, type BoldSpan, type CodeSpan, type MathSpan } from "../../shared/math";
import { explainMathFallback } from "../copy/explain-client-errors";
// KaTeX's stylesheet ships with the app: the KaTeX chunk is imported by URL (see loadMath),
// so no stylesheet would come with it.
import "katex/dist/katex.min.css";
import "./math-text.css";

type Katex = typeof import("katex").default;

type InlineSpan = (MathSpan & { kind?: "math" }) | (CodeSpan & { kind: "code" });
/**
 * `text` from `from` to `to` with its formulas typeset, its `code spans` set as code (their
 * text from `code`), `**bold**` spans set as `<strong>`, and the text between them passed to
 * `plain`. Delimiters carry their source in data-math-source, so reading annotations quote
 * the note's own text, backticks, `**` and LaTeX included.
 */
export function mathRange(text: string, spans: InlineSpan[], from: number, to: number, plain: (value: string) => ReactNode,
  code: (span: CodeSpan) => ReactNode = span => span.code, bolds: BoldSpan[] = []): ReactNode {
  const atoms = (start: number, end: number): ReactNode => {
    const parts: ReactNode[] = [];
    let at = start;
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue;
      if (span.start > at) parts.push(<Fragment key={at}>{plain(text.slice(at, span.start))}</Fragment>);
      const source = text.slice(span.start, span.end);
      if (span.kind === "code") {
        parts.push(<code key={span.start} className="inline-code" data-math-source={source}>{code(span)}</code>);
        at = span.end;
        continue;
      }
      const formula = <Formula key={span.start} source={source} tex={span.tex} display={span.display} />;
      const closing = span.display ? "" : text.slice(span.end, end).match(/^[，。、；：？！」』）”’]+/)?.[0] ?? "";
      parts.push(closing
        ? <span key={span.start} className="math-glue" style={{ whiteSpace: "nowrap" }}>{formula}{plain(closing)}</span>
        : formula);
      at = span.end + closing.length;
    }
    if (!parts.length) return plain(text.slice(start, end));
    if (at < end) parts.push(<Fragment key={at}>{plain(text.slice(at, end))}</Fragment>);
    return parts;
  };
  if (!bolds.some(bold => bold.end > from && bold.start < to)) return atoms(from, to);
  const out: ReactNode[] = [];
  let cursor = from;
  for (const bold of bolds) {
    if (bold.end <= from || bold.start >= to) continue;
    if (bold.start > cursor) out.push(<Fragment key={`p-${cursor}`}>{atoms(cursor, bold.start)}</Fragment>);
    const innerFrom = Math.max(from, bold.start + 2);
    const innerTo = Math.min(to, bold.end - 2);
    if (innerTo > innerFrom) {
      out.push(<strong key={`b-${Math.max(from, bold.start)}`}>
        {from <= bold.start && <span data-math-source="**" />}
        {atoms(innerFrom, innerTo)}
        {to >= bold.end && <span data-math-source="**" />}
      </strong>);
    } else {
      out.push(<span key={`bm-${Math.max(from, bold.start)}`} data-math-source="**" />);
    }
    cursor = Math.min(to, bold.end);
  }
  if (cursor < to) out.push(<Fragment key={`p-${cursor}`}>{atoms(cursor, to)}</Fragment>);
  return out;
}

/** Prose with LaTeX formulas, `code` and `**bold**`; text with none of them renders as plain text. */
export default function MathText({ text }: { text: string }) {
  const spans = findInline(text);
  return <>{mathRange(text, spans, 0, text.length, value => value, undefined, findBold(text, spans))}</>;
}

/** Block-level prose (`p`, `- ` / `1. ` lists, `##`–`####` subheadings, `> ` quotes). */
export function ProseBlocks({
  text,
  renderLine = line => <MathText text={line} />,
  paragraphClass,
  listClass,
  headingClass,
  quoteClass,
}: {
  text: string;
  renderLine?: (line: string) => ReactNode;
  paragraphClass?: string;
  listClass?: string;
  headingClass?: string;
  quoteClass?: string;
}) {
  return <>
    {proseBlocks(text).map((block, index) => {
      if (block.kind === "ul") return <ul key={index} className={listClass}>{block.items.map((item, j) => <li key={j}>{renderLine(item)}</li>)}</ul>;
      if (block.kind === "ol") return <ol key={index} className={listClass} start={block.start === 1 ? undefined : block.start}>{block.items.map((item, j) => <li key={j}>{renderLine(item)}</li>)}</ol>;
      if (block.kind === "heading") return <h3 key={index} className={headingClass}>{renderLine(block.text)}</h3>;
      if (block.kind === "quote") return <blockquote key={index} className={quoteClass}>{block.lines.map((line, j) => <p key={j}>{renderLine(line)}</p>)}</blockquote>;
      return <p key={index} className={paragraphClass}>{renderLine(block.text)}</p>;
    })}
  </>;
}

// KaTeX's module. The build points this at KaTeX's chunk (vite.config.ts); Node and the dev server use the source.
const KATEX = new URL("../lib/katex.ts", import.meta.url).href;
// Pauses before each retry of a failed download: enough for a dropped connection to come
// back. A chunk gone after a redeploy only comes back with a reload.
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
let katex: Katex | undefined;
let loading: Promise<boolean> | undefined;
let failures = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
/** Formulas on the page that wait for KaTeX: each attempt shows them how it went. */
const waiting = new Set<() => void>();

/**
 * Fetches KaTeX and its fonts the first time a formula is shown. A failed download is not
 * kept: the next call tries again. A browser keeps a failed import() of a URL for the life
 * of the page, so each retry asks for the chunk under a new URL.
 */
export function loadMath(): Promise<boolean> {
  return loading ??= import(/* @vite-ignore */ failures ? `${KATEX}?retry=${failures}` : KATEX).then(
    (module: typeof import("../lib/katex")) => { katex = module.default; return true; },
    () => { loading = undefined; failures++; retryLater(); return false; },
  ).finally(() => { for (const show of waiting) show(); });
}
/** While formulas wait, retries a failed download after a pause, a few times. */
function retryLater() {
  if (retry === undefined && !loading && failures && failures <= RETRY_MS.length && waiting.size)
    retry = setTimeout(() => { retry = undefined; void loadMath(); }, RETRY_MS[failures - 1]);
}
/** Why a formula shows its source while KaTeX is missing. */
const unloaded = () => failures <= RETRY_MS.length ? explainMathFallback().katexRetryingTitle : explainMathFallback().katexReloadTitle;

const cache = new Map<string, string | null>();
function typeset(engine: Katex, tex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      // trust stays off (no \href or \html…), and \rule cannot draw a page-sized box. maxSize
      // caps only positive sizes: math-text.css keeps negative kerns and \llap inside the formula.
      html = engine.renderToString(tex, { displayMode: display, output: "htmlAndMathml", throwOnError: true, strict: "ignore", maxSize: 20, maxExpand: 500 });
    } catch {
      html = null;
    }
    if (cache.size >= 1000) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** Whether LaTeX that KaTeX rejected was meant as a formula (\frac{1}{, x^{2) or is code that only looks like one (\d+, ^a$). */
const meantAsTex = (tex: string) => /\\[a-zA-Z]{2,}|[\^_]/.test(tex) && !/\\[dDwWsSbB](?![a-zA-Z])|(?<!\\)\$/.test(tex);

/**
 * One formula. It carries its LaTeX source in data-math-source, which is what
 * reading annotations count and quote instead of KaTeX's glyphs. Until KaTeX
 * has loaded, or when KaTeX rejects it, the source itself is shown; only LaTeX
 * with a mistake is marked as such, code is left as plain text.
 */
export function Formula({ source, tex, display }: { source: string; tex: string; display: boolean }) {
  const [, update] = useState(0);
  useEffect(() => {
    if (katex) return;
    const show = () => update(count => count + 1);
    waiting.add(show);
    // The first formula starts the download; after a failure, only the retries try again.
    if (failures) retryLater();
    else void loadMath();
    return () => {
      waiting.delete(show);
      if (!waiting.size) { clearTimeout(retry); retry = undefined; }
    };
  }, []);
  const html = katex ? typeset(katex, tex, display) : null;
  if (html === null) {
    const invalid = katex && meantAsTex(tex);
    const missing = !katex && failures > 0;
    return <span className={invalid ? "math-source math-invalid" : missing ? "math-source math-unloaded" : "math-source"} data-math-source={source}
      title={invalid ? explainMathFallback().invalidLatexTitle : missing ? unloaded() : undefined}>{source}</span>;
  }
  return <span className={display ? "math math-display" : "math"} data-math-source={source} dangerouslySetInnerHTML={{ __html: html }} />;
}
