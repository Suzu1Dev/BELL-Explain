import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exampleLessons } from "../shared/examples.js";
import type { CheckEvent } from "../shared/learning.js";
import type { Lesson } from "../shared/types.js";
import { createApp } from "./app.js";
import type { ChatCall } from "./ai.js";
import { LearningStore, NEW_PER_DAY, NEW_PER_LESSON_PER_DAY } from "./learning.js";
import { LessonStore } from "./store.js";
import { intervalLabel } from "../src/lib/review.js";

const own = (lesson: Lesson, id: string, category = lesson.category): Lesson => ({ ...structuredClone(lesson), id, isDemo: false, category,
  followUpQuestions: ["閉包為什麼能記住變數？", "兩個計數器會互相影響嗎？"] });
const grading = { verdict: "partial", feedback: "提到了環境，但沒說明每次呼叫都建立新環境。", referenceAnswer: "函式保留建立時的詞法環境，所以能讀寫外層變數。", keyPoints: ["函式保留詞法環境", "每次呼叫建立新環境"], sectionIds: ["section-1", "not-a-section"] };

async function app(t: TestContext, chat?: ChatCall) {
  const directory = mkdtempSync(join(tmpdir(), "bell-learning-"));
  const store = new LessonStore(":memory:", exampleLessons);
  const learning = new LearningStore(join(directory, "learning.sqlite"));
  const lesson = own(exampleLessons[0], "note-a");
  lesson.sections = lesson.sections.map((section, index) => ({ ...section, id: `section-${index + 1}` }));
  store.save(lesson);
  const server = createServer(createApp({ store, examples: exampleLessons, config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "m" }, chat, learning }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); learning.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { host: "127.0.0.1:3001", "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`, { headers: { host: "127.0.0.1:3001" } });
  const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line) as CheckEvent);
  return { store, learning, lesson, post, get, events, directory };
}

test("a new learning database starts at its schema version without a pointless backup", async t => {
  const { directory } = await app(t);
  const db = new DatabaseSync(join(directory, "learning.sqlite"));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  db.close();
  assert.equal(existsSync(join(directory, "learning.sqlite.before-v1")), false);
});

test("self-check grading caches a reference, records the attempt and queues a review of a partial answer", async t => {
  const calls: Array<{ data: Record<string, unknown> }> = [];
  const { post, get, events, learning, store } = await app(t, async (_role, _instruction, data) => { calls.push({ data: data as Record<string, unknown> }); return grading; });
  const response = await post("/api/lessons/note-a/checks/0", { answer: "因為它記得外面的變數" });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  const checked = (await events(response)).find(event => event.type === "checked") as Extract<CheckEvent, { type: "checked" }>;
  assert.equal(checked.result.verdict, "partial");
  assert.deepEqual(checked.result.sectionIds, ["section-1"], "unknown section ids are dropped");
  assert.equal(checked.result.attempt.gradedBy, "model");
  assert.equal((calls[0].data.learnerAnswer as string), "因為它記得外面的變數");
  const items = await (await get("/api/lessons/note-a/checks")).json();
  assert.equal(items[0].reference.referenceAnswer, grading.referenceAnswer);
  assert.equal(items[0].lastAttempt.verdict, "partial");
  assert.equal(items[1].reference, undefined);
  // The partial answer is a review card due soon.
  const due = learning.due(store.listRaw(), new Date(Date.now() + 15 * 60_000));
  assert.ok(due.some(card => card.kind === "check" && card.prompt === "閉包為什麼能記住變數？" && card.answer === grading.referenceAnswer));
  // A later attempt can be self-assessed for free against the cached reference.
  const self = await post("/api/lessons/note-a/checks/0/self", { answer: "每次呼叫都會建立新環境", verdict: "correct" });
  assert.equal((await self.json()).gradedBy, "self");
  assert.equal(calls.length, 1);
  assert.equal((await post("/api/lessons/note-a/checks/1/self", { answer: "x", verdict: "correct" })).status, 409);
  // Asking for the answer without trying is recorded as unanswered.
  const blank = (await events(await post("/api/lessons/note-a/checks/1", { answer: "  " }))).find(event => event.type === "checked") as Extract<CheckEvent, { type: "checked" }>;
  assert.equal(blank.result.verdict, "unanswered");
  assert.equal(calls[1].data.learnerAnswer, null);
});

