import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from "ts-fsrs";
import { isCodeSource, termIsMath } from "../shared/annotations.js";
import { codeText, findInline } from "../shared/math.js";
import { figureHasCell, isLessonV3, lessonPartIds, type StoredLesson } from "../shared/lesson-v3.js";
import { LEARN_AHEAD_MS, type CheckAttempt, type CheckReference, type CheckVerdict, type RecallAnswer, type RecallState, type ReviewCardView, type ReviewSummary, type SelfCheckItem } from "../shared/learning.js";
import { migrate, type Migration } from "./db/migrate.js";
import { AppError } from "./errors.js";
import { TRASH_DAYS } from "./store.js";

/** New cards per note and in total that may enter review on one day. */
export const NEW_PER_LESSON_PER_DAY = 3;
export const NEW_PER_DAY = 15;

const MIGRATIONS: Migration[] = [{
  version: 1,
  up: (db) => db.exec(`
    CREATE TABLE check_answers (lesson_id TEXT NOT NULL, question_index INTEGER NOT NULL, question TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (lesson_id, question_index));
    CREATE TABLE check_attempts (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, question_index INTEGER NOT NULL, answer TEXT NOT NULL, verdict TEXT NOT NULL, graded_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX check_attempts_lesson ON check_attempts (lesson_id, question_index, created_at);
    CREATE TABLE review_cards (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, state_json TEXT NOT NULL, due TEXT NOT NULL, introduced_at TEXT, created_at TEXT NOT NULL, UNIQUE (lesson_id, kind, ref));
    CREATE INDEX review_cards_due ON review_cards (introduced_at, due);
    CREATE TABLE review_log (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, rating INTEGER NOT NULL, state INTEGER NOT NULL, reviewed_at TEXT NOT NULL);
    CREATE TABLE orphaned_lessons (lesson_id TEXT PRIMARY KEY, since TEXT NOT NULL);
  `),
}];

export const checkResultSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  feedback: z.string().trim().min(1).max(800),
  referenceAnswer: z.string().trim().min(1).max(2400),
  keyPoints: z.array(z.string().trim().min(1).max(240)).min(2).max(4),
  sectionIds: z.array(z.string().trim().min(1).max(80)).max(3),
}).strict();

const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));
type CardRow = { id: string; lesson_id: string; kind: string; ref: string; state_json: string; due: string; introduced_at: string | null };
const cleanHeading = (heading: string) => heading.replace(/^\d+\s*[/．.、：:]\s*/, "");
/**
 * A review card offered earlier on its due day (`dueToday`) and remembered is scheduled
 * as of its due time: FSRS counts elapsed days by calendar date, and an early-morning
 * review would otherwise look like a same-day repeat and stunt the next interval.
 * A card rated before its due day, such as from a stale queue on another device, is
 * rated as of now, so it is not credited with a review on time. A forgotten card (Again)
 * relearns from now.
 */
const reviewTime = (card: Card, now: Date, rating: Grade, dueToday: boolean) =>
  (rating !== Rating.Again && card.state === State.Review && card.due > now && dueToday ? card.due : now);
/**
 * Cloze: `quote` with each place of `term` blanked out. In prose a blank takes whole
 * backticks: a term saved across a code span's edge blanks up to that edge, leaving no
 * lone backtick to pair with the next code span.
 */
function cloze(quote: string, term: string, prose: boolean): string {
  if (!prose || !term) return quote.split(term).join("＿＿＿");
  const codes = findInline(quote).filter((span) => span.kind === "code");
  const within = (at: number, span: { start: number; end: number }) => at > span.start && at < span.end;
  let result = "";
  let at = 0;
  for (let found = quote.indexOf(term); found >= 0; found = quote.indexOf(term, at)) {
    let start = found;
    let end = found + term.length;
    for (const span of codes) {
      const [first, last] = codeText(span);
      if (start >= first && end <= last) continue;
      if (within(start, span)) start = span.start;
      if (within(end, span)) end = span.end;
    }
    result += `${quote.slice(at, Math.max(at, start))}＿＿＿`;
    at = end;
  }
  return result + quote.slice(at);
}
function toCard(json: string): Card {
  const value = JSON.parse(json) as Card & { due: string; last_review?: string };
  return { ...value, due: new Date(value.due), last_review: value.last_review ? new Date(value.last_review) : undefined };
}
const cardKey = (row: { lesson_id: string; kind: string; ref: string }) => `${row.lesson_id}|${row.kind}|${row.ref}`;
/**
 * The cards notes call for: a section and a term card for each part of the learner's
 * own notes, which sync creates, and those plus the check cards of their questions,
 * which sync keeps. Built-in examples get none. A format-3 note gets term cards only,
 * and keeps a recall card for each of its steps: recall cards come with the in-lesson
 * rating (rateRecall), and a format-3 note has no section or check cards.
 */
