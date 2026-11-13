import type { Figure, FigureCell } from "./lesson-v3.js";

/** "unanswered" is set by the server when the learner asks for the answer without trying. */
export type CheckVerdict = "correct" | "partial" | "incorrect" | "unanswered";
export interface CheckReference { referenceAnswer: string; keyPoints: string[]; sectionIds: string[]; }
export interface CheckAttempt { answer: string; verdict: CheckVerdict; gradedBy: "model" | "self"; at: string; }
export interface SelfCheckItem { index: number; question: string; reference?: CheckReference; lastAttempt?: CheckAttempt; }
export interface CheckResult extends CheckReference { verdict: CheckVerdict; feedback: string; attempt: CheckAttempt; }
export type CheckEvent = { type: "stage"; message: string } | { type: "checked"; result: CheckResult } | { type: "error"; message: string };

export interface ReviewCardView {
  id: string;
  lessonId: string;
  lessonTitle: string;
  category: string;
  kind: "section" | "term" | "check" | "recall";
  /** Where 〔回到這一步〕 opens: a section id of an original-format note or a step id of a v3 note. */
  sectionId?: string;
  /** For recall cards: the step's 1-based number, for the source chip 「閉包 · 第 2 步」. */
  step?: number;
  prompt: string;
  /** For term cards: the annotated term itself, so the client can localize the prompt. */
  term?: string;
  /** For term cards: the original sentence with the term blanked. */
  context?: string;
  /** A term card picked from a code line or program output: its prompt and context are never LaTeX. */
  code?: boolean;
  /** A term card whose term its paragraph shows as written although it looks like LaTeX (grep '\[ERROR\]'): the prompt is never LaTeX. */
  plainTerm?: boolean;
  hints: string[];
  answer: string;
  analogy?: string;
  keyPoints?: string[];
  /** For recall cards: the step's figure, shown on both faces. */
  figure?: Figure;
  /** For recall cards: the cell of `figure` to show as 「?」 on the front and fill in on the back. Always a cell `figure` has. */
  blank?: FigureCell;
  isNew: boolean;
  /** How long until the card would come back for each rating (milliseconds), 1 = again … 4 = easy. */
  intervals: Record<1 | 2 | 3 | 4, number>;
}
export interface ReviewSummary { due: number; newAvailable: number; reviewedToday: number; total: number; }

/**
 * Cards still in their minute-long learning steps are offered this early, so a session can
 * finish them: review lists such a card once `due − now` is at most this. A recall card rated
 * in the lesson starts there (記得 comes back in 10 minutes, 不確定 in 1), so it is in review at
 * once; show it as 「待複習」 while `due − now` is within this window.
 */
export const LEARN_AHEAD_MS = 20 * 60_000;

/** The learner's own verdict on an in-lesson recall question: 〔記得〕 is FSRS Good, 〔不確定〕 is Again. */
export type RecallAnswer = "remembered" | "unsure";
/**
 * A rated recall question of a v3 note. Unrated steps have none.
 * - `scheduled`: the card is in review; `due` is when it next comes back, and follows later
 *   reviews, so it can be in the past (due now). 不確定 is always scheduled: like a missed
 *   self-check, it uses none of the day's new-card allowance.
 * - `waiting`: 記得 rated after today's new-card limit (3 per note, 15 in all). The rating is
 *   recorded and the card joins review as a new card on a later day with room, which need
 *   not be tomorrow: newer notes and other new cards share the same allowance.
 * - `tomorrow`: no longer returned (`waiting` replaced it); kept so clients that name it
 *   still compile.
 * - `demo`: a built-in example; nothing is saved, so the next read has no state for it.
 */
export interface RecallState {
  stepId: string;
  rating: RecallAnswer;
  status: "scheduled" | "waiting" | "demo" | "tomorrow";
  due?: string;
  ratedAt: string;
}