test("an invalid grading reply reports an error and saves nothing; bad requests are refused", async t => {
  const { post, events, learning, lesson } = await app(t, async () => ({ verdict: "maybe" }));
  const failed = await events(await post("/api/lessons/note-a/checks/0", { answer: "x" }));
  assert.equal(failed.at(-1)?.type, "error");
  assert.deepEqual(learning.checks(lesson).map(item => item.lastAttempt), [undefined, undefined]);
  assert.equal((await post("/api/lessons/note-a/checks/9", { answer: "x" })).status, 404);
  assert.equal((await post("/api/lessons/missing/checks/0", { answer: "x" })).status, 404);
  assert.equal((await post("/api/lessons/note-a/checks/0", { answer: "x".repeat(4001) })).status, 400);
});

test("review introduces a few new cards per note per day, interleaves categories and reschedules ratings", () => {
  // The day boundaries below are Taipei's, whatever BELL_TIMEZONE the machine has.
  const learning = new LearningStore(":memory:", { timeZone: "Asia/Taipei" });
  const lessons = [own(exampleLessons[0], "a", "JavaScript"), own(exampleLessons[1], "b", "網路"), own(exampleLessons[2], "c", "演算法")];
  for (const lesson of lessons) lesson.sections = [...lesson.sections, ...lesson.sections.map(section => ({ ...section, id: `${section.id}-2` }))];
  lessons[0].annotations = [{ id: "ann-1", sourceKey: `${lessons[0].sections[0].id}:body`, term: "閉包", quote: "閉包讓函式記得環境", explanation: "函式加上它的環境。", analogy: "", createdAt: new Date().toISOString() } as never,
    { id: "ann-2", sourceKey: `${lessons[0].sections[0].id}:code`, term: "\\(", quote: 're.sub(r"\\(\\d+\\)", "", s)', explanation: "跳脫的括號。", analogy: "", createdAt: new Date().toISOString() } as never];
  const morning = new Date("2026-10-08T01:00:00Z"); // 09:00 in Taipei
  const first = learning.due([...lessons, exampleLessons[0]], morning);
  assert.equal(first.length, NEW_PER_LESSON_PER_DAY * lessons.length);
  assert.ok(first.every(card => card.lessonId !== exampleLessons[0].id), "demo notes get no cards");
  // Categories alternate instead of finishing one note first.
  assert.deepEqual(first.slice(0, 3).map(card => card.category).sort(), ["JavaScript", "演算法", "網路"]);
  // The same day brings no further new cards.
  assert.equal(learning.due(lessons, new Date("2026-10-08T05:00:00Z")).filter(card => card.isNew && !first.some(item => item.id === card.id)).length, 0);
  const card = first[0];
  assert.ok(card.intervals[4] > card.intervals[1]);
  // Easy graduates the card to days away; Again keeps it in this session's learning steps.
  const { due } = learning.rate(card.id, 4, morning);
  assert.ok(Date.parse(due) - morning.getTime() >= 86_400_000);
  learning.rate(first[1].id, 1, morning);
  const later = learning.due(lessons, new Date(morning.getTime() + 60_000));
  assert.equal(later.some(item => item.id === card.id), false);
  assert.ok(later.some(item => item.id === first[1].id));
  // The next Taipei day (16:00 UTC) allows new cards again.
  const nextDay = learning.due(lessons, new Date("2026-10-08T16:30:00Z"));
  assert.ok(nextDay.some(item => item.isNew && !first.some(previous => previous.id === item.id)));
  assert.ok(NEW_PER_DAY >= NEW_PER_LESSON_PER_DAY * lessons.length);
  const summary = learning.summary(lessons, new Date("2026-10-08T16:30:00Z"));
  assert.equal(summary.reviewedToday, 0);
  assert.ok(summary.total >= 13);
  // A term picked from code is flagged so the review card never typesets its backslashes.
  const terms = learning.due(lessons, new Date("2026-10-12T01:00:00Z")).filter(item => item.kind === "term");
  assert.deepEqual(terms.map(item => [item.prompt, item.code]).sort(), [["「\\(」在這段裡是什麼意思？", true], ["「閉包」在這段裡是什麼意思？", undefined]]);
  learning.close();
});

