import { parseD2 } from "./d2.js";
import type { CubeMove } from "./rubik.js";
import type { Connection, Lesson, LessonAnnotation, Source } from "./types.js";

/*
 * Lesson format 3: one point per step, a figure chosen from six kinds, and a recall
 * question per step. Types follow design/v3/learning/03-WRITING-GUIDE.md §8.1.
 * A note without `format` is the original format (`Lesson`) and stays exactly as stored.
 */

/** v3 lesson. Character limits use the width rule: full-width = 1, half-width = 0.5, ceil. */
export interface LessonV3 {
  format: 3;
  title: string;                 // ≤ 16
  question: string;              // ≤ 30, ends with ？
  answer: string;                // ≤ 50, 1–2 sentences, at most one **emphasis**
  steps: Step[];                 // 2–5
  followUps: string[];           // 0–3, each ≤ 40
  source: { label: string; url?: string };
  // computed, never generated: minutes, category, tags
}

export interface Step {
  id: string;                    // "s1", "s2", …
  lead: string;                  // ≤ 28, one sentence
  body: string;                  // ≤ 120, ≤ 3 sentences, inline `code` allowed
  figure?: Figure;
  analogy?: { title: string; text: string };   // title ≤ 8 starting with 像; title + text ≤ 40
  deeper?: { summary: string; body: string };  // ≤ 20 / ≤ 200
  recall: Recall;
}

export interface Recall {
  question: string;              // ≤ 30
  answer: string;                // ≤ 60; first clause is the bolded verdict, e.g. "3。…" or "不共用。…"
  hint?: string;                 // ≤ 30, a guiding question
  blank?: FigureCell;            // which cell the review card blanks out
}

export type FigureCell =
  | { kind: "state"; row: number; var: string }         // 0-based row
  | { kind: "state-output"; row: number }
  | { kind: "sequence"; event: number }                 // 0-based event index
  | { kind: "compare"; item: number; row: number }
  | { kind: "keyfact" };

export type Figure = AnnotatedCode | StateTable | Compare | Sequence | Timeline | KeyFact | D2Diagram | RubikFigure;

export interface AnnotatedCode {
  kind: "annotated-code";
  file?: string;                 // "counter.js"
  language: string;
  source: string;                // ≤ 14 lines
  focus: number[];               // 1-based lines to highlight; others are dimmed
  notes: { line: number; text: string }[];  // 1–3, text ≤ 32, line ∈ focus
  output?: string;               // ≤ 3 lines
}

export interface StateTable {
  kind: "state";
  vars: string[];                // 1–3 identifiers
  rows: {
    moment: string;              // ≤ 10, e.g. "第 1 次呼叫"
    code?: string;               // ≤ 24, hidden at 360px
    values: Record<string, { from?: string; to: string }>;  // every var in vars
    output?: string;             // ≤ 12
  }[];                           // 2–6
  caption?: string;              // ≤ 30, tells the reader which column to look at
}

export interface Compare {
  kind: "compare";
  items: { title: string; tone?: "wrong" | "right" }[];   // 2–3, title ≤ 16
  rows: { label: string; values: string[] }[];            // 2–5, label ≤ 8, each value ≤ 16, values.length === items.length
  verdict?: string;              // ≤ 30
}

export interface Sequence {
  kind: "sequence";
  lanes: { id: string; label: string }[];                 // 2–4, label ≤ 6
  events: { lane: string; label: string; output?: string }[];  // 3–8, in execution order, label ≤ 14, output ≤ 6
  caption?: string;              // ≤ 30
}

export interface Timeline {
  kind: "timeline";
  unit: "ms" | "s";
  span: number;                  // axis end, e.g. 600
  rows: {
    label: string;               // ≤ 6
    marks?: { at: number; label: string }[];                       // label ≤ 4
    ranges?: { from: number; to: number; state: "wait" | "cancel"; label?: string }[];
    fire?: { at: number; label: string };                          // label ≤ 8
  }[];                           // 1–4
  caption?: string;              // ≤ 30
}

