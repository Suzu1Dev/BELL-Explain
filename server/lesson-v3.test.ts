import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { z } from "zod";
import { exampleLessons } from "../shared/examples.js";
import { DEPTHS } from "../shared/depth-rubric.js";
import { annotationSources } from "../shared/annotations.js";
import { parseD2 } from "../shared/d2.js";
import { lessonMarkdown } from "../shared/lesson-markdown.js";
import { figureHasCell, isLessonV3, lessonMinutes, lessonPartIds, syncFormatOf, V3_BANNED, width, type Figure, type LessonNoteV3, type LessonV3, type StoredLesson , V3_LIMITS } from "../shared/lesson-v3.js";
import type { Lesson, Source } from "../shared/types.js";
import { CloudSyncStore, createCloudApp } from "../cloud/app.js";
import { generateLesson, type ChatCall } from "./ai.js";
import { AppError } from "./errors.js";
import { KnowledgeService } from "./knowledge.js";
import { LearningStore } from "./learning.js";
import { lessonV3Instruction, normalizeLessonV3, V3_ATTEMPTS } from "./lesson-v3-generate.js";
import { lessonV3ContentSchema, lessonV3ContentSchemaFor, lessonV3Schema } from "./lesson-v3-schema.js";
import { apiBoundary } from "./prompts/boundary.js";
import { LESSON_V3_PROMPT } from "./prompts/lesson-v3.js";
import { LESSON_V3_EXAMPLE } from "./prompts/lesson-v3-example.js";
import { teachingSchema } from "./schema.js";
import { LessonStore } from "./store.js";
import { FORMAT_HELD_MESSAGE, SyncService } from "./sync.js";
import { lessonHash, syncLessonSchema } from "./sync-protocol.js";
import { withExample } from "./test-helpers.js";

// Fixtures are edited in place, so they are typed loosely; the validators are what is under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;
const example = (): Draft => structuredClone(LESSON_V3_EXAMPLE);
const locales = JSON.parse(readFileSync(new URL("./fixtures/closure-lesson.json", import.meta.url), "utf8")) as Record<"zh-TW" | "en", LessonV3>;
const issuesOf = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues;
};
const pathsOf = (schema: z.ZodType, value: unknown) => issuesOf(schema, value).map(issue => issue.path.join("."));
const structural = (value: unknown) => pathsOf(lessonV3Schema, value);
const content = (value: unknown, locale: "zh-TW" | "en" = "zh-TW") => pathsOf(lessonV3ContentSchemaFor(locale), value);
const edited = (edit: (lesson: Draft) => void, base: () => Draft = example) => { const lesson = base(); edit(lesson); return lesson; };
const full = (count: number) => "字".repeat(count);

// ---- figures the closure lesson does not use, swapped into step 3 ----------------
const withSequence = () => edited(lesson => {
  lesson.steps[2].figure = {
    kind: "sequence",
    lanes: [{ id: "stack", label: "呼叫堆疊" }, { id: "micro", label: "微任務" }, { id: "macro", label: "任務佇列" }],
    events: [
      { lane: "stack", label: "console.log(1)", output: "1" },
      { lane: "macro", label: "排入 setTimeout" },
      { lane: "micro", label: "Promise.then", output: "3" },
      { lane: "macro", label: "setTimeout 回呼", output: "2" },
    ],
    caption: "微任務先於下一個任務執行。",
  };
  lesson.steps[2].recall.blank = { kind: "sequence", event: 3 };
});
const withTimeline = () => edited(lesson => {
  lesson.steps[2].figure = {
    kind: "timeline", unit: "ms", span: 600,
    rows: [
      { label: "輸入", marks: [{ at: 0, label: "a" }, { at: 100, label: "ab" }] },
      { label: "計時器", ranges: [{ from: 0, to: 100, state: "cancel" }, { from: 100, to: 400, state: "wait", label: "等 300ms" }], fire: { at: 400, label: "送出搜尋" } },
    ],
    caption: "最後一次輸入後滿 300ms 才送出。",
  };
  delete lesson.steps[2].recall.blank;
});
const withKeyFact = () => edited(lesson => {
  lesson.steps[2].figure = { kind: "keyfact", value: "300", unit: "ms", label: "防抖等待時間", note: "停止輸入滿 300ms 才送出一次請求。" };
  lesson.steps[2].recall.blank = { kind: "keyfact" };
});

test("width counts full-width characters as 1 and half-width as 0.5, rounded up", () => {
  assert.equal(width("閉包"), 2);
  assert.equal(width("ab"), 1);
  assert.equal(width("abc"), 2);
  assert.equal(width(""), 0);
  assert.equal(width("，"), 1);
  assert.equal(width("`count`"), 4);
  assert.deepEqual(content(edited(lesson => { lesson.title = full(V3_LIMITS.title); })), []);
  assert.deepEqual(content(edited(lesson => { lesson.title = full(V3_LIMITS.title + 1); })), ["title"]);
  assert.deepEqual(content(edited(lesson => { lesson.title = "a".repeat(V3_LIMITS.title * 2); })), []);
  assert.deepEqual(content(edited(lesson => { lesson.title = "a".repeat(V3_LIMITS.title * 2 + 1); })), ["title"]);
});

test("the author's few-shot is the copy team's zh-TW closure lesson and passes both levels with no issues", () => {
  // The prompt shows the model this lesson as the standard, so it must be the reviewed copy and valid as it is.
  assert.deepEqual(LESSON_V3_EXAMPLE, locales["zh-TW"]);
  assert.deepEqual(issuesOf(lessonV3ContentSchemaFor("zh-TW"), LESSON_V3_EXAMPLE), []);
  assert.deepEqual(structural(LESSON_V3_EXAMPLE), []);
  assert.deepEqual(content(LESSON_V3_EXAMPLE), []);
  assert.equal(lessonV3ContentSchema.safeParse(LESSON_V3_EXAMPLE).success, true);
  assert.equal(lessonMinutes(LESSON_V3_EXAMPLE), 4);
  // Parsing never rewrites: what is stored is what was validated.
  assert.deepEqual(lessonV3ContentSchema.parse(LESSON_V3_EXAMPLE), LESSON_V3_EXAMPLE);
  for (const base of [withSequence, withTimeline, withKeyFact]) assert.deepEqual(content(base()), [], base.name);
});

test("the copy team's closure lesson passes the rules of its own language with no issues", () => {
  assert.deepEqual(issuesOf(lessonV3ContentSchemaFor("zh-TW"), locales["zh-TW"]), []);
  assert.deepEqual(issuesOf(lessonV3ContentSchemaFor("en"), locales.en), []);
  // Each language's question mark and analogy opening are its own.
  const enAsZh = content(locales.en, "zh-TW");
  for (const path of ["question", "steps.0.analogy.title", "steps.2.analogy.title", "steps.0.body"]) assert.ok(enAsZh.includes(path), `en as zh-TW: ${path}`);
  const zhAsEn = content(locales["zh-TW"], "en");
  for (const path of ["question", "steps.0.analogy.title", "steps.2.analogy.title"]) assert.ok(zhAsEn.includes(path), `zh-TW as en: ${path}`);
});

