/** A formula in a string: `text.slice(start, end)` is its source, delimiters included. */
export interface MathSpan { start: number; end: number; tex: string; display: boolean; }
/**
 * A `code span` in prose: `text.slice(start, end)` is its source, backticks included,
 * and `code` what it shows (one space just inside both backticks dropped, as Markdown does).
 */
export interface CodeSpan { start: number; end: number; code: string; }
/** Where a code span's text, what it shows, starts and ends in `text`: inside its backticks. */
export function codeText(span: CodeSpan): [number, number] {
  const fence = (span.end - span.start - span.code.length) / 2;
  return [span.start + fence, span.end - fence];
}

// Regexes and shell commands quoted in prose without backticks only look like formulas.
// Glued to a word or a quote: f\(x\), grep '\[ERROR\]', echo "\(1+2\)".
const GLUED_BEFORE = /[A-Za-z'"]/;
const GLUED_AFTER = /['"]/;
// Quotes and regex wildcards never appear in a formula: \( -name '*.js' \), s/\(.*\)/. An ellipsis
// (1+2+...+n) is not a wildcard, and quotes in \text{"abc"} are text inside the formula.
const CODE_INSIDE = /"|(?:^|\s)'|(?<!\.)\.[*+?]|\[\^/;
const TEXT = /\\(?:text[a-z]*|mbox)\s*\{[^{}]*\}/g;
// Letters, digits, symbols, commands and the operators / * ! - (總數 - 已完成, 總延遲 / 請求數).
const MATH_CHAR = /[\p{L}\p{N}\p{S}\\/*!-]/u;
/** Code, or nothing but Chinese text and punctuation (用 \( 和 \) 包起來), rather than math. */
function readsAsCode(text: string, start: number, end: number, tex: string): boolean {
  return GLUED_BEFORE.test(text[start - 1] ?? "") || GLUED_AFTER.test(text[end] ?? "") || CODE_INSIDE.test(tex.replace(TEXT, ""))
    || !MATH_CHAR.test(tex.replace(/\p{Script=Han}/gu, ""));
}

/** Where the line holding `at` ends. */
const lineEnd = (text: string, at: number) => { const end = text.indexOf("\n", at); return end < 0 ? text.length : end; };
/** Whether `text` between `from` and `to` is only spaces, on one line. */
const blank = (text: string, from: number, to: number) => /^[^\S\n]*$/.test(text.slice(from, to));
/** Whether only spaces come before `at` on its line. */
const startsLine = (text: string, at: number) => blank(text, text.lastIndexOf("\n", at - 1) + 1, at);

/**
 * Finds the formulas in `text`, and its code spans into `codes`. A code span closes on
 * its own line, as each line of a body is a paragraph of its own; only a code block,
 * three or more backticks opening one line and closing another, runs over lines.
 */
function scan(text: string, codes: CodeSpan[] = []): MathSpan[] {
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      // A code span closes at the next run of exactly as many backticks.
      let run = i;
      while (text[run] === "`") run++;
      const fence = run - i;
      const next = (from: number) => {
        let close = text.indexOf("`".repeat(fence), from);
        while (close >= 0 && text[close + fence] === "`") {
          let after = close;
          while (text[after] === "`") after++;
          close = text.indexOf("`".repeat(fence), after);
        }
        return close;
      };
      let close = next(run);
      if (close > lineEnd(text, run)) {
        if (fence < 3 || !startsLine(text, i)) close = -1;
        else while (close >= 0 && !startsLine(text, close)) close = next(close + fence);
      }
      if (close < 0) { i = run; continue; }
      const inner = text.slice(run, close);
      const code = /^ .*\S.* $/s.test(inner) ? inner.slice(1, -1) : inner;
      if (code.trim()) codes.push({ start: i, end: close + fence, code });
      i = close + fence;
      continue;
    }
    if (text[i] !== "\\") { i++; continue; }
    const open = text[i + 1];
    if (open === "(" || open === "[") {
      const closer = open === "(" ? ")" : "]";
      let end = -1;
      for (let j = i + 2; j < text.length; j++) {
        if (text[j] === "\\") {
          if (text[j + 1] === closer) { end = j; break; }
          // A second opener before any closer: the first one was not a delimiter.
          if (text[j + 1] === open) break;
          j++;
        } else if (text[j] === "\n" && (open === "(" || text[j + 1] === "\n")) break;
      }
      const tex = end < 0 ? "" : text.slice(i + 2, end);
      // Over several lines, \[ and \] stand on lines of their own: prose that mentions
      // both brackets (寫成 \[ … 寫成 \]) is not a formula.
      const alone = !tex.includes("\n") || (blank(text, text.lastIndexOf("\n", i - 1) + 1, i) && blank(text, end + 2, lineEnd(text, end + 2)));
      if (tex.trim() && alone) {
        if (!readsAsCode(text, i, end + 2, tex)) spans.push({ start: i, end: end + 2, tex, display: open === "[" });
        i = end + 2;
        continue;
      }
    }
    i += 2;
  }
  return spans;
}

/**
 * Finds \( … \) and \[ … \] formulas. $ is never a delimiter: notes are full of
 * shell variables and prices. A backslash-escaped delimiter (\\( is a backslash,
 * then "(") and anything inside `code spans` stay text, as do unclosed or empty
 * delimiters and spans that read as code; inline math ends at a line break and
 * display math at a blank line.
 */
export const findMath = (text: string) => scan(text);
/** Formulas and `code spans` of prose, in order: what a prose field typesets or sets as code. */
export function findInline(text: string): Array<(MathSpan & { kind: "math" }) | (CodeSpan & { kind: "code" })> {
  const codes: CodeSpan[] = [];
  const math = scan(text, codes);
  return [...math.map(span => ({ ...span, kind: "math" as const })), ...codes.map(span => ({ ...span, kind: "code" as const }))]
    .sort((a, b) => a.start - b.start);
}

/** The non-empty lines of `text`, as a body is split into paragraphs, except that a display formula spanning lines stays whole. */
export function mathLines(text: string): string[] {
  const spans = scan(text);
  const lines: string[] = [];
  let start = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    if (spans.some(span => at > span.start && at < span.end)) continue;
    lines.push(text.slice(start, at));
    start = at + 1;
  }
  lines.push(text.slice(start));
  return lines.filter(Boolean);
}

