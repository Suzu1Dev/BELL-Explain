import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { exampleLessons } from "../shared/examples.js";
import { DEPTHS } from "../shared/depth-rubric.js";
import { V3_LIMITS, isLessonV3, type StoredLesson } from "../shared/lesson-v3.js";
import type { GenerateEvent, JobView, Lesson, LessonAnnotation } from "../shared/types.js";
import { CloudSyncStore, createCloudApp } from "../cloud/app.js";
import type { ChatCall } from "./ai.js";
import { createApp, type AppOptions } from "./app.js";
import { AppError } from "./errors.js";
import { V3_ATTEMPTS } from "./lesson-v3-generate.js";
import { LESSON_V3_EXAMPLE } from "./prompts/lesson-v3-example.js";
import type { ProviderService } from "./provider-router.js";
import { LessonStore } from "./store.js";
import { FORMAT_HELD_MESSAGE, SyncService } from "./sync.js";
import { lessonHash, syncLessonSchema } from "./sync-protocol.js";

/**
 * 整理成新格式 (L1.7): POST /api/lessons/:id/reformat writes an original-format note again in
 * format 3 from the source it keeps. Only the fake model below answers; nothing reaches a provider.
 */

const AUTHOR = "課程作者";
const REPAIR = "你上一次的 JSON 回覆有結構問題";
const CURATOR = "知識整理代理";
const CREATED = "2026-11-01T00:00:00.000Z";
const annotation = (id: string, term: string, sourceKey: string, quote: string): LessonAnnotation =>
  ({ id, term, sourceKey, quote, explanation: "解說。", analogy: "比喻。", createdAt: CREATED });

/** The closure demo as a learner's own note that fell back from format 3, with what they added to it. */
function legacy(): Lesson {
  const note = structuredClone(exampleLessons[0]);
  note.sections.forEach((section, index) => { section.id = `section-${index + 1}`; });
  note.sections[0].body += "函式加上它留住的變數，就是閉包。";
  note.sections[2].body += "兩個計數器各自改同一個 `count` 嗎？不會。";
  return {
    ...note, id: "legacy-note", isDemo: false, favorite: true, failedFormat: 3, createdAt: CREATED, updatedAt: CREATED,
    parentLessonId: "linker-note",
    connections: [{ targetId: "linker-note", sectionId: "section-1", reason: "同一個計數器例子。" }],
    annotations: [
      // Still in the rewrite at the matching step: s1's body.
      annotation("term-kept", "閉包", "section-1:body", "函式加上它留住的變數，就是閉包"),
      // Only in s2 of the rewrite, not in s3: moves there.
      annotation("term-moved", "count", "section-3:body", "同一個 `count`"),
      // Not in the rewrite at all: dropped.
      annotation("term-gone", "詞法環境", "summary", "持續存取建立當下的詞法環境"),
    ],
  };
}
/** Another note that links into the one being rewritten. */
function linker(): Lesson {
  const note = structuredClone(exampleLessons[1]);
  note.sections.forEach((section, index) => { section.id = `section-${index + 1}`; });
  return {
    ...note, id: "linker-note", isDemo: false, favorite: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    connections: [
      { targetId: "legacy-note", sectionId: "section-2", reason: "閉包讓回呼記得狀態。" },
      { targetId: "legacy-note", sectionId: "section-9", reason: "沒有對應的步驟。" },
    ],
  };
}