test("English lessons: ? and Like are required, banned phrases match in any case, code stays out of prose", () => {
  const en = () => structuredClone(locales.en) as Draft;
  assert.deepEqual(content(edited(lesson => { lesson.question = "Why does a function remember count"; }, en), "en"), ["question"]);
  assert.deepEqual(content(edited(lesson => { lesson.question = "Why does a function remember count？"; }, en), "en"), ["question"]);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].analogy.title = "A spare key"; }, en), "en"), ["steps.0.analogy.title"]);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].analogy.title = "like a key"; }, en), "en"), ["steps.0.analogy.title"]);
  for (const body of ["Let's look at it.", "let’s look at it.", "In this lesson we look.", "IN THIS ARTICLE we look.", "It works!", "As shown above, it works."]) {
    const lesson = edited(draft => { draft.steps[0].body = body; }, en);
    assert.deepEqual(content(lesson, "en"), ["steps.0.body"], body);
  }
  // Inline code is not prose: `!` and `let's ` inside backticks are fine.
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "Use `a !== b` here."; }, en), "en"), []);
  // English is all half-width, so the code-in-prose run applies to zh-TW only; newlines and fences apply to both.
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "a".repeat(40); }, en), "en"), []);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "First.\nSecond."; }, en), "en"), ["steps.0.body"]);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "See ```count += 1``` here."; }, en), "en"), ["steps.0.body"]);
  // English sentences end before a space, so a version number is not a full stop.
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "Node.js 22 runs it. Version 0.5 did too. That is all."; }, en), "en"), []);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = Array.from({ length: V3_LIMITS.bodySentences + 1 }, (_, idx) => `Sentence ${idx + 1}.`).join(" "); }, en), "en"), ["steps.0.body"]);
});

test("zh-TW body: no newline, no fenced code, and fewer than 40 half-width characters in a row", () => {
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "第一句。\n第二句。"; })), ["steps.0.body"]);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = "看 ```count``` 這裡。"; })), ["steps.0.body"]);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = `程式${"a".repeat(V3_LIMITS.bodyHalfWidthRun)}。`; })), ["steps.0.body"]);
  assert.deepEqual(content(edited(lesson => { lesson.steps[0].body = `程式${"a".repeat(V3_LIMITS.bodyHalfWidthRun - 1)}。`; })), []);
});