const ASCII_WORD = /[A-Za-z0-9_]/;
export interface BoldSpan { start: number; end: number; }

/**
 * Single-line `**bold**` spans in prose, outside `code` and formulas. Single `*` (`A*`, `*.js`),
 * spaces inside `**` (`2 ** 10`), globs (`src/**` + `/*.ts`), pointers (`char **argv`) and
 * intraword `**` (`x**2 + y**2`) stay text.
 */
export function findBold(text: string, spans: ReadonlyArray<{ start: number; end: number }> = findInline(text)): BoldSpan[] {
  const bolds: BoldSpan[] = [];
  let spanIndex = 0;
  let i = 0;
  while (i < text.length) {
    while (spanIndex < spans.length && spans[spanIndex].end <= i) spanIndex++;
    if (spanIndex < spans.length && i >= spans[spanIndex].start) { i = spans[spanIndex].end; continue; }
    if (text[i] !== "*") { i++; continue; }
    let run = i;
    while (text[run] === "*") run++;
    if (run - i !== 2) { i = run; continue; }
    const beforeOpen = text[i - 1] ?? "";
    const afterOpen = text[i + 2] ?? "";
    const canOpen = Boolean(afterOpen) && !/\s/.test(afterOpen) && afterOpen !== "/"
      && !(ASCII_WORD.test(beforeOpen) && ASCII_WORD.test(afterOpen));
    if (!canOpen) { i = run; continue; }
    const endOfLine = lineEnd(text, i);
    let innerIndex = spanIndex;
    let close = -1;
    let j = i + 2;
    while (j < endOfLine) {
      while (innerIndex < spans.length && spans[innerIndex].end <= j) innerIndex++;
      if (innerIndex < spans.length && j >= spans[innerIndex].start) {
        if (spans[innerIndex].end > endOfLine) break;
        j = spans[innerIndex].end;
        continue;
      }
      if (text[j] !== "*") { j++; continue; }
      let closeRun = j;
      while (closeRun < endOfLine && text[closeRun] === "*") closeRun++;
      if (closeRun - j === 2) {
        const beforeClose = text[j - 1] ?? "";
        const afterClose = text[j + 2] ?? "";
        if (!/\s/.test(beforeClose) && !(ASCII_WORD.test(beforeClose) && ASCII_WORD.test(afterClose))) {
          close = j + 2;
          break;
        }
        // A second opener (`char **argv; **bold**`) means the first `**` was unclosed syntax.
        if (/\s/.test(beforeClose) && Boolean(afterClose) && !/\s/.test(afterClose) && afterClose !== "/") break;
      }
      j = closeRun;
    }
    if (close < 0) { i = run; continue; }
    bolds.push({ start: i, end: close });
    i = close;
  }
  return bolds;
}

export type ProseBlock =
  | { kind: "p" | "heading"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; start: number; items: string[] }
  | { kind: "quote"; lines: string[] };

/**
 * Splits prose into paragraphs, lists, subheadings and blockquotes while keeping
 * multi-line `\[ … \]` display formulas whole and every item text an exact slice of `text`.
 */
export function proseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  for (const line of mathLines(text)) {
    const ul = /^\s*(?:[-•]|\*(?!\*))\s+(\S[\s\S]*)$/.exec(line);
    if (ul) {
      const prev = blocks.at(-1);
      if (prev?.kind === "ul") prev.items.push(ul[1]);
      else blocks.push({ kind: "ul", items: [ul[1]] });
      continue;
    }
    const ol = /^\s*(\d{1,3})\.\s+(\S[\s\S]*)$/.exec(line);
    if (ol) {
      const prev = blocks.at(-1);
      if (prev?.kind === "ol") prev.items.push(ol[2]);
      else blocks.push({ kind: "ol", start: Number(ol[1]), items: [ol[2]] });
      continue;
    }
    const heading = /^\s*#{2,4}\s+(\S[\s\S]*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    const quote = /^\s*>\s+(\S[\s\S]*)$/.exec(line);
    if (quote) {
      const prev = blocks.at(-1);
      if (prev?.kind === "quote") prev.lines.push(quote[1]);
      else blocks.push({ kind: "quote", lines: [quote[1]] });
      continue;
    }
    blocks.push({ kind: "p", text: line });
  }
  return blocks;
}

/**
 * Whether `term`, picked from `quote`, may be typeset on its own: each formula it has alone
 * is a formula where it stands in `quote`. \[ERROR\] picked from grep '\[ERROR\]' is not.
 */
export function typesetAsQuoted(term: string, quote: string): boolean {
  const own = findMath(term);
  if (!own.length) return true;
  const there = findMath(quote);
  for (let at = quote.indexOf(term); at >= 0; at = quote.indexOf(term, at + 1)) {
    if (own.every(span => there.some(other => other.start === at + span.start && other.end === at + span.end))) return true;
  }
  return false;
}