type Call = { role: string; instruction: string; data: Record<string, unknown> };
/** A model that answers each agent; `author` answers the v3 author's first call of each attempt. */
function model(author: () => unknown = () => structuredClone(LESSON_V3_EXAMPLE)) {
  const calls: Call[] = [];
  const chat: ChatCall = async (role, instruction, data) => {
    calls.push({ role, instruction, data: structuredClone(data) as Record<string, unknown> });
    if (instruction.startsWith(REPAIR)) return { fixes: [] };
    if (role === AUTHOR) return author();
    if (role === CURATOR) return { category: "JavaScript", tags: ["閉包"], connections: [{ targetId: "linker-note", sectionId: "section-2", reason: "回呼裡的閉包。" }] };
    throw new Error(`unexpected agent ${role}`);
  };
  /** The agents asked, without the repair rounds inside an attempt. */
  const roles = () => calls.filter(call => !call.instruction.startsWith(REPAIR)).map(call => call.role);
  return { chat, calls, roles };
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function setup(t: TestContext, chat: ChatCall, options: { lessonV3?: boolean; notes?: StoredLesson[]; sync?: (store: LessonStore) => SyncService; config?: AppOptions["config"]; provider?: ProviderService } = {}) {
  const store = new LessonStore(":memory:");
  for (const note of options.notes ?? [legacy(), linker()]) store.save(note);
  const sync = options.sync?.(store);
  const app: AppOptions = {
    store, examples: exampleLessons, chat, lessonV3: options.lessonV3 ?? true, sync, provider: options.provider,
    config: options.config ?? { apiKey: "test-only", model: "fake-model", baseUrl: "https://example.invalid/v1" },
  };
  const server = createServer(createApp(app));
  const base = await listen(server);
  t.after(async () => { await close(server); store.close(); });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const reformat = async (id = "legacy-note", body: unknown = {}) => {
    const response = await request(`/api/lessons/${id}/reformat`, { method: "POST", body: JSON.stringify(body) });
    const text = await response.text();
    const json = response.headers.get("content-type")?.includes("ndjson") ? undefined : JSON.parse(text);
    const events = json ? [] : text.trim().split("\n").map(line => JSON.parse(line) as GenerateEvent<StoredLesson>);
    return { status: response.status, json, events, end: events.at(-1) };
  };
  const job = async (events: GenerateEvent<StoredLesson>[]) => {
    const first = events[0];
    assert.equal(first.type, "job");
    return (await (await request(`/api/jobs/${first.type === "job" ? first.id : ""}`)).json()) as JobView;
  };
  return { store, request, reformat, job };
}

test("整理成新格式: the note is rewritten in place, keeping its id, favorite, links and the annotations the new text still holds", async t => {
  const fake = model();
  const { store, request, reformat, job } = await setup(t, fake.chat);
  const before = store.getRaw("legacy-note") as Lesson;
  assert.equal((await (await request("/api/config")).json()).lessonV3, true, "the browser can tell the menu entry is available");

  const { status, events, end } = await reformat();
  assert.equal(status, 200);
  assert.equal(end?.type, "complete", JSON.stringify(end));
  assert.deepEqual(fake.roles(), [AUTHOR, CURATOR], "the v3 author once, then the curator; never the original pipeline");
  const [author] = fake.calls;
  assert.deepEqual(author.data.source, before.source, "written from the source the note keeps");
  assert.equal(author.data.depth, "intermediate");
  assert.ok(author.instruction.includes(DEPTHS.intermediate.rule));
  assert.deepEqual(author.data.continuesFrom, { title: linker().title, summary: linker().summary }, "a follow-up note still builds on its parent");
  assert.ok(events.some(event => event.type === "stage" && event.message === "有 1 則詞句解說引用的文字已不在新內容裡，沒有搬過去。"));

  const note = store.getRaw("legacy-note");
  assert.ok(note && isLessonV3(note));
  assert.deepEqual(end?.type === "complete" && end.lesson, store.get("legacy-note"));
  assert.deepEqual([note.id, note.createdAt, note.favorite, note.isDemo, note.parentLessonId], ["legacy-note", CREATED, true, false, "linker-note"]);
  assert.ok(note.updatedAt > before.updatedAt);
  assert.equal("failedFormat" in note, false, "the 「整理失敗」 mark is cleared");
  assert.equal("sections" in note, false);
  assert.deepEqual(note.steps.map(step => step.id), ["s1", "s2", "s3"]);
  assert.deepEqual(note.annotations?.map(item => [item.id, item.sourceKey]), [["term-kept", "s1:body"], ["term-moved", "s2:body"]]);
  // Its own link stays; the curator's new one is added once.
  assert.deepEqual(note.connections.map(link => [link.targetId, link.sectionId]), [["linker-note", "section-1"], ["linker-note", "section-2"]]);
  assert.equal(syncLessonSchema.safeParse(structuredClone(note)).success, true, "the rewrite syncs as it is");

  // A link into section 2 now points at step s2; one with no matching step is left as it was.
  const other = store.getRaw("linker-note")!;
  assert.deepEqual(other.connections.map(link => link.sectionId), ["s2", "section-9"]);
  assert.ok(other.updatedAt > linker().updatedAt, "the changed link goes out with the next sync");
  assert.deepEqual(store.get("linker-note")!.connections.map(link => link.sectionId), ["s2"]);

  const view = await job(events);
  assert.deepEqual([view.kind, view.status, view.lessonId], ["reformat", "done", "legacy-note"]);
  // A stale tab asking again gets the saved note back, without another model call.
  const again = await reformat();
  assert.equal(again.end?.type, "complete");
  assert.equal(fake.calls.length, 2);
});

test("整理成新格式: the depth can be chosen; anything else in the body is refused", async t => {
  const fake = model();
  const { reformat } = await setup(t, fake.chat);
  assert.equal((await reformat("legacy-note", { depth: "expert" })).status, 400);
  assert.equal((await reformat("legacy-note", { depth: "beginner", extra: true })).status, 400);
  assert.equal(fake.calls.length, 0);
  assert.equal((await reformat("legacy-note", { depth: "beginner" })).end?.type, "complete");
  assert.equal(fake.calls[0].data.depth, "beginner");
  assert.ok(fake.calls[0].instruction.includes(DEPTHS.beginner.rule));
});

test("整理成新格式: a failure leaves the note exactly as it was and says why", async t => {
  const cases: Array<{ name: string; author: () => unknown; message: RegExp; authors: number }> = [
    { name: "both attempts fail the writing guide", author: () => ({ ...structuredClone(LESSON_V3_EXAMPLE), title: "字".repeat(V3_LIMITS.title + 1) }), message: /^新格式試寫了兩次，仍未通過撰寫規範；原筆記未變更/, authors: V3_ATTEMPTS },
    { name: "the source is too large for one call", author: () => { throw new AppError(413, "too large"); }, message: /^原始內容太長，無法一次整理成新格式；原筆記未變更。$/, authors: 1 },
    { name: "a rate limit", author: () => { throw new AppError(429, "模型請求過於頻繁，請稍後再試。"); }, message: /^模型請求過於頻繁，請稍後再試。原筆記未變更。$/, authors: 1 },
    { name: "a provider error", author: () => { throw new Error("socket hang up"); }, message: /^整理成新格式時遇到問題；原筆記未變更/, authors: 1 },
  ];
  for (const { name, author, message, authors } of cases) {
    await t.test(name, async t => {
      const fake = model(author);
      const { store, reformat, job } = await setup(t, fake.chat);
      const before = store.getRaw("legacy-note");
      const { status, events, end } = await reformat();
      assert.equal(status, 200);
      assert.equal(end?.type, "error");
      assert.match(end?.type === "error" ? end.message : "", message);
      assert.equal(fake.roles().filter(role => role === AUTHOR).length, authors);
      assert.deepEqual(fake.roles().filter(role => role !== AUTHOR), [], "no fallback to the original format, no curation");
      assert.deepEqual(store.getRaw("legacy-note"), before);
      assert.deepEqual(store.getRaw("linker-note"), linker());
      assert.equal((await job(events)).status, "failed");
    });
  }
});

test("整理成新格式: an edit to the note while it is written wins; the rewrite is not saved", async t => {
  let store: LessonStore | undefined;
  const fake = model(() => {
    const note = store!.getRaw("legacy-note") as Lesson;
    store!.save({ ...note, sections: note.sections.slice(1), updatedAt: "2026-11-05T00:00:00.000Z" });
    return structuredClone(LESSON_V3_EXAMPLE);
  });
  const env = await setup(t, fake.chat);
  store = env.store;
  const { end } = await env.reformat();
  assert.match(end?.type === "error" ? end.message : "", /^筆記在整理期間已更新或刪除，新格式未寫入/);
  assert.equal(end?.type === "error" ? end.status : undefined, 409);
  const note = env.store.getRaw("legacy-note");
  assert.ok(note && !isLessonV3(note));
  assert.equal(note.sections.length, legacy().sections.length - 1);
});

test("整理成新格式: deleting the note mid-job reports 409 and never restores stale content", async t => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = model(() => gate.then(() => structuredClone(LESSON_V3_EXAMPLE)));
  const env = await setup(t, fake.chat);
  const response = await env.request("/api/lessons/legacy-note/reformat", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(env.store.delete("legacy-note"), true);
  release();
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as GenerateEvent<StoredLesson>);
  const end = events.at(-1);
  assert.equal(end?.type, "error");
  assert.equal(end?.type === "error" ? end.status : undefined, 409);
  assert.match(end?.type === "error" ? end.message : "", /已更新或刪除/);
  assert.equal(env.store.getRaw("legacy-note"), undefined);
});

