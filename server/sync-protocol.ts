import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Lesson } from '../shared/types.js';
import type { LessonNoteV3, StoredLesson } from '../shared/lesson-v3.js';
import { annotationSources } from '../shared/annotations.js';
import { teachingSchema, curatorSchema } from './schema.js';
import { checkV3References, lessonV3Shape } from './lesson-v3-schema.js';
import { annotationSchema, MAX_ANNOTATIONS, MAX_ANNOTATED_LESSON_BYTES } from './lesson-annotations.js';
import { documentSourceSchema } from './document-schema.js';

export const syncId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
const syncSourceSchema = z.object({
    kind: z.enum(['code', 'repo', 'article', 'concept', 'url', 'document']),
    content: z.string().max(1_000_000), label: z.string().max(2000),
    url: z.string().max(4000).optional(), scope: z.string().max(20_000).optional(),
    truncated: z.boolean().optional(), fetchedAt: z.string().max(100).optional(),
    document: documentSourceSchema.optional(),
}).passthrough().refine(source => source.kind === 'document' ? Boolean(source.document) : !source.document, '文件來源需要有效的檔案資訊。');
/** What every saved note carries, whatever its format. */
const noteFields = {
  id: syncId, category: curatorSchema.shape.category, tags: curatorSchema.shape.tags,
  connections: curatorSchema.shape.connections,
  source: syncSourceSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  isDemo: z.boolean(), favorite: z.boolean(),
  // Keep the field optional: loading an older note must not change its hash.
  annotations: z.array(annotationSchema).max(MAX_ANNOTATIONS).optional(),
  parentLessonId: syncId.optional(),
};
function checkAnnotations(lesson: StoredLesson, ctx: z.RefinementCtx) {
  if (!lesson.annotations?.length) return;
  if (Buffer.byteLength(JSON.stringify(lesson), 'utf8') > MAX_ANNOTATED_LESSON_BYTES)
    ctx.addIssue({code:'custom',path:['annotations'],message:'含有詞句解說的筆記超過可同步容量'});
  const sources = annotationSources(lesson);
  const ids = new Set<string>();
  const selections = new Set<string>();
  lesson.annotations.forEach((annotation, index) => {
    const path = ['annotations', index];
    if (ids.has(annotation.id))
      ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: '詞彙解說 ID 重複' });
    ids.add(annotation.id);
    const selection = JSON.stringify([annotation.term, annotation.sourceKey]);
    if (selections.has(selection))
      ctx.addIssue({ code: 'custom', path: [...path, 'term'], message: '同一來源的詞彙解說重複' });
    selections.add(selection);
    const matches = sources.filter(source => source.key === annotation.sourceKey);
    if (matches.length !== 1)
      ctx.addIssue({ code: 'custom', path: [...path, 'sourceKey'], message: '詞彙解說來源不存在或無法唯一識別' });
    else if (!matches[0].text.includes(annotation.quote))
      ctx.addIssue({ code: 'custom', path: [...path, 'quote'], message: '詞彙解說引文必須來自指定來源' });
    if (!annotation.quote.includes(annotation.term))
      ctx.addIssue({ code: 'custom', path: [...path, 'term'], message: '詞彙必須包含在來源引文中' });
  });
}
/**
 * A note in the original format. Unchanged, so these notes keep their exact content and hash;
 * only a note saved after a failed format-3 attempt adds `failedFormat`.
 */
export const legacySyncLessonSchema = teachingSchema.safeExtend({ ...noteFields, failedFormat: z.literal(3).optional() }).superRefine(checkAnnotations);
/** A format-3 note: strict, so nothing it carries is dropped on the way through. */
export const syncLessonV3Schema = z.strictObject({ ...lessonV3Shape, ...noteFields })
  .superRefine(checkV3References).superRefine(checkAnnotations);
/** Formats this build can store and synchronize; `GET /v1/capabilities` advertises them. */
export const LESSON_FORMATS = [3] as const;

const hasFormat = (value: unknown) => typeof value === 'object' && value !== null && Object.hasOwn(value, 'format');
/**
 * Any synchronized note. A note that names a `format` is checked only as that format,
 * never as the original one, whose parser would silently drop the fields it does not know.
 */
export const syncLessonSchema: z.ZodType<Lesson | LessonNoteV3> = z.unknown().transform((value, ctx) => {
  const result = hasFormat(value) ? syncLessonV3Schema.safeParse(value) : legacySyncLessonSchema.safeParse(value);
  if (result.success) return result.data as Lesson | LessonNoteV3;
  for (const issue of result.error.issues) ctx.addIssue({ ...issue, code: 'custom', message: issue.message, path: issue.path });
  return z.NEVER;
});
export const syncCapabilitiesSchema = z.object({ lessonFormats: z.array(z.number().int()).max(20) }).loose();
export const syncDocumentSchema = z.object({
  id: syncId, revision: z.number().int().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/),
  lesson: syncLessonSchema.nullable(),
}).strict().refine(value => value.lesson === null || value.id === value.lesson.id, '筆記 ID 不一致');
export const syncOperationSchema = z.object({
  operationId: z.string().uuid(), id: syncId, baseRevision: z.number().int().min(0),
  lesson: syncLessonSchema.nullable(),
}).strict().refine(value => value.lesson === null || value.id === value.lesson.id, '筆記 ID 不一致');
export const syncPushResultSchema = z.object({accepted: z.boolean(), document: syncDocumentSchema}).strict();
export const syncPullSchema = z.object({
  cursor: z.number().int().min(0), hasMore: z.boolean(),
  changes: z.array(z.object({sequence: z.number().int().min(1), document: syncDocumentSchema}).strict()).max(100),
}).strict();
export const syncInfoSchema = z.object({protocol: z.literal(1), workspaceId: z.string().uuid()}).strict();

// Content, rather than client wall clocks, decides whether two versions match.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function lessonHash(lesson: StoredLesson | null): string {
  const data = lesson === null ? null : Object.fromEntries(Object.entries(lesson).filter(([key]) => !['createdAt', 'updatedAt'].includes(key)));
  return createHash('sha256').update(canonical(data)).digest('hex');
}
export function validateSyncDocument(value: unknown) {
  const document = syncDocumentSchema.parse(value);
  if (document.hash !== lessonHash(document.lesson)) throw new Error('Invalid synchronized content hash');
  return document;
}