type Rule = { name: string; path: string; edit: (lesson: Draft) => void; base?: () => Draft };
const at = (step: number, ...rest: (string | number)[]) => ["steps", step, ...rest].join(".");
// One violation per fixture, each against a lesson that otherwise passes.
const writingRules: Rule[] = [
  // §10.1 widths
  { name: "title width", path: "title", edit: l => { l.title = full(V3_LIMITS.title + 1); } },
  { name: "question width", path: "question", edit: l => { l.question = `${full(V3_LIMITS.question)}？`; } },
  { name: "answer width", path: "answer", edit: l => { l.answer = `${full(V3_LIMITS.answer)}。`; } },
  { name: "lead width", path: at(0, "lead"), edit: l => { l.steps[0].lead = full(V3_LIMITS.lead + 1); } },
  { name: "body width", path: at(0, "body"), edit: l => { l.steps[0].body = `${full(V3_LIMITS.body)}。`; } },
  { name: "analogy title width", path: at(0, "analogy", "title"), edit: l => { l.steps[0].analogy = { title: `像${full(V3_LIMITS.analogyTitle)}`, text: "短。" }; } },
  { name: "analogy total width", path: at(0, "analogy"), edit: l => { l.steps[0].analogy.text = full(V3_LIMITS.analogyTotal); } },
  { name: "deeper summary width", path: at(1, "deeper", "summary"), edit: l => { l.steps[1].deeper.summary = full(V3_LIMITS.deeperSummary + 1); } },
  { name: "deeper body width", path: at(1, "deeper", "body"), edit: l => { l.steps[1].deeper.body = `${full(V3_LIMITS.deeperBody)}。`; } },
  { name: "recall question width", path: at(0, "recall", "question"), edit: l => { l.steps[0].recall.question = full(V3_LIMITS.recallQuestion + 1); } },
  { name: "recall answer width", path: at(0, "recall", "answer"), edit: l => { l.steps[0].recall.answer = full(V3_LIMITS.recallAnswer + 1); } },
  { name: "recall hint width", path: at(0, "recall", "hint"), edit: l => { l.steps[0].recall.hint = full(V3_LIMITS.recallHint + 1); } },
  { name: "follow-up width", path: "followUps.0", edit: l => { l.followUps[0] = full(V3_LIMITS.followUp + 1); } },
  { name: "code note width", path: at(0, "figure", "notes", 0, "text"), edit: l => { l.steps[0].figure.notes[0].text = full(V3_LIMITS.code.note + 1); } },
  { name: "state moment width", path: at(1, "figure", "rows", 0, "moment"), edit: l => { l.steps[1].figure.rows[0].moment = full(V3_LIMITS.state.moment + 1); } },
  { name: "state code width", path: at(1, "figure", "rows", 0, "code"), edit: l => { l.steps[1].figure.rows[0].code = "a".repeat(V3_LIMITS.state.code * 2 + 1); } },
  { name: "state output width", path: at(1, "figure", "rows", 1, "output"), edit: l => { l.steps[1].figure.rows[1].output = full(V3_LIMITS.state.output + 1); } },
  { name: "state caption width", path: at(1, "figure", "caption"), edit: l => { l.steps[1].figure.caption = full(V3_LIMITS.state.caption + 1); } },
  { name: "compare item width", path: at(2, "figure", "items", 0, "title"), edit: l => { l.steps[2].figure.items[0].title = full(V3_LIMITS.compare.itemTitle + 1); } },
  { name: "compare label width", path: at(2, "figure", "rows", 0, "label"), edit: l => { l.steps[2].figure.rows[0].label = full(V3_LIMITS.compare.label + 1); } },
  { name: "compare value width", path: at(2, "figure", "rows", 0, "values", 1), edit: l => { l.steps[2].figure.rows[0].values[1] = full(V3_LIMITS.compare.value + 1); } },
  { name: "compare verdict width", path: at(2, "figure", "verdict"), edit: l => { l.steps[2].figure.verdict = full(V3_LIMITS.compare.verdict + 1); } },
  { name: "lane label width", path: at(2, "figure", "lanes", 0, "label"), base: withSequence, edit: l => { l.steps[2].figure.lanes[0].label = full(V3_LIMITS.sequence.laneLabel + 1); } },
  { name: "event label width", path: at(2, "figure", "events", 0, "label"), base: withSequence, edit: l => { l.steps[2].figure.events[0].label = full(V3_LIMITS.sequence.eventLabel + 1); } },
  { name: "event output width", path: at(2, "figure", "events", 0, "output"), base: withSequence, edit: l => { l.steps[2].figure.events[0].output = full(V3_LIMITS.sequence.output + 1); } },
  { name: "sequence caption width", path: at(2, "figure", "caption"), base: withSequence, edit: l => { l.steps[2].figure.caption = full(V3_LIMITS.sequence.caption + 1); } },
  { name: "timeline row label width", path: at(2, "figure", "rows", 0, "label"), base: withTimeline, edit: l => { l.steps[2].figure.rows[0].label = full(V3_LIMITS.timeline.rowLabel + 1); } },
  { name: "timeline mark width", path: at(2, "figure", "rows", 0, "marks", 0, "label"), base: withTimeline, edit: l => { l.steps[2].figure.rows[0].marks[0].label = full(V3_LIMITS.timeline.markLabel + 1); } },
  { name: "timeline fire width", path: at(2, "figure", "rows", 1, "fire", "label"), base: withTimeline, edit: l => { l.steps[2].figure.rows[1].fire.label = full(V3_LIMITS.timeline.fireLabel + 1); } },
  { name: "timeline caption width", path: at(2, "figure", "caption"), base: withTimeline, edit: l => { l.steps[2].figure.caption = full(V3_LIMITS.timeline.caption + 1); } },
  { name: "keyfact value width", path: at(2, "figure", "value"), base: withKeyFact, edit: l => { l.steps[2].figure.value = full(V3_LIMITS.keyfact.value + 1); } },
  { name: "keyfact unit width", path: at(2, "figure", "unit"), base: withKeyFact, edit: l => { l.steps[2].figure.unit = full(V3_LIMITS.keyfact.unit + 1); } },
  { name: "keyfact label width", path: at(2, "figure", "label"), base: withKeyFact, edit: l => { l.steps[2].figure.label = full(V3_LIMITS.keyfact.label + 1); } },
  { name: "keyfact note width", path: at(2, "figure", "note"), base: withKeyFact, edit: l => { l.steps[2].figure.note = full(V3_LIMITS.keyfact.note + 1); } },
  // §10.2 counts
  { name: "one step", path: "steps", edit: l => { l.steps = [l.steps[0]]; } },
  { name: "too many steps", path: "steps", edit: l => { while (l.steps.length <= V3_LIMITS.steps.max) l.steps.push({ ...structuredClone(l.steps[0]), id: `s${l.steps.length + 1}`, analogy: undefined }); } },
  { name: "too many follow-ups", path: "followUps", edit: l => { l.followUps = Array.from({ length: V3_LIMITS.followUps.max + 1 }, (_, idx) => `問題${idx + 1}？`); } },
  { name: "no code notes", path: at(0, "figure", "notes"), edit: l => { l.steps[0].figure.notes = []; } },
  { name: "too many code notes", path: at(0, "figure", "notes"), edit: l => { while (l.steps[0].figure.notes.length <= V3_LIMITS.code.notes.max) l.steps[0].figure.notes.push({ line: 2, text: "再一個註解。" }); } },
  { name: "too many code lines", path: at(0, "figure", "source"), edit: l => { l.steps[0].figure.source = Array.from({ length: V3_LIMITS.code.lines + 1 }, (_, idx) => `// ${idx}`).join("\n"); l.steps[0].figure.focus = [1, 2, 3]; l.steps[0].figure.notes = [{ line: 2, text: "重點。" }]; } },
  { name: "too many output lines", path: at(0, "figure", "output"), edit: l => { l.steps[0].figure.output = Array.from({ length: V3_LIMITS.code.outputLines + 1 }, (_, idx) => String(idx + 1)).join("\n"); } },
  { name: "too many state vars", path: at(1, "figure", "vars"), edit: l => {
    const figure = l.steps[1].figure;
    while (figure.vars.length <= V3_LIMITS.state.vars.max) {
      const name = `v${figure.vars.length}`;
      figure.vars.push(name);
      for (const row of figure.rows) row.values[name] = { to: "0" };
    }
  } },
  { name: "one state row", path: at(1, "figure", "rows"), edit: l => { l.steps[1].figure.rows = l.steps[1].figure.rows.slice(0, 1); delete l.steps[1].recall.blank; } },
  { name: "too many state rows", path: at(1, "figure", "rows"), edit: l => { const rows = l.steps[1].figure.rows; while (rows.length <= V3_LIMITS.state.rows.max) rows.push(structuredClone(rows[1])); } },
  { name: "one compare item", path: at(2, "figure", "items"), edit: l => {
    const figure = l.steps[2].figure;
    figure.items = figure.items.slice(0, 1);
    for (const row of figure.rows) row.values = row.values.slice(0, 1);
    delete l.steps[2].recall.blank;
  } },
  { name: "four compare items", path: at(2, "figure", "items"), edit: l => {
    const figure = l.steps[2].figure;
    figure.items.push({ title: "c" }, { title: "d" });
    for (const row of figure.rows) row.values.push("c", "d");
  } },
  { name: "one compare row", path: at(2, "figure", "rows"), edit: l => { l.steps[2].figure.rows = l.steps[2].figure.rows.slice(0, 1); delete l.steps[2].recall.blank; } },
  { name: "too many compare rows", path: at(2, "figure", "rows"), edit: l => { const rows = l.steps[2].figure.rows; while (rows.length <= V3_LIMITS.compare.rows.max) rows.push(structuredClone(rows[0])); } },
  { name: "one lane", path: at(2, "figure", "lanes"), base: withSequence, edit: l => {
    const figure = l.steps[2].figure;
    figure.lanes = figure.lanes.slice(0, 1);
    for (const event of figure.events) event.lane = "stack";
  } },
  { name: "five lanes", path: at(2, "figure", "lanes"), base: withSequence, edit: l => { l.steps[2].figure.lanes.push({ id: "d", label: "四" }, { id: "e", label: "五" }); } },
  { name: "two events", path: at(2, "figure", "events"), base: withSequence, edit: l => { l.steps[2].figure.events = l.steps[2].figure.events.slice(0, 2); delete l.steps[2].recall.blank; } },
  { name: "nine events", path: at(2, "figure", "events"), base: withSequence, edit: l => { const events = l.steps[2].figure.events; events.push(...events.map((event: Draft) => ({ ...event })), { lane: "stack", label: "結束" }); } },
  { name: "five timeline rows", path: at(2, "figure", "rows"), base: withTimeline, edit: l => { const rows = l.steps[2].figure.rows; rows.push(...rows.map((row: Draft) => structuredClone(row)), { label: "其他" }); } },
  // §10.4 banned phrases and symbols; §10.5 analogies; §10.6 prose shape
  ...V3_BANNED.map((phrase): Rule => ({ name: `banned ${phrase}`, path: at(0, "body"), edit: l => { l.steps[0].body = `這是${phrase}一段話。`; } })),
  { name: "emoji in title", path: "title", edit: l => { l.title = "閉包 ✅"; } },
  { name: "circled number in lead", path: at(0, "lead"), edit: l => { l.steps[0].lead = "① 回傳的函式"; } },
  { name: "numbered lead 02 /", path: at(0, "lead"), edit: l => { l.steps[0].lead = "02 / 回傳的函式"; } },
  { name: "numbered lead 1.", path: at(0, "lead"), edit: l => { l.steps[0].lead = "1. 回傳的函式"; } },
  { name: "two-sentence lead", path: at(0, "lead"), edit: l => { l.steps[0].lead = "第一句。第二句"; } },
  { name: "too many body sentences", path: at(0, "body"), edit: l => { l.steps[0].body = Array.from({ length: V3_LIMITS.bodySentences + 1 }, () => "一。").join(""); } },
  { name: "analogy without 像", path: at(0, "analogy", "title"), edit: l => { l.steps[0].analogy.title = "帶走鑰匙"; } },
  { name: "too many analogies", path: at(V3_LIMITS.analogiesPerLesson, "analogy"), edit: l => {
    while (l.steps.length <= V3_LIMITS.analogiesPerLesson) l.steps.push({ ...structuredClone(l.steps[1]), id: `s${l.steps.length + 1}` });
    for (let idx = 0; idx <= V3_LIMITS.analogiesPerLesson; idx++) l.steps[idx].analogy = { title: "像相簿", text: "翻到同一頁。" };
  } },
  { name: "question without ？", path: "question", edit: l => { l.question = "函式為什麼記得變數"; } },
  { name: "too many answer sentences", path: "answer", edit: l => { l.answer = Array.from({ length: V3_LIMITS.answerSentences + 1 }, () => "一。").join(""); } },
  { name: "two emphases", path: "answer", edit: l => { l.answer = "**一**和**二**。"; } },
];
// §10.3: references resolve. Stored notes are held to these too.
const referenceRules: Rule[] = [
  { name: "focus beyond the source", path: at(0, "figure", "focus", 3), edit: l => { l.steps[0].figure.focus.push(20); } },
  { name: "note on a line not in focus", path: at(0, "figure", "notes", 0, "line"), edit: l => { l.steps[0].figure.notes[0].line = 5; } },
  { name: "state row missing a var", path: at(1, "figure", "rows", 1, "values", "count"), edit: l => { delete l.steps[1].figure.rows[1].values.count; } },
  { name: "compare values per item", path: at(2, "figure", "rows", 0, "values"), edit: l => { l.steps[2].figure.rows[0].values.pop(); } },
  { name: "unknown lane", path: at(2, "figure", "events", 0, "lane"), base: withSequence, edit: l => { l.steps[2].figure.events[0].lane = "nope"; } },
  { name: "duplicate lane id", path: at(2, "figure", "lanes", 1, "id"), base: withSequence, edit: l => { l.steps[2].figure.lanes[1].id = "stack"; } },
  { name: "mark beyond span", path: at(2, "figure", "rows", 0, "marks", 1, "at"), base: withTimeline, edit: l => { l.steps[2].figure.rows[0].marks[1].at = 700; } },
  { name: "range beyond span", path: at(2, "figure", "rows", 1, "ranges", 1, "to"), base: withTimeline, edit: l => { l.steps[2].figure.rows[1].ranges[1].to = 700; } },
  { name: "fire beyond span", path: at(2, "figure", "rows", 1, "fire", "at"), base: withTimeline, edit: l => { l.steps[2].figure.rows[1].fire.at = 700; } },
  { name: "empty range", path: at(2, "figure", "rows", 1, "ranges", 0, "to"), base: withTimeline, edit: l => { l.steps[2].figure.rows[1].ranges[0].from = 100; } },
  { name: "blank of another figure kind", path: at(1, "recall", "blank"), edit: l => { l.steps[1].recall.blank = { kind: "compare", item: 0, row: 0 }; } },
  { name: "blank row out of range", path: at(1, "recall", "blank"), edit: l => { l.steps[1].recall.blank = { kind: "state-output", row: 9 }; } },
  { name: "blank output on a row without one", path: at(1, "recall", "blank"), edit: l => { l.steps[1].recall.blank = { kind: "state-output", row: 0 }; } },
  { name: "blank var not in vars", path: at(1, "recall", "blank"), edit: l => { l.steps[1].recall.blank = { kind: "state", row: 1, var: "other" }; } },
  // Names every object inherits must still have a value of their own.
  ...["constructor", "toString", "hasOwnProperty", "__proto__"].flatMap((name): Rule[] => [
    { name: `state var ${name} with no value`, path: at(1, "figure", "rows", 0, "values", name), edit: l => { l.steps[1].figure.vars.push(name); } },
    { name: `blank on var ${name} with no value`, path: at(1, "recall", "blank"), edit: l => { l.steps[1].figure.vars.push(name); l.steps[1].recall.blank = { kind: "state", row: 1, var: name }; } },
  ]),
  { name: "blank compare cell out of range", path: at(2, "recall", "blank"), edit: l => { l.steps[2].recall.blank = { kind: "compare", item: 2, row: 0 }; } },
  { name: "blank sequence event out of range", path: at(2, "recall", "blank"), base: withSequence, edit: l => { l.steps[2].recall.blank = { kind: "sequence", event: 4 }; } },
  { name: "blank on a step without a figure", path: at(0, "recall", "blank"), edit: l => { delete l.steps[0].figure; l.steps[0].recall.blank = { kind: "keyfact" }; } },
  { name: "keyfact blank on another figure", path: at(0, "recall", "blank"), edit: l => { l.steps[0].recall.blank = { kind: "keyfact" }; } },
  { name: "duplicate step id", path: at(1, "id"), edit: l => { l.steps[1].id = "s1"; } },
  { name: "minutes is not a model field", path: "", edit: l => { l.minutes = 3; } },
  { name: "unknown figure kind", path: at(0, "figure", "kind"), edit: l => { l.steps[0].figure.kind = "diagram"; } },
];