function wantedCards(lessons: StoredLesson[]) {
  const create: Array<{ lesson_id: string; kind: "section" | "term"; ref: string }> = [];
  const keep = new Set<string>();
  for (const lesson of lessons.filter((item) => !item.isDemo)) {
    if (isLessonV3(lesson)) {
      for (const annotation of lesson.annotations || []) create.push({ lesson_id: lesson.id, kind: "term", ref: annotation.id });
      for (const step of lesson.steps) keep.add(cardKey({ lesson_id: lesson.id, kind: "recall", ref: step.id }));
      continue;
    }
    for (const section of lesson.sections) create.push({ lesson_id: lesson.id, kind: "section", ref: section.id });
    for (const annotation of lesson.annotations || []) create.push({ lesson_id: lesson.id, kind: "term", ref: annotation.id });
    lesson.followUpQuestions.forEach((_question, index) => keep.add(cardKey({ lesson_id: lesson.id, kind: "check", ref: String(index) })));
  }
  for (const card of create) keep.add(cardKey(card));
  return { create, keep };
}

/**
 * Self-check answers and spaced review, kept on the server so every device sees
 * the same progress. Cards are derived from notes and follow their edits and deletes.
 */
export class LearningStore {
  private readonly db: DatabaseSync;
  private readonly day: Intl.DateTimeFormat;
  constructor(path: string, options: { timeZone?: string } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    migrate(this.db, "學習紀錄", MIGRATIONS, path);
    // Daily limits follow the learner's calendar day, not the server's UTC clock.
    this.day = new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone || process.env.BELL_TIMEZONE || "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  close(): void { this.db.close(); }

  // ---- self-check -------------------------------------------------------
  reference(lessonId: string, index: number, question: string): CheckReference | undefined {
    const row = this.db.prepare("SELECT question, json FROM check_answers WHERE lesson_id = ? AND question_index = ?").get(lessonId, index) as { question: string; json: string } | undefined;
    // A regenerated note may ask something else at the same index.
    return row && row.question === question ? JSON.parse(row.json) as CheckReference : undefined;
  }
  saveReference(lessonId: string, index: number, question: string, reference: CheckReference): void {
    this.db.prepare("INSERT INTO check_answers (lesson_id, question_index, question, json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (lesson_id, question_index) DO UPDATE SET question = excluded.question, json = excluded.json, created_at = excluded.created_at")
      .run(lessonId, index, question, JSON.stringify(reference), new Date().toISOString());
  }
  /** Records an attempt; on a reviewed note, anything short of correct becomes a review card due soon. */
  recordAttempt(lessonId: string, index: number, answer: string, verdict: CheckVerdict, gradedBy: "model" | "self", options: { review?: boolean; now?: Date } = {}): CheckAttempt {
    const { review = true, now = new Date() } = options;
    const attempt: CheckAttempt = { answer, verdict, gradedBy, at: now.toISOString() };
    this.db.prepare("INSERT INTO check_attempts (id, lesson_id, question_index, answer, verdict, graded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), lessonId, index, answer, verdict, gradedBy, attempt.at);
    if (review && verdict !== "correct") {
      const existing = this.db.prepare("SELECT id, state_json FROM review_cards WHERE lesson_id = ? AND kind = 'check' AND ref = ?").get(lessonId, String(index)) as { id: string; state_json: string } | undefined;
      const card = scheduler.next(existing ? toCard(existing.state_json) : createEmptyCard(now), now, Rating.Again).card;
      if (existing) this.db.prepare("UPDATE review_cards SET state_json = ?, due = ?, introduced_at = COALESCE(introduced_at, ?) WHERE id = ?").run(JSON.stringify(card), card.due.toISOString(), now.toISOString(), existing.id);
      else this.db.prepare("INSERT INTO review_cards (id, lesson_id, kind, ref, state_json, due, introduced_at, created_at) VALUES (?, ?, 'check', ?, ?, ?, ?, ?)")
        .run(randomUUID(), lessonId, String(index), JSON.stringify(card), card.due.toISOString(), now.toISOString(), now.toISOString());
    }
    return attempt;
  }
  checks(lesson: StoredLesson): SelfCheckItem[] {
    if (isLessonV3(lesson)) return [];
    const last = this.db.prepare("SELECT question_index, answer, verdict, graded_by, created_at FROM check_attempts WHERE lesson_id = ? ORDER BY created_at DESC").all(lesson.id) as Array<{ question_index: number; answer: string; verdict: CheckVerdict; graded_by: "model" | "self"; created_at: string }>;
    return lesson.followUpQuestions.map((question, index) => {
      const attempt = last.find((row) => row.question_index === index);
      return { index, question, reference: this.reference(lesson.id, index, question),
        lastAttempt: attempt ? { answer: attempt.answer, verdict: attempt.verdict, gradedBy: attempt.graded_by, at: attempt.created_at } : undefined };
    });
  }

  // ---- spaced review ----------------------------------------------------
  /** Adds cards for new sections and explained terms; removes cards whose note or part is gone. */
  syncCards(lessons: StoredLesson[], now = new Date()): void {
    const { create, keep } = wantedCards(lessons);
    const insert = this.db.prepare("INSERT OR IGNORE INTO review_cards (id, lesson_id, kind, ref, state_json, due, introduced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)");
    const fresh = JSON.stringify(createEmptyCard(now));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const card of create) insert.run(randomUUID(), card.lesson_id, card.kind, card.ref, fresh, now.toISOString(), now.toISOString());
      // A note that is gone keeps its learning data as long as the note itself can be
      // restored from the trash; parts removed from a note that still exists go at once.
      const present = new Set(lessons.map((lesson) => lesson.id));
      for (const row of this.db.prepare("SELECT id, lesson_id, kind, ref FROM review_cards").all() as CardRow[])
        if (present.has(row.lesson_id) && !keep.has(cardKey(row))) this.db.prepare("DELETE FROM review_cards WHERE id = ?").run(row.id);
      const learned = this.db.prepare("SELECT lesson_id FROM review_cards UNION SELECT lesson_id FROM check_answers UNION SELECT lesson_id FROM check_attempts").all() as Array<{ lesson_id: string }>;
      for (const { lesson_id } of learned)
        if (!present.has(lesson_id)) this.db.prepare("INSERT OR IGNORE INTO orphaned_lessons (lesson_id, since) VALUES (?, ?)").run(lesson_id, now.toISOString());
      for (const { lesson_id } of this.db.prepare("SELECT lesson_id FROM orphaned_lessons").all() as Array<{ lesson_id: string }>)
        if (present.has(lesson_id)) this.db.prepare("DELETE FROM orphaned_lessons WHERE lesson_id = ?").run(lesson_id);
      const expired = new Date(now.getTime() - TRASH_DAYS * 86_400_000).toISOString();
      for (const { lesson_id } of this.db.prepare("SELECT lesson_id FROM orphaned_lessons WHERE since < ?").all(expired) as Array<{ lesson_id: string }>) {
        for (const table of ["review_cards", "check_answers", "check_attempts", "orphaned_lessons"]) this.db.prepare(`DELETE FROM ${table} WHERE lesson_id = ?`).run(lesson_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private dayOf(date: Date) { return this.day.format(date); }
  /**
   * New material introduced on a day. The learner's own misses use no allowance: check
   * cards, and recall cards rated 不確定 in the lesson.
   */
  private introducedOn(rows: CardRow[], day: string) {
    return rows.filter((row) => row.kind !== "check" && row.introduced_at && this.dayOf(new Date(row.introduced_at)) === day && !(row.kind === "recall" && this.missedInLesson(row.id)));
  }
  /** A recall card whose in-lesson rating was 不確定 and scheduled it then: its first log entry is Again, not still new. */
  private missedInLesson(cardId: string) {
    const first = this.db.prepare("SELECT rating, state FROM review_log WHERE card_id = ? ORDER BY rowid LIMIT 1").get(cardId) as { rating: number; state: number } | undefined;
    return first?.rating === Rating.Again && first.state !== State.New;
  }
  /** Cards of notes that still exist; those of deleted notes wait out the trash period unseen. */
  private rows(present: Map<string, StoredLesson>): CardRow[] {
    return (this.db.prepare("SELECT * FROM review_cards").all() as CardRow[]).filter((row) => present.has(row.lesson_id));
  }
  private isDue(row: CardRow, now: Date) {
    if (!row.introduced_at) return false;
    if (row.due <= now.toISOString()) return true;
    const { state } = JSON.parse(row.state_json) as { state: State };
    // Day-long intervals follow the learner's calendar: due any time today means today's session.
    if (state === State.Review) return this.dayOf(new Date(row.due)) <= this.dayOf(now);
    return (state === State.Learning || state === State.Relearning) && Date.parse(row.due) <= now.getTime() + LEARN_AHEAD_MS;
  }
  /** Cards to review now: everything introduced and due, then today's allowance of new cards, interleaved by category. */
  due(lessons: StoredLesson[], now = new Date(), limit = 60): ReviewCardView[] {
    this.syncCards(lessons, now);
    const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const rows = this.rows(byId);
    const today = this.dayOf(now);
    const introducedToday = this.introducedOn(rows, today);
    const perLesson = new Map<string, number>();
    for (const row of introducedToday) perLesson.set(row.lesson_id, (perLesson.get(row.lesson_id) || 0) + 1);
    let allowance = Math.max(0, NEW_PER_DAY - introducedToday.length);
    const selected = rows.filter((row) => this.isDue(row, now));
    // New cards follow note order (newest first) and section order within a note.
    const order = new Map(lessons.map((lesson, index) => [lesson.id, index]));
    const newCards = rows.filter((row) => !row.introduced_at && byId.has(row.lesson_id))
      .sort((a, b) => (order.get(a.lesson_id)! - order.get(b.lesson_id)!) || this.position(byId.get(a.lesson_id)!, a) - this.position(byId.get(b.lesson_id)!, b));
    const introduce = this.db.prepare("UPDATE review_cards SET introduced_at = ? WHERE id = ?");
    for (const row of newCards) {
      if (!allowance) break;
      if ((perLesson.get(row.lesson_id) || 0) >= NEW_PER_LESSON_PER_DAY) continue;
      introduce.run(now.toISOString(), row.id);
      perLesson.set(row.lesson_id, (perLesson.get(row.lesson_id) || 0) + 1);
      allowance--;
      selected.push({ ...row, introduced_at: now.toISOString() });
    }
    // Interleave categories so related topics are practiced side by side.
    const groups = new Map<string, CardRow[]>();
    for (const row of selected.sort((a, b) => a.due.localeCompare(b.due))) {
      const category = byId.get(row.lesson_id)?.category || "";
      groups.set(category, [...(groups.get(category) || []), row]);
    }
    const interleaved: CardRow[] = [];
    while (interleaved.length < Math.min(limit, selected.length)) for (const queue of groups.values()) { const next = queue.shift(); if (next) interleaved.push(next); }
    return interleaved.slice(0, limit).flatMap((row) => this.view(row, byId.get(row.lesson_id), now) ?? []);
  }
  private position(lesson: StoredLesson, row: CardRow) {
    if (row.kind === "section") return isLessonV3(lesson) ? -1 : lesson.sections.findIndex((section) => section.id === row.ref);
    if (row.kind === "recall") return isLessonV3(lesson) ? lesson.steps.findIndex((step) => step.id === row.ref) : -1;
    return 1000 + (lesson.annotations || []).findIndex((annotation) => annotation.id === row.ref);
  }
  private view(row: CardRow, lesson: StoredLesson | undefined, now: Date): ReviewCardView | undefined {
    if (!lesson) return undefined;
    const card = toCard(row.state_json);
    // Durations, not dates: a card revealed minutes after the queue loaded still shows true intervals.
    const intervals = Object.fromEntries(([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]).map((grade) =>
      [grade, scheduler.next(card, reviewTime(card, now, grade, this.dayOf(card.due) === this.dayOf(now)), grade).card.due.getTime() - now.getTime()])) as ReviewCardView["intervals"];
    const base = { id: row.id, lessonId: lesson.id, lessonTitle: lesson.title, category: lesson.category, isNew: card.state === State.New, intervals };
    if (row.kind === "section") {
      if (isLessonV3(lesson)) return undefined;
      const section = lesson.sections.find((item) => item.id === row.ref);
      if (!section) return undefined;
      return { ...base, kind: "section", sectionId: section.id, prompt: cleanHeading(section.heading), hints: section.concepts.slice(0, 4), answer: section.body, analogy: section.analogy || undefined };
    }
    if (row.kind === "term") {
      const annotation = (lesson.annotations || []).find((item) => item.id === row.ref);
      if (!annotation) return undefined;
      const quote = cloze(annotation.quote, annotation.term, !isCodeSource(annotation.sourceKey));
      const sectionId = annotation.sourceKey.split(":")[0];
      return { ...base, kind: "term", sectionId: lessonPartIds(lesson).includes(sectionId) ? sectionId : undefined, prompt: `「${annotation.term}」在這段裡是什麼意思？`, term: annotation.term, context: quote, ...(isCodeSource(annotation.sourceKey) ? { code: true } : termIsMath(annotation) ? {} : { plainTerm: true }), hints: [], answer: annotation.explanation, analogy: annotation.analogy || undefined };
    }
    if (row.kind === "recall") {
      if (!isLessonV3(lesson)) return undefined;
      const index = lesson.steps.findIndex((item) => item.id === row.ref);
      if (index < 0) return undefined;
      const { figure, recall } = lesson.steps[index];
      // A blank the figure lacks would leave a 「?」 with nothing behind it; the card then shows the whole figure.
      const blank = recall.blank && figureHasCell(figure, recall.blank) ? recall.blank : undefined;
      return { ...base, kind: "recall", sectionId: row.ref, step: index + 1, prompt: recall.question, hints: recall.hint ? [recall.hint] : [], answer: recall.answer, ...(figure ? { figure } : {}), ...(blank ? { blank } : {}) };
    }
    if (isLessonV3(lesson)) return undefined;
    const index = Number(row.ref);
    const question = lesson.followUpQuestions[index];
    if (!question) return undefined;
    const reference = this.reference(lesson.id, index, question);
    return { ...base, kind: "check", prompt: question, hints: [], answer: reference?.referenceAnswer || "這題還沒有參考答案，可以回到筆記重新對照。", keyPoints: reference?.keyPoints, sectionId: reference?.sectionIds[0] };
  }
  // ---- in-lesson recall --------------------------------------------------
  /**
   * The rated recall questions of a v3 note, in step order. The rating is the first entry
   * in the card's review log, which rateRecall writes when it creates the card.
   */
  recalls(lesson: StoredLesson): RecallState[] {
    if (!isLessonV3(lesson) || lesson.isDemo) return [];
    const rows = this.db.prepare("SELECT * FROM review_cards WHERE lesson_id = ? AND kind = 'recall'").all(lesson.id) as CardRow[];
    return lesson.steps.flatMap((step) => {
      const row = rows.find((item) => item.ref === step.id);
      const state = row && this.recallState(row);
      return state ? [state] : [];
    });
  }
  private recallState(row: CardRow): RecallState | undefined {
    const first = this.db.prepare("SELECT rating, reviewed_at FROM review_log WHERE card_id = ? ORDER BY rowid LIMIT 1").get(row.id) as { rating: number; reviewed_at: string } | undefined;
    if (!first) return undefined;
    return { stepId: row.ref, rating: first.rating === Rating.Again ? "unsure" : "remembered", status: row.introduced_at ? "scheduled" : "waiting", ...(row.introduced_at ? { due: row.due } : {}), ratedAt: first.reviewed_at };
  }
  /**
   * The learner's first rating of a step's recall question puts it into review at once,
   * rated as given. 〔記得〕 does so within today's new-card limits (NEW_PER_LESSON_PER_DAY
   * for this note, NEW_PER_DAY in all, shared with the cards review introduces); past either
   * limit the rating is recorded and the card waits, new, for a later day's allowance.
   * 〔不確定〕 is a miss, scheduled as Again whatever the limits and using none of them, as a
   * missed self-check is. A step already rated keeps its first rating and schedule: a
   * repeated or retried request, or one from another device, returns what is recorded.
   * Built-in examples save nothing.
   */
  rateRecall(lessonId: string, stepId: string, answer: RecallAnswer, lessons: StoredLesson[], now = new Date()): RecallState {
    const present = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const lesson = present.get(lessonId);
    if (!lesson) throw new AppError(404, "找不到這篇筆記。");
    if (!isLessonV3(lesson)) throw new AppError(409, "這篇筆記是舊格式，沒有每一步的回想題。");
    if (!lesson.steps.some((step) => step.id === stepId)) throw new AppError(404, "找不到這一步，筆記可能已經更新，請重新整理。");
    const at = now.toISOString();
    if (lesson.isDemo) return { stepId, rating: answer, status: "demo", ratedAt: at };
    const grade = answer === "remembered" ? Rating.Good : Rating.Again;
    const find = this.db.prepare("SELECT * FROM review_cards WHERE lesson_id = ? AND kind = 'recall' AND ref = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let row = find.get(lessonId, stepId) as CardRow | undefined;
      if (!row) {
        const room = answer === "unsure" || this.hasRoom(lessonId, lessons, present, now);
        const card = room ? scheduler.next(createEmptyCard(now), now, grade).card : createEmptyCard(now);
        const id = randomUUID();
        this.db.prepare("INSERT INTO review_cards (id, lesson_id, kind, ref, state_json, due, introduced_at, created_at) VALUES (?, ?, 'recall', ?, ?, ?, ?, ?)")
          .run(id, lessonId, stepId, JSON.stringify(card), card.due.toISOString(), room ? at : null, at);
        this.db.prepare("INSERT INTO review_log (id, card_id, rating, state, reviewed_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), id, grade, card.state, at);
        row = find.get(lessonId, stepId) as CardRow;
      }
      const state = this.recallState(row);
      this.db.exec("COMMIT");
      // Every recall card is created with its log entry; the fallback only keeps the reply whole.
      return state ?? { stepId, rating: answer, status: row.introduced_at ? "scheduled" : "waiting", ...(row.introduced_at ? { due: row.due } : {}), ratedAt: at };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Whether today's new-card limits leave room for one more card of this note, counted as review counts them, leaving out cards the next sync removes. */
  private hasRoom(lessonId: string, lessons: StoredLesson[], present: Map<string, StoredLesson>, now: Date) {
    const { keep } = wantedCards(lessons);
    const introduced = this.introducedOn(this.rows(present).filter((item) => keep.has(cardKey(item))), this.dayOf(now));
    return introduced.length < NEW_PER_DAY && introduced.filter((item) => item.lesson_id === lessonId).length < NEW_PER_LESSON_PER_DAY;
  }

  rate(id: string, rating: Grade, now = new Date()): { due: string } {
    const row = this.db.prepare("SELECT * FROM review_cards WHERE id = ?").get(id) as CardRow | undefined;
    if (!row || !row.introduced_at) throw new AppError(404, "找不到這張複習卡，可能所屬的筆記已刪除。");
    const current = toCard(row.state_json);
    const { card } = scheduler.next(current, reviewTime(current, now, rating, this.dayOf(current.due) === this.dayOf(now)), rating);
    this.db.prepare("UPDATE review_cards SET state_json = ?, due = ? WHERE id = ?").run(JSON.stringify(card), card.due.toISOString(), id);
    this.db.prepare("INSERT INTO review_log (id, card_id, rating, state, reviewed_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), id, rating, card.state, now.toISOString());
    return { due: card.due.toISOString() };
  }
  summary(lessons: StoredLesson[], now = new Date()): ReviewSummary {
    this.syncCards(lessons, now);
    return this.tally(this.rows(new Map(lessons.map((lesson) => [lesson.id, lesson]))), now);
  }
  /**
   * The counts summary() would give, read without writing anything: cards sync would
   * remove are left out and cards it would add count as new, uncreated. For readers
   * outside Explain, such as the BELL Suite today feed, which must not change the
   * learner's records.
   */
  peekSummary(lessons: StoredLesson[], now = new Date()): ReviewSummary {
    const { create, keep } = wantedCards(lessons);
    const rows = this.rows(new Map(lessons.map((lesson) => [lesson.id, lesson]))).filter((row) => keep.has(cardKey(row)));
    const stored = new Set(rows.map(cardKey));
    const fresh = JSON.stringify(createEmptyCard(now));
    for (const card of create) {
      const key = cardKey(card);
      if (stored.has(key)) continue;
      stored.add(key);
      rows.push({ id: `uncreated:${key}`, ...card, state_json: fresh, due: now.toISOString(), introduced_at: null });
    }
    return this.tally(rows, now);
  }
  /** Due cards, today's remaining allowance of new ones, reviews today and all cards of notes that exist. */
  private tally(rows: CardRow[], now: Date): ReviewSummary {
    const today = this.dayOf(now);
    const introducedToday = this.introducedOn(rows, today);
    const perLesson = new Map<string, number>();
    for (const row of introducedToday) perLesson.set(row.lesson_id, (perLesson.get(row.lesson_id) || 0) + 1);
    let allowance = Math.max(0, NEW_PER_DAY - introducedToday.length);
    let available = 0;
    for (const row of rows.filter((item) => !item.introduced_at)) {
      if (!allowance) break;
      if ((perLesson.get(row.lesson_id) || 0) >= NEW_PER_LESSON_PER_DAY) continue;
      perLesson.set(row.lesson_id, (perLesson.get(row.lesson_id) || 0) + 1);
      allowance--;
      available++;
    }
    const due = rows.filter((row) => this.isDue(row, now)).length;
    // A recall rated past the new-card limit is logged as still new: recorded, not reviewed.
    const reviewedToday = (this.db.prepare("SELECT reviewed_at FROM review_log WHERE state <> ?").all(State.New) as Array<{ reviewed_at: string }>).filter((row) => this.dayOf(new Date(row.reviewed_at)) === today).length;
    return { due, newAvailable: available, reviewedToday, total: rows.length };
  }
}

export function createReviewRouter(learning: LearningStore, lessons: () => StoredLesson[]): Router {
  const router = Router();
  // Summary reads must not initialize cards or prune history during a handoff preview.
  router.get("/review/summary", (_req, res) => { res.json(learning.peekSummary(lessons())); });
  router.get("/review/due", (_req, res) => { res.json(learning.due(lessons())); });
  // In-lesson recall of a v3 note: GET lists the rated steps, POST rates one (RecallState).
  router.get("/lessons/:id/recall", (req, res) => {
    const lesson = lessons().find((item) => item.id === req.params.id);
    if (!lesson) throw new AppError(404, "找不到這篇筆記。");
    res.json(learning.recalls(lesson));
  });
  router.post("/lessons/:id/recall/:stepId", (req, res) => {
    const parsed = z.object({ rating: z.enum(["remembered", "unsure"]) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請選〔記得〕或〔不確定〕。");
    res.json(learning.rateRecall(req.params.id, req.params.stepId, parsed.data.rating, lessons()));
  });
  router.post("/review/:id", (req, res) => {
    const parsed = z.object({ rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請用 1（重來）到 4（簡單）評分。");
    res.json(learning.rate(req.params.id, parsed.data.rating as Grade));
  });
  return router;
}
