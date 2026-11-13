import { isLessonV3, type StoredLesson } from "../../shared/lesson-v3";

const KEY = "bell.reading";
const LIMIT = 100;
/** Where the learner is in a note, kept in this browser only. */
export interface ReadingProgress { sectionId: string; index: number; total: number; furthest: number; at: string; }

export function readingProgress(): Record<string, ReadingProgress> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, ReadingProgress>;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export function saveReadingProgress(lessonId: string, sectionId: string, index: number, total: number): void {
  try {
    const all = readingProgress();
    const previous = all[lessonId];
    // The same section again within a minute is skipped, unless another note was read in between:
    // `at` decides which note the continue card offers.
    const latest = Object.values(all).reduce((max, item) => (item.at > max ? item.at : max), "");
    if (previous?.sectionId === sectionId && previous.at === latest && Date.now() - Date.parse(previous.at) < 60_000) return;
    all[lessonId] = { sectionId, index, total, furthest: Math.max(previous?.furthest ?? 0, index), at: new Date().toISOString() };
    const kept = Object.entries(all).sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, LIMIT);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Reading still works without storage.
  }
}
/** The most recently read note that still exists, with its section or step heading. */
export function lastRead(lessons: StoredLesson[]): { lesson: StoredLesson; progress: ReadingProgress; heading: string } | undefined {
  const progress = readingProgress();
  return lessons
    .filter((lesson) => !lesson.isDemo && progress[lesson.id])
    .map((lesson) => ({ lesson, progress: progress[lesson.id] }))
    .sort((a, b) => b.progress.at.localeCompare(a.progress.at))
    .map(({ lesson, progress: item }) => {
      const parts = isLessonV3(lesson) ? lesson.steps : lesson.sections;
      const index = parts.findIndex(section => section.id === item.sectionId);
      const section = parts[index] ?? parts[0];
      if (!section) return undefined;
      const text = "lead" in section ? section.lead : section.heading.replace(/^\d+\s*[/．.、：:]\s*/, "");
      return { lesson, progress: { ...item, index: Math.max(0, index), total: parts.length }, heading: text };
    })
    .find(Boolean);
}
