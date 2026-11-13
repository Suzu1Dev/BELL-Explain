import test from "node:test";
import assert from "node:assert/strict";
import { exampleLessons } from "../shared/examples.js";
import { DEPTHS } from "../shared/depth-rubric.js";
import type { Depth, Source } from "../shared/types.js";
import { generateLesson, needsRubikIllustration, teachingSchemaText, type ChatCall } from "./ai.js";
import { runDeepReading } from "./document-reading.js";
import type { DocumentService } from "./documents.js";
import { gradeCheck } from "./learning-check.js";
import { explainAnnotation } from "./lesson-annotations.js";
import { addLessonExamples } from "./lesson-examples.js";
import { apiBoundary, cliBoundary } from "./prompts/boundary.js";
import { mathRule, transcriptionMathRule } from "./prompts/math.js";
import { teachingSchema } from "./schema.js";
import { withExample } from "./test-helpers.js";

const fixture = exampleLessons[0];
const analysis = { title: "閉包", scope: "貼上內容", keyConcepts: ["閉包"], explanationPlan: ["理解環境", "理解狀態"], caveats: [] };
const teaching = () => teachingSchema.parse(withExample({ ...structuredClone(fixture), visual: { ...structuredClone(fixture.visual), kind: "flow", scene: { layout: "flow", edges: [], groups: [] } } }));
const curation = { category: "JavaScript", tags: ["閉包"], connections: [] };
/** Records each agent's instruction and answers with a valid fixture for its role. */
function recording() {
  const calls: Array<{ role: string; instruction: string }> = [];
  const chat: ChatCall = async (role, instruction) => {
    calls.push({ role, instruction });
    return role.includes("分析") ? analysis : role.includes("整理") ? curation : teaching();
  };
  return { calls, chat };
}
const source = (content: string, label = "貼上的程式碼"): Source => ({ kind: "code", label, content, scope: "僅分析本次貼上的內容。" });

test("API and CLI agents share the honesty rules; only the CLI prompt adds the tool ban", () => {
  assert.match(apiBoundary, /明確交代推測、限制與未驗證資訊/);
  assert.ok(cliBoundary.startsWith(apiBoundary));
  assert.match(cliBoundary, /禁止使用任何工具/);
  assert.doesNotMatch(apiBoundary, /禁止使用任何工具/);
});

test("each depth reaches the analysis and teaching agents, and intermediate asks for complexity", async () => {
  for (const depth of Object.keys(DEPTHS) as Depth[]) {
    const { calls, chat } = recording();
    await generateLesson({ kind: "code", content: "x", depth }, source("const x = 1"), [], chat, new AbortController().signal, () => {});
    const [analyst, teacher, curator] = calls;
    assert.ok(analyst.instruction.includes(DEPTHS[depth].rule), `${depth} analyst`);
    assert.ok(teacher.instruction.includes(DEPTHS[depth].rule), `${depth} teacher`);
    assert.equal(curator.instruction.includes(DEPTHS[depth].rule), false);
  }
  assert.match(DEPTHS.intermediate.rule, /時間與空間複雜度/);
  // Advanced stands on its own: it repeats the intermediate requirements it builds on.
  for (const clause of [/時間與空間複雜度/, /n、m、b、d/, /不變量、前置條件、邊界與錯誤情況/, /實際格式、欄位或狀態轉換/, /正確性或最佳性/]) assert.match(DEPTHS.advanced.rule, clause);
});

test("teaching rules ask for 1-based section references, unspoiled predictions and checkable follow-ups; curation reuses categories", async () => {
  const { calls, chat } = recording();
  await generateLesson({ kind: "code", content: "x", depth: "intermediate" }, source("const x = 1"), [], chat, new AbortController().signal, () => {});
  const teacher = calls.find(call => call.role === "教學代理")!.instruction;
  assert.match(teacher, /從 1 起算的序號/);
  assert.match(teacher, /不要在同一段 body 公布答案/);
  assert.match(teacher, /自我檢查題/);
  assert.match(calls.find(call => call.role === "知識整理代理")!.instruction, /優先逐字沿用 existing 中已有的分類名稱/);
});

test("the 2×2×2 cube rules and schema are sent only for Rubik's cube material", async () => {
  assert.equal(needsRubikIllustration(source("int bfs(void);", "sysprog21/minirubik")), true);
  assert.equal(needsRubikIllustration(source("const x = 1"), "解釋 2x2 魔術方塊的轉面"), true);
  assert.equal(needsRubikIllustration(source("print('hello')")), false);
  for (const name of ["Pocket Cube solver", "二階方塊的轉法", "口袋方塊", "2x2x2 cube"]) assert.equal(needsRubikIllustration(source("x", name)), true, name);
  assert.match(teachingSchemaText(true), /"illustration"/);
  assert.doesNotMatch(teachingSchemaText(false), /"illustration"/);
  const plain = recording();
  await generateLesson({ kind: "code", content: "x", depth: "beginner" }, source("print('hello')"), [], plain.chat, new AbortController().signal, () => {});
  const teacher = plain.calls.find(call => call.role === "教學代理")!.instruction;
  assert.doesNotMatch(teacher, /魔術方塊互動插圖/);
  assert.match(teacher, /不要輸出 visual\.illustration/);
  const cube = recording();
  await generateLesson({ kind: "repo", content: "x", depth: "beginner" }, source("solve()", "sysprog21/minirubik"), [], cube.chat, new AbortController().signal, () => {});
  assert.match(cube.calls.find(call => call.role === "教學代理")!.instruction, /魔術方塊互動插圖/);
});

