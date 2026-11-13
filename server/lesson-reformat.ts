import { annotationSources } from "../shared/annotations.js";
import type { Lesson, LessonAnnotation } from "../shared/types.js";
import type { LessonNoteV3, StoredLesson } from "../shared/lesson-v3.js";
import { annotationUpdatedAt } from "./lesson-annotations.js";
import { existingConnections } from "./schema.js";

/**
 * 整理成新格式 (L1.7): an original-format note written again in format 3 replaces it in place.
 * What the learner attached to the old note moves over wherever the new steps allow it.
 */

/** Section N of an original note becomes step sN of its v3 rewrite: the parts keep their order. */
const stepOf = (sectionId: string) => sectionId.replace(/^section-(\d+)$/, "s$1");
/** Where an annotation's text sits in the rewrite: the summary is the answer, a heading is its step's lead. */
const v3Key = (sourceKey: string) => sourceKey === "summary"
  ? "answer"
  : sourceKey.replace(/^section-(\d+):(.+)$/, (_all, n: string, field: string) => `s${n}:${field === "heading" ? "lead" : field}`);

export interface Reformatted {
  note: LessonNoteV3;
  /** Other notes whose links into this one were moved from section-N to step sN. */
  linked: StoredLesson[];
  /** Annotations the rewrite no longer contains the quoted words of. */
  dropped: number;
}

/**
 * The saved note for a rewrite: the same id, creation time, favorite and follow-up parent; the
 * links it made, plus any the curator found; and every annotation whose quoted words are still
 * in the new text, at the matching step or, failing that, the one place they appear. The new
 * note never carries `failedFormat`.
 *
 * Its own links are kept as stored, the same as links from other notes into it: one whose note or
 * part is missing stays in the data and is hidden when read (LessonStore.get/list), so it shows
 * again if that part comes back, from the trash or a sync. Only the curator's new links have to
 * point at a saved part, as for a new note.
 */
export function reformatted(current: Lesson, written: LessonNoteV3, library: readonly StoredLesson[]): Reformatted {
  const sources = annotationSources(written);
  const selections = new Set<string>();
  const annotations: LessonAnnotation[] = [];
  for (const annotation of current.annotations ?? []) {
    const holding = sources.filter(source => source.text.includes(annotation.quote));
    const matching = holding.filter(source => source.key === v3Key(annotation.sourceKey));
    const target = matching.length === 1 ? matching[0] : holding.length === 1 ? holding[0] : undefined;
    const selection = target && JSON.stringify([annotation.term, target.key]);
    if (!target || !selection || selections.has(selection)) continue;
    selections.add(selection);
    annotations.push({ ...annotation, sourceKey: target.key });
  }
  const others = library.filter(lesson => lesson.id !== current.id);
  const note: LessonNoteV3 = {
    ...written,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: annotationUpdatedAt(current),
    favorite: current.favorite,
    isDemo: false,
    connections: [...current.connections, ...existingConnections(written.connections, others)]
      .filter((link, index, all) => all.findIndex(other => other.targetId === link.targetId && other.sectionId === link.sectionId) === index)
      .slice(0, 8),
    ...(current.annotations ? { annotations } : {}),
    ...(current.parentLessonId ? { parentLessonId: current.parentLessonId } : {}),
  };
  const steps = new Set(written.steps.map(step => step.id));
  const moves = (targetId: string, sectionId: string) => targetId === current.id && stepOf(sectionId) !== sectionId && steps.has(stepOf(sectionId));
  const linked = others.flatMap(other => other.connections.some(link => moves(link.targetId, link.sectionId))
    ? [{ ...other, connections: other.connections.map(link => moves(link.targetId, link.sectionId) ? { ...link, sectionId: stepOf(link.sectionId) } : link), updatedAt: annotationUpdatedAt(other) }]
    : []);
  return { note, linked, dropped: (current.annotations?.length ?? 0) - annotations.length };
}
