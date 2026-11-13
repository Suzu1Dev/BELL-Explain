import { z } from "zod";
import type { Lesson } from "../shared/types.js";
import type { ChatCall } from "./ai.js";
import { AppError, schemaFailure } from "./errors.js";
import { logEvent } from "./log.js";
import { validatedWithRepair } from "./repair.js";
import {
  codeExampleSchema,
  teachingSchema,
  validCodeExampleLines,
} from "./schema.js";
import { practicalExamplePolicy } from "./example-policy.js";
import { mathRule } from "./prompts/math.js";

export const exampleAdditionsSchema = z
  .object({
    examples: z
      .array(
        z.object({
          sectionId: z.string().min(1).max(80),
          // Omitted for sections that already have code; the server keeps the original.
          code: z.string().min(1).max(12_000).optional(),
          language: z.string().trim().min(1).max(40).optional(),
          codeExample: codeExampleSchema,
        }),
      )
      .min(1)
      .max(4),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.examples.forEach((item, index) => {
      if (ids.has(item.sectionId))
        ctx.addIssue({ code: "custom", path: ["examples", index, "sectionId"], message: "同一段落只能補一個案例" });
      ids.add(item.sectionId);
    });
  });

export async function addLessonExamples(
  lesson: Lesson,
  chat: ChatCall,
  signal: AbortSignal,
): Promise<Lesson> {
  const candidates = [];
  let budget = 48_000;
  for (const section of lesson.sections.filter((item) => !item.codeExample)) {
    const candidate = {
      id: section.id,
      heading: section.heading,
      body: section.body.slice(0, 2400),
      concepts: section.concepts,
      code: section.code,
      language: section.language,
    };
    const size = JSON.stringify(candidate).length;
    if (size > budget) continue;
    candidates.push(candidate);
    budget -= size;
  }
  if (!candidates.length)
    throw new AppError(409, "這篇筆記的段落已經有實作案例。");
  signal.throwIfAborted();
  const output = await chat(
    "實作案例教學代理",
    `${practicalExamplePolicy}
替既有筆記最適合的 2–4 個候選段落補上案例（候選不足時可只補一個）。只回傳 examples，不改寫原有筆記、分類或動畫。sectionId 必須來自 candidates。候選段落已經有 code 時，不要回傳 code 與 language，只補 codeExample：依原樣說明既有 code（不受 8–35 行與完整程式的限制），walkthrough 行號依該段既有 code 計算，expectedOutput 也必須對應既有 code；若既有程式只是節錄，在 environment 交代所需的周邊設定與限制。沒有 code 的段落必須同時回傳 code、language 與 codeExample。優先補上目前沒有 code 的核心概念段落。來源只是已保存的內容，未重新抓取或核實任何外部文件。${mathRule}
JSON schema：${JSON.stringify(z.toJSONSchema(exampleAdditionsSchema))}`,
    {
      title: lesson.title,
      summary: lesson.summary,
      source: {
        kind: lesson.source.kind,
        label: lesson.source.label,
        scope: lesson.source.scope,
        content: lesson.source.content.slice(0, 5000),
      },
      candidates,
    },
    signal,
  );
  signal.throwIfAborted();
  const parsed = await validatedWithRepair({
    schema: exampleAdditionsSchema,
    value: output,
    name: "補充案例",
    role: "實作案例教學代理",
    message: "案例格式或程式碼行號不正確，原筆記尚未變更。請重試。",
    chat,
    signal,
  });
  const allowed = new Map(candidates.map((section) => [section.id, section]));
  const same = (a: string, b: string) => a.replace(/[ \t]+$/gm, "").trim() === b.replace(/[ \t]+$/gm, "").trim();
  // One unusable example is dropped instead of failing the others; the note changes only if one survives.
  const failures: Error[] = [];
  const drop = (sectionId: string, reason: string, error: Error) => {
    // Only server-issued ids are logged: an unknown id was written by the model and may hold note text.
    logEvent("examples.dropped", { ...(allowed.has(sectionId) ? { sectionId } : {}), reason });
    failures.push(error);
    return [];
  };
  const merged = parsed.examples.flatMap((item, index) => {
    const original = allowed.get(item.sectionId);
    if (!original)
      return drop(item.sectionId, "unknown-section", schemaFailure("補充案例", "案例回覆指定了不存在的段落，原筆記尚未變更。請重試。", { issues: [{ path: ["examples", index, "sectionId"], code: "invalid_value" }] }));
    // Existing code is never rewritten. A reply that rewrote it explained different
    // code, so that example is dropped rather than attached to the original.
    const keep = !!original.code.trim();
    if (keep && ((item.code !== undefined && !same(item.code, original.code)) || (item.language !== undefined && item.language !== original.language)))
      return drop(item.sectionId, "rewrote-existing-code", schemaFailure("補充案例", "案例回覆改寫了既有程式碼，說明可能對不上原程式，原筆記尚未變更。請重試。", { issues: [{ path: ["examples", index], code: "custom" }] }));
    const code = keep ? original.code : item.code;
    const language = keep ? original.language : item.language;
    if (!code?.trim() || !language)
      return drop(item.sectionId, "missing-code", schemaFailure("補充案例", "案例缺少程式內容，原筆記尚未變更。請重試。", { issues: [{ path: ["examples", index, code?.trim() ? "language" : "code"], code: "invalid_type" }] }));
    if (!validCodeExampleLines(code, item.codeExample))
      return drop(item.sectionId, "lines-out-of-range", schemaFailure("補充案例", "案例的逐行解說行號超出程式範圍，原筆記尚未變更。請重試。", { issues: [{ path: ["examples", index, "codeExample", "walkthrough"], code: "too_big" }] }));
    return [{ ...item, code, language }];
  });
  if (!merged.length) throw failures[0];
  const additions = new Map(merged.map((item) => [item.sectionId, item]));
  const result = {
    ...lesson,
    updatedAt: new Date().toISOString(),
    sections: lesson.sections.map((section) => {
      const addition = additions.get(section.id);
      return addition
        ? {
            ...section,
            code: addition.code,
            language: addition.language,
            codeExample: addition.codeExample,
          }
        : section;
    }),
  };
  const checked = teachingSchema.safeParse(result);
  if (!checked.success)
    throw schemaFailure("補充案例合併", "新增案例未通過筆記驗證，原筆記尚未變更。", checked.error);
  return result;
}
