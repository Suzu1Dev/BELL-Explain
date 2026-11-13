import { z } from "zod";
import { parseD2 } from "../shared/d2.js";
import {
  figureHasCell, isFullWidth, V3_BANNED, V3_BANNED_EN, V3_LIMITS as L, width,
  type Figure, type LessonV3, type Step, type V3Locale,
} from "../shared/lesson-v3.js";
import { CUBE_MOVES, type CubeMove } from "../shared/rubik.js";

/*
 * Two levels of checking for lesson format 3.
 *
 * - `lessonV3Schema` is the shape: strict objects, the six figure kinds, references
 *   that resolve (§10.3), and generous size caps. Stored and synchronized notes are
 *   checked against it, so a note written under today's writing limits still loads
 *   if those limits change later. No transforms: a parsed note keeps its hash.
 * - `lessonV3ContentSchema` adds the writing guide (§10.1, .2, .4–.6): widths, counts,
 *   banned phrases, analogies and code in prose. Generation must pass it. It checks
 *   zh-TW writing; `lessonV3ContentSchemaFor("en")` checks English (copy/WRITING-GUIDE.en.md §10).
 */

type Path = (string | number)[];
type Ctx = z.RefinementCtx;

const text = (max: number) => z.string().min(1).max(max);
const SHORT = 400;
const LONG = 4000;
const CODE = 20_000;
const index = z.number().int().min(0).max(1000);
const position = z.number().finite().min(0).max(1e9);

export const figureCellSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("state"), row: index, var: text(SHORT) }),
  z.strictObject({ kind: z.literal("state-output"), row: index }),
  z.strictObject({ kind: z.literal("sequence"), event: index }),
  z.strictObject({ kind: z.literal("compare"), item: index, row: index }),
  z.strictObject({ kind: z.literal("keyfact") }),
]);

const annotatedCodeSchema = z.strictObject({
  kind: z.literal("annotated-code"),
  file: text(SHORT).optional(),
  language: text(60),
  source: text(CODE),
  focus: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
  notes: z.array(z.strictObject({ line: z.number().int().min(1).max(10_000), text: text(SHORT) })).max(20),
  output: text(LONG).optional(),
});
const stateTableSchema = z.strictObject({
  kind: z.literal("state"),
  vars: z.array(text(SHORT)).min(1).max(10),
  rows: z.array(z.strictObject({
    moment: text(SHORT),
    code: text(SHORT).optional(),
    values: z.record(z.string().max(SHORT), z.strictObject({ from: text(SHORT).optional(), to: text(SHORT) })),
    output: text(SHORT).optional(),
  })).min(1).max(30),
  caption: text(SHORT).optional(),
});
const compareSchema = z.strictObject({
  kind: z.literal("compare"),
  items: z.array(z.strictObject({ title: text(SHORT), tone: z.enum(["wrong", "right"]).optional() })).min(1).max(8),
  rows: z.array(z.strictObject({ label: text(SHORT), values: z.array(text(SHORT)).max(8) })).min(1).max(20),
  verdict: text(SHORT).optional(),
});
const sequenceSchema = z.strictObject({
  kind: z.literal("sequence"),
  lanes: z.array(z.strictObject({ id: text(60), label: text(SHORT) })).min(1).max(10),
  events: z.array(z.strictObject({ lane: text(60), label: text(SHORT), output: text(SHORT).optional() })).min(1).max(40),
  caption: text(SHORT).optional(),
});
const timelineSchema = z.strictObject({
  kind: z.literal("timeline"),
  unit: z.enum(["ms", "s"]),
  span: z.number().finite().positive().max(1e9),
  rows: z.array(z.strictObject({
    label: text(SHORT),
    marks: z.array(z.strictObject({ at: position, label: text(SHORT) })).max(40).optional(),
    ranges: z.array(z.strictObject({ from: position, to: position, state: z.enum(["wait", "cancel"]), label: text(SHORT).optional() })).max(40).optional(),
    fire: z.strictObject({ at: position, label: text(SHORT) }).optional(),
  })).min(1).max(10),
  caption: text(SHORT).optional(),
});
const keyFactSchema = z.strictObject({
  kind: z.literal("keyfact"),
  value: text(SHORT),
  unit: text(SHORT).optional(),
  label: text(SHORT),
  note: text(SHORT),
});
const d2DiagramSchema = z.strictObject({
  kind: z.literal("d2"),
  title: text(SHORT).optional(),
  source: text(CODE),
  caption: text(SHORT).optional(),
});
const rubikFigureSchema = z.strictObject({
  kind: z.literal("rubik-2x2"),
  title: text(SHORT),
  caption: text(LONG),
  setupMoves: z.array(z.enum(CUBE_MOVES as [CubeMove, ...CubeMove[]])).max(12),
  view: z.enum(["space", "moves", "search"]).optional(),
});
export const figureSchema = z.discriminatedUnion("kind", [
  annotatedCodeSchema, stateTableSchema, compareSchema, sequenceSchema, timelineSchema, keyFactSchema, d2DiagramSchema, rubikFigureSchema,
]);