export interface KeyFact {
  kind: "keyfact";
  value: string;                 // ≤ 6
  unit?: string;                 // ≤ 4
  label: string;                 // ≤ 12
  note: string;                  // ≤ 40
}

export interface D2Diagram {
  kind: "d2";
  title?: string;                // ≤ 28
  source: string;                // declarative D2 containers, nodes & `a -> b: label` edges
  caption?: string;              // ≤ 52
}

export interface RubikFigure {
  kind: "rubik-2x2";
  title: string;                 // ≤ 28
  caption: string;               // ≤ 140
  setupMoves: CubeMove[];        // 0–12 moves from solved state
  view?: "space" | "moves" | "search";
}

/**
 * A saved v3 note: the generated lesson plus what every saved note carries. `source` is
 * the material the note was made from, which also has the `label` and `url` of `LessonV3`.
 */
export interface LessonNoteV3 extends LessonV3 {
  id: string;
  category: string;
  tags: string[];
  source: Source;
  /** Targets name a section id of an original-format note or a step id of a v3 note. */
  connections: Connection[];
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
  favorite: boolean;
  annotations?: LessonAnnotation[];
  parentLessonId?: string;
}

/** Any saved note. Read paths branch on `format`; a note without it is the original format. */
export type StoredLesson = Lesson | LessonNoteV3;

export const isLessonV3 = (lesson: StoredLesson | LessonV3): lesson is LessonNoteV3 =>
  (lesson as { format?: unknown }).format === 3;

/**
 * The lesson format a sync server must store to keep this note whole: a v3 note's own format,
 * or 3 for an original-format note marked 「整理失敗」, whose mark an older server would drop.
 */
export const syncFormatOf = (lesson: StoredLesson): number | undefined =>
  isLessonV3(lesson) ? lesson.format : lesson.failedFormat;

/** Section ids of an original note, step ids of a v3 note: what a connection may point at. */
export const lessonPartIds = (lesson: StoredLesson): string[] =>
  isLessonV3(lesson) ? lesson.steps.map(step => step.id) : lesson.sections.map(section => section.id);

// ---- width -----------------------------------------------------------------

/** East Asian Wide and Fullwidth ranges: CJK, kana, hangul, full-width forms and pictographs. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

/** Full-width characters (Chinese, full-width punctuation) count 1; the rest count 0.5. */
export function isFullWidth(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x1100) return false;
  let low = 0, high = WIDE.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = WIDE[middle];
    if (code < start) high = middle - 1;
    else if (code > end) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Characters as the guide counts them: full-width 1, half-width 0.5, rounded up.
 * Counted as written, so `code` backticks and **emphasis** marks count too.
 */
export function width(text: string): number {
  let halves = 0;
  for (const char of text) halves += isFullWidth(char) ? 2 : 1;
  return Math.ceil(halves / 2);
}

// ---- limits (shared by the validator, the prompt and the renderer) ---------

export const V3_LIMITS = {
  title: 32, question: 52, answer: 140, answerSentences: 4,
  steps: { min: 2, max: 12 },
  lead: 44, body: 300, bodySentences: 6, bodyHalfWidthRun: 110,
  analogyTitle: 14, analogyTotal: 72, analogiesPerLesson: 4,
  deeperSummary: 36, deeperBody: 520,
  recallQuestion: 52, recallAnswer: 120, recallHint: 48,
  followUps: { min: 0, max: 6 }, followUp: 60,
  code: { lines: 26, notes: { min: 1, max: 5 }, note: 56, outputLines: 6 },
  state: { vars: { min: 1, max: 4 }, rows: { min: 2, max: 8 }, moment: 16, code: 36, output: 20, caption: 52 },
  compare: { items: { min: 2, max: 3 }, itemTitle: 28, rows: { min: 2, max: 6 }, label: 14, value: 36, verdict: 52 },
  sequence: { lanes: { min: 2, max: 4 }, laneLabel: 16, events: { min: 3, max: 8 }, eventLabel: 28, output: 16, caption: 52 },
  timeline: { rows: { min: 1, max: 4 }, rowLabel: 12, markLabel: 10, fireLabel: 14, caption: 52 },
  keyfact: { value: 12, unit: 8, label: 20, note: 64 },
  d2: { title: 28, lines: 24, nodes: { min: 2, max: 12 }, edges: { min: 1, max: 12 }, label: 36, caption: 52 },
  rubik: { title: 28, caption: 140, moves: 12 },
} as const;

