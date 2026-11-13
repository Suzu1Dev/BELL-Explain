import { restoreCjkRadicals } from "./cjk-radicals.js";

/**
 * One positioned text run from pdf.js, in PDF user-space units (y grows upward).
 * `block` is set by readingOrder: lines never join across blocks (columns or full-width strips).
 */
export interface LayoutItem { str: string; x: number; y: number; width: number; size: number; mono: boolean; block?: number; }
export interface LayoutLine { text: string; x: number; y: number; end: number; size: number; mono: boolean; charWidth: number; block?: number; }
export interface LayoutPage { top: number; bottom: number; lines: LayoutLine[]; }

const CJK = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯\u{20000}-\u{3134f}]/u;
const isCjk = (char: string | undefined) => !!char && CJK.test(char);
const lastChar = (text: string) => /.$/u.exec(text)?.[0];
const firstChar = (text: string) => /^./u.exec(text)?.[0];
const LIST_START = /^(?:[•●▪◦‣∙·*\-–]\s|\d{1,3}[.)、]\s?|[（(][一二三四五六七八九十\d]{1,3}[）)]|[一二三四五六七八九十]{1,3}、|[a-zA-Z][.)]\s)/u;
/** Ends a sentence, a clause leading into a list, or a quotation. */
const CLOSING = /[。！？.!?:：；;…」』）)”’"']$/u;
const PAGE_NUMBER = /^[\s\-–—·|]*(?:page\s*|p\.\s*|第\s*)?\d{1,5}\s*(?:頁|(?:of|\/|／)\s*\d{1,5})?[\s\-–—·|]*$/i;

/** Monospaced Latin glyphs advance about 0.6 em; CJK fonts are often flagged fixed-pitch but advance 1 em. */
export function isMonospaceRun(fontFamily: string | undefined, str: string, width: number, size: number): boolean {
  const glyphs = [...str.replace(/\s/g, "")];
  if (fontFamily !== "monospace" || !glyphs.length || !glyphs.every(char => char <= "ɏ") || size <= 0) return false;
  const advance = width / ([...str].length * size);
  return advance > 0.54 && advance < 0.66;
}

/** Groups runs into visual lines using positions instead of the order-only joins pdf.js provides. */
export function buildLines(items: LayoutItem[]): LayoutLine[] {
  const lines: LayoutLine[] = [];
  let line: (LayoutLine & { pending: boolean; monoChars: number; chars: number }) | undefined;
  const flush = () => {
    if (!line || !line.text.trim()) return;
    lines.push({ text: line.text.replace(/\s+$/u, ""), x: line.x, y: line.y, end: line.end, size: line.size, mono: line.monoChars >= line.chars * 0.6, charWidth: line.charWidth, block: line.block });
  };
  for (const item of items) {
    if (!item.str) continue;
    const size = item.size > 0 ? item.size : 10;
    const blank = !item.str.trim();
    const same = !!line && item.block === line.block && Math.abs(item.y - line.y) <= Math.max(line.size, size) * 0.45 && item.x > line.end - Math.max(line.size, size) * 1.5;
    if (blank) { if (same) line!.pending = true; continue; }
    const chars = [...item.str].length;
    if (same && line) {
      const gap = item.x - line.end;
      if (item.mono && line.monoChars >= line.chars * 0.6) {
        const spaces = Math.max(line.pending ? 1 : 0, Math.round(gap / line.charWidth));
        line.text += " ".repeat(Math.min(Math.max(spaces, 0), 40)) + item.str;
      } else {
        const cjk = isCjk(lastChar(line.text)) || isCjk(firstChar(item.str));
        const space = !/\s$/u.test(line.text) && (line.pending || gap > size * (cjk ? 0.9 : 0.2));
        line.text += (space ? " " : "") + item.str;
      }
      line.end = Math.max(line.end, item.x + item.width);
      line.chars += chars;
      if (item.mono) line.monoChars += chars;
      line.pending = false;
    } else {
      flush();
      line = { text: item.str, x: item.x, y: item.y, end: item.x + item.width, size, mono: item.mono, block: item.block,
        charWidth: item.mono ? item.width / chars : size * 0.6, pending: false, monoChars: item.mono ? chars : 0, chars };
    }
  }
  flush();
  return lines;
}

