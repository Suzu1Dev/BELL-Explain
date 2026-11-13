import test from "node:test";
import assert from "node:assert/strict";
import { exampleLessons } from "../shared/examples.js";
import { lessonMarkdown } from "../shared/lesson-markdown.js";
import type { Lesson, RubikIllustrationSpec } from "../shared/types.js";
import { liveTeachingSchema, rubikIllustrationSchema, teachingSchema } from "./schema.js";
import { lessonHash, syncLessonSchema, validateSyncDocument } from "./sync-protocol.js";
import { withExample } from "./test-helpers.js";

const illustration: RubikIllustrationSpec = {
  kind: "rubik-2x2",
  title: "把狀態放回 2×2 魔方",
  caption: "BELL 依固定數學規則繪製的互動示意，未執行來源程式。從已解狀態轉一次 D，得到 13642571111111。",
  setupMoves: ["D"],
  focus: [
    { sectionIndex: 0, view: "space" },
    { sectionIndex: 1, view: "moves" },
    { sectionIndex: 2, view: "search" },
  ],
};

function lesson(): Lesson {
  const value = withExample(structuredClone(exampleLessons[0]));
  value.title = "2×2 魔方狀態教學";
  value.visual.kind = "flow";
  value.visual.scene = { layout: "flow", edges: [], groups: [] };
  value.visual.illustration = structuredClone(illustration);
  return value;
}

test("optional 2×2 illustration survives teaching validation while older general lessons remain compatible", () => {
  const value = lesson();
  assert.deepEqual(teachingSchema.parse(value).visual.illustration, illustration);
  assert.deepEqual(liveTeachingSchema.parse(value).visual.illustration, illustration);
  delete value.visual.illustration;
  assert.equal(liveTeachingSchema.safeParse(value).success, true);
  assert.equal(teachingSchema.safeParse(exampleLessons[0]).success, true);
  assert.equal(rubikIllustrationSchema.safeParse({ ...illustration, setupMoves: [] }).success, true);
  assert.equal(rubikIllustrationSchema.safeParse({ ...illustration, setupMoves: ["R", "R2", "R'", "B", "B2", "B'", "D", "D2", "D'"] }).success, true);
});

test("illustrations reject unsupported moves, executable fields, invalid modes and oversized content", () => {
  for (const invalid of [
    { ...illustration, kind: "rubik-3x3" },
    { ...illustration, title: " " },
    { ...illustration, title: "x".repeat(161) },
    { ...illustration, caption: "x".repeat(1601) },
    { ...illustration, setupMoves: Array(13).fill("D") },
    { ...illustration, setupMoves: ["U"] },
    { ...illustration, setupMoves: ["R3"] },
    { ...illustration, setupMoves: ["javascript:alert(1)"] },
    { ...illustration, script: "arbitrary generated code" },
    { ...illustration, focus: [{ sectionIndex: 0, view: "matrix" }] },
    { ...illustration, focus: [{ sectionIndex: -1, view: "space" }] },
    { ...illustration, focus: [{ sectionIndex: 8, view: "space" }] },
    { ...illustration, focus: [{ sectionIndex: 1.5, view: "space" }] },
  ]) assert.equal(rubikIllustrationSchema.safeParse(invalid).success, false);
});

test("illustration focus references actual sections and assigns at most one view to each", () => {
  const absent = lesson();
  absent.visual.illustration!.focus = [{ sectionIndex: absent.sections.length, view: "space" }];
  assert.equal(teachingSchema.safeParse(absent).success, false);
  assert.equal(liveTeachingSchema.safeParse(absent).success, false);
  assert.equal(syncLessonSchema.safeParse(absent).success, false);
  const duplicate = lesson();
  duplicate.visual.illustration!.focus = [{ sectionIndex: 0, view: "space" }, { sectionIndex: 0, view: "moves" }];
  assert.equal(teachingSchema.safeParse(duplicate).success, false);
});

test("full lesson synchronization preserves illustration data and includes it in the content hash", () => {
  const value = lesson();
  const document = { id: value.id, revision: 1, hash: lessonHash(value), lesson: value };
  const synced = validateSyncDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual((synced.lesson as Lesson | null)?.visual.illustration, illustration);
  const changed = structuredClone(value); changed.visual.illustration!.setupMoves = ["R"];
  assert.notEqual(lessonHash(changed), document.hash);
});

test("Markdown exports the illustration description, exact setup sequence and section mapping as text", () => {
  const value = lesson(); value.visual.illustration!.setupMoves = ["D", "R2", "B'"];
  const markdown = lessonMarkdown(value);
  assert.match(markdown, /## 互動立體圖解：把狀態放回 2×2 魔方/);
  assert.ok(markdown.includes(illustration.caption));
  assert.match(markdown, /D R2 B'/);
  assert.match(markdown, /不是求解答案/);
  assert.match(markdown, /未執行來源程式或完整 BFS/);
  assert.match(markdown, /第 2 段.*轉面操作/);
  assert.doesNotMatch(markdown, /!\[.*\]\(/);
  value.visual.illustration!.setupMoves = [];
  assert.match(lessonMarkdown(value), /已解狀態；不套用操作/);
});
