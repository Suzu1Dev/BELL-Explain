import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Rating } from "ts-fsrs";
import { exampleLessons } from "../shared/examples.js";
import type { Lesson } from "../shared/types.js";
import { createApp } from "./app.js";
import { LearningStore } from "./learning.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { LessonStore, TRASH_DAYS } from "./store.js";
import {
  allowedSuiteRoute, buildTodayFeed, cleanSuiteTitle, parseSuiteLinks, validSuiteHref, validateSuiteFeed, validateSuiteManifest,
  type SuiteLinks, type SuiteTodayFeed,
} from "./suite.js";

const SENTINEL = "SENTINEL-ANSWER-7f3";
const OWN_TAILNET_ORIGIN = "https://box.tail-one.ts.net:20001";
const PERSONAL_TAILNET = "https://box.tail-one.ts.net:20003";
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const aiConfig = { apiKey: "", model: "", baseUrl: "https://api.openai.com/v1" };

/** A note of the learner's own, built from a curated example. */
function own(id: string, title: string, updatedAt: string): Lesson {
  return { ...structuredClone(exampleLessons[0]), id, title, isDemo: false, favorite: false,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt, annotations: [], followUpQuestions: ["閉包為什麼能記住變數？"] };
}
/** The same note with every text but its id, title and times carrying the sentinel. */
function secretive(lesson: Lesson): Lesson {
  const ids = new Set(["id", "sectionId", "targetId", "sourceKey", "nodeId", "from", "to", "createdAt", "updatedAt"]);
  const mark = (value: unknown, key: string): unknown =>
    typeof value === "string" ? (ids.has(key) ? value : `${SENTINEL} ${value}`)
      : Array.isArray(value) ? value.map(item => mark(item, key))
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mark(item, name)]))
          : value;
  const marked = Object.fromEntries(Object.entries(lesson).map(([key, value]) => [key, key === "title" ? value : mark(value, key)])) as unknown as Lesson;
  marked.source = { ...marked.source, label: `${SENTINEL} /home/learner/私人/講義.pdf`, url: `https://example.test/${SENTINEL}` };
  marked.annotations = [{ id: "term-1", term: `${SENTINEL} 閉包`, explanation: `${SENTINEL} 詞句解說`, analogy: `${SENTINEL} 比喻`,
    sourceKey: `${lesson.sections[0].id}:body`, quote: `${SENTINEL} 原句`, createdAt: lesson.createdAt }];
  return marked;
}

/** Every row of every table, read through a separate read-only connection. */
function tables(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
    return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}
