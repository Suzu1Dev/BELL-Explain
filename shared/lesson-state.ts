import type { StoredLesson } from "./lesson-v3";

/** A GET started before a mutation must not roll that note back on arrival. */
export function mergeRefreshedLessons(current: StoredLesson[], incoming: StoredLesson[]): StoredLesson[] {
  const byId = new Map(current.map(lesson => [lesson.id, lesson]));
  const merged = incoming.map(lesson => {
    const existing = byId.get(lesson.id);
    return existing && existing.updatedAt > lesson.updatedAt ? existing : lesson;
  });
  // The response remains authoritative for deletions and list ordering.
  return JSON.stringify(current) === JSON.stringify(merged) ? current : merged;
}
