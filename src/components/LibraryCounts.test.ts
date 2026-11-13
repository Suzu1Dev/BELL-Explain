import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { exampleLessons } from "../../shared/examples.js";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({
    load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    },
  });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  }`)}`);
}

const { api } = await import("../lib/api.js");
const { default: App } = await import("../App.js");

async function waitFor(check: () => void) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
  }
}

async function mount(t: TestContext, lessons: () => Promise<unknown>) {
  const window = new Window({ url: "http://127.0.0.1:21115/#/home" });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    ResizeObserver: window.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let refresh: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, "setInterval", ((callback: () => void, timeout?: number) => {
    if (timeout === 15_000) refresh = callback as () => Promise<void>;
    return 1;
  }) as typeof setInterval);
  t.mock.method(api, "lessons", lessons as typeof api.lessons);
  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }));
  t.mock.method(api, "config", async () => ({ configured: false, model: "", storage: "SQLite" }));
  t.mock.method(api, "jobs", async () => []);
  t.mock.method(api, "reviewSummary", async () => ({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await window.happyDOM.close();
  });
  await act(async () => { root.render(createElement(App)); });
  const counts = () => ({
    nav: window.document.querySelector('button[aria-label="知識庫"] .nav-count')?.textContent,
    recent: window.document.querySelector(".recent-section .count-label")?.textContent,
  });
  return { window, counts, refresh: async () => { await refresh?.(); } };
}

test("pending counts stay unknown, then a real result appears and survives a refresh failure", async t => {
  let resolveLessons!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveLessons = resolve; });
  const page = await mount(t, () => pending);
  assert.deepEqual(page.counts(), { nav: "—", recent: "—" });
  assert.doesNotMatch(page.window.document.body.textContent || "", /最近筆記 0/);

  await act(async () => {
    resolveLessons(exampleLessons.slice(0, 1));
    await pending;
  });
  await waitFor(() => assert.deepEqual(page.counts(), { nav: "1", recent: "1" }));

  t.mock.method(api, "lessons", async () => { throw new Error("離線"); });
  await act(async () => { await page.refresh(); });
  assert.deepEqual(page.counts(), { nav: "1", recent: "1" });
});

test("a confirmed empty library shows zero and does not become unknown after a refresh failure", async t => {
  let resolveLessons!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveLessons = resolve; });
  const page = await mount(t, () => pending);
  assert.deepEqual(page.counts(), { nav: "—", recent: "—" });

  await act(async () => {
    resolveLessons([]);
    await pending;
  });
  await waitFor(() => assert.deepEqual(page.counts(), { nav: "0", recent: "0" }));
  assert.match(page.window.document.querySelector(".empty-state")?.textContent || "", /還沒有筆記/);

  t.mock.method(api, "lessons", async () => { throw new Error("離線"); });
  await act(async () => { await page.refresh(); });
  assert.deepEqual(page.counts(), { nav: "0", recent: "0" });
});

test("the first load failure keeps both counts unknown", async t => {
  const page = await mount(t, async () => { throw new Error("離線"); });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /離線/));
  assert.deepEqual(page.counts(), { nav: "—", recent: "—" });
  assert.doesNotMatch(page.window.document.body.textContent || "", /最近筆記 0/);
  assert.equal(page.window.document.querySelector(".empty-state") === null, true, "failed first load must not show the empty library");
});
