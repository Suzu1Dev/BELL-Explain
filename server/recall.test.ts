import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from "ts-fsrs";
import { exampleLessons } from "../shared/examples.js";
import { LEARN_AHEAD_MS, type RecallState, type ReviewCardView } from "../shared/learning.js";
import { recallParts, type LessonNoteV3, type StoredLesson } from "../shared/lesson-v3.js";
import type { Lesson, Source } from "../shared/types.js";
import { createApp } from "./app.js";
import { AppError } from "./errors.js";
import { LearningStore, NEW_PER_DAY, NEW_PER_LESSON_PER_DAY } from "./learning.js";
import { LESSON_V3_EXAMPLE } from "./prompts/lesson-v3-example.js";
import { LessonStore } from "./store.js";
import { FORMAT_HELD_MESSAGE } from "./sync.js";

const CREATED = "2026-11-09T00:00:00.000Z";
const source: Source = { kind: "code", label: "JavaScript 閉包與獨立計數器", content: "function createCounter(initial = 0) { let count = initial; }" };
/** The closure lesson of 03 §8.3 as one of the learner's own notes. */
function closure(id = "closure", extra: Partial<LessonNoteV3> = {}): LessonNoteV3 {
  const { source: _generated, ...lesson } = structuredClone(LESSON_V3_EXAMPLE);
  return { ...lesson, id, category: "JavaScript", tags: ["閉包"], connections: [], source, createdAt: CREATED, updatedAt: CREATED, favorite: false, isDemo: false, ...extra };
}
/** The closure lesson with five steps, for the per-note limit. */
function fiveSteps(id: string): LessonNoteV3 {
  const note = closure(id);
  note.steps = [...note.steps, ...note.steps.slice(0, 2).map((step, index) => ({ ...structuredClone(step), id: `s${4 + index}` }))];
  return note;
}
const own = (lesson: Lesson, id: string): Lesson => ({ ...structuredClone(lesson), id, isDemo: false });
// Same settings as the store; learning steps (minutes) are never fuzzed, so this is exact.
const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));
const expectedGap = (grade: Grade, at: Date, card: Card = createEmptyCard(at)) => scheduler.next(card, at, grade).card.due.getTime() - at.getTime();
const gap = (state: RecallState) => Date.parse(state.due!) - Date.parse(state.ratedAt);
const recallCards = (cards: ReviewCardView[], lessonId?: string) => cards.filter(card => card.kind === "recall" && (!lessonId || card.lessonId === lessonId));
// 09:00 in Taipei; the next Taipei day starts at 16:00 UTC.
const MORNING = new Date("2026-11-10T01:00:00Z");
const NEXT_DAY = new Date("2026-11-10T16:30:00Z");
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const DAY_AFTER = minutesAfter(NEXT_DAY, 24 * 60);

async function app(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "bell-recall-"));
  const store = new LessonStore(":memory:", exampleLessons);
  const learning = new LearningStore(join(directory, "learning.sqlite"));
  store.save(closure());
  store.save(own(exampleLessons[0], "old-note"));
  const server = createServer(createApp({ store, examples: exampleLessons, config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "m" }, learning }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); learning.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { host: "127.0.0.1:3001", "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}${path}`, { headers: { host: "127.0.0.1:3001" } });
  return { post, get };
}

