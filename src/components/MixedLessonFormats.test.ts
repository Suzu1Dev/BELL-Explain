import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { exampleLessons } from "../../shared/examples.js";
import type { LessonNoteV3, LessonV3, StoredLesson } from "../../shared/lesson-v3.js";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  }`)}`);
}
const { api } = await import("../lib/api.js");
const { default: App, clearNoModelReformatJobs } = await import("../App.js");
const localized = JSON.parse(readFileSync(new URL("../../server/fixtures/closure-lesson.json", import.meta.url), "utf8")) as Record<"zh-TW" | "en", LessonV3>;
const generated = localized["zh-TW"];
const v3: LessonNoteV3 = {
  ...generated, id: "synced-v3", category: "JavaScript", tags: ["閉包"],
  source: { kind: "code", label: generated.source.label, content: "const count = 0;" },
  connections: [], createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", isDemo: false, favorite: false,
};
const mixed: StoredLesson[] = [{ ...exampleLessons[0], failedFormat: 3 }, v3];

async function waitFor(check: () => void) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
  }
}

async function mount(t: TestContext, hash: string, ended?: import("../../shared/types.js").JobView, overrides: { config?: Partial<import("../../shared/types.js").AppConfig>; lessons?: StoredLesson[] } = {}) {
  delete process.env.BELL_LESSON_V3;
  const window = new Window({ url: `http://127.0.0.1:21115/${hash}` });
  const globals: Record<string, unknown> = {
    window, document: window.document, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    ResizeObserver: window.ResizeObserver, IntersectionObserver: window.IntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  if (ended) window.sessionStorage.setItem("bell.job", ended.id);
  t.mock.method(globalThis, "setInterval", ((callback: () => void) => 1) as typeof setInterval);
  t.mock.method(api, "lessons", async () => overrides.lessons ?? mixed);
  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }));
  t.mock.method(api, "config", async () => ({ configured: false, model: "", storage: "SQLite", ...overrides.config }));
  t.mock.method(api, "jobs", async () => ended ? [ended] : []);
  t.mock.method(api, "job", async () => ended ?? null);
  t.mock.method(api, "reviewSummary", async () => ({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }));
  t.mock.method(api, "reviewDue", async () => []);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
    await window.happyDOM.close();
  });
  await act(async () => { root.render(createElement(App)); });
  return window;
}

for (const hash of ["#/", "#/library"]) {
  test(`${hash} renders legacy and synced v3 notes with the format flag off`, async t => {
    const window = await mount(t, hash);
    await waitFor(() => {
      assert.equal(window.document.querySelectorAll(".note-card").length, 2);
      assert.match(window.document.body.textContent || "", /閉包：函式的隨身背包/);
      assert.match(window.document.body.textContent || "", /3 步/);
      assert.match(window.document.body.textContent || "", /3 段/);
    });
    assert.equal(window.document.querySelector(".page-error"), null);
    assert.equal(process.env.BELL_LESSON_V3, undefined);
  });
}

test("#/review renders normally with a mixed library and the format flag off", async t => {
  const window = await mount(t, "#/review");
  await waitFor(() => assert.match(window.document.querySelector(".review-done")?.textContent || "", /今天沒有到期的複習/));
  assert.equal(window.document.querySelector(".page-error"), null);
  assert.equal(process.env.BELL_LESSON_V3, undefined);
});

for (const hash of ["#/library", "#/note/demo-closure"]) {
  test(`${hash} shows the existing failed-format badge copy`, async t => {
    const window = await mount(t, hash);
    await waitFor(() => assert.equal(window.document.querySelector(".format-failed-badge")?.textContent, "整理失敗"));
    if (hash.startsWith("#/note/")) assert.match(window.document.querySelector(".reader-reformat-note")?.textContent || "", /這次沒整理成步驟版面，已完整保留為舊版/);
  });
}

