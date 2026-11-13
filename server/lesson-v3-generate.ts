import { z } from "zod";
import type { Source } from "../shared/types.js";
import type { LessonNoteV3, LessonV3, StoredLesson } from "../shared/lesson-v3.js";
import { lessonV3ContentSchema, lessonV3Schema } from "./lesson-v3-schema.js";
import { LESSON_V3_PROMPT } from "./prompts/lesson-v3.js";
import { LESSON_V3_EXAMPLE } from "./prompts/lesson-v3-example.js";
import { validatedWithRepair } from "./repair.js";
import { AppError, SchemaValidationError, schemaFailure } from "./errors.js";
import { logEvent } from "./log.js";
import type { ChatCall, ChatImage } from "./ai.js";
import { existingConnections, type Curation } from "./schema.js";

/** Writing guide §10: a lesson that fails is written again once before the original format is used. */
export const V3_ATTEMPTS = 2;
const AUTHOR = "課程作者";
const MESSAGE = "課程作者回傳的新格式課程沒有通過檢查。";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Sets what the server already knows, so no repair round is spent on it: the format, the
 * step ids in order, and the source label (the saved note carries the full source anyway).
 * Text is only trimmed; nothing is shortened, since a cut sentence would pass and read badly.
 */
export function normalizeLessonV3(source: Pick<Source, "label" | "url">) {
  const label = source.label.slice(0, 2000) || "來源";
  return (input: unknown): { value: unknown; fixes: string[] } => {
    if (!isObject(input)) return { value: input, fixes: [] };
    const value = structuredClone(input);
    const fixes: string[] = [];
    const trim = (node: Record<string, unknown>, key: string, path: string) => {
      const text = node[key];
      if (typeof text === "string" && text !== text.trim()) { node[key] = text.trim(); fixes.push(path); }
    };
    if (value.format !== 3) { value.format = 3; fixes.push("format"); }
    value.source = source.url && source.url.length <= 4000 ? { label, url: source.url } : { label };
    for (const key of ["title", "question", "answer"]) trim(value, key, key);
    if (Array.isArray(value.steps)) value.steps.forEach((step, index) => {
      if (!isObject(step)) return;
      if (step.id !== `s${index + 1}`) { step.id = `s${index + 1}`; fixes.push(`steps.${index}.id`); }
      trim(step, "lead", `steps.${index}.lead`);
      trim(step, "body", `steps.${index}.body`);
    });
    return { value, fixes };
  };
}

/** The author's instructions: the guide's §9 prompt, the closure lesson as an example, and the shape. */
export function lessonV3Instruction(context: string): string {
  return [
    LESSON_V3_PROMPT,
    context,
    "以 data.source 為核心範圍完整涵蓋其所有重要觀念與實作（不可遺漏主要章節或只挑單一小例），並以第一手官方文件、標準規格書與原廠手冊的準確定義校準技術細節（不得捏造未提供的外部網址或聲稱實際執行程式）。若有 data.learningQuestion，question 與 answer 直接回應它；若無，question 與 steps 必須涵蓋整份來源的完整知識脈絡。source 照抄 data.source.label；不要輸出 minutes、category、tags，這些由程式產生。",
    "若 data.previousProblems 存在，那是上一次的課程沒通過的檢查（path 是欄位位置），這次全部避開。",
    `範例（僅示範單一短概念的 JSON 欄位結構與句型，切勿照抄其 3 步短篇幅；長篇或多章節來源請展開 6–12 步並充分運用 figure 與 deeper）：${JSON.stringify(LESSON_V3_EXAMPLE)}`,
    `JSON schema：${JSON.stringify(z.toJSONSchema(lessonV3Schema))}`,
  ].filter(Boolean).join("\n");
}

type Problem = { path: string; message: string };
const problemsOf = (value: unknown): Problem[] => {
  const result = lessonV3ContentSchema.safeParse(value);
  return result.success ? [] : result.error.issues.slice(0, 20).map(issue => ({ path: issue.path.map(String).join("."), message: issue.message }));
};

/**
 * Writes a v3 lesson, with the usual repair rounds on each attempt and one fresh attempt that is
 * told what failed. Returns undefined when both attempts fail validation, or when the request is
 * too large for one model call (this prompt is longer than the original teacher's), so the caller
 * can use the original format, and tells `onGiveUp` which of the two it was; any other error
 * (abort, provider, rate limit) is thrown as it is.
 */
export async function authorLessonV3(options: {
  chat: ChatCall;
  signal: AbortSignal;
  source: Source;
  /** Prompt rules that depend on the request: depth, continuation, document and image policies. */
  context: string;
  data: Record<string, unknown>;
  images?: ChatImage[];
  onRepair?: (count: number) => void;
  onGiveUp?: (reason: "invalid" | "too-large") => void;
}): Promise<LessonV3 | undefined> {
  const instruction = lessonV3Instruction(options.context);
  let previousProblems: Problem[] | undefined;
  for (let attempt = 1; attempt <= V3_ATTEMPTS; attempt++) {
    options.signal.throwIfAborted();
    let repaired = false;
    let rejected: unknown;
    try {
      const lesson = await validatedWithRepair({
        schema: lessonV3ContentSchema,
        name: AUTHOR,
        message: MESSAGE,
        chat: options.chat,
        signal: options.signal,
        normalize: normalizeLessonV3(options.source),
        // Called once the repair rounds are spent: keep the reply to tell the next attempt what failed.
        fallback: value => { rejected = value; return { value, fixes: [] }; },
        onRepair: count => { repaired = true; options.onRepair?.(count); },
        value: await options.chat(AUTHOR, instruction, { ...options.data, ...(previousProblems ? { previousProblems } : {}) }, options.signal, undefined, options.images),
      });
      logEvent("lesson.v3", { attempt, outcome: repaired ? "repaired" : "valid", steps: lesson.steps.length });
      return lesson;
    } catch (error) {
      if (error instanceof AppError && error.status === 413) {
        options.signal.throwIfAborted();
        logEvent("lesson.v3", { attempt, outcome: "too-large" });
        options.onGiveUp?.("too-large");
        return undefined;
      }
      if (!(error instanceof SchemaValidationError) || error.stage !== AUTHOR) throw error;
      options.signal.throwIfAborted();
      previousProblems = problemsOf(rejected);
      logEvent("lesson.v3", { attempt, outcome: "invalid", issues: error.issues.length });
    }
  }
  options.onGiveUp?.("invalid");
  return undefined;
}

/** A saved v3 note: the validated lesson, its curation and the real source. Minutes are never stored. */
export function makeLessonV3(lesson: LessonV3, curation: Curation, source: Source, existing: readonly StoredLesson[], id: string): LessonNoteV3 {
  const valid = lessonV3ContentSchema.safeParse(lesson);
  if (!valid.success) throw schemaFailure("組裝筆記", "模型回傳的課程結構不完整，請重試。", valid.error);
  const { source: _generated, ...generated } = valid.data;
  const now = new Date().toISOString();
  return {
    ...generated,
    category: curation.category,
    tags: curation.tags,
    connections: existingConnections(curation.connections, existing),
    source,
    id,
    createdAt: now,
    updatedAt: now,
    favorite: false,
    isDemo: false,
  };
}