export const stepSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/),
  lead: text(SHORT),
  body: text(LONG),
  figure: figureSchema.optional(),
  analogy: z.strictObject({ title: text(SHORT), text: text(LONG) }).optional(),
  deeper: z.strictObject({ summary: text(SHORT), body: text(LONG) }).optional(),
  recall: z.strictObject({
    question: text(SHORT),
    answer: text(LONG),
    hint: text(SHORT).optional(),
    blank: figureCellSchema.optional(),
  }),
});

/** The generated part of a v3 note; a saved note adds the shared fields around it. */
export const lessonV3Shape = {
  format: z.literal(3),
  title: text(SHORT),
  question: text(SHORT),
  answer: text(LONG),
  steps: z.array(stepSchema).min(1).max(16),
  followUps: z.array(text(LONG)).max(10),
};

const lines = (source: string) => source.split("\n").length;

function checkFigure(figure: Figure, at: Path, ctx: Ctx) {
  const issue = (path: Path, message: string) => ctx.addIssue({ code: "custom", path: [...at, ...path], message });
  switch (figure.kind) {
    case "annotated-code": {
      const count = lines(figure.source);
      figure.focus.forEach((line, i) => {
        if (line > count) issue(["focus", i], `重點行 ${line} 超出程式碼範圍（共 ${count} 行）`);
      });
      figure.notes.forEach((note, i) => {
        if (!figure.focus.includes(note.line)) issue(["notes", i, "line"], `註解行 ${note.line} 必須是 focus 裡的一行`);
      });
      break;
    }
    case "state":
      figure.rows.forEach((row, r) => figure.vars.forEach(name => {
        // Own keys only: a var named `constructor` or `toString` must have its own value.
        if (!Object.hasOwn(row.values, name)) issue(["rows", r, "values", name], `第 ${r} 列缺少變數 ${name} 的值`);
      }));
      break;
    case "compare":
      figure.rows.forEach((row, r) => {
        if (row.values.length !== figure.items.length) issue(["rows", r, "values"], `需要 ${figure.items.length} 個值，對應每一個比較對象`);
      });
      break;
    case "sequence": {
      const ids = new Set<string>();
      figure.lanes.forEach((lane, i) => {
        if (ids.has(lane.id)) issue(["lanes", i, "id"], `軌道 id ${lane.id} 重複`);
        ids.add(lane.id);
      });
      figure.events.forEach((event, i) => {
        if (!ids.has(event.lane)) issue(["events", i, "lane"], `軌道 ${event.lane} 不存在於 lanes`);
      });
      break;
    }
    case "timeline":
      figure.rows.forEach((row, r) => {
        const within = (value: number, path: Path) => {
          if (value > figure.span) issue(["rows", r, ...path], `${value} 超出時間軸範圍 0–${figure.span}`);
        };
        row.marks?.forEach((mark, i) => within(mark.at, ["marks", i, "at"]));
        row.ranges?.forEach((range, i) => {
          within(range.from, ["ranges", i, "from"]);
          within(range.to, ["ranges", i, "to"]);
          if (range.from >= range.to) issue(["rows", r, "ranges", i, "to"], "區段的 from 必須小於 to");
        });
        if (row.fire) within(row.fire.at, ["fire", "at"]);
      });
      break;
    case "keyfact":
    case "rubik-2x2":
      break;
    case "d2": {
      const graph = parseD2(figure.source);
      for (const err of graph.errors) issue(["source"], err);
      if (graph.allNodes.length < 2) issue(["source"], "D2 結構圖至少需要 2 個節點");
      if (graph.edges.length < 1) issue(["source"], "D2 結構圖至少需要 1 條 `->` 連線");
      break;
    }
  }
}

