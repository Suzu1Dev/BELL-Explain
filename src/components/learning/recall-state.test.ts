import test from "node:test";
import assert from "node:assert/strict";
import type { RecallState } from "../../../shared/learning";
import { recallConfirmation, wrapUpStatus } from "./recall-state";
import { learningCopy } from "../../copy/learning";

const now = new Date("2026-11-10T12:00:00.000Z");
const copy = learningCopy();
const state = (status: RecallState["status"], due?: string, rating: RecallState["rating"] = "remembered"): RecallState => ({ stepId: "s1", rating, status, due, ratedAt: now.toISOString() });

test("scheduled due buckets follow the actual due timestamp and 20-minute window", () => {
  assert.equal(recallConfirmation(state("scheduled", "2026-11-10T12:20:00.000Z"), copy, now), "記得 · 待複習");
  assert.equal(recallConfirmation(state("scheduled", "2026-11-10T12:21:00.000Z"), copy, now), "記得 · 21 分鐘後再問");
  assert.equal(recallConfirmation(state("scheduled", "2026-11-10T14:00:00.000Z"), copy, now), "記得 · 2 小時後再問");
  assert.equal(recallConfirmation(state("scheduled", "2026-11-10T18:30:00.000Z"), copy, now), "記得 · 今天 18:30 再問");
  assert.equal(recallConfirmation(state("scheduled", "2026-11-11T09:30:00.000Z"), copy, now), "記得 · 明天 09:30 再問");
  assert.equal(recallConfirmation(state("scheduled", "2026-11-14T09:30:00.000Z"), copy, now), "記得 · 4 天後再問");
});

test("waiting is remembered-only; demo and wrap-up stay rating-driven", () => {
  assert.equal(recallConfirmation(state("waiting"), copy, now), "記得 · 之後開始複習");
  assert.equal(recallConfirmation(state("waiting", undefined, "unsure"), copy, now), "不確定 · 待複習");
  assert.equal(recallConfirmation(state("demo"), copy, now), "記得 · 示範課程不排入複習");
  assert.deepEqual(wrapUpStatus(state("waiting"), copy), { text: "之後開始複習", icon: "waiting" });
  assert.deepEqual(wrapUpStatus(state("scheduled", undefined, "unsure"), copy), { text: "不確定", icon: "again" });
  assert.deepEqual(wrapUpStatus(undefined, copy), { text: "未回想", icon: "unanswered" });
});