test("recall: two 記得 and one 不確定 in the closure lesson queue three recall cards rated Good, Good and Again", async t => {
  const { post, get } = await app(t);
  const rate = async (step: string, rating: string) => {
    const response = await post(`/api/lessons/closure/recall/${step}`, { rating });
    assert.equal(response.status, 200);
    return await response.json() as RecallState;
  };
  const s1 = await rate("s1", "remembered");
  const s2 = await rate("s2", "remembered");
  const s3 = await rate("s3", "unsure");
  assert.deepEqual([s1, s2, s3].map(state => [state.stepId, state.rating, state.status]),
    [["s1", "remembered", "scheduled"], ["s2", "remembered", "scheduled"], ["s3", "unsure", "scheduled"]]);
  assert.equal(gap(s1), expectedGap(Rating.Good, new Date(s1.ratedAt)));
  assert.equal(gap(s2), expectedGap(Rating.Good, new Date(s2.ratedAt)));
  assert.equal(gap(s3), expectedGap(Rating.Again, new Date(s3.ratedAt)));
  assert.ok(gap(s3) < gap(s1), "不確定 comes back sooner than 記得");

  // The lesson reads its rated steps back, in step order.
  assert.deepEqual(await (await get("/api/lessons/closure/recall")).json(), [s1, s2, s3]);

  // In review at once: their first steps (10 and 1 minutes) fall within LEARN_AHEAD_MS.
  const due = await (await get("/api/review/due")).json() as ReviewCardView[];
  const cards = recallCards(due, "closure");
  assert.deepEqual(cards.map(card => card.sectionId).sort(), ["s1", "s2", "s3"]);
  // A v3 note has no 「這一段在講什麼？」 section cards; an original-format note still has them.
  assert.equal(due.some(card => card.lessonId === "closure" && card.kind === "section"), false);
  assert.ok(due.some(card => card.lessonId === "old-note" && card.kind === "section"));

  // The step-2 card carries its figure and the cell to blank: the output of the third call.
  const second = cards.find(card => card.sectionId === "s2")!;
  const step2 = LESSON_V3_EXAMPLE.steps[1];
  assert.equal(second.step, 2);
  assert.equal(second.prompt, step2.recall.question);
  assert.equal(second.answer, step2.recall.answer);
  assert.deepEqual(second.hints, [step2.recall.hint]);
  assert.deepEqual(second.figure, step2.figure);
  assert.deepEqual(second.blank, { kind: "state-output", row: 3 });
  assert.equal((second.figure as { rows: Array<{ output?: string }> }).rows[3].output, "3");
  // Step 1 has a figure but no blank.
  const first = cards.find(card => card.sectionId === "s1")!;
  assert.equal(first.figure?.kind, "annotated-code");
  assert.equal(first.blank, undefined);

  // Rating a step again, from a retry or another device, keeps the first rating and schedule.
  assert.deepEqual(await rate("s3", "remembered"), s3);
  assert.deepEqual(await (await get("/api/lessons/closure/recall")).json(), [s1, s2, s3]);
});

test("recall: the API refuses bad ratings, unknown steps and notes, and original-format notes", async t => {
  const { post, get } = await app(t);
  const status = async (path: string, body: unknown) => (await post(path, body)).status;
  assert.equal(await status("/api/lessons/closure/recall/s1", { rating: 3 }), 400);
  assert.equal(await status("/api/lessons/closure/recall/s1", { rating: "good" }), 400);
  assert.equal(await status("/api/lessons/closure/recall/s1", { rating: "remembered", due: "2030-01-01" }), 400);
  assert.equal(await status("/api/lessons/closure/recall/s9", { rating: "remembered" }), 404);
  assert.equal(await status("/api/lessons/missing/recall/s1", { rating: "remembered" }), 404);
  assert.equal(await status("/api/lessons/old-note/recall/s1", { rating: "remembered" }), 409);
  assert.equal((await get("/api/lessons/missing/recall")).status, 404);
  assert.deepEqual(await (await get("/api/lessons/old-note/recall")).json(), []);
  assert.deepEqual(await (await get("/api/lessons/closure/recall")).json(), []);
});

function store() {
  return new LearningStore(":memory:", { timeZone: "Asia/Taipei" });
}

test("recall: a 4th 記得 in one note on a day is recorded and waits, then joins review as new", t => {
  const learning = store();
  t.after(() => learning.close());
  const note = fiveSteps("five");
  const lessons = [note];
  assert.equal(NEW_PER_LESSON_PER_DAY, 3);
  const states = ["s1", "s2", "s3", "s4"].map(step => learning.rateRecall("five", step, "remembered", lessons, MORNING));
  assert.deepEqual(states.map(state => state.status), ["scheduled", "scheduled", "scheduled", "waiting"]);
  assert.equal(states[3].rating, "remembered");
  assert.equal(states[3].due, undefined);

  const later = minutesAfter(MORNING, 1);
  assert.deepEqual(recallCards(learning.due(lessons, later)).map(card => card.sectionId).sort(), ["s1", "s2", "s3"]);
  const summary = learning.summary(lessons, later);
  assert.equal(summary.newAvailable, 0, "the waiting card is past this note's limit today");
  assert.equal(summary.reviewedToday, 3, "a rating past the limit is recorded, not reviewed");

  // On the next Taipei day the waiting card comes in as a new card.
  const fourth = recallCards(learning.due(lessons, NEXT_DAY)).find(card => card.sectionId === "s4");
  assert.ok(fourth, "s4 joins the next day's review");
  assert.equal(fourth.isNew, true);
  assert.equal(fourth.step, 4);
  assert.deepEqual(learning.recalls(note).find(state => state.stepId === "s4"),
    // Its due stays at the rating time until it is reviewed: due now, in the review queue.
    { stepId: "s4", rating: "remembered", status: "scheduled", due: MORNING.toISOString(), ratedAt: MORNING.toISOString() });
  // s4 used one of the note's three slots that day; s5 still has room.
  assert.equal(learning.rateRecall("five", "s5", "unsure", lessons, NEXT_DAY).status, "scheduled");
});