test("整理成新格式 is refused with 409 while BELL_LESSON_V3 is off, before anything else is looked at", async t => {
  const fake = model();
  const { store, request, reformat } = await setup(t, fake.chat, { lessonV3: false });
  assert.equal((await (await request("/api/config")).json()).lessonV3, false);
  for (const id of ["legacy-note", "missing"]) {
    const { status, json } = await reformat(id);
    assert.equal(status, 409);
    assert.match(json.error, /新格式尚未開啟（BELL_LESSON_V3）/);
  }
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(store.getRaw("legacy-note"), legacy());
});

test("整理成新格式 refuses a note without its original content, a curated demo and an unknown note", async t => {
  const empty = { ...legacy(), id: "no-source", source: { ...legacy().source, content: "  \n" } };
  const demo = { ...structuredClone(exampleLessons[0]), id: "demo-note" };
  const fake = model();
  const { store, reformat } = await setup(t, fake.chat, { notes: [empty, demo] });
  const missing = await reformat("no-source");
  assert.equal(missing.status, 422);
  assert.match(missing.json.error, /^這篇筆記沒有保存原始內容，無法重新整理成新格式；原筆記未變更。$/);
  assert.deepEqual(store.getRaw("no-source"), empty);
  assert.equal((await reformat("demo-note")).status, 400);
  assert.equal((await reformat("nowhere")).status, 404);
  assert.equal(fake.calls.length, 0);
});