/** Same-row runs closer together than a column gutter (0.8 em), numbered in content order. */
interface Fragment { items: LayoutItem[]; index: number; x: number; end: number; y: number; size: number; mono: boolean; chars: number; monoChars: number; }
/** A column, or a full-width strip; strips next to each other merge and keep their content order. */
interface Block { fragments: Fragment[]; column: boolean; }
const byIndex = (a: Fragment, b: Fragment) => a.index - b.index;
const chars = (list: Fragment[]) => list.reduce((sum, f) => sum + f.chars, 0);
/** Runs of at least 3 em are text; shorter ones may be a page number, a figure label or a piece of a formula. */
const long = (f: Fragment, em: number) => f.end - f.x >= em * 3;
/** The size most characters are set in, not that of many small figure labels. */
function mainSize(list: Fragment[]): number {
  let seen = 0;
  const total = chars(list);
  return [...list].sort((a, b) => a.size - b.size).find(f => (seen += f.chars) * 2 >= total)!.size;
}
/** Sizes within 10 % of each other. */
const sameSize = (a: number, b: number) => Math.abs(a - b) < b * 0.1;

function fragments(items: LayoutItem[]): Fragment[] {
  const list: Fragment[] = [];
  for (const item of items) {
    if (!item.str) continue;
    const last = list.at(-1);
    // Blank runs only mark spaces, so they stay with the run before them.
    if (!item.str.trim()) { last?.items.push(item); continue; }
    const size = item.size > 0 ? item.size : 10;
    const chars = [...item.str].length;
    // A trailing space inside a run would otherwise reach into the gutter.
    const end = item.x + item.width * [...item.str.trimEnd()].length / chars;
    const em = Math.max(last?.size ?? 0, size);
    if (last && Math.abs(item.y - last.y) <= em * 0.45 && item.x > last.end - em * 1.5 && item.x - last.end < em * 0.8) {
      last.items.push(item);
      last.end = Math.max(last.end, end);
      last.chars += chars;
      if (item.mono) last.monoChars += chars;
    } else list.push({ items: [item], index: list.length, x: item.x, end, y: item.y, size, mono: false, chars, monoChars: item.mono ? chars : 0 });
  }
  for (const fragment of list) fragment.mono = fragment.monoChars >= fragment.chars * 0.6;
  return list;
}

/**
 * Gutters: x bands centred in the inner 60 % of the text area that the fewest runs cross, left to right.
 * They must be at least 1 em wide, since IEEE journals separate their columns by only about 1.2 em.
 */