/** §10.3: every reference inside a lesson resolves. Applies to stored and generated notes alike. */
export function checkV3References(lesson: Pick<LessonV3, "steps">, ctx: Ctx) {
  const ids = new Set<string>();
  lesson.steps.forEach((step, i) => {
    if (ids.has(step.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `步驟 id ${step.id} 重複` });
    ids.add(step.id);
    if (step.figure) checkFigure(step.figure, ["steps", i, "figure"], ctx);
    if (step.recall.blank && !figureHasCell(step.figure, step.recall.blank))
      ctx.addIssue({ code: "custom", path: ["steps", i, "recall", "blank"], message: "recall.blank 指到的格子不存在於這一步的圖解" });
  });
}

/** The shape of a generated v3 lesson, with the model's own `source` label. */
export const lessonV3Schema = z.strictObject({
  ...lessonV3Shape,
  source: z.strictObject({ label: text(2000), url: z.string().max(4000).optional() }),
}).superRefine(checkV3References);

// ---- the writing guide -------------------------------------------------------

const INLINE_CODE = /(`+)[^`]*?\1/g;
const prose = (value: string) => value.replace(INLINE_CODE, " ");
// For counting sentences inline code stands for a word, so a ? right after `null` still ends one.
const sentenceProse = (value: string) => value.replace(INLINE_CODE, "_");

/**
 * What differs by language; every width limit and count is shared. English ends a sentence
 * with . ? or ! before a space, so `0.5` and `Node.js` stay one sentence. zh-TW ends one at
 * 。？！, and at a half-width ? or ! only right after a word and before a space, a full-width
 * character or the end, so code left outside backticks (`a !== b`, `obj?.x`, `a ?? b`,
 * `x ? y : z`) stays one sentence. The run of 40 half-width characters finds code pasted
 * into Chinese prose, so English, which is all half-width, skips it (en §10.6).
 */
const LOCALES: Record<V3Locale, { question: string; analogy: string; banned: readonly string[]; sentenceEnd: RegExp; codeRun: boolean }> = {
  "zh-TW": { question: "？", analogy: "像", banned: V3_BANNED, sentenceEnd: /[。？！]+|(?<=[^\s?!])[?!]+(?=\s|$|[^\x00-\x7f])/u, codeRun: true },
  en: { question: "?", analogy: "Like ", banned: V3_BANNED_EN, sentenceEnd: /[.?!]+(?=\s|$)/, codeRun: false },
};
// §7 lists ✅ 👉 ★ ① as icons the interface draws itself.
const PICTOGRAPH = /[\p{Extended_Pictographic}①-⓿★☆✓✔\u{1f1e6}-\u{1f1ff}]/u;
const NUMBERED = /^\s*[0-9０-９]+\s*[/／.．]/;

function longestHalfWidthRun(value: string): number {
  let longest = 0, run = 0;
  for (const char of value) {
    run = isFullWidth(char) ? 0 : run + 1;
    if (run > longest) longest = run;
  }
  return longest;
}