test("整理成新格式: the note's own links stay as stored, like links into it from other notes; a read hides one whose part is missing", async t => {
  const own = legacy();
  own.connections.push(
    { targetId: "linker-note", sectionId: "section-9", reason: "那篇沒有第 9 段。" },
    { targetId: "trashed-note", sectionId: "section-1", reason: "那篇已刪除。" },
  );
  const fake = model();
  // The curator's new links still have to point at a saved part: section-8 does not exist.
  const chat: ChatCall = async (role, ...rest) => role === CURATOR
    ? { category: "JavaScript", tags: ["閉包"], connections: [
      { targetId: "linker-note", sectionId: "section-2", reason: "回呼裡的閉包。" },
      { targetId: "linker-note", sectionId: "section-8", reason: "不存在的段落。" },
      { targetId: "linker-note", sectionId: "section-1", reason: "和原有的重複。" },
    ] }
    : fake.chat(role, ...rest);
  const { store, reformat } = await setup(t, chat, { notes: [own, linker()] });
  assert.deepEqual(store.get("legacy-note")!.connections.map(link => link.sectionId), ["section-1"], "before: the read already hides both");

  assert.equal((await reformat()).end?.type, "complete");
  const note = store.getRaw("legacy-note");
  assert.ok(note && isLessonV3(note));
  assert.deepEqual(note.connections.map(link => [link.targetId, link.sectionId, link.reason]), [
    ["linker-note", "section-1", "同一個計數器例子。"],
    ["linker-note", "section-9", "那篇沒有第 9 段。"],
    ["trashed-note", "section-1", "那篇已刪除。"],
    ["linker-note", "section-2", "回呼裡的閉包。"],
  ]);
  assert.equal(syncLessonSchema.safeParse(structuredClone(note)).success, true);
  assert.deepEqual(store.get("legacy-note")!.connections.map(link => [link.targetId, link.sectionId]), [["linker-note", "section-1"], ["linker-note", "section-2"]]);
  // The note it pointed at comes back from the trash: the link shows again, as one from another note would.
  store.save({ ...linker(), id: "trashed-note", connections: [] });
  assert.deepEqual(store.get("legacy-note")!.connections.map(link => [link.targetId, link.sectionId]), [["linker-note", "section-1"], ["trashed-note", "section-1"], ["linker-note", "section-2"]]);
});

test("整理成新格式 without a usable model connection is refused with 503 before a job starts", async t => {
  const unconfigured = {
    status: async () => ({ configured: false, message: "Codex 尚未登入。" }),
    createChat: async () => { throw new Error("must not be asked for a chat"); },
  } as unknown as ProviderService;
  const cases: Array<{ name: string; config?: AppOptions["config"]; provider?: ProviderService }> = [
    { name: "the selected provider is not ready", provider: unconfigured },
    { name: "no provider service and no AI API key", config: { apiKey: "", model: "", baseUrl: "https://example.invalid/v1" } },
  ];
  for (const { name, config, provider } of cases) {
    await t.test(name, async t => {
      const fake = model();
      const { store, request, reformat } = await setup(t, fake.chat, { config, provider });
      const { status, json } = await reformat();
      assert.equal(status, 503);
      assert.equal(json.error, "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API。");
      assert.equal(json.code, "no_model", "a distinct code, so the reader can point to Settings instead of a retry");
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(await (await request("/api/jobs")).json(), [], "no job was started");
      assert.deepEqual(store.getRaw("legacy-note"), legacy());
      assert.deepEqual(store.getRaw("linker-note"), linker());
    });
  }
});