test("each writing rule (§10.1, .2, .4–.6) is enforced on its own field; the stored shape accepts it", () => {
  for (const rule of writingRules) {
    const lesson = edited(rule.edit, rule.base);
    assert.deepEqual(structural(lesson), [], `${rule.name}: structure`);
    const found = content(lesson);
    assert.ok(found.includes(rule.path), `${rule.name}: expected ${rule.path}, got ${JSON.stringify(found)}`);
  }
  // Every issue names its phrase, so the repair round knows what to change.
  for (const phrase of V3_BANNED) {
    const messages = issuesOf(lessonV3ContentSchema, edited(l => { l.steps[0].body = `這是${phrase}一段話。`; })).map(issue => issue.message);
    assert.ok(messages.some(message => message.includes(phrase)), phrase);
  }
});

test("each reference rule (§10.3) is enforced by both levels, at the field that is wrong", () => {
  for (const rule of referenceRules) {
    const lesson = edited(rule.edit, rule.base);
    for (const [level, found] of [["structure", structural(lesson)], ["content", content(lesson)]] as const)
      assert.ok(found.includes(rule.path), `${rule.name} (${level}): expected ${JSON.stringify(rule.path)}, got ${JSON.stringify(found)}`);
  }
});

test("a recall blank names a state cell only when that row has its own value for the var", () => {
  const figure = (values: Record<string, unknown>): Figure => ({ kind: "state", vars: ["count", "constructor"], rows: [{ moment: "建立", values: values as never }, { moment: "呼叫", values: values as never }] });
  const blank = (name: string) => ({ kind: "state" as const, row: 0, var: name });
  assert.equal(figureHasCell(figure({ count: { to: "0" } }), blank("count")), true);
  assert.equal(figureHasCell(figure({ count: { to: "0" } }), blank("constructor")), false);
  assert.equal(figureHasCell(figure({ count: { to: "0" }, constructor: { to: "1" } }), blank("constructor")), true);
  assert.equal(figureHasCell(figure({ count: { to: "0" } }), blank("toString")), false);
  // A var named after Object's members is fine once every row gives it a value.
  const named = edited(l => {
    l.steps[1].figure.vars.push("constructor");
    for (const row of l.steps[1].figure.rows) row.values.constructor = { to: "0" };
    l.steps[1].recall.blank = { kind: "state", row: 1, var: "constructor" };
  });
  assert.deepEqual(structural(named), []);
  assert.deepEqual(content(named), []);
  // The parser drops a `__proto__` key, so that var can never have a value and is refused.
  const proto = edited(l => { l.steps[1].figure.vars.push("__proto__"); });
  for (const row of proto.steps[1].figure.rows) Object.defineProperty(row.values, "__proto__", { value: { to: "0" }, enumerable: true });
  assert.ok(structural(JSON.parse(JSON.stringify(proto))).includes(at(1, "figure", "rows", 0, "values", "__proto__")));
});

