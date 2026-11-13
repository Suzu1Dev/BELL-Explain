import test from "node:test";
import assert from "node:assert/strict";
import { reviewFailure, reviewRefresh, reviewSuccess } from "./review-state.js";

test("review failures distinguish unknown, known zero and stale data", () => {
  const initial = reviewRefresh({ status: "error" });
  assert.deepEqual(initial, { status: "error", retrying: true });
  const failed = reviewFailure(initial, 100);
  assert.deepEqual(failed, { status: "error" });
  const zero = reviewSuccess({ due: 0, newAvailable: 0, reviewedToday: 2, total: 0 }, 100);
  assert.equal(zero.summary?.due, 0);
  assert.equal(reviewFailure(zero, 100).status, "stale");
  assert.equal(reviewFailure(zero, 100).summary?.reviewedToday, 2);
});

test("retrying preserves the visible state and success clears the retry flag", () => {
  const summary = { due: 2, newAvailable: 0, reviewedToday: 0, total: 2 };
  const failed = { status: "error", summary, updatedAt: 100, retrying: true } as const;
  assert.deepEqual(reviewRefresh(failed), failed);
  const stale = reviewFailure(failed, 100);
  assert.equal(reviewRefresh(stale).status, "stale");
  assert.equal(reviewRefresh(stale).retrying, true);
  assert.deepEqual(reviewSuccess(summary, 200), { status: "ready", summary, updatedAt: 200 });
});

test("a stale summary remains available at the 30-minute boundary", () => {
  const current = reviewSuccess({ due: 3, newAvailable: 1, reviewedToday: 2, total: 4 }, 1_000);
  const atBoundary = reviewFailure(current, 1_000 + 30 * 60 * 1000);
  assert.equal(atBoundary.status, "stale");
  assert.equal(atBoundary.summary, current.summary);
});

test("a summary is dropped immediately after the 30-minute boundary", () => {
  const current = reviewSuccess({ due: 3, newAvailable: 1, reviewedToday: 2, total: 4 }, 1_000);
  assert.deepEqual(reviewFailure(current, 1_001 + 30 * 60 * 1000), { status: "error" });
});

test("a summary without a success timestamp cannot become stale", () => {
  const summary = { due: 3, newAvailable: 1, reviewedToday: 2, total: 4 };
  assert.deepEqual(reviewFailure({ status: "ready", summary }, 1_000), { status: "error" });
});