test("整理成新格式 while both job slots are busy is refused with 429; a request for a note already being rewritten joins its job", async t => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let authors = 0;
  const fake = model(() => { authors++; return gate.then(() => structuredClone(LESSON_V3_EXAMPLE)); });
  const second = { ...legacy(), id: "legacy-two", annotations: [] };
  const waiting = { ...legacy(), id: "legacy-three", annotations: [] };
  const { store, request, reformat } = await setup(t, fake.chat, { notes: [legacy(), second, waiting, linker()] });
  const post = (id: string) => request(`/api/lessons/${id}/reformat`, { method: "POST", body: "{}" });
  const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line) as GenerateEvent<StoredLesson>);

  const first = await post("legacy-note");
  const other = await post("legacy-two");
  assert.deepEqual([first.status, other.status], [200, 200]);
  const busy = await reformat("legacy-three");
  assert.equal(busy.status, 429);
  assert.equal(busy.json.error, "已有兩個學習工作進行中，請等待完成後重試。");
  assert.deepEqual(store.getRaw("legacy-three"), waiting, "the refused note is untouched");
  const joined = await post("legacy-note");
  assert.equal(joined.status, 200, "the same note follows its running job instead of being refused");
  const running = (await (await request("/api/jobs")).json()) as JobView[];
  assert.deepEqual(running.map(job => [job.kind, job.status, job.lessonId]).sort(), [["reformat", "running", "legacy-note"], ["reformat", "running", "legacy-two"]]);

  release();
  const [a, b, c] = await Promise.all([events(first), events(other), events(joined)]);
  assert.deepEqual([a.at(-1)?.type, b.at(-1)?.type, c.at(-1)?.type], ["complete", "complete", "complete"]);
  assert.deepEqual(c[0], a[0], "both streams follow the same job");
  assert.equal(authors, 2, "one author call per running job; none for the refused note");
  // Once a slot is free the refused note can be rewritten.
  assert.equal((await reformat("legacy-three")).end?.type, "complete");
  assert.equal(authors, 3);
});

const token = "integration-test-secret-with-at-least-thirty-two-characters";
test("整理成新格式 on a device whose cloud predates format 3: the rewrite waits on the device, the note's other changes go up", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bell-reformat-sync-"));
  const cloud = new CloudSyncStore(join(directory, "cloud.sqlite"));
  const cloudApp = createCloudApp({ store: cloud, token });
  let old = true;
  const cloudServer = createServer((req, res) => {
    if (old && req.url?.startsWith("/v1/capabilities")) { res.statusCode = 404; res.end(); return; }
    cloudApp(req, res);
  });
  const remoteUrl = await listen(cloudServer);
  let sync: SyncService | undefined;
  t.after(async () => {
    await sync?.close().catch(() => {});
    await close(cloudServer);
    cloud.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // Synced before 「整理失敗」 existed: an original note an old cloud stores.
  const original: Lesson = { ...legacy(), failedFormat: undefined };
  delete original.failedFormat;
  const env = await setup(t, model().chat, {
    notes: [original, linker()],
    sync: store => (sync = new SyncService({
      path: join(directory, "device.sqlite"), intervalMs: 60_000,
      lessons: { list: () => store.listRaw({ strict: true }), get: id => store.getRaw(id, { strict: true }), save: lesson => store.save(lesson), delete: id => store.delete(id) },
    })),
  });
  await sync!.configure({ remoteUrl, token, uploadExisting: true });
  const inCloud = () => Object.fromEntries(cloud.pull(0).changes.map(change => [change.document.id, change.document.hash]));
  assert.deepEqual(inCloud(), { "legacy-note": lessonHash(original), "linker-note": lessonHash(linker()) });

  assert.equal((await env.reformat()).end?.type, "complete");
  await sync!.sync();
  const rewritten = env.store.getRaw("legacy-note")!;
  assert.ok(isLessonV3(rewritten));
  // The cloud keeps the original; the moved link in the other note is not held with it.
  assert.deepEqual(inCloud(), { "legacy-note": lessonHash(original), "linker-note": lessonHash(env.store.getRaw("linker-note")!) });
  assert.equal(sync!.status().pending, 1);
  assert.equal(sync!.status().lastError, FORMAT_HELD_MESSAGE);
  assert.ok(isLessonV3(env.store.getRaw("legacy-note")!), "a held rewrite stays on the device, not rolled back by the pull");

  // Once the cloud is updated, the rewrite goes up on the next sync.
  old = false;
  await sync!.sync();
  assert.equal(inCloud()["legacy-note"], lessonHash(rewritten));
  assert.equal(sync!.status().pending, 0);
  assert.ok(!sync!.status().lastError);
});