test("zh-TW sentences end at 。？！, and at ? or ! only where a sentence can end", () => {
  const lead = (value: string) => content(edited(l => { l.steps[0].lead = value; })).includes(at(0, "lead"));
  // Code left outside backticks is one sentence.
  for (const value of ["比較 a !== b 的結果", "讀取 obj?.x 的值", "a ?? b 取右邊", "條件 x ? y : z 選一個", "用 !flag 反轉", "非空斷言 el!.focus()"])
    assert.equal(lead(value), false, value);
  // A half-width ? or ! after a word ends a sentence before a space, a full-width character or the end.
  for (const value of ["為什麼是 undefined? 因為沒有回傳", "是 null?答案在下面", "是 `null`? 對", "真的嗎?!是的"])
    assert.equal(lead(value), true, value);
  assert.equal(lead("第一句？第二句"), true);
  // The message says how many sentences were counted, so a repair knows how far to go.
  const overBody = Array.from({ length: V3_LIMITS.bodySentences + 1 }, () => "一。").join("");
  const overAnswer = Array.from({ length: V3_LIMITS.answerSentences + 1 }, () => "一。").join("");
  const messages = issuesOf(lessonV3ContentSchema, edited(l => { l.steps[0].lead = "第一句。第二句"; l.steps[0].body = overBody; l.answer = overAnswer; })).map(issue => issue.message);
  for (const expected of [
    "lead 只能有一句，現在 2 句",
    `body 最多 ${V3_LIMITS.bodySentences} 句，現在 ${V3_LIMITS.bodySentences + 1} 句`,
    `answer 最多 ${V3_LIMITS.answerSentences} 句，現在 ${V3_LIMITS.answerSentences + 1} 句`,
  ])
    assert.ok(messages.includes(expected), `${expected} in ${JSON.stringify(messages)}`);
  const body = (value: string) => content(edited(l => { l.steps[0].body = value; })).includes(at(0, "body"));
  assert.equal(body("若 a !== b 就略過。改讀 obj?.x 的值。最後回傳 a ?? b。"), false);
  assert.equal(body(`真的嗎? 是的。${Array.from({ length: V3_LIMITS.bodySentences - 1 }, () => "二。").join("")}`), true);
  // English is unchanged: a sentence ends at . ? or ! before a space.
  const en = (value: string) => content(edited(l => { l.steps[0].lead = value; }, () => structuredClone(locales.en)), "en").includes(at(0, "lead"));
  assert.equal(en("Read obj?.x first"), false);
  assert.equal(en("Is it null? It is not"), true);
});

test("banned phrases and symbols are allowed inside inline code", () => {
  assert.deepEqual(content(edited(l => { l.steps[0].body = "`讓我們` 只是字串。"; })), []);
  assert.deepEqual(content(edited(l => { l.steps[0].body = "`！` 是全形驚嘆號，`點子` 是變數名稱。"; })), []);
});

// ---- the original format is untouched -------------------------------------
const GOLDEN: Record<string, [string, string]> = {
  "demo-closure": ["0c0685415dc98c6c9f0ec66b1851339398bb0ed77851008e276aef9ef22792f3", "48cb4724909462afb7643dbe21487e6227cfe9f2d65d49cb7300a64ebdca0181"],
  "demo-event-loop": ["4fa477b9b17f6e18d8baae8482f83916a91bdaee9626c3e36fd4f3225e85b664", "b41823d15a926392b6ca2edcf41ba5fefdb8345573552a3df8e5c1ec4847d553"],
  "demo-debounce": ["f29d4367a99372cb0fb7f24b8efb742725fc0e9842a876faacd4b7f09f03c182", "e08bf27386d71b699d0f31210abc91df71a36234f6fd65723a27fd545acbc72a"],
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test("original-format notes keep their hash, markdown and sync shape byte for byte", () => {
  assert.deepEqual(exampleLessons.map(lesson => lesson.id).sort(), Object.keys(GOLDEN).sort());
  for (const lesson of exampleLessons) {
    const [hash, markdown] = GOLDEN[lesson.id];
    assert.equal(lessonHash(lesson), hash, lesson.id);
    assert.equal(sha256(lessonMarkdown(lesson)), markdown, lesson.id);
    assert.equal(isLessonV3(lesson), false);
    const parsed = syncLessonSchema.parse(structuredClone(lesson));
    assert.deepEqual(parsed, lesson);
    assert.equal(lessonHash(parsed), hash);
    // A format key always means the new format: never read as an original note with a stray field.
    for (const format of [3, 2]) assert.equal(syncLessonSchema.safeParse({ ...structuredClone(lesson), format }).success, false, `${lesson.id} format ${format}`);
  }
});

// ---- a saved v3 note through every read path ----------------------------------
const CREATED = "2026-11-09T00:00:00.000Z";
const v3Source: Source = { kind: "code", label: "JavaScript 閉包與獨立計數器", content: "function createCounter(initial = 0) { let count = initial; }" };
function noteV3(id = "v3-note", extra: Partial<LessonNoteV3> = {}): LessonNoteV3 {
  const { source: _generated, ...lesson } = structuredClone(LESSON_V3_EXAMPLE);
  return { ...lesson, id, category: "JavaScript", tags: ["閉包"], connections: [], source: v3Source, createdAt: CREATED, updatedAt: CREATED, favorite: false, isDemo: false, ...extra };
}
const annotation = { id: "term-1", term: "閉包", explanation: "函式和它記得的變數。", analogy: "像帶著鑰匙。", sourceKey: "s1:body", quote: "函式加上它留住的變數，就是閉包", createdAt: CREATED };

test("a v3 note syncs unchanged, with its annotation, and keeps its hash", () => {
  const note = noteV3("v3-note", { annotations: [annotation] });
  const parsed = syncLessonSchema.parse(structuredClone(note));
  assert.deepEqual(parsed, note);
  assert.equal(lessonHash(parsed), lessonHash(note));
  assert.equal(isLessonV3(parsed), true);
  assert.equal(syncLessonSchema.safeParse({ ...structuredClone(note), annotations: [{ ...annotation, sourceKey: "summary" }] }).success, false);
  assert.equal(syncLessonSchema.safeParse({ ...structuredClone(note), minutes: 3 }).success, false);
  // Stored notes are held to the shape, not today's writing limits.
  assert.equal(syncLessonSchema.safeParse({ ...structuredClone(note), title: full(40) }).success, true);
  assert.deepEqual(annotationSources(note).map(source => source.key), ["answer", "s1:lead", "s1:body", "s2:lead", "s2:body", "s3:lead", "s3:body"]);
  assert.deepEqual(lessonPartIds(note), ["s1", "s2", "s3"]);
});

test("the store keeps v3 notes as written and resolves links to their step ids", () => {
  const store = new LessonStore(":memory:", exampleLessons);
  try {
    const target = noteV3("v3-target");
    const old = exampleLessons[0];
    const linking = noteV3("v3-linking", { connections: [
      { targetId: "v3-target", sectionId: "s3", reason: "同一個工廠函式" },
      { targetId: "v3-target", sectionId: "s9", reason: "不存在的步驟" },
      { targetId: old.id, sectionId: old.sections[0].id, reason: "舊格式的段落" },
    ] });
    store.save(target);
    store.save(linking);
    assert.deepEqual(store.getRaw("v3-target"), target);
    const kept = [["v3-target", "s3"], [old.id, old.sections[0].id]];
    assert.deepEqual(store.get("v3-linking")!.connections.map(link => [link.targetId, link.sectionId]), kept);
    assert.deepEqual(store.list().find(lesson => lesson.id === "v3-linking")!.connections.map(link => [link.targetId, link.sectionId]), kept);
  } finally {
    store.close();
  }
});

test("review: a v3 note makes term cards only and has no self-check list", () => {
  const learning = new LearningStore(":memory:", { timeZone: "Asia/Taipei" });
  try {
    const note = noteV3("v3-review", { annotations: [annotation] });
    learning.syncCards([note]);
    const cards = learning.due([note], new Date(Date.now() + 60_000));
    assert.deepEqual(cards.map(card => [card.kind, card.lessonId]), [["term", "v3-review"]]);
    assert.deepEqual(learning.checks(note), []);
  } finally {
    learning.close();
  }
});

test("search indexes a v3 note by step, figure text included", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bell-v3-knowledge-"));
  const knowledge = new KnowledgeService({ dbPath: join(directory, "knowledge.sqlite"), cacheDir: join(directory, "cache") });
  t.after(async () => { await knowledge.close(); rmSync(directory, { recursive: true, force: true }); });
  knowledge.upsertLesson(noteV3("v3-search"));
  await knowledge.waitForIdle();
  const found = (await knowledge.search("anotherCounter")).results;
  assert.ok(found.length > 0);
  assert.equal(found[0].ownerId, "v3-search");
  assert.equal(found[0].sectionId, "s3");
});