test("term cards from code lines and program output are flagged as code; prose terms shown as written keep a plain prompt", () => {
  const learning = new LearningStore(":memory:");
  const lesson = own(exampleLessons[0], "a");
  lesson.sections = lesson.sections.slice(0, 1);
  const term = (id: string, field: string, value: string, quote = `${value} 的上下文`) => ({ id, sourceKey: `${lesson.sections[0].id}:${field}`, term: value, quote, explanation: "說明", analogy: "", createdAt: new Date().toISOString() });
  lesson.annotations = [term("prose", "body", "\\(x^2\\)"), term("output", "example-output", "a\\[b\\]")];
  // Prose that shows the term as written, as a regex: the prompt keeps it as written too.
  const regex = { ...structuredClone(lesson), id: "b", annotations: [term("regex", "body", "\\[ERROR\\]", "用 grep '\\[ERROR\\]' app.log 找出錯誤行。")] };
  const cards = learning.due([lesson, regex], new Date("2026-10-08T01:00:00Z")).filter(card => card.kind === "term");
  assert.deepEqual(cards.map(card => [card.prompt, card.code, card.plainTerm]).sort(), [
    ["「\\(x^2\\)」在這段裡是什麼意思？", undefined, undefined], ["「\\[ERROR\\]」在這段裡是什麼意思？", undefined, true], ["「a\\[b\\]」在這段裡是什麼意思？", true, undefined]]);
  learning.close();
});

test("cards and answers follow note edits and deletes", () => {
  const learning = new LearningStore(":memory:");
  const lesson = own(exampleLessons[0], "a");
  learning.recordAttempt("a", 0, "x", "incorrect", "self");
  learning.saveReference("a", 0, lesson.followUpQuestions[0], { referenceAnswer: "r", keyPoints: ["k1", "k2"], sectionIds: [] });
  // A wrong answer comes back within the same sitting.
  const cards = learning.due([lesson], new Date());
  assert.ok(cards.some(card => card.kind === "check"));
  assert.ok(cards.some(card => card.kind === "section"));
  // A changed question no longer matches its old cached reference.
  assert.equal(learning.reference("a", 0, "換了題目"), undefined);
  // A missed check does not use up the day's new cards for that note.
  assert.equal(cards.filter(card => card.kind !== "check").length, NEW_PER_LESSON_PER_DAY);
  // Deleting the note hides its cards at once but keeps its learning data while the note can be restored from the trash.
  assert.deepEqual(learning.due([], new Date()), []);
  assert.equal(learning.summary([]).total, 0);
  assert.equal(learning.checks(lesson)[0].reference?.referenceAnswer, "r");
  const restored = learning.due([lesson], new Date(Date.now() + 15 * 60_000));
  assert.ok(restored.some(card => card.kind === "check" && !card.isNew), "a restored note keeps its review history");
  // After the trash period the data is gone for good.
  learning.due([], new Date(Date.now() + 86_400_000));
  learning.due([], new Date(Date.now() + 32 * 86_400_000));
  assert.deepEqual(learning.checks(lesson).map(item => [item.reference, item.lastAttempt]), [[undefined, undefined], [undefined, undefined]]);
  assert.throws(() => learning.rate(cards[0].id, 3), /找不到這張複習卡/);
  learning.close();
});

test("rating buttons say when a card comes back in plain units", () => {
  assert.equal(intervalLabel(20_000), "1 分鐘");
  assert.equal(intervalLabel(10 * 60_000), "10 分鐘");
  assert.equal(intervalLabel(5 * 3_600_000), "5 小時");
  assert.equal(intervalLabel(9 * 86_400_000), "9 天");
  assert.equal(intervalLabel(90 * 86_400_000), "3 個月");
  assert.equal(intervalLabel(800 * 86_400_000), "2.2 年");
});