/** A connection kept open on a database: its PRAGMA data_version changes whenever any other connection commits. */
function watch(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  return { version: () => (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version, close: () => db.close() };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
async function setup(t: TestContext, options: { allowedOrigins?: string[]; suiteLinks?: SuiteLinks; learning?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bell-suite-"));
  const paths = { notes: join(directory, "bell.sqlite"), learning: join(directory, "learning.sqlite") };
  const store = new LessonStore(paths.notes, exampleLessons);
  const learning = options.learning === false ? undefined : new LearningStore(paths.learning, { timeZone: "Asia/Taipei" });
  const watchers = { notes: watch(paths.notes), learning: learning ? watch(paths.learning) : undefined };
  const server = createServer(createApp({ store, examples: exampleLessons, config: aiConfig, learning, allowedOrigins: options.allowedOrigins, suiteLinks: options.suiteLinks }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    watchers.notes.close();
    watchers.learning?.close();
    learning?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // Raw HTTP, so Host, Origin and Fetch Metadata arrive exactly as a browser or proxy sent them.
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    request.once("error", reject);
    request.end();
  });
  /** Both databases as stored: whether another connection committed since the last look, and every row of every table. */
  const state = () => ({
    versions: { notes: watchers.notes.version(), learning: watchers.learning?.version() },
    notes: tables(paths.notes),
    learning: learning ? tables(paths.learning) : undefined,
  });
  return { store, learning, get, port, state, paths };
}
/** What BELL Personal's server sends when it reads a sibling's feed. */
const PERSONAL_READ = { accept: "application/json" };
const counts = (summary: { due: number; newAvailable: number; reviewedToday: number }) =>
  ({ due: summary.due, newAvailable: summary.newAvailable, reviewedToday: summary.reviewedToday });

test("the suite manifest describes Explain's capabilities and only the configured links", async t => {
  const { get } = await setup(t, { suiteLinks: { personal: "http://127.0.0.1:21103" } });
  const reply = await get("/api/suite/manifest");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.match(String(reply.headers["content-type"]), /^application\/json/);
  assert.equal(reply.headers["access-control-allow-origin"], undefined);
  const manifest = JSON.parse(reply.body);
  assert.deepEqual(manifest, {
    schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "理解與複習",
    capabilities: [
      { id: "explain.draft", kind: "accept-handoff", route: "#/explain", accepts: ["text"], maxChars: 2000 },
      { id: "review.today", kind: "today-feed", api: "/api/suite/today" },
      { id: "review.open", kind: "object-route", route: "#/review" },
      { id: "note.open", kind: "object-route", route: "#/note/{id}" },
    ],
    links: { personal: "http://127.0.0.1:21103" },
  });
  validateSuiteManifest(manifest);

  const unset = await setup(t);
  assert.deepEqual(JSON.parse((await unset.get("/api/suite/manifest")).body).links, {});

  // Served on the tailnet name, with a sibling on the same tailnet.
  const tailnet = await setup(t, { allowedOrigins: [OWN_TAILNET_ORIGIN], suiteLinks: { personal: PERSONAL_TAILNET, pr: "http://localhost:4610" } });
  const remote = await tailnet.get("/api/suite/manifest", { host: "box.tail-one.ts.net:20001", origin: OWN_TAILNET_ORIGIN, "sec-fetch-site": "same-origin" });
  assert.equal(remote.status, 200);
  assert.deepEqual(JSON.parse(remote.body).links, { personal: PERSONAL_TAILNET, pr: "http://localhost:4610" });
  // A linked sibling is a navigation target, not an allowed origin.
  assert.equal((await tailnet.get("/api/suite/manifest", { host: "box.tail-one.ts.net:20001", origin: PERSONAL_TAILNET })).status, 403);

  // Links that the runtime configuration would refuse also stop createApp.
  const store = new LessonStore(":memory:", exampleLessons);
  t.after(() => store.close());
  for (const suiteLinks of [{ personal: "https://example.com" }, { personal: "http://127.0.0.1:1/" }, { explain: "http://127.0.0.1:1" } as SuiteLinks, { personal: PERSONAL_TAILNET }]) {
    assert.throws(() => createApp({ store, examples: exampleLessons, config: aiConfig, suiteLinks }), JSON.stringify(suiteLinks));
  }
});

test("the today feed is valid, mirrors the review summary, leaves out the built-in examples and shows at most five items", async t => {
  const { store, learning, get } = await setup(t);
  // A curated example updated last must still not appear.
  store.save({ ...structuredClone(exampleLessons[0]), updatedAt: "2099-01-01T00:00:00.000Z" });
  for (let index = 1; index <= 6; index++) store.save(own(`note-${index}`, `筆記 ${index}`, `2026-11-0${index}T08:00:00.000Z`));
  const reply = await get("/api/suite/today");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.match(String(reply.headers["content-type"]), /^application\/json/);
  assert.equal(reply.headers["access-control-allow-origin"], undefined);
  const feed = validateSuiteFeed(JSON.parse(reply.body));
  assert.deepEqual(Object.keys(feed), ["schemaVersion", "appId", "generatedAt", "counts", "items", "truncated"]);
  assert.match(feed.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const summary = learning!.summary(store.listRaw({ strict: true }));
  assert.ok(summary.newAvailable > 0 && summary.due === 0);
  assert.deepEqual(feed.counts, counts(summary));
  assert.equal(feed.items.length, 5);
  assert.deepEqual(feed.items[0], { sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review",
    state: "new", updatedAt: feed.generatedAt, detail: `${summary.newAvailable} 張新卡` });
  assert.deepEqual(feed.items.slice(1).map(item => item.id), ["note-6", "note-5", "note-4", "note-3"]);
  assert.deepEqual(feed.items[1], { sourceApp: "explain", type: "lesson", id: "note-6", title: "筆記 6", href: "#/note/note-6", state: "waiting", updatedAt: "2026-11-06T08:00:00.000Z" });
  assert.equal(feed.truncated, true);
  for (const example of exampleLessons) assert.ok(!reply.body.includes(example.id) && !reply.body.includes(example.title), example.id);
});

test("the feed builder keeps only own notes with valid ids, normalises times and flags truncation", () => {
  const now = new Date("2026-11-08T05:30:00.000Z");
  const zero = { due: 0, newAvailable: 0, reviewedToday: 0, total: 0 };
  const exampleIds = new Set(exampleLessons.map(lesson => lesson.id));
  const localTime = own("note-local", "本地時間", "2026-11-08T13:30:00+08:00");
  const badTime = { ...own("note-created", "只有建立時間", "not a date"), createdAt: "2026-11-02T00:00:00.000Z" };
  const lessons = [
    own("a", "A", "2026-11-07T00:00:00.000Z"), own("bad id", "空白", "2026-11-08T05:00:00.000Z"), own("x".repeat(129), "太長", "2026-11-08T05:00:00.000Z"),
    own("b:c.d_e-f", "C", "2026-11-08T01:00:00.000Z"), localTime, badTime,
    { ...structuredClone(exampleLessons[1]), isDemo: false, updatedAt: "2099-01-01T00:00:00.000Z" },
  ];
  const feed = validateSuiteFeed(buildTodayFeed({ lessons, summary: { due: 12, newAvailable: 3, reviewedToday: 5, total: 40 }, now, exampleIds }));
  assert.deepEqual(feed, {
    schemaVersion: 1, appId: "explain", generatedAt: "2026-11-08T05:30:00.000Z", counts: { due: 12, newAvailable: 3, reviewedToday: 5 },
    items: [
      { sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "due", updatedAt: "2026-11-08T05:30:00.000Z", detail: "12 張到期 · 3 張新卡" },
      { sourceApp: "explain", type: "lesson", id: "note-local", title: "本地時間", href: "#/note/note-local", state: "waiting", updatedAt: "2026-11-08T05:30:00.000Z" },
      { sourceApp: "explain", type: "lesson", id: "b:c.d_e-f", title: "C", href: "#/note/b:c.d_e-f", state: "waiting", updatedAt: "2026-11-08T01:00:00.000Z" },
      { sourceApp: "explain", type: "lesson", id: "a", title: "A", href: "#/note/a", state: "waiting", updatedAt: "2026-11-07T00:00:00.000Z" },
      { sourceApp: "explain", type: "lesson", id: "note-created", title: "只有建立時間", href: "#/note/note-created", state: "waiting", updatedAt: "2026-11-02T00:00:00.000Z" },
    ],
    truncated: false,
  });
  // The empty fixture of the contract, exactly.
  assert.deepEqual(buildTodayFeed({ lessons: [], summary: zero, now }), {
    schemaVersion: 1, appId: "explain", generatedAt: "2026-11-08T05:30:00.000Z", counts: { due: 0, newAvailable: 0, reviewedToday: 0 },
    items: [{ sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "waiting", updatedAt: "2026-11-08T05:30:00.000Z", detail: "今天沒有到期的複習" }],
    truncated: false,
  });
  assert.equal(buildTodayFeed({ lessons: [], summary: { ...zero, due: 4 }, now }).items[0].detail, "4 張到期");
  const notes = (count: number) => Array.from({ length: count }, (_, index) => own(`n${index}`, `N${index}`, `2026-11-0${index + 1}T00:00:00.000Z`));
  assert.equal(buildTodayFeed({ lessons: notes(4), summary: zero, now }).truncated, false);
  const five = buildTodayFeed({ lessons: notes(5), summary: zero, now });
  assert.equal(five.truncated, true);
  assert.equal(five.items.length, 5);
  // Counts beyond the contract's ceiling are clipped rather than making the feed invalid.
  assert.equal(validateSuiteFeed(buildTodayFeed({ lessons: [], summary: { ...zero, due: 250_000 }, now })).counts.due, 100_000);
});

test("a note whose id cannot fill #/note/{id} is left out, never encoded, and never makes the feed invalid", () => {
  const now = new Date("2026-11-08T05:30:00.000Z");
  const zero = { due: 0, newAvailable: 0, reviewedToday: 0, total: 0 };
  // Lesson ids are randomUUID() (server/ai.ts, server/sync.ts) or sync ids (server/sync-protocol.ts),
  // which all fit; these stand for a stored row that does not.
  const outside = [".", "..", "a/b", "a%2Fb", "50%", "a b", "筆記", "x".repeat(129), ""];
  const longest = "y".repeat(128);
  const lessons = [
    ...outside.map((id, index) => own(id, `外 ${index}`, "2026-11-08T05:00:00.000Z")),
    own(longest, "最長", "2026-11-07T00:00:00.000Z"), own("6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", "UUID", "2026-11-06T00:00:00.000Z"),
  ];
  const feed = validateSuiteFeed(buildTodayFeed({ lessons, summary: zero, now }));
  assert.deepEqual(feed.items.slice(1).map(item => [item.id, item.href]), [
    [longest, `#/note/${longest}`],
    ["6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", "#/note/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41"],
  ]);
  assert.equal(feed.truncated, false, "a left-out note is not counted as hidden");
  for (const id of outside) {
    assert.ok(!allowedSuiteRoute("explain", `#/note/${id}`), id);
    assert.ok(!allowedSuiteRoute("explain", `#/note/${encodeURIComponent(id)}`), `encoded ${id}`);
  }
});

test("the today feed carries titles and counts only, never answers, hints, key points, note text, sources or file names", async t => {
  const { store, learning, get } = await setup(t);
  const lesson = secretive(own("note-secret", "我的筆記", "2026-11-07T10:00:00.000Z"));
  store.save(lesson);
  learning!.saveReference(lesson.id, 0, lesson.followUpQuestions[0], { referenceAnswer: `${SENTINEL} 參考答案`, keyPoints: [`${SENTINEL} 重點一`, `${SENTINEL} 重點二`], sectionIds: [] });
  learning!.recordAttempt(lesson.id, 0, `${SENTINEL} 我的回答`, "partial", "self");
  // The sentinel is really there: the review queue, which shows answers, carries it.
  const queue = await get("/api/review/due");
  assert.ok(queue.body.includes(SENTINEL));
  const reply = await get("/api/suite/today");
  assert.equal(reply.status, 200);
  const feed = validateSuiteFeed(JSON.parse(reply.body));
  assert.ok(feed.counts.due > 0);
  assert.deepEqual(feed.items.map(item => item.title), ["今日複習", "我的筆記"]);
  assert.ok(!reply.body.includes(SENTINEL), "no answer, hint, key point, body, source or file name");
  assert.ok(!reply.body.includes("/home/learner") && !reply.body.includes(".pdf"));
  assert.ok(!(await get("/api/suite/manifest")).body.includes(SENTINEL));
});

test("reading the today feed writes nothing to either database, even before a note has review cards, and counts what summary() would", async t => {
  const { store, learning, get, state } = await setup(t);
  for (let index = 1; index <= 3; index++) store.save(own(`note-${index}`, `筆記 ${index}`, `2026-11-0${index}T08:00:00.000Z`));
  const calls = { due: 0, summary: 0, syncCards: 0 };
  const due = learning!.due.bind(learning), summary = learning!.summary.bind(learning), syncCards = learning!.syncCards.bind(learning);
  learning!.due = (...args) => { calls.due++; return due(...args); };
  learning!.summary = (...args) => { calls.summary++; return summary(...args); };
  learning!.syncCards = (...args) => { calls.syncCards++; return syncCards(...args); };
  const before = state();
  assert.deepEqual(before.learning!.review_cards, [], "no note has a card yet");
  const replies: Reply[] = [];
  for (const [path, headers] of [["/api/suite/today", {}], ["/api/suite/today", PERSONAL_READ], ["/api/suite/today?refresh=1", PERSONAL_READ], ["/api/suite/today", {}]] as const)
    replies.push(await get(path, headers));
  assert.deepEqual(state(), before, "four reads committed nothing and left every row of both databases as it was");
  assert.deepEqual(calls, { due: 0, summary: 0, syncCards: 0 });
  // Three own notes of three sections each, none introduced yet: three new cards from each, none due.
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.deepEqual(validateSuiteFeed(JSON.parse(reply.body)).counts, { due: 0, newAvailable: 9, reviewedToday: 0 });
  }
  assert.equal(validateSuiteFeed(JSON.parse(replies[0].body)).items[0].detail, "9 張新卡");
  // Control: the writing summary() of Explain's own review page creates the cards, the watcher sees that commit, and the counts agree.
  const synced = learning!.summary(store.listRaw({ strict: true }));
  const after = state();
  assert.notEqual(after.versions.learning, before.versions.learning, "the watcher does see another connection's commit");
  assert.equal(after.learning!.review_cards.length, 9);
  assert.deepEqual(synced, { due: 0, newAvailable: 9, reviewedToday: 0, total: 9 });
});

test("summary leaves new cards uncreated until opening the review queue", async t => {
  const { store, get, state } = await setup(t);
  store.save(own("summary-preview", "預覽摘要", "2026-11-09T08:00:00.000Z"));
  const before = state();
  assert.equal(before.learning!.review_cards.length, 0);
  const summary = await get("/api/review/summary");
  assert.equal(summary.status, 200);
  assert.deepEqual(JSON.parse(summary.body), { due: 0, newAvailable: 3, reviewedToday: 0, total: 3 });
  assert.deepEqual(state(), before, "preview changes neither rows nor database versions");
  const queue = await get("/api/review/due");
  assert.equal(queue.status, 200);
  assert.equal(JSON.parse(queue.body).length, 3);
  assert.equal(state().learning!.review_cards.length, 3, "opening review still creates usable cards");
  const afterQueue = state();
  const refreshed = await get("/api/review/summary");
  assert.equal(refreshed.status, 200);
  assert.deepEqual(JSON.parse(refreshed.body), { due: 3, newAvailable: 0, reviewedToday: 0, total: 3 });
  assert.deepEqual(state(), afterQueue, "subsequent summary is also read-only");
});

test("the today feed follows reviews, a note without cards, edits and deletes as summary() would, and every read still writes nothing", async t => {
  const { store, learning, get, state } = await setup(t);
  for (let index = 1; index <= 2; index++) store.save(own(`note-${index}`, `筆記 ${index}`, `2026-11-0${index}T08:00:00.000Z`));
  /** Reads the feed as Explain's page and as Personal would, checks nothing was written, then compares with the writing summary(). */
  const read = async (label: string) => {
    const lessons = store.listRaw({ strict: true });
    const before = state();
    const peeked = learning!.peekSummary(lessons);
    const feeds = [];
    for (const headers of [{}, PERSONAL_READ]) feeds.push(validateSuiteFeed(JSON.parse((await get("/api/suite/today", headers)).body)));
    const reviewSummary = await get("/api/review/summary");
    assert.equal(reviewSummary.status, 200);
    assert.deepEqual(JSON.parse(reviewSummary.body), peeked, `${label}: the UI summary has the same read-only counts`);
    assert.deepEqual(state(), before, `${label}: reading wrote nothing`);
    const synced = learning!.summary(lessons);
    assert.deepEqual(peeked, synced, `${label}: the counts summary() gives after its sync`);
    for (const feed of feeds) assert.deepEqual(feed.counts, counts(synced), label);
    return synced;
  };
  assert.deepEqual(await read("no card yet"), { due: 0, newAvailable: 6, reviewedToday: 0, total: 6 });
  // Opening the review queue introduces each note's three cards, due at once.
  const queue = JSON.parse((await get("/api/review/due")).body) as Array<{ id: string; lessonId: string }>;
  assert.equal(queue.length, 6);
  assert.deepEqual(await read("cards introduced"), { due: 6, newAvailable: 0, reviewedToday: 0, total: 6 });
  store.save(own("note-3", "筆記 3", "2026-11-03T08:00:00.000Z"));
  assert.deepEqual(await read("a new note without cards"), { due: 6, newAvailable: 3, reviewedToday: 0, total: 9 });
  learning!.rate(queue.find(card => card.lessonId === "note-1")!.id, Rating.Easy);
  assert.deepEqual(await read("a card remembered"), { due: 5, newAvailable: 3, reviewedToday: 1, total: 9 });
  learning!.recordAttempt("note-1", 0, "不確定", "partial", "self");
  assert.deepEqual(await read("a missed self-check"), { due: 6, newAvailable: 3, reviewedToday: 1, total: 10 });
  // Note 2 loses its first section, introduced and due, and gains a new one: one of its three new cards today is free again.
  const edited = store.getRaw("note-2") as Lesson;
  store.save({ ...edited, sections: [...edited.sections.slice(1), { ...edited.sections[0], id: "added-section", heading: "新的一節" }] });
  assert.deepEqual(await read("an edited note"), { due: 5, newAvailable: 4, reviewedToday: 1, total: 10 });
  store.save({ ...store.getRaw("note-1")!, followUpQuestions: [] });
  assert.deepEqual(await read("a removed question"), { due: 4, newAvailable: 4, reviewedToday: 1, total: 9 });
  assert.ok(store.delete("note-1"));
  assert.deepEqual(await read("a deleted note"), { due: 2, newAvailable: 4, reviewedToday: 1, total: 6 });
  // The deleted note's cards wait out the trash period in the database, counted nowhere.
  assert.equal(state().learning!.review_cards.filter(row => JSON.parse(row).lesson_id === "note-1").length, 3);
});

test("the today feed reads past every sync change — a 31-day orphan with answers, a new orphan, a restored note, new and removed parts — without a write lock, writing nothing", async t => {
  const { store, learning, get, state, paths } = await setup(t);
  const day = 86_400_000;
  for (const id of ["note-1", "note-2", "note-gone", "note-back", "note-3"]) store.save(own(id, id, "2026-11-01T08:00:00.000Z"));
  // Explain's own pages write as before: the review queue introduces 15 cards, a check is answered and missed, a card is rated.
  const queue = JSON.parse((await get("/api/review/due")).body) as Array<{ id: string; lessonId: string }>;
  assert.equal(queue.length, 15);
  const question = (store.getRaw("note-gone") as Lesson).followUpQuestions[0];
  learning!.saveReference("note-gone", 0, question, { referenceAnswer: "參考答案", keyPoints: ["重點"], sectionIds: [] });
  learning!.recordAttempt("note-gone", 0, "答案", "incorrect", "self");
  learning!.rate(queue.find(card => card.lessonId === "note-1")!.id, Rating.Easy);
  // note-gone and note-back were deleted more than the trash period ago (summary() then noted them as orphans) …
  assert.ok(store.delete("note-gone"));
  assert.ok(store.delete("note-back"));
  learning!.summary(store.listRaw({ strict: true }), new Date(Date.now() - (TRASH_DAYS + 2) * day));
  // … note-back has since been restored, note-3 was deleted just now, note-4 is new, note-2 lost a section and gained one.
  store.save(own("note-back", "note-back", "2026-11-01T08:00:00.000Z"));
  assert.ok(store.delete("note-3"));
  store.save(own("note-4", "note-4", "2026-11-04T08:00:00.000Z"));
  const edited = store.getRaw("note-2") as Lesson;
  store.save({ ...edited, sections: [...edited.sections.slice(1), { ...edited.sections[0], id: "added-section", heading: "新的一節" }] });

  // The snapshot is taken before the first read.
  const before = state();
  const rows = (table: string, lessonId: string) => before.learning![table].filter(row => JSON.parse(row).lesson_id === lessonId).length;
  assert.deepEqual(["review_cards", "check_answers", "check_attempts", "orphaned_lessons"].map(table => rows(table, "note-gone")), [4, 1, 1, 1], "a 31-day orphan with cards, an answer and an attempt that summary() would purge");
  assert.equal(rows("orphaned_lessons", "note-back"), 1, "a restored note summary() would take off the orphan list");
  assert.equal(rows("orphaned_lessons", "note-3"), 0, "a deleted note summary() would put on it");
  assert.equal(rows("review_cards", "note-4"), 0, "a new note summary() would give cards");

  // Another connection holds the write lock on both databases while the feed is read: a read that asked for it would wait out busy_timeout and fail.
  const locks = [paths.notes, paths.learning].map(path => new DatabaseSync(path));
  t.after(() => { for (const lock of locks) if (lock.isOpen) lock.close(); });
  for (const lock of locks) lock.exec("BEGIN IMMEDIATE");
  const probe = new DatabaseSync(paths.learning);
  assert.throws(() => probe.exec("BEGIN IMMEDIATE"), /locked|busy/i, "the lock is held: any other writer is refused");
  probe.close();
  const replies: Reply[] = [];
  for (const [path, headers] of [["/api/suite/today", {}], ["/api/suite/today", PERSONAL_READ], ["/api/suite/today?refresh=1", PERSONAL_READ], ["/api/suite/today", PERSONAL_READ]] as const)
    replies.push(await get(path, headers));
  // The UI summary must also answer without taking a write lock during a handoff preview.
  const reviewSummary = await get("/api/review/summary");
  assert.equal(reviewSummary.status, 200, "the summary must not ask for the held write lock");
  assert.deepEqual(JSON.parse(reviewSummary.body), { due: 7, newAvailable: 4, reviewedToday: 1, total: 12 });
  for (const lock of locks) { lock.exec("ROLLBACK"); lock.close(); }
  assert.deepEqual(state(), before, "feed and summary reads under a held write lock committed nothing and left every row of both databases as it was");

  const expected = { due: 7, newAvailable: 4, reviewedToday: 1 };
  for (const reply of replies) {
    assert.equal(reply.status, 200, "every read was answered while the lock was held");
    assert.deepEqual(validateSuiteFeed(JSON.parse(reply.body)).counts, expected);
  }
  // The writing summary() agrees with the counts, and makes exactly the changes the reads left alone.
  const synced = learning!.summary(store.listRaw({ strict: true }));
  assert.deepEqual(synced, { ...expected, total: 12 });
  const after = state();
  assert.notEqual(after.versions.learning, before.versions.learning);
  const now = (table: string, lessonId: string) => after.learning![table].filter(row => JSON.parse(row).lesson_id === lessonId).length;
  assert.deepEqual(["review_cards", "check_answers", "check_attempts", "orphaned_lessons"].map(table => now(table, "note-gone")), [0, 0, 0, 0], "summary() purged the 31-day orphan; the reads did not");
  assert.equal(now("orphaned_lessons", "note-back"), 0);
  assert.equal(now("orphaned_lessons", "note-3"), 1);
  assert.equal(now("review_cards", "note-4"), 3);
});

test("peekSummary() gives summary()'s counts across days, the daily allowance, built-in examples and the trash period, and never writes", t => {
  const directory = mkdtempSync(join(tmpdir(), "bell-suite-peek-"));
  const path = join(directory, "learning.sqlite");
  const learning = new LearningStore(path, { timeZone: "Asia/Taipei" });
  const watcher = watch(path);
  t.after(() => { watcher.close(); learning.close(); rmSync(directory, { recursive: true, force: true }); });
  const withTerm = (lesson: Lesson, id: string): Lesson => ({ ...lesson, annotations: [...(lesson.annotations || []),
    { id, term: "閉包", explanation: "解說", analogy: "", sourceKey: `${lesson.sections[0].id}:body`, quote: "原句", createdAt: lesson.createdAt }] });
  let lessons = Array.from({ length: 6 }, (_, index) => own(`note-${index + 1}`, `筆記 ${index + 1}`, "2026-11-01T08:00:00.000Z"));
  lessons[0] = withTerm(lessons[0], "term-1");
  const compare = (label: string, now: Date) => {
    const before = { version: watcher.version(), rows: tables(path) };
    const peeked = [learning.peekSummary(lessons, now), learning.peekSummary(lessons, now), learning.peekSummary([...lessons].reverse(), now)];
    assert.deepEqual({ version: watcher.version(), rows: tables(path) }, before, `${label}: peeking wrote nothing`);
    const synced = learning.summary(lessons, now);
    for (const peek of peeked) assert.deepEqual(peek, synced, label);
    return synced;
  };
  const day = (offset: number) => new Date(Date.UTC(2026, 10, 8 + offset, 2)); // 10:00 in Taipei
  // Six notes of three sections, the first with a term: 18 new cards a day would be over the allowance of 15.
  assert.deepEqual(compare("no card", day(0)), { due: 0, newAvailable: 15, reviewedToday: 0, total: 19 });
  const queue = learning.due(lessons, day(0));
  assert.equal(queue.length, 15);
  assert.deepEqual(compare("today's allowance used", day(0)), { due: 15, newAvailable: 0, reviewedToday: 0, total: 19 });
  const later = new Date(day(0).getTime() + 60_000);
  for (const card of queue.filter(card => card.lessonId === "note-1")) learning.rate(card.id, Rating.Easy, later);
  learning.recordAttempt("note-6", 0, "答案", "incorrect", "self", { now: later });
  assert.deepEqual(compare("reviews and a missed check", later), { due: 13, newAvailable: 0, reviewedToday: 3, total: 20 });
  // The next day brings a new allowance: note 1's term and note 6's sections.
  assert.deepEqual(compare("the next day", day(1)), { due: 13, newAvailable: 4, reviewedToday: 0, total: 20 });
  // Note 2 loses a section and gains a term, note 3 turns into a built-in example, note 4 is deleted.
  lessons = lessons.flatMap(lesson => lesson.id === "note-4" ? []
    : lesson.id === "note-3" ? [{ ...lesson, isDemo: true }]
      : lesson.id === "note-2" ? [withTerm({ ...lesson, sections: lesson.sections.slice(1) }, "term-2")] : [lesson]);
  assert.deepEqual(compare("edits and a delete", day(1)), { due: 6, newAvailable: 5, reviewedToday: 0, total: 14 });
  const deleted = () => tables(path).review_cards.filter(row => JSON.parse(row).lesson_id === "note-4").length;
  assert.equal(deleted(), 3, "a deleted note's cards wait out the trash period");
  compare("after the trash period", day(TRASH_DAYS + 2));
  assert.equal(deleted(), 0, "summary() purged them; peekSummary() never counted them");
});

test("titles become one plain line of at most 120 characters", async t => {
  const messy = `  第一行\n第二行\t\u202e反轉\u2066隔離\u2069\u0007\u007f\u0085${"長".repeat(200)}  `;
  const cleaned = cleanSuiteTitle(messy);
  assert.ok([...cleaned].length <= 120);
  assert.doesNotMatch(cleaned, UNSAFE);
  assert.ok(cleaned.startsWith("第一行 第二行 反轉隔離 長長"), cleaned.slice(0, 20));
  assert.equal(cleanSuiteTitle("\u202e\n \t\u0000"), "未命名課程");
  assert.equal(cleanSuiteTitle("📚".repeat(130)), "📚".repeat(120), "clipped by code point, never inside a pair");
  assert.equal(cleanSuiteTitle("a\ud800b"), "a�b");

  const { store, get } = await setup(t);
  store.save(own("note-messy", messy, "2026-11-07T10:00:00.000Z"));
  store.save(own("note-blank", "\u202e\r\n", "2026-11-06T10:00:00.000Z"));
  const feed = validateSuiteFeed(JSON.parse((await get("/api/suite/today")).body));
  assert.deepEqual(feed.items.slice(1).map(item => item.title), [cleaned, "未命名課程"]);
});

test("the suite endpoints keep the Host, Origin and Fetch Metadata guard and send no CORS headers", async t => {
  const { get, port } = await setup(t, { suiteLinks: { personal: "http://127.0.0.1:21103" } });
  for (const path of ["/api/suite/manifest", "/api/suite/today"]) {
    const allowed = await get(path, { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
    assert.equal(allowed.status, 200, path);
    assert.equal(allowed.headers["access-control-allow-origin"], undefined);
    for (const headers of <Array<Record<string, string>>>[
      { host: "evil.example" },
      { host: "100.64.0.10:20001" },
      { origin: "https://evil.example" },
      { origin: "http://127.0.0.1:21103" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "cross-site" },
    ]) {
      const reply = await get(path, headers);
      assert.equal(reply.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(reply.headers["access-control-allow-origin"], undefined);
      assert.deepEqual(Object.keys(JSON.parse(reply.body)), ["error"]);
    }
    const preflight = await get(path, { origin: "http://127.0.0.1:21103", "access-control-request-method": "GET" }, "OPTIONS");
    assert.equal(preflight.status, 403);
    for (const name of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"]) assert.equal(preflight.headers[name], undefined);
  }
});

test("the today feed fails closed: 503 without learning records, a plain 500 on an internal error", async t => {
  const bare = await setup(t, { learning: false });
  const unavailable = await bare.get("/api/suite/today");
  assert.equal(unavailable.status, 503);
  assert.deepEqual(JSON.parse(unavailable.body), { error: "學習紀錄尚未啟用。" });
  assert.equal((await bare.get("/api/suite/manifest")).status, 200);

  const { store, learning, get } = await setup(t);
  store.save(own("note-1", "筆記", "2026-11-07T10:00:00.000Z"));
  learning!.peekSummary = () => { throw new Error(`${SENTINEL} /home/learner/learning.sqlite`); };
  const failed = await get("/api/suite/today");
  assert.equal(failed.status, 500);
  assert.deepEqual(Object.keys(JSON.parse(failed.body)), ["error"]);
  assert.ok(!failed.body.includes(SENTINEL) && !failed.body.includes("/home/learner") && !failed.body.includes("筆記\""));
});

test("the TypeScript copy of the contract accepts its valid fixtures and refuses the invalid ones", () => {
  const at = "2026-11-08T05:30:00.000Z";
  const queue = { sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "due", updatedAt: at, detail: "12 張到期 · 3 張新卡" };
  const today = { schemaVersion: 1, appId: "explain", generatedAt: at, counts: { due: 12, newAvailable: 3, reviewedToday: 5 }, truncated: false, items: [queue,
    { sourceApp: "explain", type: "lesson", id: "6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", title: "示範資料 · 傅立葉轉換的直覺", href: "#/note/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", state: "waiting", updatedAt: "2026-11-07T14:02:11.000Z" }] };
  validateSuiteFeed(today);
  const invalid: Array<[string, (feed: Record<string, any>) => void]> = [
    ["answer in an item", feed => { feed.items[0].answer = "F(ω)"; }],
    ["hints at the top level", feed => { feed.hints = ["積分"]; }],
    ["absolute href", feed => { feed.items[0].href = "https://evil.example/#/review"; }],
    ["protocol-relative href", feed => { feed.items[0].href = "#//evil.example"; }],
    ["encoded slash href", feed => { feed.items[0].href = "#/%2Fevil.example"; }],
    ["javascript href", feed => { feed.items[0].href = "javascript:alert(1)"; }],
    ["CRLF in href", feed => { feed.items[0].href = "#/a%0d%0aSet-Cookie"; }],
    ["backslash href", feed => { feed.items[0].href = "#/\\evil"; }],
    ["href not among Explain's routes", feed => { feed.items[0].href = "#/settings"; }],
    ["href with a query", feed => { feed.items[0].href = "#/review?x=1"; }],
    ["href with an encoded slash in the id", feed => { feed.items[0].href = "#/note/a%2Fb"; }],
    ["href to a dot-dot note", feed => { feed.items[0].href = "#/note/.."; }],
    ["title too long", feed => { feed.items[0].title = "長".repeat(121); }],
    ["title with RTL override", feed => { feed.items[0].title = "今日\u202e複習"; }],
    ["title with newline", feed => { feed.items[0].title = "今日\n複習"; }],
    ["id with spaces", feed => { feed.items[0].id = "a b"; }],
    ["unknown state", feed => { feed.items[0].state = "overdue"; }],
    ["item from another app", feed => { feed.items[0].sourceApp = "pr"; }],
    ["local time without Z", feed => { feed.items[0].updatedAt = "2026-11-08T13:30:00+08:00"; }],
    ["six items", feed => { feed.items = Array.from({ length: 6 }, (_, index) => ({ ...queue, id: `item-${index}` })); }],
    ["negative count", feed => { feed.counts = { due: -1 }; }],
    ["fractional count", feed => { feed.counts = { due: 1.5 }; }],
    ["unknown version", feed => { feed.schemaVersion = 2; }],
    ["detail too long", feed => { feed.items[0].detail = "字".repeat(81); }],
  ];
  for (const [name, change] of invalid) {
    const feed = structuredClone(today) as Record<string, any>;
    change(feed);
    assert.throws(() => validateSuiteFeed(feed), name);
  }
  const manifest = { schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "理解與複習", links: { personal: "http://127.0.0.1:21103" },
    capabilities: [{ id: "explain.draft", kind: "accept-handoff", route: "#/explain", accepts: ["text"], maxChars: 2000 }, { id: "review.today", kind: "today-feed", api: "/api/suite/today" },
      { id: "review.open", kind: "object-route", route: "#/review" }, { id: "note.open", kind: "object-route", route: "#/note/{id}" }] };
  validateSuiteManifest(manifest);
  for (const [name, patch] of [
    ["link to own app", { links: { explain: "http://127.0.0.1:21101" } }],
    ["link to a public https host", { links: { personal: "https://example.com" } }],
    ["absolute api", { capabilities: [{ id: "review.today", kind: "today-feed", api: "http://127.0.0.1:1/api/x" }] }],
    ["unknown key", { extra: true }],
  ] as const) assert.throws(() => validateSuiteManifest({ ...manifest, ...patch }), name);
  assert.throws(() => validateSuiteManifest({ ...manifest, links: { personal: PERSONAL_TAILNET } }), "a tailnet link needs an own tailnet origin");
  validateSuiteManifest({ ...manifest, links: { personal: PERSONAL_TAILNET } }, [OWN_TAILNET_ORIGIN]);
  for (const href of ["#/review", "#/note/b%3Ac", "#/note/b:c", "#/explain?text=a+b&from=personal"]) assert.ok(validSuiteHref(href), href);
  for (const href of ["#//x", "#/%2F", "#/%5C", "#/%E0%A4%A", "#/a%0A", "/review", "#/a b"]) assert.ok(!validSuiteHref(href), href);
});

test("contract §5.1: hrefs and back routes are exactly one of the app's allowed routes, with raw ids", () => {
  for (const href of ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/b:c.d_e-f", `#/note/${"a".repeat(128)}`])
    assert.ok(allowedSuiteRoute("explain", href), href);
  for (const href of ["#/note/", "#/note/.", "#/note/..", "#/note/a/b", "#/note/a%3Ab", `#/note/${"a".repeat(129)}`, "#/library/", "#/review?x=1", "#/explain?text=a", "#/tasks", "#/settings"])
    assert.ok(!allowedSuiteRoute("explain", href), href);
  for (const href of ["#/today", "#/tasks", "#/tasks/t-1", "#/events/ics:feed-1:abc", "#/ideas/i1", "#/inbox/18c2f0a9b1d3e4f5"]) assert.ok(allowedSuiteRoute("personal", href), href);
  for (const href of ["#/settings", "#/calendar", "#/work/projects/p1", "#/inbox?view=sent", "#/review"]) assert.ok(!allowedSuiteRoute("personal", href), href);
  for (const href of ["#/", "#/home", "#/demo", "#/repos", "#/repos/bell-explain", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/run_01"]) assert.ok(allowedSuiteRoute("pr", href), href);
  for (const href of ["#/runs/", "#/runs/..", "#/repos/a/b", "#/discover?draft=x", "#/unknown"]) assert.ok(!allowedSuiteRoute("pr", href), href);
  assert.ok(!allowedSuiteRoute("explain", `#/${"a".repeat(600)}`));
});

test("BELL_SUITE_LINKS accepts loopback and own-tailnet origins and refuses everything else at startup", () => {
  const ownOrigins = [OWN_TAILNET_ORIGIN];
  for (const value of [undefined, "", "  "]) assert.deepEqual(parseSuiteLinks(value, ownOrigins), {});
  assert.deepEqual(parseSuiteLinks("personal=http://127.0.0.1:21103", []), { personal: "http://127.0.0.1:21103" });
  assert.deepEqual(parseSuiteLinks("personal=https://127.0.0.1:21103,pr=http://[::1]:4610,reader=http://127.0.0.1:21104", []), {
    personal: "https://127.0.0.1:21103",
    pr: "http://[::1]:4610",
    reader: "http://127.0.0.1:21104",
  });
  assert.deepEqual(parseSuiteLinks(`personal=${PERSONAL_TAILNET}, pr=http://localhost:4610`, ownOrigins), { personal: PERSONAL_TAILNET, pr: "http://localhost:4610" });
  assert.deepEqual(readRuntimeConfig({}).suiteLinks, {});
  assert.deepEqual(readRuntimeConfig({ BELL_ALLOWED_ORIGINS: OWN_TAILNET_ORIGIN, BELL_SUITE_LINKS: `personal=${PERSONAL_TAILNET}` }).suiteLinks, { personal: PERSONAL_TAILNET });
  // Without an own origin on that tailnet, a tailnet link is refused too.
  assert.throws(() => readRuntimeConfig({ BELL_SUITE_LINKS: `personal=${PERSONAL_TAILNET}` }), /BELL_SUITE_LINKS/);
  for (const value of [
    "personal=http://box.tail-one.ts.net:20003", // non-loopback http
    "personal=https://box.othertailnet.ts.net:20003", // another tailnet
    "personal=https://example.com", // arbitrary https
    "personal=https://100.64.0.10:20003", // tailnet IP, not a MagicDNS name
    "personal=https://tail-one.ts.net", // no host label
    "personal=https://*.tail-one.ts.net", // wildcard
    "personal=https://user:pw@box.tail-one.ts.net:20003", // credentials
    "personal=http://127.0.0.1:21103/app", // path
    "personal=http://127.0.0.1:21103/", // trailing slash
    "personal=http://127.0.0.1:21103?x=1", // query
    "personal=http://127.0.0.1:21103#x", // fragment
    "personal=http://127.0.0.1:0", // port 0
    "personal=http://127.0.0.1:", // empty port
    "personal=ftp://127.0.0.1:21", // scheme
    "personal=127.0.0.1:21103", // no scheme
    "explain=http://127.0.0.1:21101", // Explain itself
    "calendar=http://127.0.0.1:1", // unknown app
    "personal=http://127.0.0.1:1,personal=http://127.0.0.1:2", // duplicate
    "personal http://127.0.0.1:1", // format
    "Personal=http://127.0.0.1:1", // format
    "personal=http://127.0.0.1:1,", // empty entry
    "personal=http://127.0.0.1:1,pr=http://127.0.0.1:2,personal=http://127.0.0.1:3,pr=http://127.0.0.1:4", // more than three
  ]) {
    assert.throws(() => readRuntimeConfig({ BELL_ALLOWED_ORIGINS: OWN_TAILNET_ORIGIN, BELL_SUITE_LINKS: value }), (error: Error) => {
      assert.match(error.message, /^BELL_SUITE_LINKS /, value);
      assert.ok(!error.message.includes("pw") && !error.message.includes("://"), "the value is never echoed");
      return true;
    }, value);
  }
});

test("GET /api/suite/topics exposes minimized non-demo topic metadata for Web Reader without leaking note bodies or paths", async t => {
  const { store, get } = await setup(t);
  const lesson = { ...secretive(own("closure-note", "JavaScript 閉包與作用域", "2026-11-10T08:00:00.000Z")), category: "程式語言", tags: ["JavaScript", "閉包"] };
  store.save(lesson);
  const reply = await get("/api/suite/topics", PERSONAL_READ);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.ok(!reply.body.includes(SENTINEL), "never leaks secret note text or source URLs");
  const payload = JSON.parse(reply.body) as { schemaVersion: number; appId: string; topics: Array<{ id: string; title: string; category?: string; href: string; tags: string[] }> };
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.appId, "explain");
  assert.equal(payload.topics.length, 1);
  assert.deepEqual(payload.topics[0], {
    id: "closure-note",
    title: "JavaScript 閉包與作用域",
    category: "程式語言",
    tags: ["JavaScript", "閉包"],
    href: "#/note/closure-note",
  });
});