test("recall: the 16th new card of the day waits, and the cards it took leave review none", t => {
  const learning = store();
  t.after(() => learning.close());
  const notes = Array.from({ length: 6 }, (_, index) => closure(`closure-${index + 1}`));
  const old = own(exampleLessons[0], "old-note");
  const lessons: StoredLesson[] = [...notes, old];
  assert.equal(NEW_PER_DAY, 15);
  const scheduled = notes.slice(0, 5).flatMap(note => note.steps.map(step => learning.rateRecall(note.id, step.id, "remembered", lessons, MORNING)));
  assert.equal(scheduled.length, 15);
  assert.ok(scheduled.every(state => state.status === "scheduled"));
  // The sixth note has introduced nothing today; only the daily limit holds it back.
  assert.equal(learning.rateRecall("closure-6", "s1", "remembered", lessons, MORNING).status, "waiting");
  // The limit is shared with review: today's queue introduces none of the old note's cards.
  const today = learning.due(lessons, minutesAfter(MORNING, 1));
  assert.equal(today.filter(card => card.isNew).length, 0);
  assert.equal(today.length, 15);
});

test("recall: cards review introduced count toward the daily limit too", t => {
  const learning = store();
  t.after(() => learning.close());
  const notes = Array.from({ length: 5 }, (_, index) => closure(`closure-${index + 1}`));
  const old = own(exampleLessons[0], "old-note");
  const lessons: StoredLesson[] = [old, ...notes];
  // Review introduces three of the old note's cards first.
  assert.equal(learning.due(lessons, MORNING).filter(card => card.isNew && card.lessonId === "old-note").length, NEW_PER_LESSON_PER_DAY);
  const states = notes.flatMap(note => note.steps.map(step => learning.rateRecall(note.id, step.id, "remembered", lessons, MORNING).status));
  assert.deepEqual(states, [...Array(12).fill("scheduled"), ...Array(3).fill("waiting")]);
});

test("recall: a rated card is in review at once because its first step falls within the shared LEARN_AHEAD_MS", t => {
  const learning = store();
  t.after(() => learning.close());
  const note = closure();
  const state = learning.rateRecall("closure", "s1", "remembered", [note], MORNING);
  const wait = Date.parse(state.due!) - MORNING.getTime();
  assert.ok(wait > 0 && wait <= LEARN_AHEAD_MS, "記得 is due in minutes, inside the window");
  assert.equal(learning.peekSummary([note], MORNING).due, 1);
  assert.deepEqual(recallCards(learning.due([note], MORNING)).map(card => card.sectionId), ["s1"]);
  // The window is the server's: a card is listed exactly when due − now is at most LEARN_AHEAD_MS.
  const due = new Date(state.due!);
  assert.equal(learning.peekSummary([note], new Date(due.getTime() - LEARN_AHEAD_MS)).due, 1);
  assert.equal(learning.peekSummary([note], new Date(due.getTime() - LEARN_AHEAD_MS - 1)).due, 0);
});