test("markdown export writes the answer first, then each step with its figure as text", () => {
  const markdown = lessonMarkdown(noteV3());
  for (const part of [
    "# 閉包：函式的隨身背包", "分類：JavaScript · 閉包", "**外層函式都跑完了，裡面的變數怎麼還在？**",
    "## 交出去的函式，還抓著外層的 `count`", "**counter.js**", "```javascript", "- 第 2 行：", "> 像留著備份鑰匙：",
    "**回想**：", "答案：", "| 時刻 | 程式 | count | 輸出 |", "| 第 3 次呼叫 | counter() | 2 → 3 | 3 |",
    "**深入：別處改了變數，閉包看到的也會變**", "|  | `counter` | `anotherCounter` |", "## 延伸問題",
  ]) assert.ok(markdown.includes(part), part);
  assert.ok(markdown.indexOf("**外層函式都跑完了") < markdown.indexOf("## 交出去的函式"));
});

// ---- sync: a new client never sends v3 to a cloud that cannot keep it -----------
const token = "integration-test-secret-with-at-least-thirty-two-characters";
class Notes {
  data = new Map<string, StoredLesson>();
  list() { return [...this.data.values()].map(value => structuredClone(value)); }
  get(id: string) { const value = this.data.get(id); return value ? structuredClone(value) : undefined; }
  save(value: StoredLesson) { this.data.set(value.id, structuredClone(value)); }
  delete(id: string) { return this.data.delete(id); }
}
async function listen(server: Server) {
  return new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}