/** Lesson languages the writing rules cover: zh-TW per 03-WRITING-GUIDE, en per copy/WRITING-GUIDE.en.md. */
export type V3Locale = "zh-TW" | "en";

/** Strings the guide never allows outside code (§10.4). English phrases match in any letter case. */
export const V3_BANNED = ["本文將", "如上圖", "如右圖", "讓我們", "！", "點子"] as const;
export const V3_BANNED_EN = ["In this article", "In this lesson", "as shown above", "on the right", "let's ", "!"] as const;

// ---- reading time ----------------------------------------------------------

/**
 * Estimated minutes (§1): prose characters ÷ 300, plus 0.5 per figure and 0.25 per
 * recall question, rounded, at least 2. Prose is what a reader reads in order: the
 * question, the answer and each step's lead, body and analogy; folded `deeper` is skipped.
 * Computed when read, never generated or stored.
 */
export function lessonMinutes(lesson: Pick<LessonV3, "question" | "answer" | "steps">): number {
  const prose = [lesson.question, lesson.answer, ...lesson.steps.flatMap(step =>
    [step.lead, step.body, ...(step.analogy ? [step.analogy.title, step.analogy.text] : [])])];
  const characters = prose.reduce((sum, text) => sum + width(text), 0);
  const figures = lesson.steps.filter(step => step.figure).length;
  return Math.max(2, Math.round(characters / 300 + figures * 0.5 + lesson.steps.length * 0.25));
}

/** Whether a recall blank names a cell its step's figure has. */
export function figureHasCell(figure: Figure | undefined, cell: FigureCell): boolean {
  const index = (value: number, length: number) => Number.isInteger(value) && value >= 0 && value < length;
  switch (cell.kind) {
    case "state":
      return figure?.kind === "state" && index(cell.row, figure.rows.length) && figure.vars.includes(cell.var) && Object.hasOwn(figure.rows[cell.row].values, cell.var);
    case "state-output":
      return figure?.kind === "state" && index(cell.row, figure.rows.length) && figure.rows[cell.row].output !== undefined;
    case "sequence":
      return figure?.kind === "sequence" && index(cell.event, figure.events.length);
    case "compare":
      return figure?.kind === "compare" && index(cell.item, figure.items.length) && index(cell.row, figure.rows.length);
    case "keyfact":
      return figure?.kind === "keyfact";
  }
}

/**
 * A recall answer split where §8.1 puts its verdict: the first sentence, in bold in the
 * lesson and in large type on a review card, then the reason. `verdict` keeps its own end
 * mark ("3。", "No."), so `verdict` and `reason` together are the trimmed answer.
 * - A sentence ends at a full-width 。？！, or at a half-width . ? ! before a space or the
 *   end; closing ) ] ） and quotes right after the mark stay with it, as does a ** that
 *   closes bold opened in the verdict (**Yes.** Because …).
 * - Never inside inline `code` (`0.5`, `Node.js`) or a 「」『』 quote: a quoted sentence's
 *   own end mark does not end the answer's first sentence.
 * - Not after e.g., i.e., vs. or cf.
 */