test("recall: 不確定 past both limits is still scheduled as Again, uses no allowance, and reviews as a learning card", t => {
  const learning = store();
  t.after(() => learning.close());
  const five = fiveSteps("five");
  const notes = Array.from({ length: 5 }, (_, index) => closure(`closure-${index + 1}`));
  const lessons: StoredLesson[] = [...notes, five];
  // Per note: an 不確定 between 記得 takes none of the note's three slots.
  const rate = (step: string, answer: "remembered" | "unsure") => learning.rateRecall("five", step, answer, lessons, MORNING);
  const states = [rate("s1", "remembered"), rate("s2", "remembered"), rate("s4", "unsure"), rate("s3", "remembered"), rate("s5", "remembered")];
  assert.deepEqual(states.map(state => [state.stepId, state.status]), [["s1", "scheduled"], ["s2", "scheduled"], ["s4", "scheduled"], ["s3", "scheduled"], ["s5", "waiting"]]);
  assert.equal(gap(states[2]), expectedGap(Rating.Again, MORNING));
  // Per day: with 3 + 12 cards introduced, 記得 waits and 不確定 is still scheduled.
  for (const note of notes.slice(0, 4)) for (const step of note.steps) learning.rateRecall(note.id, step.id, "remembered", lessons, MORNING);
  assert.equal(learning.rateRecall("closure-5", "s1", "remembered", lessons, MORNING).status, "waiting");
  const unsure = learning.rateRecall("closure-5", "s2", "unsure", lessons, MORNING);
  assert.equal(unsure.status, "scheduled");
  assert.equal(gap(unsure), expectedGap(Rating.Again, MORNING));
  assert.deepEqual(learning.recalls(notes[4]).map(state => [state.stepId, state.rating, state.status]), [["s1", "remembered", "waiting"], ["s2", "unsure", "scheduled"]]);

  // In review it is a learning card rated Again, not a new one.
  const now = minutesAfter(MORNING, 2);
  const card = recallCards(learning.due(lessons, now), "closure-5").find(item => item.sectionId === "s2")!;
  assert.equal(card.isNew, false);
  const again = scheduler.next(createEmptyCard(MORNING), MORNING, Rating.Again).card;
  assert.equal(card.intervals[Rating.Again], expectedGap(Rating.Again, now, again));
  assert.equal(card.intervals[Rating.Good], expectedGap(Rating.Good, now, again));
  assert.equal(learning.summary(lessons, now).newAvailable, 0, "no slot was freed or taken by the misses");
});

test("recall: a waiting card says waiting, not tomorrow, while later days have no room, and starts on the first day that does", t => {
  const learning = store();
  t.after(() => learning.close());
  const five = fiveSteps("five");
  const newer = Array.from({ length: 5 }, (_, index) => closure(`closure-${index + 1}`));
  const lessons: StoredLesson[] = [...newer, five];
  for (const step of five.steps) learning.rateRecall("five", step.id, "remembered", [five], MORNING);
  const status = () => learning.recalls(five).map(state => [state.stepId, state.status]);
  assert.deepEqual(status().slice(3), [["s4", "waiting"], ["s5", "waiting"]]);
  // The next day the learner rates five newer lessons before opening review: 15 cards, the whole day.
  for (const note of newer) for (const step of note.steps) assert.equal(learning.rateRecall(note.id, step.id, "remembered", lessons, NEXT_DAY).status, "scheduled");
  learning.due(lessons, minutesAfter(NEXT_DAY, 1));
  assert.deepEqual(status().slice(3), [["s4", "waiting"], ["s5", "waiting"]], "still waiting on the second day");
  assert.equal(learning.recalls(five)[3].due, undefined);
  // The third day has room: review brings both in as new cards, due since their rating.
  const started = recallCards(learning.due(lessons, DAY_AFTER), "five").filter(card => card.isNew).map(card => card.sectionId);
  assert.deepEqual(started, ["s4", "s5"]);
  assert.deepEqual(learning.recalls(five).slice(3), ["s4", "s5"].map(stepId => ({ stepId, rating: "remembered", status: "scheduled", due: MORNING.toISOString(), ratedAt: MORNING.toISOString() })));
});

