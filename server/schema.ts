import { z } from "zod";
import type { Lesson, Source } from "../shared/types.js";
import { lessonPartIds, type StoredLesson } from "../shared/lesson-v3.js";
import { AppError, schemaFailure } from "./errors.js";
import { CUBE_MOVES } from "../shared/rubik.js";

const short = z.string().trim().min(1).max(240);
const text = z.string().trim().min(1).max(8000);
export const codeExampleSchema = z.object({
  title: short,
  scenario: z.string().trim().min(1).max(1200),
  environment: z.string().trim().min(1).max(800),
  walkthrough: z
    .array(
      z.object({
        startLine: z.number().int().min(1).max(400),
        endLine: z.number().int().min(1).max(400),
        explanation: z.string().trim().min(1).max(1200),
        state: z.string().trim().min(1).max(240).optional(),
        output: z.string().trim().min(1).max(600).optional(),
      }),
    )
    .min(2)
    .max(8),
  expectedOutput: z.string().trim().min(1).max(3000),
  application: z.string().trim().min(1).max(1500),
});
export function validCodeExampleLines(
  code: string,
  example: z.infer<typeof codeExampleSchema>,
) {
  const lines = code.split("\n").length;
  return example.walkthrough.every(
    (step) => step.startLine <= step.endLine && step.endLine <= lines,
  );
}
export const requestSchema = z
  .object({
    kind: z.enum(["code", "repo", "article", "concept", "url", "document"]),
    content: z.string().trim().max(60_000),
    depth: z.enum(["beginner", "intermediate", "advanced"]),
    exampleId: z
      .enum(["demo-closure", "demo-event-loop", "demo-debounce"])
      .optional(),
    indexedRepoId: z.string().min(1).max(100).optional(),
    documentId: z.string().uuid().optional(),
    question: z.string().trim().max(4000).optional(),
    documentRange: z.object({ start: z.number().int().min(1).max(1_000_000), end: z.number().int().min(1).max(1_000_000) }).strict().optional(),
    documentVisual: z.boolean().optional(),
    // Only for rendering an encrypted PDF during this request; never persisted.
    documentPassword: z.string().min(1).max(256).optional(),
    parentLessonId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/).optional(),
  })
  .strict()
  .refine(
    (v) =>
      Boolean(v.exampleId) ||
      v.content.length >= 2 ||
      (v.kind === "repo" && Boolean(v.indexedRepoId)) ||
      (v.kind === "document" && Boolean(v.documentId)),
    "請輸入至少 2 個字元，選擇 Repo 索引，或上傳檔案。",
  )
  .refine(
    (v) => !v.indexedRepoId || v.kind === "repo",
    "只有 Repo 來源可使用 Repo 索引。",
  )
  .refine(
    (v) => v.kind === "document" ? Boolean(v.documentId) && !v.exampleId && !v.content : !v.documentId,
    "檔案解說必須使用已上傳的檔案 ID，且不能同時提供其他來源。",
  )
  .refine(
    (v) => v.kind === "document" || (v.documentRange === undefined && v.documentVisual === undefined && v.documentPassword === undefined),
    "只有檔案解說可以指定頁碼範圍、頁面影像或 PDF 密碼。",
  )
  .refine((v) => !v.documentRange || v.documentRange.start <= v.documentRange.end, "解說範圍的起點不能大於終點。");