test("a review card due later today joins today's session; learning steps keep exact times", () => {
  const learning = new LearningStore(":memory:", { timeZone: "Asia/Taipei" });
  const lesson = own(exampleLessons[0], "a");
  const monday = new Date("2026-10-12T00:31:00Z"); // 08:31 in Taipei
  const card = learning.due([lesson], monday)[0];
  const { due } = learning.rate(card.id, 4, monday);
  const dueDay = new Date(due);
  // Earlier in the morning of the due day, the card is already part of the session.
  const sameDayEarlier = new Date(Date.UTC(dueDay.getUTCFullYear(), dueDay.getUTCMonth(), dueDay.getUTCDate(), 0, 5));
  assert.ok(sameDayEarlier.getTime() < dueDay.getTime());
  assert.ok(learning.due([lesson], sameDayEarlier).some(item => item.id === card.id));
  assert.ok(learning.summary([lesson], sameDayEarlier).due >= 1);
  // The day before it is not.
  assert.equal(learning.due([lesson], new Date(sameDayEarlier.getTime() - 86_400_000)).some(item => item.id === card.id), false);
  // Remembering it early in the day schedules as if on time, so the next interval is not stunted.
  const onTime = new LearningStore(":memory:", { timeZone: "Asia/Taipei" });
  const same = onTime.due([lesson], monday)[0];
  onTime.rate(same.id, 4, monday);
  const early = Date.parse(learning.rate(card.id, 3, sameDayEarlier).due);
  const exact = Date.parse(onTime.rate(same.id, 3, dueDay).due);
  assert.ok(Math.abs(early - exact) < 2 * 86_400_000, "an early review gets about the same next interval as one on time");
  // Rated again seconds later (a retry, or a stale queue on another device), it is not
  // credited with a review on its new due day: its interval does not compound.
  const again = Date.parse(learning.rate(card.id, 3, new Date(sameDayEarlier.getTime() + 5_000)).due);
  assert.ok(again - early < (early - sameDayEarlier.getTime()) / 2, "a repeat rating long before the due day does not jump ahead");
  onTime.close();
  learning.close();
});

test("term review cards include annotation.term alongside the fallback prompt while non-term cards omit term", async t => {
  const { store, lesson, get } = await app(t);
  lesson.sections = lesson.sections.slice(0, 1);
  lesson.annotations = [
    { id: "ann-plain", sourceKey: `${lesson.sections[0].id}:body`, term: "closure", quote: "A closure remembers its outer scope.", explanation: "Function plus lexical environment.", analogy: "", createdAt: new Date().toISOString() } as never,
    { id: "ann-math", sourceKey: `${lesson.sections[0].id}:body`, term: String.raw`\(\nabla f\)`, quote: String.raw`The gradient \(\nabla f\) points uphill.`, explanation: "Gradient vector.", analogy: "", createdAt: new Date().toISOString() } as never,
  ];
  store.save(lesson);
  const due = await (await get("/api/review/due")).json() as Array<{ kind: string; term?: string; prompt: string; code?: boolean; plainTerm?: boolean }>;
  const termCards = due.filter(card => card.kind === "term").sort((a, b) => (a.term || "").localeCompare(b.term || ""));
  assert.deepEqual(termCards.map(card => ({ term: card.term, prompt: card.prompt, code: card.code, plainTerm: card.plainTerm })), [
    { term: String.raw`\(\nabla f\)`, prompt: `「${String.raw`\(\nabla f\)`}」在這段裡是什麼意思？`, code: undefined, plainTerm: undefined },
    { term: "closure", prompt: "「closure」在這段裡是什麼意思？", code: undefined, plainTerm: undefined },
  ]);
  for (const other of due.filter(card => card.kind !== "term")) {
    assert.equal(other.term, undefined);
  }
});