/** §10.1–.2 and §10.4–.6, with a path for each problem so a repair can patch just that field. */
export function checkV3Writing(lesson: Pick<LessonV3, "title" | "question" | "answer" | "steps" | "followUps">, ctx: Ctx, locale: V3Locale = "zh-TW") {
  const rules = LOCALES[locale];
  const sentences = (value: string) => sentenceProse(value).split(rules.sentenceEnd).filter(part => part.trim()).length;
  // English phrases match in any case ("Let's", "In this lesson"); a curly apostrophe counts as '.
  const fold = (value: string) => locale === "en" ? value.toLowerCase().replace(/\u2019/g, "'") : value;
  const banned = rules.banned.map(fold);
  const issue = (path: Path, message: string) => ctx.addIssue({ code: "custom", path, message });
  const fits = (value: string | undefined, max: number, path: Path) => {
    if (value === undefined) return;
    const used = width(value);
    if (used > max) issue(path, `寬度 ${used}，上限 ${max}（全形 1、半形 0.5）`);
  };
  const count = (length: number, range: { min: number; max: number }, path: Path, what: string) => {
    if (length < range.min || length > range.max) issue(path, `${what}要 ${range.min}–${range.max} 個，現在 ${length} 個`);
  };
  const writing = (value: string | undefined, path: Path) => {
    if (value === undefined) return;
    const plain = prose(value);
    const folded = fold(plain);
    banned.forEach((phrase, i) => { if (folded.includes(phrase)) issue(path, `不可使用「${rules.banned[i]}」`); });
    if (PICTOGRAPH.test(plain)) issue(path, "程式碼以外不可使用 emoji 或符號圖示");
  };
  const field = (value: string | undefined, max: number, path: Path) => { fits(value, max, path); writing(value, path); };

  field(lesson.title, L.title, ["title"]);
  field(lesson.question, L.question, ["question"]);
  if (!lesson.question.trimEnd().endsWith(rules.question)) issue(["question"], `question 要以「${rules.question}」結尾`);
  field(lesson.answer, L.answer, ["answer"]);
  const answerSentences = sentences(lesson.answer);
  if (answerSentences > L.answerSentences) issue(["answer"], `answer 最多 ${L.answerSentences} 句，現在 ${answerSentences} 句`);
  if ((lesson.answer.match(/\*\*[^*]+\*\*/g) || []).length > 1) issue(["answer"], "answer 最多一個 **強調**");
  count(lesson.steps.length, L.steps, ["steps"], "steps ");
  count(lesson.followUps.length, L.followUps, ["followUps"], "followUps ");
  lesson.followUps.forEach((question, i) => field(question, L.followUp, ["followUps", i]));

  let analogies = 0;
  lesson.steps.forEach((step, i) => {
    const at = (...path: Path): Path => ["steps", i, ...path];
    field(step.lead, L.lead, at("lead"));
    const leadSentences = sentences(step.lead);
    if (leadSentences > 1) issue(at("lead"), `lead 只能有一句，現在 ${leadSentences} 句`);
    if (NUMBERED.test(step.lead)) issue(at("lead"), "lead 不可以編號開頭，例如「02 /」或「1.」");
    field(step.body, L.body, at("body"));
    const bodySentences = sentences(step.body);
    if (bodySentences > L.bodySentences) issue(at("body"), `body 最多 ${L.bodySentences} 句，現在 ${bodySentences} 句`);
    if (/[\r\n]/.test(step.body)) issue(at("body"), "body 不可換行；程式碼放在 figure");
    if (step.body.includes("```")) issue(at("body"), "body 不可有 ``` 程式碼區塊；程式碼放在 figure");
    if (rules.codeRun && longestHalfWidthRun(step.body) >= L.bodyHalfWidthRun) issue(at("body"), `body 不可有連續 ${L.bodyHalfWidthRun} 個以上的半形字元；程式碼放在 figure`);
    if (step.analogy) {
      analogies += 1;
      field(step.analogy.title, L.analogyTitle, at("analogy", "title"));
      writing(step.analogy.text, at("analogy", "text"));
      if (!step.analogy.title.startsWith(rules.analogy)) issue(at("analogy", "title"), `類比標題要以「${rules.analogy}」開頭`);
      const total = width(step.analogy.title) + width(step.analogy.text);
      if (total > L.analogyTotal) issue(at("analogy"), `類比標題加內容寬度 ${total}，上限 ${L.analogyTotal}`);
      if (analogies > L.analogiesPerLesson) issue(at("analogy"), `整堂課最多 ${L.analogiesPerLesson} 個類比`);
    }
    if (step.deeper) {
      field(step.deeper.summary, L.deeperSummary, at("deeper", "summary"));
      field(step.deeper.body, L.deeperBody, at("deeper", "body"));
    }
    field(step.recall.question, L.recallQuestion, at("recall", "question"));
    field(step.recall.answer, L.recallAnswer, at("recall", "answer"));
    field(step.recall.hint, L.recallHint, at("recall", "hint"));
    if (step.figure) checkFigureWriting(step, at("figure"), field, count, issue);
  });
}

