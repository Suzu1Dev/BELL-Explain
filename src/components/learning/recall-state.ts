import { LEARN_AHEAD_MS, type RecallState } from "../../../shared/learning";
import { fill, type LearningCopy } from "../../copy/learning";

export type DueBucket = "dueNow" | "minutes" | "hours" | "todayAt" | "tomorrowAt" | "days";

function localDay(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
}

function dueBucket(state: RecallState, now: Date): DueBucket {
  if (!state.due) return "dueNow";
  const due = new Date(state.due);
  const delta = due.getTime() - now.getTime();
  if (delta <= LEARN_AHEAD_MS) return "dueNow";
  if (delta < 3_600_000) return "minutes";
  if (delta < 6 * 3_600_000) return "hours";
  const days = localDay(due) - localDay(now);
  if (days <= 0) return "todayAt";
  if (days === 1) return "tomorrowAt";
  return "days";
}

export function recallConfirmation(state: RecallState, copy: LearningCopy, now = new Date()): string {
  if (state.status === "demo") return copy.recall.confirmation.byRating[state.rating].demo;
  if (state.status === "waiting" || state.status === "tomorrow") {
    return state.rating === "remembered" ? copy.recall.confirmation.byRating.remembered.waiting : copy.recall.confirmation.byRating.unsure.dueNow;
  }
  const bucket = dueBucket(state, now);
  const text = copy.recall.confirmation.byRating[state.rating][bucket];
  const n = bucket === "minutes" ? Math.ceil((Date.parse(state.due!) - now.getTime()) / 60_000)
    : bucket === "hours" ? Math.ceil((Date.parse(state.due!) - now.getTime()) / 3_600_000)
      : bucket === "days" ? Math.max(2, localDay(new Date(state.due!)) - localDay(now)) : 0;
  return bucket === "days" || bucket === "minutes" || bucket === "hours"
    ? fill(text, { n })
    : bucket === "todayAt" || bucket === "tomorrowAt"
      ? fill(text, { time: new Date(state.due!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) })
      : text;
}

export function wrapUpStatus(state: RecallState | undefined, copy: LearningCopy): { text: string; icon: "check" | "again" | "waiting" | "unanswered" } {
  if (!state) return { text: copy.wrapUp.statusUnanswered, icon: "unanswered" };
  if (state.status === "waiting" || state.status === "tomorrow") return { text: copy.wrapUp.statusWaiting, icon: "waiting" };
  return state.rating === "remembered" ? { text: copy.wrapUp.statusRemembered, icon: "check" } : { text: copy.wrapUp.statusUnsure, icon: "again" };
}