function findGutters(list: Fragment[], em: number, left: number, right: number): Array<[number, number]> {
  const inner = (from: number, to: number) => Math.abs((from + to) / 2 - (left + right) / 2) < (right - left) * 0.3;
  const events = list.flatMap(f => [[f.x, 1], [f.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const spans: Array<[number, number, number]> = [];
  let count = 0;
  events.forEach(([x, delta], index) => {
    count += delta;
    const next = events[index + 1]?.[0];
    if (next !== undefined && next > x) spans.push([x, next, count]);
  });
  const lowest = Math.min(...spans.filter(([from, to]) => inner(from, to)).map(span => span[2]));
  const runs: Array<[number, number]> = [];
  for (const [from, to, covered] of spans) {
    if (covered !== lowest) continue;
    const run = runs.at(-1);
    if (run && run[1] === from) run[1] = to; else runs.push([from, to]);
  }
  return runs.filter(([from, to]) => to - from >= em && inner(from, to));
}

/**
 * Splits one band (rows between full-width rows) at the gutters when every side reads as a
 * column of prose running alongside its neighbour; otherwise the band keeps its content order.
 */
function splitBand(band: Fragment[][], gutters: Array<[number, number]>, em: number, [left, right]: [number, number], marks: Set<Fragment>): Block[] | undefined {
  // Marks out in the margin, such as a vertical arXiv stamp, follow the columns instead of joining one.
  const margin = band.flat().filter(f => marks.has(f));
  const rows = band.map(row => row.filter(f => !marks.has(f))).filter(row => row.length);
  const wide = (f: Fragment) => !f.mono && f.end - f.x >= em * 8;
  // Each side's text and body: wide lines filling the side out to its right edge. A line running
  // over into a gutter, such as an overfull URL, does not move that edge.
  const sideOf = (f: Fragment) => gutters.filter(([from, to]) => from + to < f.x + f.end).length;
  const columns = (list: Fragment[]) => {
    const sides: Fragment[][] = [[], ...gutters.map(() => [])];
    for (const f of list) sides[sideOf(f)].push(f);
    return sides.map(side => {
      const text = side.filter(f => !f.mono);
      const inside = text.filter(f => !gutters.some(([from, to]) => f.x < to && f.end > from));
      const edge = Math.max(...(inside.length ? inside : text).map(f => f.end)), span = edge - Math.min(...side.map(f => f.x));
      return { side, text, edge, span, body: text.filter(f => wide(f) && f.end >= edge - Math.max(em * 2, span * 0.15)) };
    });
  };
  const whole = columns(rows.flat());
  const body = new Set(whole.flatMap(column => column.body));
  // Blank strips across every side split the band into groups. A group at the top or bottom without
  // body text on every side, such as an author block, a running header or figure labels, is not part
  // of the columns, unless it holds titles that each start at their side's left edge, as two text boxes do.
  const sidesOf = (keep: (f: Fragment) => boolean) => rows.map(row => new Set(row.filter(keep).map(sideOf)));
  const covers = (sets: Array<Set<number>>, from: number, to: number) => whole.every((_, side) => sets.slice(from, to).some(set => set.has(side)));
  // Prose is set in the size most body text is; captions and labels of pictures are smaller.
  const bodySize = body.size ? mainSize([...body]) : em;
  const bodySides = sidesOf(f => body.has(f)), proseSides = sidesOf(f => body.has(f) && sameSize(f.size, bodySize));
  const columnar = (from: number, to: number) => covers(bodySides, from, to);
  // The short last line of a caption across the page is flush with the left column, yet no title of the right one.
  const edges = whole.map(column => Math.min(...column.body.map(line => line.x)));
  const flush = (from: number, to: number) => {
    const group = rows.slice(from, to).flat();
    return whole.every((_, side) => group.some(f => sideOf(f) === side)) && group.every(f => f.x < edges[sideOf(f)] + em);
  };
  const gap = (i: number) => rows[i - 1][0].y - rows[i][0].y;
  const bounds = [0, ...rows.flatMap((_, i) => i && gap(i) >= em * 2.5 ? [i] : []), rows.length];
  let a = 0, b = bounds.length - 1;
  while (a < b - 1 && !columnar(bounds[a], bounds[a + 1]) && !flush(bounds[a], bounds[a + 1])) a++;
  while (b > a + 1 && !columnar(bounds[b - 1], bounds[b])) b--;
  // A tall strip between groups of prose in the body size on every side is a full-width picture, table
  // or formula with no text across the gutter; which rows then run alongside which is unclear, so the
  // content order stays. The space above a heading in one column often lines up with a gap in the
  // other, but stays below 4 em; pictures standing side by side in the columns have smaller captions.
  const prose = bounds.slice(a, b).flatMap((from, k) => covers(proseSides, from, bounds[a + k + 1]) ? [a + k] : []);
  if (prose.length && bounds.slice(prose[0] + 1, prose.at(-1)! + 1).some(i => gap(i) >= em * 4)) return undefined;
  const top = bounds[a], bottom = bounds[b];
  // Each side needs a real column width and most of its text in body lines: prose does, while
  // table cells, labels and code in a proportional font stay short or ragged.
  const core = columns(rows.slice(top, bottom).flat());
  const extents = core.map(({ text, span, body }) => {
    if (body.length < 3 || chars(body) < chars(text) * 0.6 || span < Math.max(em * 10, (right - left) * 0.2)) return undefined;
    return [Math.min(...body.map(f => f.y)), Math.max(...body.map(f => f.y))];
  });
  // Neighbouring columns must run alongside each other for at least half of the shorter one.
  const alongside = (a: number[], b: number[]) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= Math.min(a[1] - a[0], b[1] - b[0]) * 0.5;
  if (extents.some((extent, i) => !extent || (i > 0 && !alongside(extent, extents[i - 1]!)))) return undefined;
  // A table whose cells wrap sentences starts its cells together, row after row, each below a gap or a
  // short closing line; even without row padding the shorter cell of a row leaves a gap on its side.
  // Columns of prose set on one line grid only now and then start paragraphs on the same line.
  // Only lines of text count: a figure label, a formula piece or a short heading above a line is no cell.
  const starts = core.map(({ side, edge }) => {
    const lines: Array<{ y: number; end: number; text: boolean; size: number }> = [];
    for (const f of [...side].sort((a, b) => b.y - a.y)) {
      const line = lines.at(-1);
      if (line && line.y - f.y <= em * 0.45) { line.end = Math.max(line.end, f.end); line.text ||= long(f, em); line.size = Math.max(line.size, f.size); }
      else lines.push({ y: f.y, end: f.end, text: long(f, em), size: f.size });
    }
    // Each size has its own leading: small-type captions or an algorithm above the prose sit closer.
    const steps = lines.slice(1).map((line, i) => ({ step: lines[i].y - line.y, key: sameSize(lines[i].size, line.size) ? Math.round(line.size * 2) : 0 }));
    const any = median(steps.map(({ step }) => step)) ?? em;
    const leading = new Map<number, number>();
    for (const { key } of steps) if (key && !leading.has(key)) leading.set(key, median(steps.filter(other => other.key === key).map(({ step }) => step))!);
    return lines.slice(1).flatMap((line, i) => {
      const spaced = lines[i].y - line.y > (leading.get(Math.round(line.size * 2)) ?? any) * 1.3;
      return spaced || lines[i].end < edge - em * 6 ? [{ y: line.y, spaced, text: line.text && lines[i].text }] : [];
    });
  });
  const at = (list: (typeof starts)[number], y: number) => list.find(other => Math.abs(other.y - y) < em * 0.5);
  const together = starts[0].filter(({ y }) => starts.every(list => at(list, y)?.text) && starts.some(list => at(list, y)!.spaced)).length;
  // Shared starts are most of those on the side with the fewest, and a fair part of every side's: two of
  // a column's three paragraphs may start by chance on lines where the other column starts many.
  const counts = starts.map(list => list.length);
  if (together >= 2 && together >= Math.min(...counts) * 0.6 && together >= Math.max(...counts) * 0.3) return undefined;
  return [{ fragments: rows.slice(0, top).flat(), column: false }, ...core.map(({ side }) => ({ fragments: side.sort(byIndex), column: true })),
    { fragments: [...margin, ...rows.slice(bottom).flat()], column: false }];
}

/** Orders a page band by band, top to bottom; undefined when no band has columns. */
function arrange(list: Fragment[]): Block[] | undefined {
  if (list.length < 6) return undefined;
  const em = mainSize(list.some(f => !f.mono) ? list.filter(f => !f.mono) : list);
  // Short runs such as a centred page number or a figure label may sit in a gutter, so only long ones find it.
  const spans = list.filter(f => long(f, em));
  const left = Math.min(...spans.map(f => f.x)), right = Math.max(...spans.map(f => f.end));
  const gutters = spans.length >= 6 ? findGutters(spans, em, left, right) : [];
  if (!gutters.length) return undefined;
  const rows: Fragment[][] = [];
  for (const fragment of [...list].sort((a, b) => b.y - a.y || a.index - b.index)) {
    const row = rows.at(-1);
    if (row && row[0].y - fragment.y <= Math.max(row[0].size, fragment.size) * 0.45) row.push(fragment);
    else rows.push([fragment]);
  }
  const marks = new Set(list.filter(f => f.end <= left - em || f.x >= right + em));
  // Runs by height, to find a run's neighbours by bisection instead of scanning the page for each row.
  const byHeight = list.filter(f => !marks.has(f)).sort((a, b) => b.y - a.y);
  const near = (f: Fragment, reach: number) => {
    let low = 0, high = byHeight.length;
    while (low < high) { const mid = (low + high) >> 1; if (byHeight[mid].y >= f.y + reach) low = mid + 1; else high = mid; }
    const found: Fragment[] = [];
    for (let i = low; i < byHeight.length && byHeight[i].y > f.y - reach; i++) if (byHeight[i] !== f) found.push(byHeight[i]);
    return found;
  };
  const crossing = (f: Fragment) => gutters.filter(([from, to]) => f.x < to && f.end > from);
  // A row is full width when a run on it crosses a gutter, as a title, a full-width abstract or caption
  // and the pieces of a display formula across the page do, unless a line of the next column runs
  // beside it on that row, or a long one overlaps its line height: a line overlapping the run or
  // starting right past the gutter means a column line only ran over into the gutter, as an overfull
  // URL or a wide formula does. The next line of a caption set small crosses the gutter itself, so it
  // is no such line. A short run, such as a figure's tick label, crosses the page only as a piece of
  // a formula, with other pieces within 1 em on both sides of the gutter.
  const fullWidth = (row: Fragment[]) => row.some(f => {
    const crossed = crossing(f);
    if (!crossed.length) return false;
    if (!long(f, em)) {
      const around = near(f, em);
      if (!crossed.every(([from, to]) => around.some(h => h.x < from) && around.some(h => h.end > to))) return false;
    }
    const overrun = (h: Fragment) => !crossing(h).length && (h.x < f.end && h.end > f.x || crossed.some(([from, to]) =>
      f.x + f.end < from + to ? h.end > to && h.x < to + em * 2 : h.x < from && h.end > from - em * 2));
    return !row.some(h => h !== f && !marks.has(h) && overrun(h)) && !near(f, em * 0.9).some(h => long(h, em) && overrun(h));
  });
  const blocks: Block[] = [];
  const add = (block: Block) => {
    const previous = blocks.at(-1);
    if (!block.column && previous && !previous.column) previous.fragments.push(...block.fragments);
    else if (block.fragments.length) blocks.push(block);
  };
  // Characters in full-width rows below the last band of columns, and in all.
  let band: Fragment[][] = [], below = 0, across = 0, split = false;
  const close = () => {
    if (band.length) (splitBand(band, gutters, em, [left, right], marks) ?? [{ fragments: band.flat(), column: false }]).forEach(block => {
      if (block.column) { split = true; below = 0; }
      add(block);
    });
    band = [];
  };
  for (const row of rows) {
    if (fullWidth(row)) {
      close();
      add({ fragments: [...row], column: false });
      if (split) below += chars(row);
      across += chars(row);
    } else band.push(row);
  }
  close();
  // A page whose text mostly runs across the gutters and goes on below the columns is single-column,
  // and a table or pictures side by side on it keep their rows. A first page's long abstract sits
  // above a short band of columns, with at most a footer below them.
  const columns = chars(blocks.filter(block => block.column).flatMap(block => block.fragments));
  if (!columns || across >= columns && below * 5 >= across) return undefined;
  for (const block of blocks) if (!block.column) block.fragments.sort(byIndex);
  return blocks;
}

/**
 * Puts a multi-column page in reading order: bands split by full-width rows, each read
 * column by column (left column top to bottom, then the next). Pages without clear prose
 * columns, such as slides, tables and code, keep their content order and are returned as is.
 */
export function readingOrder(items: LayoutItem[]): LayoutItem[] {
  const blocks = arrange(fragments(items));
  if (!blocks) return items;
  return blocks.flatMap((block, index) => block.fragments.flatMap(f => f.items.map(item => ({ ...item, block: index + 1 }))));
}

/**
 * Drops running headers, footers and page numbers: lines near the top or bottom
 * edge whose text (digits ignored) repeats on at least half of the pages.
 */
export function removeRunningLines(pages: LayoutPage[]): void {
  const edge = (page: LayoutPage, line: LayoutLine) => {
    const height = page.top - page.bottom;
    return line.y >= page.top - height * 0.12 || line.y <= page.bottom + height * 0.12;
  };
  const key = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, "").toLowerCase();
  // A line also counts as its whole row, so a header split by column detection matches the unsplit one.
  const keys = pages.map(page => {
    const lines = page.lines.filter(line => edge(page, line));
    return new Map(lines.map(line => [line, [key(line.text), key(lines.filter(other => Math.abs(other.y - line.y) <= Math.max(other.size, line.size) * 0.45)
      .sort((a, b) => a.x - b.x).map(other => other.text).join(""))]]));
  });
  const counts = new Map<string, number>();
  for (const page of keys) for (const value of new Set([...page.values()].flat())) counts.set(value, (counts.get(value) || 0) + 1);
  const textPages = pages.filter(page => page.lines.length).length;
  const threshold = Math.max(3, Math.ceil(textPages * 0.5));
  for (const [index, page] of pages.entries()) page.lines = page.lines.filter(line => {
    const values = keys[index].get(line);
    if (!values) return true;
    if (PAGE_NUMBER.test(line.text)) return false;
    return textPages < 3 || values.every(value => (counts.get(value) || 0) < threshold);
  });
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function glue(text: string, next: string): string {
  // Rejoin words hyphenated across a line break; keep CJK lines unspaced.
  if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(next)) return text.slice(0, -1) + next;
  return isCjk(lastChar(text)) || isCjk(firstChar(next)) ? text + next : `${text} ${next}`;
}

/** Rebuilds paragraphs and code blocks of one page from its visual lines. */
export function pageText(lines: LayoutLine[]): string {
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index++) {
    const [a, b] = [lines[index - 1], lines[index]];
    const dy = a.y - b.y;
    if (!a.mono && !b.mono && Math.abs(a.size - b.size) < a.size * 0.1 && dy > 0 && dy < a.size * 3) gaps.push(dy);
  }
  const lineGap = median(gaps);
  // Right edge of the column a line belongs to, to recognise a short closing line.
  const rightEdge = (line: LayoutLine) => lines.reduce((edge, other) =>
    other.block === line.block && !other.mono && other.x > line.x - line.size * 3 && other.x < line.x + line.size * 3 ? Math.max(edge, other.end) : edge, line.end);
  const leftEdge = (line: LayoutLine) => Math.min(...lines.filter(other => other.block === line.block && !other.mono).map(other => other.x));
  const breaks = (prev: LayoutLine, line: LayoutLine) => {
    const size = Math.max(prev.size, line.size);
    const dy = prev.y - line.y;
    if (Math.abs(line.size - prev.size) > prev.size * 0.15 || LIST_START.test(line.text)) return true;
    if (prev.block !== line.block) {
      // Across blocks only the top of the next column carries a paragraph on, unless it starts indented
      // or is a heading or box title: short within its own column, yet neither closing a sentence nor
      // carrying on a word in lower case. Scripts without case, such as Chinese, give no such hint, so
      // there the previous column must have closed its sentence.
      if (line.y <= prev.y || line.x < prev.end || line.x > leftEdge(line) + size * 0.8) return true;
      const lead = /[\p{L}\p{N}]/u.exec(line.text)?.[0] ?? "";
      if (rightEdge(line) - line.end > size * 6 && !CLOSING.test(line.text) && !/\p{Ll}/u.test(lead)
        && (/[\p{Lu}\p{Lt}\p{N}]/u.test(lead) || CLOSING.test(prev.text))) return true;
    } else if (dy < -size * 0.3 || Math.abs(line.x - prev.x) > size * 8 || (lineGap ? dy > lineGap * 1.4 : dy > size * 1.9) || line.x > prev.x + size * 0.8) return true;
    const short = rightEdge(prev) - prev.end;
    return short > size * 6 || (short > size * 2 && /[。！？.!?:：」』）)]$/u.test(prev.text));
  };
  const blocks: string[] = [];
  let prose: string | undefined;
  let code: LayoutLine[] = [];
  const flushCode = () => {
    if (!code.length) return;
    const left = Math.min(...code.map(line => line.x));
    blocks.push(code.map(line => " ".repeat(Math.min(40, Math.max(0, Math.round((line.x - left) / line.charWidth)))) + line.text).join("\n"));
    code = [];
  };
  const flushProse = () => { if (prose) blocks.push(prose); prose = undefined; };
  lines.forEach((line, index) => {
    const prev = lines[index - 1];
    if (line.mono) {
      flushProse();
      if (code.length && prev && (prev.y - line.y > Math.max(prev.size, line.size) * 2.6 || prev.y < line.y)) flushCode();
      code.push(line);
      return;
    }
    flushCode();
    if (prose === undefined || !prev || prev.mono || breaks(prev, line)) { flushProse(); prose = line.text; }
    else prose = glue(prose, line.text);
  });
  flushCode();
  flushProse();
  return restoreCjkRadicals(blocks.join("\n\n")).normalize("NFC");
}