test("recall: after a rollback prunes the recall cards, the steps read as unrated and can be rated again", t => {
  const directory = mkdtempSync(join(tmpdir(), "bell-recall-rollback-"));
  const path = join(directory, "learning.sqlite");
  let again: LearningStore | undefined;
  t.after(() => { again?.close(); rmSync(directory, { recursive: true, force: true }); });
  const note = closure();
  const first = new LearningStore(path, { timeZone: "Asia/Taipei" });
  for (const step of note.steps) first.rateRecall("closure", step.id, "remembered", [note], MORNING);
  first.close();
  // Recall data needs no schema step, so a build from before it still opens the database
  // (README: 退回舊版會刪掉回想卡). Its review queue then deletes every card kind it does not
  // know, as below, and leaves the review log behind.
  const older = new DatabaseSync(path);
  assert.equal((older.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  older.prepare("DELETE FROM review_cards WHERE kind = 'recall'").run();
  assert.equal((older.prepare("SELECT COUNT(*) AS count FROM review_log").get() as { count: number }).count, 3);
  older.close();

  again = new LearningStore(path, { timeZone: "Asia/Taipei" });
  const later = minutesAfter(MORNING, 30);
  assert.deepEqual(again.recalls(note), [], "the ratings cannot come back");
  assert.deepEqual(recallCards(again.due([note], later)), []);
  const rerated = again.rateRecall("closure", "s1", "unsure", [note], later);
  assert.deepEqual([rerated.rating, rerated.status, rerated.ratedAt], ["unsure", "scheduled", later.toISOString()]);
  assert.deepEqual(again.recalls(note), [rerated]);
});

test("recall: built-in examples answer without saving anything", t => {
  const learning = store();
  t.after(() => learning.close());
  const demo = closure("demo", { isDemo: true });
  const state = learning.rateRecall("demo", "s1", "remembered", [demo], MORNING);
  assert.deepEqual(state, { stepId: "s1", rating: "remembered", status: "demo", ratedAt: MORNING.toISOString() });
  assert.deepEqual(learning.recalls(demo), []);
  assert.deepEqual(learning.due([demo], MORNING), []);
  assert.equal(learning.summary([demo], MORNING).total, 0);
});

test("recall: direct calls refuse original-format notes and unknown steps", t => {
  const learning = store();
  t.after(() => learning.close());
  const old = own(exampleLessons[0], "old-note");
  const note = closure();
  assert.throws(() => learning.rateRecall("old-note", "s1", "remembered", [old], MORNING), (error: unknown) => error instanceof AppError && error.status === 409);
  assert.throws(() => learning.rateRecall("closure", "s9", "remembered", [note], MORNING), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.throws(() => learning.rateRecall("missing", "s1", "remembered", [note], MORNING), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.deepEqual(learning.recalls(old), []);
});

test("recall: a step removed from the note takes its recall card with it", t => {
  const learning = store();
  t.after(() => learning.close());
  const note = closure();
  for (const step of note.steps) learning.rateRecall("closure", step.id, "remembered", [note], MORNING);
  const edited = { ...note, steps: note.steps.filter(step => step.id !== "s3") };
  const cards = recallCards(learning.due([edited], minutesAfter(MORNING, 1)));
  assert.deepEqual(cards.map(card => card.sectionId).sort(), ["s1", "s2"]);
  assert.deepEqual(learning.recalls(edited).map(state => state.stepId), ["s1", "s2"]);
  // Restoring the step does not bring back the old rating: it is a new question to answer.
  assert.deepEqual(learning.recalls(note).map(state => state.stepId), ["s1", "s2"]);
});

test("recall: a review card drops a blank its figure lacks and has no figure when the step has none", t => {
  const learning = store();
  t.after(() => learning.close());
  const note = closure();
  note.steps[1].recall.blank = { kind: "state-output", row: 99 };
  delete note.steps[2].figure;
  delete note.steps[2].recall.hint;
  for (const step of note.steps) learning.rateRecall("closure", step.id, "remembered", [note], MORNING);
  const cards = recallCards(learning.due([note], minutesAfter(MORNING, 1)));
  const second = cards.find(card => card.sectionId === "s2")!;
  assert.equal(second.figure?.kind, "state");
  assert.equal(second.blank, undefined);
  assert.equal("blank" in second, false);
  const third = cards.find(card => card.sectionId === "s3")!;
  assert.equal("figure" in third, false);
  assert.equal("blank" in third, false);
  assert.deepEqual(third.hints, [], "s3 has no hint");
  assert.equal(third.step, 3);
});

test("recall: the read-only summary counts recall cards and writes nothing", t => {
  const directory = mkdtempSync(join(tmpdir(), "bell-recall-peek-"));
  const path = join(directory, "learning.sqlite");
  const learning = new LearningStore(path, { timeZone: "Asia/Taipei" });
  const reader = new DatabaseSync(path, { readOnly: true });
  t.after(() => { reader.close(); learning.close(); rmSync(directory, { recursive: true, force: true }); });
  const cards = () => (reader.prepare("SELECT COUNT(*) AS count FROM review_cards").get() as { count: number }).count;
  const note = closure();
  const old = own(exampleLessons[0], "old-note");
  const lessons: StoredLesson[] = [note, old];
  for (const step of note.steps) learning.rateRecall("closure", step.id, "remembered", lessons, MORNING);
  assert.equal(cards(), 3, "rating creates only the recall cards");
  const later = minutesAfter(MORNING, 1);
  const peek = learning.peekSummary(lessons, later);
  assert.equal(cards(), 3, "peeking writes nothing");
  assert.equal(peek.due, 3);
  assert.equal(peek.reviewedToday, 3);
  assert.ok(peek.total > 3, "the old note's cards count as new, uncreated");
  // The writing summary creates the old note's cards and agrees with the peek.
  assert.deepEqual(learning.summary(lessons, later), peek);
  assert.equal(cards(), peek.total);
});

test("recall: recallParts splits the verdict from the reason", () => {
  assert.deepEqual(recallParts("3。`count` 從 2 加到 3，因為三次呼叫改的都是同一個變數。"),
    { verdict: "3。", reason: "`count` 從 2 加到 3，因為三次呼叫改的都是同一個變數。" });
  assert.deepEqual(recallParts("不共用。每次呼叫 `createCounter` 都會建立新的 `count`。"),
    { verdict: "不共用。", reason: "每次呼叫 `createCounter` 都會建立新的 `count`。" });
  assert.deepEqual(recallParts("No. Each call makes its own `count`."), { verdict: "No.", reason: "Each call makes its own `count`." });
  // Inline code never ends the verdict, whatever marks it holds.
  assert.deepEqual(recallParts("`a.b()` 會回傳 3。因為 `b` 讀的是 `a`。"), { verdict: "`a.b()` 會回傳 3。", reason: "因為 `b` 讀的是 `a`。" });
  assert.deepEqual(recallParts("印出 `\"。\"`。因為字串原樣輸出。"), { verdict: "印出 `\"。\"`。", reason: "因為字串原樣輸出。" });
  // A number is not a sentence end; a bold verdict keeps its closing marks.
  assert.deepEqual(recallParts("Returns 3.14 every time"), { verdict: "Returns 3.14 every time", reason: "" });
  assert.deepEqual(recallParts("**3。** 因為改的是同一個變數。"), { verdict: "**3。**", reason: "因為改的是同一個變數。" });
  assert.deepEqual(recallParts("會，兩個都會變"), { verdict: "會，兩個都會變", reason: "" });
  assert.deepEqual(recallParts("真的嗎？！是的。"), { verdict: "真的嗎？！", reason: "是的。" });
});

test("recall: recallParts never splits inside 「」 or 『』, keeps a closing ** or quote, and skips e.g. and i.e.", () => {
  // A quoted sentence's own end mark does not end the verdict.
  assert.deepEqual(recallParts("他說「好。」所以結束。"), { verdict: "他說「好。」所以結束。", reason: "" });
  assert.deepEqual(recallParts("會印出「完成！」和『再見。』兩行。因為兩次呼叫都有輸出。"),
    { verdict: "會印出「完成！」和『再見。』兩行。", reason: "因為兩次呼叫都有輸出。" });
  assert.deepEqual(recallParts("文件寫著「先呼叫 `init()`。再呼叫『run』。」所以順序不能反。"),
    { verdict: "文件寫著「先呼叫 `init()`。再呼叫『run』。」所以順序不能反。", reason: "" });
  // A half-width end before ** or a closing quote, and an answer with leading spaces.
  assert.deepEqual(recallParts("**Yes.** Because each call makes its own `count`."), { verdict: "**Yes.**", reason: "Because each call makes its own `count`." });
  assert.deepEqual(recallParts("  **3。** 因為"), { verdict: "**3。**", reason: "因為" });
  assert.deepEqual(recallParts("It prints \"done.\" Then it exits."), { verdict: "It prints \"done.\"", reason: "Then it exits." });
  // Abbreviations are not sentence ends.
  assert.deepEqual(recallParts("e.g. a counter. Then more."), { verdict: "e.g. a counter.", reason: "Then more." });
  assert.deepEqual(recallParts("Yes, i.e. the same `count`. Both calls change it."), { verdict: "Yes, i.e. the same `count`.", reason: "Both calls change it." });
  assert.deepEqual(recallParts("A closure vs. a class. Both keep state."), { verdict: "A closure vs. a class.", reason: "Both keep state." });
});

test("recall: the sync hold message covers 整理失敗 notes as well as new-format notes", () => {
  assert.match(FORMAT_HELD_MESSAGE, /新格式筆記/);
  assert.match(FORMAT_HELD_MESSAGE, /整理失敗/);
});