/** A cloud, optionally an old build that has no capabilities endpoint. */
async function cloudSetup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "bell-v3-sync-"));
  const cloud = new CloudSyncStore(join(directory, "cloud.sqlite"));
  const app = createCloudApp({ store: cloud, token });
  let old = false;
  const server = createServer((req, res) => {
    if (old && req.url?.startsWith("/v1/capabilities")) { res.statusCode = 404; res.end(); return; }
    app(req, res);
  });
  const remoteUrl = await listen(server);
  const clients: SyncService[] = [];
  const client = (name: string) => {
    const notes = new Notes();
    const sync = new SyncService({ path: join(directory, `${name}.sqlite`), lessons: notes, intervalMs: 60_000 });
    clients.push(sync);
    return { notes, sync, connect: () => sync.configure({ remoteUrl, token, uploadExisting: true }) };
  };
  t.after(async () => {
    for (const sync of clients) await sync.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    cloud.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { cloud, client, setOld: (value: boolean) => { old = value; } };
}

test("sync carries a v3 note to another device unchanged", async t => {
  const env = await cloudSetup(t);
  const a = env.client("a");
  const b = env.client("b");
  const note = noteV3("v3-sync", { annotations: [annotation] });
  a.notes.save(note);
  await a.connect();
  await b.connect();
  assert.deepEqual(b.notes.get("v3-sync"), note);
  assert.equal(env.cloud.pull(0).changes[0].document.hash, lessonHash(note));
  const changed = { ...note, favorite: true, updatedAt: "2026-11-10T00:00:00.000Z" };
  a.notes.save(changed);
  a.sync.updatedLesson(changed);
  await a.sync.sync();
  await b.sync.sync();
  assert.deepEqual(b.notes.get("v3-sync"), changed);
  assert.ok(!a.sync.status().lastError);
});

test("an old cloud gets the original notes; v3 notes wait on the device until it is updated", async t => {
  const env = await cloudSetup(t);
  env.setOld(true);
  const a = env.client("a");
  const old: Lesson = { ...structuredClone(exampleLessons[0]), id: "old-note", isDemo: false, connections: [] };
  a.notes.save(old);
  a.notes.save(noteV3("v3-held"));
  // An original-format note marked 「整理失敗」 waits too: an old cloud would drop the mark.
  const marked: Lesson = { ...structuredClone(old), id: "failed-held", failedFormat: 3 };
  a.notes.save(marked);
  await a.connect();
  const pushed = () => env.cloud.pull(0).changes.map(change => change.document.id);
  assert.deepEqual(pushed(), ["old-note"]);
  assert.equal(a.sync.status().pending, 2);
  assert.equal(a.sync.status().lastError, FORMAT_HELD_MESSAGE);
  await a.sync.sync();
  assert.deepEqual(pushed(), ["old-note"]);
  // Once the cloud is updated, the held note goes up on the next sync.
  env.setOld(false);
  await a.sync.sync();
  assert.deepEqual(pushed().sort(), ["failed-held", "old-note", "v3-held"]);
  assert.equal(a.sync.status().pending, 0);
  assert.ok(!a.sync.status().lastError);
  const b = env.client("b");
  await b.connect();
  assert.deepEqual(b.notes.get("failed-held"), marked);
});

// ---- generation -------------------------------------------------------------
const AUTHOR = "課程作者";
const REPAIR = "你上一次的 JSON 回覆有結構問題";
const analysis = { title: "閉包", scope: "貼上內容", keyConcepts: ["閉包"], explanationPlan: ["理解環境", "理解狀態"], caveats: [] };
const curation = { category: "JavaScript", tags: ["閉包"], connections: [] };
const teaching = () => teachingSchema.parse(withExample({ ...structuredClone(exampleLessons[0]), visual: { ...structuredClone(exampleLessons[0].visual), kind: "flow", scene: { layout: "flow", edges: [], groups: [] } } }));
const source: Source = { kind: "code", label: "貼上的程式碼", content: "function createCounter() { let count = 0; return () => ++count; }", scope: "僅分析本次貼上的內容。" };
type Call = { role: string; instruction: string; data: Draft };
/** A model that answers each agent; `author` answers the v3 author's first call of each attempt. */
function model(author: (attempt: number) => unknown) {
  const calls: Call[] = [];
  let attempts = 0;
  const chat: ChatCall = async (role, instruction, data) => {
    calls.push({ role, instruction, data: structuredClone(data) });
    if (instruction.startsWith(REPAIR)) return { fixes: [] };
    if (role === AUTHOR) return author(++attempts);
    return role.includes("分析") ? analysis : role.includes("整理") ? curation : teaching();
  };
  const authorCalls = () => calls.filter(call => call.role === AUTHOR && !call.instruction.startsWith(REPAIR));
  return { calls, chat, authorCalls, roles: () => calls.map(call => call.role) };
}
const generate = (chat: ChatCall, events: string[] = [], context: { format?: 3 } = { format: 3 }) =>
  generateLesson({ kind: "code", content: source.content, depth: "intermediate", question: "閉包為什麼記得變數？" }, source, [], chat, new AbortController().signal,
    event => { if (event.type === "stage") events.push(event.message); }, [], context);

test("v3 generation: one author call, the guide's prompt and example, and a note the server completes", async () => {
  const reply = { ...example(), minutes: 7, title: "  閉包：函式的隨身背包 ", source: { label: "模型自己寫的標題" } };
  reply.steps.forEach((step: Draft, index: number) => { step.id = `step-${index}`; });
  const fake = model(() => reply);
  const lesson = await generate(fake.chat);
  assert.deepEqual(fake.roles(), [AUTHOR, "知識整理代理"]);
  const [author] = fake.authorCalls();
  assert.ok(author.instruction.includes(LESSON_V3_PROMPT));
  assert.ok(author.instruction.includes(JSON.stringify(LESSON_V3_EXAMPLE)));
  assert.ok(author.instruction.includes(DEPTHS.intermediate.rule));
  assert.equal(author.data.learningQuestion, "閉包為什麼記得變數？");
  assert.equal(author.data.previousProblems, undefined);
  assert.ok(isLessonV3(lesson));
  assert.equal(lesson.title, "閉包：函式的隨身背包");
  assert.deepEqual(lesson.steps.map(step => step.id), ["s1", "s2", "s3"]);
  assert.deepEqual(lesson.source, source);
  assert.equal("minutes" in lesson, false);
  assert.equal(lesson.category, "JavaScript");
  assert.deepEqual(lesson.tags, ["閉包"]);
  assert.equal(syncLessonSchema.safeParse(lesson).success, true);
});

test("v3 generation: a failed attempt is written again once, told what failed", async () => {
  const fake = model(attempt => attempt === 1 ? { ...example(), title: full(V3_LIMITS.title + 1) } : example());
  const lesson = await generate(fake.chat);
  const authors = fake.authorCalls();
  assert.equal(authors.length, 2);
  assert.ok(authors[1].data.previousProblems.some((problem: { path: string }) => problem.path === "title"));
  assert.ok(isLessonV3(lesson));
  assert.equal(fake.roles().includes("分析代理"), false);
});

test("v3 generation: two failed attempts save the note in the original format and say so", async () => {
  const events: string[] = [];
  const fake = model(() => ({ ...example(), title: full(V3_LIMITS.title + 1) }));
  const lesson = await generate(fake.chat, events);
  assert.equal(fake.authorCalls().length, V3_ATTEMPTS);
  assert.ok(events.includes("新格式整理失敗，改存成舊格式。"));
  for (const role of ["分析代理", "教學代理", "知識整理代理"]) assert.ok(fake.roles().includes(role), role);
  assert.equal(isLessonV3(lesson), false);
  assert.equal("format" in lesson, false);
  assert.ok((lesson as Lesson).sections.length > 0);
  // Marked 「整理失敗」 on the saved note, so it can be found again later.
  assert.equal((lesson as Lesson).failedFormat, 3);
  assert.equal(syncFormatOf(lesson), 3);
  const parsed = syncLessonSchema.parse(structuredClone(lesson));
  assert.deepEqual(parsed, lesson);
  assert.notEqual(lessonHash(parsed), lessonHash({ ...lesson, failedFormat: undefined }));
  for (const failedFormat of [2, "3", true]) assert.equal(syncLessonSchema.safeParse({ ...structuredClone(lesson), failedFormat }).success, false, String(failedFormat));
});

test("v3 generation: only a note that fell back carries the 「整理失敗」 mark", async () => {
  const written = await generate(model(() => example()).chat);
  assert.equal(isLessonV3(written), true);
  assert.equal("failedFormat" in written, false);
  const original = await generate(model(() => example()).chat, [], {});
  assert.equal("failedFormat" in original, false);
  assert.equal(syncFormatOf(original), undefined);
  const large = await generate(model(() => { throw new AppError(413, "too large"); }).chat);
  assert.equal((large as Lesson).failedFormat, 3);
  // The mark lives on the stored note, so every read of the library still has it.
  const store = new LessonStore(":memory:", []);
  try {
    store.save(large);
    assert.equal((store.get(large.id) as Lesson).failedFormat, 3);
    assert.deepEqual(store.list().filter(lesson => syncFormatOf(lesson) === 3 && !isLessonV3(lesson)).map(lesson => lesson.id), [large.id]);
  } finally { store.close(); }
});

test("v3 generation: a rate limit during a repair round stops the job without another attempt", async () => {
  const roles: string[] = [];
  const chat: ChatCall = async (role, instruction) => {
    roles.push(role);
    if (instruction.startsWith(REPAIR)) throw new AppError(429, "rate limited");
    return role === AUTHOR ? { ...example(), title: full(V3_LIMITS.title + 1) } : role.includes("分析") ? analysis : role.includes("整理") ? curation : teaching();
  };
  await assert.rejects(generate(chat), (error: unknown) => error instanceof AppError && error.status === 429);
  assert.deepEqual(roles, [AUTHOR, AUTHOR]);
});

test("v3 generation: a source too large for the author's prompt falls back; other errors stop the job", async () => {
  const large = model(() => { throw new AppError(413, "too large"); });
  const lesson = await generate(large.chat);
  assert.equal(isLessonV3(lesson), false);
  assert.ok(large.roles().includes("教學代理"));
  const limited = model(() => { throw new AppError(429, "rate limited"); });
  await assert.rejects(generate(limited.chat), (error: unknown) => error instanceof AppError && error.status === 429);
  assert.deepEqual(limited.roles(), [AUTHOR]);
});

test("without the setting, generation is the original pipeline", async () => {
  const fake = model(() => example());
  const lesson = await generate(fake.chat, [], {});
  assert.equal(fake.roles().includes(AUTHOR), false);
  assert.equal(isLessonV3(lesson), false);
});

test("the author's fixed prompt leaves most of the 80,000-character request for the source", async () => {
  let longest = 0;
  const chat: ChatCall = async (role, instruction) => {
    if (role === AUTHOR) longest = `${apiBoundary}\n代理角色：${role}\n${instruction}`.length;
    return role === AUTHOR ? example() : curation;
  };
  await generateLesson({ kind: "code", content: "x", depth: "advanced", question: "閉包為什麼記得變數？" }, source, [], chat, new AbortController().signal, () => {}, [], { format: 3 });
  assert.ok(longest > 0 && longest < 16_000, `author system prompt is ${longest} characters`);
  assert.ok(lessonV3Instruction(DEPTHS.advanced.rule).length < 16_000);
});

test("normalizing a reply sets the format, step ids and source, and only trims text", () => {
  const normalize = normalizeLessonV3({ label: "閉包筆記", url: "https://example.com/closure" });
  const { value, fixes } = normalize({ format: 2, title: " 標題 ", question: "問？", answer: "答。 ", steps: [{ id: "a", lead: " 一 ", body: "二。" }, { id: "s2", lead: "三", body: "四。" }], source: { label: "x" } });
  assert.deepEqual(value, { format: 3, title: "標題", question: "問？", answer: "答。", steps: [{ id: "s1", lead: "一", body: "二。" }, { id: "s2", lead: "三", body: "四。" }], source: { label: "閉包筆記", url: "https://example.com/closure" } });
  assert.deepEqual(fixes.sort(), ["answer", "format", "steps.0.id", "steps.0.lead", "title"].sort());
  assert.deepEqual(normalizeLessonV3({ label: "" })({ steps: [] }).value, { format: 3, source: { label: "來源" }, steps: [] });
  assert.equal(normalize("not an object").value, "not an object");
});

test("multi-chapter v3 lessons allow up to 12 steps with English technical terms and primary-source rules", () => {
  const deep = edited(l => {
    l.title = "ELF Relocation 與 Dynamic Linking";
    l.question = "程式碼如何透過 Symbol Resolution 與 Relocation 變成可執行檔？";
    l.answer = "**Linker 依 System V ABI 解析 Symbol Table 並修補 Relocation entries**，將多個 Object Files 合併為可載入的執行檔。靜態連結於建置期完成重定位，動態連結則透過 `PLT` 與 `GOT` 延遲綁定外部函式。";
    while (l.steps.length < 10) {
      l.steps.push({
        id: `s${l.steps.length + 1}`,
        lead: `Step ${l.steps.length + 1} 檢視 ELF Section Header 與 Relocation`,
        body: "依據 System V AMD64 ABI 規格，Compiler 先輸出含未解析參照的 Relocatable Object File，並於 `.rela.text` 記錄修補位移與重定位型別。實務診斷可執行 `readelf -r main.o` 與 `objdump -dr main.o` 對照機械碼 placeholder 與實際修補結果。",
        deeper: {
          summary: "System V ABI 重定位公式與工具檢驗",
          body: "規格書定義 `R_X86_64_PLT32` 計算式為 `L + A - P`，其中 `A` 為 `-4` 用以補償 `RIP`-relative 下一條指令位移。當發生 Undefined Reference 或 Duplicate Strong Symbol 時，專家會搭配 `nm -C` 與 `-Wl,-Map=output.map` 追蹤哪個 Archive Member 被拉入連結。",
        },
        recall: {
          question: "檢視 Object File 尚未修補的 Relocation entries 應使用哪個 `readelf` 參數？",
          answer: "**`readelf -r`**。它會直接列出 `.rela.*` 區段中的 offset、type 與目標 Symbol。",
        },
      });
    }
  });
  assert.deepEqual(structural(deep), []);
  assert.deepEqual(content(deep), []);
  const instruction = lessonV3Instruction(DEPTHS.advanced.rule);
  for (const required of ["完整涵蓋", "第一手權威資料", "System V ABI", "專有名詞盡量保留標準英文原文"]) {
    assert.ok(instruction.includes(required), `missing prompt guidance: ${required}`);
  }
});

test("declarative d2 and rubik-2x2 figures validate structure, writing limits, search lines and markdown export", () => {
  const d2Source = [
    "direction: right",
    "sections: Linking View { text: `.text` · 機器指令; }",
  ].join("\n");
  void d2Source;
  const parsed = parseD2([
    "direction: right",
    "# comment line",
    "sections: Linking View {",
    "  text: `.text` · `p->next` 指令",
    "  data: `.data` · 已初始化變數",
    "}",
    "segments: Execution View {",
    "  rx: `PT_LOAD` (R+X) · 唯讀程式碼頁",
    "  rw: `PT_LOAD` (R+W) · 可寫資料頁",
    "}",
    "sections.text -> segments.rx: 合併映射",
    "sections.data -> segments.rw: 載入初值",
  ].join("\n"));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.allNodes.length, 4);
  assert.equal(parsed.allNodes[0].detail, "`p->next` 指令");
  assert.equal(parsed.edges.length, 2);

  const valid = edited(l => {
    l.steps[0].figure = {
      kind: "d2",
      title: "ELF Section 對 Segment 映射",
      source: [
        "direction: right",
        "sections: Linking View {",
        "  text: `.text` · 機器指令",
        "  data: `.data` · 全域變數",
        "}",
        "segments: Execution View {",
        "  rx: `PT_LOAD` (R+X)",
        "  rw: `PT_LOAD` (R+W)",
        "}",
        "sections.text -> segments.rx: 唯讀可執行",
        "sections.data -> segments.rw: 可讀寫資料",
      ].join("\n"),
      caption: "Linker 合併相同權限的區段為 `PT_LOAD`。",
    };
    l.steps[2].figure = {
      kind: "rubik-2x2",
      title: "2×2 角塊轉動示意",
      caption: "依固定數學規則繪製的互動示意，未執行來源程式。",
      setupMoves: ["D", "R'"],
      view: "moves",
    };
    delete l.steps[2].recall.blank;
  });
  assert.deepEqual(structural(valid), []);
  assert.deepEqual(content(valid), []);

  const md = lessonMarkdown(noteV3("v3-d2-rubik", { steps: valid.steps }));
  assert.match(md, /```d2\ndirection: right/);
  assert.match(md, /\*\*互動立體圖解：2×2 角塊轉動示意\*\*/);
  assert.match(md, /D R'/);

  // Unclosed group or missing edge fails structural check
  assert.ok(structural(edited(l => { l.steps[0].figure = { kind: "d2", source: "g: Group {\n  a: Node" }; })).includes(at(0, "figure", "source")));
  assert.ok(structural(edited(l => { l.steps[0].figure = { kind: "d2", source: "a: A\nb: B" }; })).includes(at(0, "figure", "source")));
  // Unsupported cube move fails structural check
  assert.ok(structural(edited(l => { l.steps[0].figure = { kind: "rubik-2x2", title: "x", caption: "y", setupMoves: ["U"] }; })).includes(at(0, "figure", "setupMoves", 0)));
  // Too many D2 lines passes stored shape but fails content writing check
  const manyLines = ["a -> b", ...Array.from({ length: V3_LIMITS.d2.lines }, (_, i) => `# line ${i}`)].join("\n");
  const overLines = edited(l => { l.steps[0].figure = { kind: "d2", source: manyLines }; });
  assert.deepEqual(structural(overLines), []);
  assert.ok(content(overLines).includes(at(0, "figure", "source")));
});