export const analystSchema = z.object({
  title: short,
  scope: z.string().trim().min(1).max(1500),
  keyConcepts: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  explanationPlan: z.array(z.string().trim().min(1).max(800)).min(2).max(8),
  caveats: z.array(z.string().trim().min(1).max(500)).max(8),
});
const visualSceneSchema = z.object({
  layout: z.enum(["flow", "sequence", "memory", "layers", "timeline"]),
  edges: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
        from: short,
        to: short,
        label: z.string().max(100),
        type: z.enum(["data", "reference", "call", "return", "control"]),
      }),
    )
    .max(16),
  groups: z
    .array(
      z.object({
        id: short,
        label: short,
        nodeIds: z.array(short).min(1).max(6),
      }),
    )
    .max(4),
});
export const rubikIllustrationSchema = z.object({
  kind: z.literal("rubik-2x2"),
  title: z.string().trim().min(1).max(160),
  caption: z.string().trim().min(1).max(1600),
  setupMoves: z.array(z.enum(CUBE_MOVES)).max(12),
  focus: z.array(z.object({
    sectionIndex: z.number().int().min(0).max(7),
    view: z.enum(["space", "moves", "search"]),
  }).strict()).max(8).optional(),
}).strict();
export const teachingSchema = z
  .object({
    title: short,
    subtitle: short,
    summary: text,
    sections: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          heading: short,
          body: text,
          analogy: text,
          code: z.string().max(12_000),
          language: z.string().max(40),
          codeExample: codeExampleSchema.optional(),
          concepts: z.array(short).min(1).max(8),
          visualStep: z.number().int().min(0).max(11),
        }),
      )
      .min(2)
      .max(8),
    visual: z.object({
      kind: z.enum(["flow", "closure", "event-loop", "debounce"]),
      title: short,
      caption: text,
      nodes: z
        .array(
          z.object({
            id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
            label: short,
            detail: text,
          }),
        )
        .min(2)
        .max(6),
      steps: z
        .array(
          z.object({
            title: short,
            description: text,
            activeNodeIds: z.array(z.string()).min(1).max(6),
            output: z.string().max(1000),
            activeEdgeIds: z.array(z.string()).max(16).optional(),
            nodeStates: z
              .array(
                z.object({
                  nodeId: short,
                  value: z.string().max(160),
                  items: z.array(z.string().max(100)).max(5),
                }),
              )
              .max(6)
              .optional(),
          }),
        )
        .min(2)
        .max(12),
      scene: visualSceneSchema.optional(),
      illustration: rubikIllustrationSchema.optional(),
    }),
    followUpQuestions: z.array(short).min(2).max(5),
  })
  .superRefine((value, ctx) => {
    const focus = value.visual.illustration?.focus || [];
    focus.forEach((item, index) => {
      if (item.sectionIndex >= value.sections.length)
        ctx.addIssue({
          code: "custom",
          path: ["visual", "illustration", "focus", index, "sectionIndex"],
          message: "立體圖解引用不存在的教學段落",
        });
    });
    if (new Set(focus.map(item => item.sectionIndex)).size !== focus.length)
      ctx.addIssue({
        code: "custom",
        path: ["visual", "illustration", "focus"],
        message: "同一段落只能指定一個立體圖解模式",
      });
    // Each problem is reported at the field that has to change, so a repair may touch it.
    value.sections.forEach((section, index) => {
      if (!section.codeExample) return;
      if (!section.code.trim())
        ctx.addIssue({ code: "custom", path: ["sections", index, "code"], message: "實作案例需要程式碼" });
      if (!section.language.trim())
        ctx.addIssue({ code: "custom", path: ["sections", index, "language"], message: "實作案例需要標明程式語言" });
      if (section.code.trim() && !validCodeExampleLines(section.code, section.codeExample))
        ctx.addIssue({
          code: "custom",
          path: ["sections", index, "codeExample", "walkthrough"],
          message: "逐行解說的行號必須在程式碼行數內，且起點不大於終點",
        });
    });
    const ids = new Set(value.visual.nodes.map((n) => n.id));
    if (ids.size !== value.visual.nodes.length)
      ctx.addIssue({ code: "custom", path: ["visual", "nodes"], message: "視覺節點 ID 重複" });
    value.visual.steps.forEach((step, index) => {
      const path = ["visual", "steps", index, "activeNodeIds"];
      if (step.activeNodeIds.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", path, message: "視覺步驟引用不存在的節點" });
      if (new Set(step.activeNodeIds).size !== step.activeNodeIds.length)
        ctx.addIssue({ code: "custom", path, message: "視覺步驟重複引用同一節點" });
    });
    value.sections.forEach((section, index) => {
      if (section.visualStep >= value.visual.steps.length)
        ctx.addIssue({ code: "custom", path: ["sections", index, "visualStep"], message: "段落引用不存在的視覺步驟" });
    });
    const scene = value.visual.scene;
    const edgeIds = new Set(scene?.edges.map((edge) => edge.id) || []);
    if (scene && edgeIds.size !== scene.edges.length)
      ctx.addIssue({ code: "custom", path: ["visual", "scene", "edges"], message: "場景連線 ID 重複" });
    scene?.edges.forEach((edge, index) => {
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)
        ctx.addIssue({
          code: "custom",
          path: ["visual", "scene", "edges", index],
          message: "場景連線必須指向不同且存在的節點",
        });
    });
    scene?.groups.forEach((group, index) => {
      if (group.nodeIds.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", path: ["visual", "scene", "groups", index, "nodeIds"], message: "場景群組引用不存在的節點" });
    });
    value.visual.steps.forEach((step, index) => {
      if (step.activeEdgeIds?.some((id) => !edgeIds.has(id)))
        ctx.addIssue({ code: "custom", path: ["visual", "steps", index, "activeEdgeIds"], message: "步驟引用不存在的場景連線" });
      if (
        step.nodeStates?.some((state) => !ids.has(state.nodeId)) ||
        new Set(step.nodeStates?.map((state) => state.nodeId)).size !==
          (step.nodeStates?.length || 0)
      )
        ctx.addIssue({ code: "custom", path: ["visual", "steps", index, "nodeStates"], message: "步驟狀態的節點無效或重複" });
    });
  });
export const curatorSchema = z.object({
  category: short,
  tags: z.array(short).min(1).max(8),
  connections: z
    .array(
      z.object({
        targetId: z.string().max(80),
        sectionId: z.string().max(80),
        reason: short,
      }),
    )
    .max(8),
});
// Versioned scenes explicitly describe topology and state. Legacy curated
// diagrams remain readable without inferring relationships for new content.
export const liveTeachingSchema = teachingSchema
  .safeExtend({
    visual: teachingSchema.shape.visual.extend({
      kind: z.literal("flow"),
      scene: visualSceneSchema,
    }),
  })
  .superRefine((value, ctx) => {
    if (!value.sections.some((section) => section.codeExample))
      ctx.addIssue({
        code: "custom",
        path: ["sections"],
        message: "新教學至少需要一個有白話解說的小型完整程式案例",
      });
  });
export type Teaching = z.infer<typeof teachingSchema>;
export type Curation = z.infer<typeof curatorSchema>;

/** Connections that point at a saved note and one of its parts (a section or a v3 step), each once. */
export function existingConnections(connections: Curation["connections"], existing: readonly StoredLesson[]): Curation["connections"] {
  return connections
    .filter((connection) => existing.some((lesson) => lesson.id === connection.targetId && lessonPartIds(lesson).includes(connection.sectionId)))
    .filter((connection, index, all) => all.findIndex((other) => other.targetId === connection.targetId && other.sectionId === connection.sectionId) === index);
}

export function makeLesson(
  teaching: Teaching,
  curation: Curation,
  source: Source,
  existing: readonly StoredLesson[],
  id: string,
): Lesson {
  const valid = liveTeachingSchema.safeParse(teaching);
  if (!valid.success)
    throw schemaFailure("組裝筆記", "模型回傳的教學結構不完整，請重試。", valid.error);
  const now = new Date().toISOString();
  const sections = valid.data.sections.map((section, index) => ({
    ...section,
    id: `section-${index + 1}`,
  }));
  const connections = existingConnections(curation.connections, existing);
  return {
    ...valid.data,
    ...curation,
    sections,
    connections,
    source,
    id,
    createdAt: now,
    updatedAt: now,
    favorite: false,
    isDemo: false,
  };
}
