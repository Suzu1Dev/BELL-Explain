import { isLessonV3, type StoredLesson } from "../../shared/lesson-v3";
import { fill, type LearningCopy } from "../copy/learning";

export interface RelatedNote {
  lessonId: string;
  sectionId?: string;
  title: string;
  /** Heading of the linked section, when the link points into a section. */
  section?: string;
  reason: string;
  kind: "links-to" | "linked-from" | "continues" | "continued-by";
}

export const RELATION_LABELS: Record<RelatedNote["kind"], string> = { "links-to": "延伸閱讀", "linked-from": "被引用", continues: "延伸自", "continued-by": "延伸出" };

export function markdownRelations(items: RelatedNote[], copy: LearningCopy["lesson"]["exportRelations"]) {
  const labels: Record<RelatedNote["kind"], string> = {
    "links-to": copy.linksTo,
    "linked-from": copy.linkedFrom,
    continues: copy.continues,
    "continued-by": copy.continuedBy,
  };
  return items.map(item => ({
    title: item.title,
    label: labels[item.kind],
    reason: item.section ? fill(copy.sectionReasonJoin, { section: item.section, reason: item.reason }) : item.reason,
  }));
}

const cleanHeading = (heading: string) => heading.replace(/^\d+\s*[/．.、：:]\s*/, "");
const part = (lesson: StoredLesson, id?: string) => isLessonV3(lesson)
  ? lesson.steps.find(item => item.id === id)
  : lesson.sections.find(item => item.id === id);
const heading = (item: ReturnType<typeof part>) => item ? cleanHeading("lead" in item ? item.lead : item.heading) : undefined;

/** Curated links in both directions plus follow-up relations, with their reasons. */
export function relatedNotes(lesson: StoredLesson, lessons: StoredLesson[]): RelatedNote[] {
  const byId = new Map(lessons.map((item) => [item.id, item]));
  const related: RelatedNote[] = [];
  const parent = lesson.parentLessonId ? byId.get(lesson.parentLessonId) : undefined;
  if (parent) related.push({ lessonId: parent.id, title: parent.title, reason: "這篇是讀完它之後的延伸問題。", kind: "continues" });
  for (const connection of lesson.connections) {
    const target = byId.get(connection.targetId);
    const section = target && part(target, connection.sectionId);
    if (target && section) related.push({ lessonId: target.id, sectionId: section.id, title: target.title, section: heading(section), reason: connection.reason, kind: "links-to" });
  }
  for (const other of lessons) {
    if (other.id === lesson.id) continue;
    if (other.parentLessonId === lesson.id) related.push({ lessonId: other.id, title: other.title, reason: "從這篇的追問延伸出來。", kind: "continued-by" });
    for (const connection of other.connections) {
      if (connection.targetId !== lesson.id || related.some((item) => item.lessonId === other.id)) continue;
      const section = part(lesson, connection.sectionId);
      related.push({ lessonId: other.id, title: other.title, section: section ? `關聯到本篇「${heading(section)}」` : undefined, reason: connection.reason, kind: "linked-from" });
    }
  }
  // Parent first, then where this note points, follow-ups and notes that point here.
  const order = { continues: 0, "links-to": 1, "continued-by": 2, "linked-from": 3 };
  return related.sort((a, b) => order[a.kind] - order[b.kind]);
}