export function recallParts(answer: string): { verdict: string; reason: string } {
  const text = answer.trim();
  const blank = (span: string) => "_".repeat(span.length);
  const masked = text.replace(/(`+)[^`]*?\1/g, blank).replace(/「[^」]*」/g, blank).replace(/『[^』]*』/g, blank);
  for (const end of masked.matchAll(/[。？！]+|[.?!]+(?=[)\]）"'”’*]*(?:\s|$))/g)) {
    if (end[0][0] === "." && /(?:^|[^\p{L}])(?:e\.g|i\.e|vs|cf)$/iu.test(masked.slice(0, end.index))) continue;
    let cut = end.index + end[0].length;
    cut += /^[)\]）」』"'”’]*/.exec(masked.slice(cut))![0].length;
    if ((masked.slice(0, cut).match(/\*\*/g) || []).length % 2 && masked.startsWith("**", cut)) cut += 2;
    return { verdict: text.slice(0, cut).trim(), reason: text.slice(cut).trim() };
  }
  return { verdict: text, reason: "" };
}

// ---- plain text ------------------------------------------------------------

const change = (value: { from?: string; to: string }) => value.from === undefined ? value.to : `${value.from} → ${value.to}`;

/**
 * A figure's words as plain lines, in reading order, for search and text export. Code
 * stays as written; tables and lanes become one line per row or event.
 */
export function figureLines(figure: Figure): string[] {
  const lines = (values: Array<string | undefined | false>) => values.filter((value): value is string => Boolean(value));
  switch (figure.kind) {
    case "annotated-code":
      return lines([figure.file, figure.source, ...figure.notes.map(note => `第 ${note.line} 行：${note.text}`), figure.output !== undefined && `輸出：${figure.output}`]);
    case "state":
      return lines([figure.caption, ...figure.rows.map(row => [
        row.moment, row.code, ...figure.vars.map(name => row.values[name] && `${name} ${change(row.values[name])}`), row.output !== undefined && `輸出 ${row.output}`,
      ].filter(Boolean).join("　"))]);
    case "compare":
      return lines([
        figure.items.map(item => item.title).join(" ／ "),
        ...figure.rows.map(row => `${row.label}：${row.values.join(" ／ ")}`),
        figure.verdict,
      ]);
    case "sequence": {
      const label = new Map(figure.lanes.map(lane => [lane.id, lane.label]));
      return lines([figure.caption, ...figure.events.map((event, index) =>
        `${index + 1}. ${label.get(event.lane) ?? event.lane}：${event.label}${event.output !== undefined ? `（輸出 ${event.output}）` : ""}`)]);
    }
    case "timeline":
      return lines([figure.caption, ...figure.rows.map(row => [
        row.label,
        ...(row.marks || []).map(mark => `${mark.at}${figure.unit} ${mark.label}`),
        ...(row.ranges || []).map(range => `${range.from}–${range.to}${figure.unit} ${range.state === "wait" ? "等待" : "取消"}${range.label ? ` ${range.label}` : ""}`),
        row.fire && `${row.fire.at}${figure.unit} ${row.fire.label}`,
      ].filter(Boolean).join("　"))]);
    case "keyfact":
      return lines([`${figure.label}：${figure.value}${figure.unit ?? ""}`, figure.note]);
    case "d2": {
      const graph = parseD2(figure.source);
      const nodeTitle = new Map(graph.allNodes.map(node => [node.id, node.title]));
      return lines([
        figure.title,
        figure.caption,
        ...graph.groups.map(group => `${group.label}：${group.nodes.map(node => node.detail ? `${node.title}（${node.detail}）` : node.title).join("、")}`),
        ...graph.nodes.map(node => node.detail ? `${node.title}：${node.detail}` : node.title),
        ...graph.edges.map(edge => `${nodeTitle.get(edge.from) ?? edge.from} → ${nodeTitle.get(edge.to) ?? edge.to}${edge.label ? `：${edge.label}` : ""}`),
      ]);
    }
    case "rubik-2x2":
      return lines([
        figure.title,
        figure.caption,
        figure.setupMoves.length ? `初始操作：${figure.setupMoves.join(" ")}` : "初始操作：已解狀態",
      ]);
  }
}
