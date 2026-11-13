import { typesetAsQuoted } from "./math.js";
import type { LessonAnnotation } from "./types.js";
import { isLessonV3, type StoredLesson } from "./lesson-v3.js";

export interface AnnotationSource { key: string; text: string; }

/** A code line or a program's expected output: shown as written, so its backslashes are never LaTeX. */
export const isCodeSource = (sourceKey: string) => /:(code|example-output)$/.test(sourceKey);
/** Whether an explained term is typeset as LaTeX: only in prose, and only as its paragraph typesets it (\[ERROR\] in grep '\[ERROR\]' is not). */
export const termIsMath = ({ term, quote, sourceKey }: Pick<LessonAnnotation, "term" | "quote" | "sourceKey">) =>
  !isCodeSource(sourceKey) && typesetAsQuoted(term, quote);

/** Authoritative guided-reading text. Keep raw-source and UI labels out. */
export function annotationSources(lesson: StoredLesson): AnnotationSource[] {
  // Format 3: the answer and each step's lead and body, which is what a reader marks up.
  if (isLessonV3(lesson)) return [{ key: "answer", text: lesson.answer }, ...lesson.steps.flatMap(step => [
    { key: `${step.id}:lead`, text: step.lead }, { key: `${step.id}:body`, text: step.body },
  ])];
  const sources: AnnotationSource[] = [{ key: "summary", text: lesson.summary }];
  for (const section of lesson.sections) {
    const add = (name: string, text: string) => sources.push({ key: `${section.id}:${name}`, text });
    add("heading", section.heading);
    add("body", section.body);
    add("analogy", section.analogy);
    add("code", section.code);
    if (section.codeExample) {
      const example = section.codeExample;
      add("example-title", example.title);
      add("example-scenario", example.scenario);
      add("example-environment", example.environment);
      add("example-output", example.expectedOutput);
      add("example-application", example.application);
      example.walkthrough.forEach((step, index) => add(`example-walkthrough:${index}`, step.explanation));
    }
    section.concepts.forEach((concept, index) => add(`concept:${index}`, concept));
  }
  return sources;
}
