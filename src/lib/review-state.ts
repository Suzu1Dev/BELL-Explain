import type { ReviewSummary } from "../../shared/learning";

export interface ReviewState {
  status: "loading" | "ready" | "stale" | "error";
  summary?: ReviewSummary;
  updatedAt?: number;
  retrying?: boolean;
}

export function reviewRefresh(current: ReviewState): ReviewState {
  return { ...current, retrying: true };
}

export function reviewSuccess(summary: ReviewSummary, updatedAt: number): ReviewState {
  return { status: "ready", summary, updatedAt };
}

export function reviewFailure(current: ReviewState, now = Date.now()): ReviewState {
  if (current.summary && current.updatedAt !== undefined && now - current.updatedAt <= 30 * 60 * 1000) {
    return { ...current, status: "stale", retrying: false };
  }
  return { status: "error" };
}