function checkFigureWriting(
  step: Step, at: Path,
  field: (value: string | undefined, max: number, path: Path) => void,
  count: (length: number, range: { min: number; max: number }, path: Path, what: string) => void,
  issue: (path: Path, message: string) => void,
) {
  const figure = step.figure!;
  const p = (...path: Path): Path => [...at, ...path];
  switch (figure.kind) {
    case "annotated-code": {
      const C = L.code;
      if (lines(figure.source) > C.lines) issue(p("source"), `程式碼最多 ${C.lines} 行，現在 ${lines(figure.source)} 行`);
      count(figure.notes.length, C.notes, p("notes"), "註解");
      figure.notes.forEach((note, i) => field(note.text, C.note, p("notes", i, "text")));
      if (figure.output !== undefined && lines(figure.output) > C.outputLines) issue(p("output"), `輸出最多 ${C.outputLines} 行`);
      break;
    }
    case "state": {
      const S = L.state;
      count(figure.vars.length, S.vars, p("vars"), "變數");
      count(figure.rows.length, S.rows, p("rows"), "列");
      figure.rows.forEach((row, r) => {
        field(row.moment, S.moment, p("rows", r, "moment"));
        if (row.code !== undefined && width(row.code) > S.code) issue(p("rows", r, "code"), `寬度 ${width(row.code)}，上限 ${S.code}（全形 1、半形 0.5）`);
        field(row.output, S.output, p("rows", r, "output"));
      });
      field(figure.caption, S.caption, p("caption"));
      break;
    }
    case "compare": {
      const K = L.compare;
      count(figure.items.length, K.items, p("items"), "比較對象");
      count(figure.rows.length, K.rows, p("rows"), "列");
      figure.items.forEach((item, i) => field(item.title, K.itemTitle, p("items", i, "title")));
      figure.rows.forEach((row, r) => {
        field(row.label, K.label, p("rows", r, "label"));
        row.values.forEach((value, v) => field(value, K.value, p("rows", r, "values", v)));
      });
      field(figure.verdict, K.verdict, p("verdict"));
      break;
    }
    case "sequence": {
      const Q = L.sequence;
      count(figure.lanes.length, Q.lanes, p("lanes"), "軌道");
      count(figure.events.length, Q.events, p("events"), "事件");
      figure.lanes.forEach((lane, i) => field(lane.label, Q.laneLabel, p("lanes", i, "label")));
      figure.events.forEach((event, i) => {
        field(event.label, Q.eventLabel, p("events", i, "label"));
        field(event.output, Q.output, p("events", i, "output"));
      });
      field(figure.caption, Q.caption, p("caption"));
      break;
    }
    case "timeline": {
      const T = L.timeline;
      count(figure.rows.length, T.rows, p("rows"), "列");
      figure.rows.forEach((row, r) => {
        field(row.label, T.rowLabel, p("rows", r, "label"));
        row.marks?.forEach((mark, i) => field(mark.label, T.markLabel, p("rows", r, "marks", i, "label")));
        field(row.fire?.label, T.fireLabel, p("rows", r, "fire", "label"));
      });
      field(figure.caption, T.caption, p("caption"));
      break;
    }
    case "keyfact": {
      const F = L.keyfact;
      field(figure.value, F.value, p("value"));
      field(figure.unit, F.unit, p("unit"));
      field(figure.label, F.label, p("label"));
      field(figure.note, F.note, p("note"));
      break;
    }
    case "d2": {
      const D = L.d2;
      const graph = parseD2(figure.source);
      field(figure.title, D.title, p("title"));
      if (lines(figure.source) > D.lines) issue(p("source"), `D2 宣告最多 ${D.lines} 行，現在 ${lines(figure.source)} 行`);
      if (graph.allNodes.length > D.nodes.max) issue(p("source"), `節點最多 ${D.nodes.max} 個，現在 ${graph.allNodes.length} 個`);
      if (graph.edges.length > D.edges.max) issue(p("source"), `連線最多 ${D.edges.max} 條，現在 ${graph.edges.length} 條`);
      for (const group of graph.groups) field(group.label, D.label, p("source"));
      for (const node of graph.allNodes) {
        field(node.title, D.label, p("source"));
        field(node.detail, D.label, p("source"));
      }
      for (const edge of graph.edges) field(edge.label, D.label, p("source"));
      field(figure.caption, D.caption, p("caption"));
      break;
    }
    case "rubik-2x2": {
      const R = L.rubik;
      field(figure.title, R.title, p("title"));
      field(figure.caption, R.caption, p("caption"));
      break;
    }
  }
}

/** The shape plus every rule of the writing guide, for lessons written in `locale`. */
export const lessonV3ContentSchemaFor = (locale: V3Locale) =>
  lessonV3Schema.superRefine((lesson, ctx) => checkV3Writing(lesson, ctx, locale));
/** What generation must produce. Explain writes zh-TW lessons. */
export const lessonV3ContentSchema = lessonV3ContentSchemaFor("zh-TW");

// Compile-time guard: the zod shape and the shared interface describe the same lesson.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<z.infer<typeof lessonV3Schema>, LessonV3> = true;
void sameShape;