test("a reload-resumed reformat uses the localized open-note action", async t => {
  const window = await mount(t, "?lang=en#/library", { id: "reformat-done", kind: "reformat", title: "Closure", lessonId: v3.id, status: "done", startedAt: "2026-11-10T00:00:00.000Z", finishedAt: "2026-11-10T00:01:00.000Z" });
  await waitFor(() => {
    const toast = window.document.querySelector(".toast");
    assert.match(toast?.textContent || "", /Updated to the step-by-step layout/);
    assert.equal(toast?.querySelector(".toast-action")?.textContent, "Open note");
  });
});

test("a reformat failure found after reload uses the short error toast", async t => {
  const window = await mount(t, "?lang=en#/library", { id: "reformat-failed", kind: "reformat", title: "Closure", status: "failed", error: "raw server detail", startedAt: "2026-11-10T00:00:00.000Z", finishedAt: "2026-11-10T00:01:00.000Z" });
  await waitFor(() => {
    const toast = window.document.querySelector(".toast");
    assert.equal(toast?.getAttribute("data-tone"), "error");
    assert.match(toast?.textContent || "", /Couldn't rebuild/);
    assert.doesNotMatch(toast?.textContent || "", /original note|raw server detail/);
  });
});

// 整理成新格式 with the format flag on: a curated sample never offers it, and a missing AI says where to connect one.
const sample = { ...exampleLessons[0] };
const own = { ...exampleLessons[0], id: "own-closure", isDemo: false };
const moreMenu = (window: Window) => window.document.querySelector(".reader-more-menu")?.textContent || "";

for (const [name, id, offered] of [["a curated sample", sample.id, false], ["the learner's own original-format note", own.id, true]] as const) {
  test(`${name} ${offered ? "offers" : "does not offer"} 整理成新格式`, async t => {
    const window = await mount(t, `#/note/${id}`, undefined, { config: { configured: true, lessonV3: true }, lessons: [sample, own] });
    await waitFor(() => assert.match(moreMenu(window), /匯出 Markdown|原始內容/));
    assert.equal(moreMenu(window).includes("整理成新格式"), offered);
  });
}

test("整理成新格式 without a connected AI points to Settings instead of a retry", async t => {
  const window = await mount(t, `?lang=en#/note/${own.id}`, undefined, { config: { configured: false, lessonV3: true }, lessons: [sample, own] });
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith(`/api/lessons/${own.id}/reformat`)) return realFetch(input, init);
    asked.push(url);
    return new Response(JSON.stringify({ error: "請先在模型設定連接 Codex、Claude Code 或 AI API。", code: "no_model" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);
  let button: HTMLButtonElement | undefined;
  await waitFor(() => {
    button = [...window.document.querySelectorAll(".reader-more-menu button")].find(item => item.textContent === "Rebuild in step-by-step view") as unknown as HTMLButtonElement | undefined;
    assert.equal(Boolean(button), true);
  });
  await act(async () => { button!.click(); });
  await waitFor(() => assert.equal(window.document.querySelector(".page-error span")?.textContent, "AI isn't connected yet. Connect AI in Settings to rebuild this note."));
  assert.equal(asked.length, 1);
  const toast = window.document.querySelector(".toast");
  assert.equal(toast?.getAttribute("data-tone"), "error");
  assert.match(toast?.textContent || "", /AI isn't connected/);
  assert.doesNotMatch(window.document.body.textContent || "", /try again in a bit|Couldn't rebuild/);
  const action = toast?.querySelector(".toast-action") as unknown as HTMLButtonElement | null;
  assert.equal(action?.textContent, "Open Settings");
  await act(async () => { action!.click(); });
  await waitFor(() => assert.equal(Boolean(window.document.querySelector(".toast")), false));
  const bannerAction = window.document.querySelector(".page-error button") as unknown as HTMLButtonElement | null;
  assert.equal(bannerAction?.textContent, "Open Settings");
  await act(async () => { bannerAction!.click(); });
  assert.equal(Boolean(window.document.querySelector(".toast")), false);
});

test("connecting AI clears only stale no-model banners", () => {
  const failure = { error: "Couldn't rebuild" };
  const progress = { message: "Rebuilding" };
  assert.deepEqual(clearNoModelReformatJobs({
    stale: { error: "AI isn't connected", noModel: true },
    failure,
    progress,
  }), { stale: {}, failure, progress });
});
