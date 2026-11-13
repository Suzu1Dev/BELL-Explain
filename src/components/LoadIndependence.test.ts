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

async function mount(t: TestContext, options: { lessons: () => Promise<unknown>; config: () => Promise<unknown> }) {
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
  t.mock.method(api, "lessons", options.lessons as typeof api.lessons);
  t.mock.method(api, "config", options.config as typeof api.config);
  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }));
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
  const generate = () => window.document.querySelector(".generate-button") as unknown as HTMLButtonElement;
  const setInput = async (value = "const answer = 42;") => {
    const textarea = window.document.querySelector("textarea") as unknown as HTMLTextAreaElement;
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(textarea, value);
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  const input = () => (window.document.querySelector("textarea") as unknown as HTMLTextAreaElement).value;
  const connection = () => window.document.querySelector(".connection-status")?.textContent ?? null;
  return { window, counts, generate, setInput, input, connection, refresh: async () => { await refresh?.(); } };
}

test("lessons failure does not hide a successful config or block generation; background recovery clears its error", async t => {
  let configCalls = 0;
  const page = await mount(t, {
    lessons: async () => { throw new TypeError("Failed to fetch"); },
    config: async () => { configCalls += 1; return { configured: true, model: "test-double", storage: "SQLite" }; },
  });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（知識庫）/));
  assert.equal(page.connection(), null);
  assert.deepEqual(page.counts(), { nav: "—", recent: "—" });
  await page.setInput();
  assert.equal(page.generate().disabled, false);

  t.mock.method(api, "lessons", async () => exampleLessons.slice(0, 1));
  await act(async () => { await page.refresh(); });
  assert.deepEqual(page.counts(), { nav: "1", recent: "1" });
  assert.equal(page.window.document.querySelector(".page-error") === null, true, "recovered errors must leave the document");
  assert.equal(page.generate().disabled, false);
  assert.equal(configCalls, 1, "a healthy config is not refetched by the library poll");
});

test("config failure keeps known lessons but generation waits for an explicit successful retry", async t => {
  const page = await mount(t, {
    lessons: async () => exampleLessons.slice(0, 1),
    config: async () => { throw new TypeError("Failed to fetch"); },
  });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（設定）/));
  assert.deepEqual(page.counts(), { nav: "1", recent: "1" });
  assert.equal(page.connection(), null);
  await page.setInput();
  assert.equal(page.generate().disabled, true);

  t.mock.method(api, "config", async () => ({ configured: true, model: "test-double", storage: "SQLite" }));
  await act(async () => {
    (page.window.document.querySelector(".page-error button") as unknown as HTMLButtonElement).click();
  });
  await waitFor(() => assert.equal(page.generate().disabled, false));
  assert.equal(page.connection(), null);
});

test("both failures stay unknown and recover only after both sides succeed", async t => {
  const page = await mount(t, {
    lessons: async () => { throw new TypeError("Failed to fetch"); },
    config: async () => { throw new TypeError("Failed to fetch"); },
  });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（知識庫）.*無法連線 Explain（設定）/));
  assert.deepEqual(page.counts(), { nav: "—", recent: "—" });
  assert.equal(page.connection(), null);
  await page.setInput();
  assert.equal(page.generate().disabled, true);

  t.mock.method(api, "lessons", async () => exampleLessons.slice(0, 1));
  t.mock.method(api, "config", async () => ({ configured: true, model: "test-double", storage: "SQLite" }));
  await act(async () => {
    (page.window.document.querySelector(".page-error button") as unknown as HTMLButtonElement).click();
  });
  await waitFor(() => assert.equal(page.generate().disabled, false));
  assert.deepEqual(page.counts(), { nav: "1", recent: "1" });
});

test("a confirmed unconfigured state is the only one that shows the connection action", async t => {
  const page = await mount(t, {
    lessons: async () => [],
    config: async () => ({ configured: false, model: "", storage: "SQLite" }),
  });
  await waitFor(() => assert.equal(page.connection(), "Codex 未連接 · 設定"));
  assert.deepEqual(page.counts(), { nav: "0", recent: "0" });
  await page.setInput();
  assert.equal(page.generate().disabled, true);
});

test("background config recovery restores generation without reloading or losing input", async t => {
  let configCalls = 0;
  const page = await mount(t, {
    lessons: async () => exampleLessons.slice(0, 1),
    config: async () => { configCalls += 1; throw new TypeError("Failed to fetch"); },
  });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（設定）/));
  await page.setInput("保留這段輸入");
  assert.equal(page.generate().disabled, true);

  t.mock.method(api, "config", async () => { configCalls += 1; return { configured: true, model: "test-double", storage: "SQLite" }; });
  await act(async () => { await page.refresh(); });
  await waitFor(() => assert.equal(page.generate().disabled, false));
  assert.equal(page.window.document.querySelector(".page-error") === null, true, "recovered errors must leave the document");
  assert.equal(page.input(), "保留這段輸入");
  assert.equal(configCalls, 2);
});

test("both sides recover independently across background refreshes", async t => {
  const page = await mount(t, {
    lessons: async () => { throw new TypeError("Failed to fetch"); },
    config: async () => { throw new TypeError("Failed to fetch"); },
  });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（知識庫）.*無法連線 Explain（設定）/));
  await page.setInput("背景恢復不能清掉草稿");

  t.mock.method(api, "lessons", async () => exampleLessons.slice(0, 1));
  await act(async () => { await page.refresh(); });
  assert.deepEqual(page.counts(), { nav: "1", recent: "1" });
  assert.equal(page.generate().disabled, true);
  assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /^無法連線 Explain（設定）。/);
  assert.equal(page.input(), "背景恢復不能清掉草稿");

  t.mock.method(api, "config", async () => ({ configured: true, model: "test-double", storage: "SQLite" }));
  await act(async () => { await page.refresh(); });
  await waitFor(() => assert.equal(page.generate().disabled, false));
  assert.equal(page.window.document.querySelector(".page-error") === null, true, "recovered errors must leave the document");
  assert.equal(page.input(), "背景恢復不能清掉草稿");
});

test("continued config failure stays unknown while lessons remain available", async t => {
  let configCalls = 0;
  const page = await mount(t, {
    lessons: async () => exampleLessons.slice(0, 1),
    config: async () => { configCalls += 1; throw new TypeError("Failed to fetch"); },
  });
  await waitFor(() => assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（設定）/));
  await page.setInput();
  await act(async () => { await page.refresh(); });
  await act(async () => { await page.refresh(); });
  assert.equal(configCalls, 3);
  assert.deepEqual(page.counts(), { nav: "1", recent: "1" });
  assert.equal(page.generate().disabled, true);
  assert.equal(page.connection(), null);
  assert.match(page.window.document.querySelector(".page-error")?.textContent || "", /無法連線 Explain（設定）/);
});