test("practical example policy asks for real formats per domain and is shared with example backfill", async () => {
  const { calls, chat } = recording();
  await generateLesson({ kind: "concept", content: "IAM", depth: "intermediate" }, source("IAM role"), [], chat, new AbortController().signal, () => {});
  const teacher = calls.find(call => call.role === "教學代理")!.instruction;
  for (const format of [/IAM identity／trust policy JSON/, /十六進位傾印/, /暫存器與記憶體的逐步追蹤表/, /123456789012/, /依一般知識撰寫，未對照最新官方文件/]) assert.match(teacher, format);
  const lesson = structuredClone(fixture);
  lesson.isDemo = false;
  lesson.sections = lesson.sections.map(section => ({ ...section, codeExample: undefined }));
  const backfill: string[] = [];
  await addLessonExamples(lesson, async (_role, instruction) => { backfill.push(instruction); throw new Error("stop"); }, new AbortController().signal).catch(() => {});
  assert.match(backfill[0], /IAM identity／trust policy JSON/);
  assert.match(backfill[0], /不要回傳 code 與 language/);
});

test("agents that write lesson prose are asked for \\( \\) and \\[ \\] math, never $, and only for real math", async () => {
  for (const clause of [String.raw`行內用 \( … \)`, String.raw`獨立成行用 \[ … \]`, "不要用 $ 當分隔符", "程式碼、指令、路徑、價格與一般數字不要包進去", String.raw`"\\(x^2\\)"`]) assert.ok(mathRule.includes(clause), clause);
  // Code in prose goes in backticks, the one place where \( and \[ stay as written.
  assert.ok(mathRule.includes("文字中提到程式碼、指令、正規表示式或路徑時一律放進反引號，例如 `grep '\\[ERROR\\]' app.log`"));
  const { calls, chat } = recording();
  const pdf: Source = { kind: "document", label: "講義.pdf", content: "第 1 頁\n面積 = πr2", scope: "第 1 頁" };
  await generateLesson({ kind: "document", content: "x", depth: "beginner" }, pdf, [], chat, new AbortController().signal, () => {});
  const teacher = calls.find(call => call.role === "教學代理")!.instruction;
  assert.ok(teacher.includes(mathRule));
  assert.equal(teacher.split(mathRule).length, 2, "the rule is sent once");
  // Titles, step titles and node labels are shown as written, so the teacher keeps LaTeX out of them.
  assert.match(teacher, /LaTeX 只寫在 summary、sections 的 heading、body、analogy 與 concepts、codeExample 的 scenario、walkthrough 與 application、visual\.caption、visual\.steps 的 description，以及 followUpQuestions/);
  assert.match(teacher, /title、subtitle、visual\.title、steps 的 title 與 output、nodes 的 label 與 detail 等其他欄位會原樣顯示，數學寫成純文字/);
  assert.match(teacher, /code 與程式輸出照原樣寫，不加 LaTeX/);
  // Formulas scattered by PDF text extraction are rebuilt only when the original is certain.
  assert.match(teacher, /擷取文字中的公式常散成零碎符號，只有能從上下文或頁面影像確定原式時才以 LaTeX 重寫/);
  assert.equal(calls.find(call => call.role === "知識整理代理")!.instruction.includes(mathRule), false);

  const lesson = { ...structuredClone(fixture), isDemo: false };
  const prompts: string[] = [];
  const record: ChatCall = async (_role, instruction) => { prompts.push(instruction); throw new Error("stop"); };
  const signal = new AbortController().signal;
  await addLessonExamples({ ...lesson, sections: lesson.sections.map(section => ({ ...section, codeExample: undefined })) }, record, signal).catch(() => {});
  await gradeCheck(lesson, lesson.followUpQuestions[0], "答案", undefined, record, signal).catch(() => {});
  await explainAnnotation(lesson, { term: lesson.summary.slice(0, 4), sourceKey: "summary", quote: lesson.summary }, record, signal).catch(() => {});
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) assert.ok(prompt.includes(mathRule));
  assert.match(prompts[1], /referenceAnswer/);
  assert.match(prompts[2], /example 會原樣顯示，裡面不用 LaTeX/);
});

test("the deep reading writes formulas as LaTeX but keeps the page's code as printed", async () => {
  // A display formula over several lines is typeset only with \[ and \] on lines of their own.
  for (const rule of [mathRule, transcriptionMathRule]) assert.ok(rule.includes(String.raw`獨立成行用 \[ … \]（可以跨行：\[ 與 \] 各自單獨一行，中間不要空一行）`));
  const instructions: string[] = [];
  const documents = { renderPages: async (_id: string, pages: number[]) => pages.map(page => ({ page, mimeType: "image/png", data: "", width: 1, height: 1 })) } as unknown as DocumentService;
  const chat: ChatCall = async (_role, instruction) => { instructions.push(instruction); throw new Error("stop"); };
  await runDeepReading(documents, "d", { name: "講義.pdf", pages: [{ page: 1, text: "x" }], more: 0 }, undefined, chat, new AbortController().signal, () => {}).catch(() => {});
  const [reading] = instructions;
  assert.match(reading, /不要摘要、不要改寫、不要補充頁面上沒有的內容/);
  assert.ok(reading.includes(transcriptionMathRule));
  // The lesson rule puts code in backticks, which would change the page.
  assert.ok(!reading.includes(mathRule));
  assert.doesNotMatch(reading, /一律放進反引號/);
  assert.match(reading, /頁面上的程式碼、指令與正規表示式照頁面原樣轉寫，不要另加反引號/);
  for (const clause of [String.raw`行內用 \( … \)`, "不要用 $ 當分隔符", "程式碼、指令、路徑、價格與一般數字不要包進去", String.raw`"\\(x^2\\)"`]) assert.ok(reading.includes(clause), clause);
});
