import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";

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

async function mount(t: TestContext, locale: "zh-TW" | "en", reviewSummary: typeof api.reviewSummary) {
  const window = new Window({ url: `http://127.0.0.1:21115/?lang=${locale}#/home` });
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
  t.mock.method(globalThis, "setInterval", ((callback: () => void, timeout?: number) => {
    if (timeout === 15_000) return 1;
    return 1;
  }) as typeof setInterval);
  t.mock.method(api, "lessons", async () => []);
  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }));
  t.mock.method(api, "config", async () => ({ configured: false, model: "", storage: "SQLite" }));
  t.mock.method(api, "jobs", async () => []);
  t.mock.method(api, "reviewSummary", reviewSummary);
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
  return window;
}

function button(window: Window, selector: string) {
  return window.document.querySelector(selector) as unknown as HTMLButtonElement;
}

function assertEnglishReviewCopy(window: Window) {
  for (const selector of [".sidebar-item-row", ".review-today-card"]) {
    const element = window.document.querySelector(selector);
    assert.ok(element, selector);
    const renderedCopy = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].join(" ");
    assert.doesNotMatch(renderedCopy, /[\u3400-\u9fff]/, selector);
  }
}

test("loading review copy is localized in the sidebar and home card", async t => {
  for (const item of [
    { locale: "zh-TW", nav: "複習，數量尚未確認", cardAria: "複習，正在載入數量…", label: "載入中…" },
    { locale: "en", nav: "Review, count not confirmed yet", cardAria: "Review, loading count…", label: "Loading…" },
  ] as const) {
    await t.test(item.locale, async t => {
      const window = await mount(t, item.locale, async () => new Promise<{ due: number; newAvailable: number; reviewedToday: number; total: number }>(() => {}));
      await waitFor(() => assert.equal(button(window, ".review-today-card").querySelector("strong")?.textContent, item.label));
      assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), item.nav);
      assert.equal(button(window, ".review-today-card").getAttribute("aria-label"), item.cardAria);
      if (item.locale === "en") assertEnglishReviewCopy(window);
    });
  }
});

test("ready review copy handles singular and plural counts and the due/new breakdown", async t => {
  for (const item of [
    { locale: "zh-TW", due: 1, newAvailable: 0, nav: "複習，1 張待複習", label: "1 張待複習", breakdown: "1 到期" },
    { locale: "en", due: 1, newAvailable: 0, nav: "Review, 1 card due", label: "1 card to review", breakdown: "1 due" },
    { locale: "zh-TW", due: 2, newAvailable: 3, nav: "複習，5 張待複習", label: "5 張待複習", breakdown: "2 到期 · 3 新卡" },
    { locale: "en", due: 2, newAvailable: 3, nav: "Review, 5 cards due", label: "5 cards to review", breakdown: "2 due · 3 new" },
  ] as const) {
    await t.test(`${item.locale}: ${item.label}`, async t => {
      const window = await mount(t, item.locale, async () => ({ due: item.due, newAvailable: item.newAvailable, reviewedToday: 0, total: item.due + item.newAvailable }));
      await waitFor(() => assert.equal(button(window, ".review-state-ready").querySelector("strong")?.textContent, item.label));
      assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), item.nav);
      assert.equal(button(window, ".review-state-ready").querySelector(".continue-where")?.textContent, item.breakdown);
      assert.equal(button(window, ".review-state-ready").querySelector(".continue-eyebrow")?.textContent, item.locale === "en" ? "Review" : "複習");
      if (item.locale === "en") assertEnglishReviewCopy(window);
    });
  }
});

test("a failed refresh within thirty minutes keeps localized stale copy", async t => {
  for (const item of [
    { locale: "zh-TW", libraryAria: "知識庫", learnAria: "學習", nav: "複習，2 張待複習（上次成功的數量）", title: "顯示上次成功的複習數量", label: "2 張待複習", hint: "上次成功的資料" },
    { locale: "en", libraryAria: "Library", learnAria: "Learn", nav: "Review, 2 cards due (last known count)", title: "Showing the last successful review count", label: "2 cards to review", hint: "Last known count" },
  ] as const) {
    await t.test(item.locale, async t => {
      let fail = false;
      const window = await mount(t, item.locale, async () => {
        if (fail) throw new Error("offline");
        return { due: 1, newAvailable: 1, reviewedToday: 0, total: 2 };
      });
      await waitFor(() => assert.equal(button(window, ".review-state-ready").querySelector("strong")?.textContent, item.label));
      fail = true;
      await act(async () => { button(window, `button[aria-label="${item.libraryAria}"]`).click(); });
      await waitFor(() => assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("title"), item.title));
      assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), item.nav);
      await act(async () => { button(window, `button[aria-label="${item.learnAria}"]`).click(); });
      await waitFor(() => assert.equal(button(window, ".review-state-stale").querySelector(".continue-where")?.textContent, item.hint));
      assert.equal(button(window, ".review-state-stale").querySelector("strong")?.textContent, item.label);
      if (item.locale === "en") assertEnglishReviewCopy(window);
    });
  }
});

test("a failed refresh after thirty minutes replaces stale copy with the localized error", async t => {
  for (const item of [
    { locale: "zh-TW", libraryAria: "知識庫", learnAria: "學習", nav: "複習，無法讀取數量", label: "無法讀取複習數量" },
    { locale: "en", libraryAria: "Library", learnAria: "Learn", nav: "Review, couldn't load count", label: "Couldn't load reviews" },
  ] as const) {
    await t.test(item.locale, async t => {
      let now = 1_000;
      let fail = false;
      t.mock.method(Date, "now", () => now);
      const window = await mount(t, item.locale, async () => {
        if (fail) throw new Error("offline");
        return { due: 1, newAvailable: 0, reviewedToday: 0, total: 1 };
      });
      await waitFor(() => assert.ok(window.document.querySelector(".review-state-ready")));
      now += 30 * 60 * 1000 + 1;
      fail = true;
      await act(async () => { button(window, `button[aria-label="${item.libraryAria}"]`).click(); });
      await waitFor(() => assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), item.nav));
      await act(async () => { button(window, `button[aria-label="${item.learnAria}"]`).click(); });
      await waitFor(() => assert.equal(button(window, ".review-state-error").querySelector("strong")?.textContent, item.label));
      if (item.locale === "en") assertEnglishReviewCopy(window);
    });
  }
});

test("expanded and collapsed sidebar error links direct learners to Review instead of retrying", async t => {
  for (const item of [
    { locale: "zh-TW", collapseAria: "收合側邊欄", linkTitle: "複習數量讀取失敗，點進頁面重試", retryTitle: "複習數量讀取失敗，點選即可重試", retryAria: "重新載入複習數量" },
    { locale: "en", collapseAria: "Collapse sidebar", linkTitle: "Couldn't load the review count. Open Review to try again.", retryTitle: "Couldn't load review count. Select to try again.", retryAria: "Reload review count" },
  ] as const) {
    await t.test(item.locale, async t => {
      const window = await mount(t, item.locale, async () => { throw new Error("offline"); });
      const assertSidebarTitles = () => {
        assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("title"), item.linkTitle);
        assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("title"), item.retryTitle);
        assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("aria-label"), item.retryAria);
      };
      await waitFor(assertSidebarTitles);
      await act(async () => { button(window, `button[aria-label="${item.collapseAria}"]`).click(); });
      await waitFor(assertSidebarTitles);
      if (item.locale === "en") assertEnglishReviewCopy(window);
    });
  }
});

test("a failed summary shows unknown counts and retries without masking the error", async t => {
  const window = await mount(t, "zh-TW", async () => { throw new Error("offline"); });
  await waitFor(() => assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), "複習，無法讀取數量"));
  const card = () => button(window, ".review-today-card");
  assert.equal(card().getAttribute("aria-label"), "複習數量讀取失敗，點選即可重試");
  assert.equal(card().querySelector(".nav-count-unknown")?.textContent, "—");
  assert.equal(card().querySelector("strong")?.textContent, "無法讀取複習數量");
  assert.equal(card().querySelector(".continue-where")?.textContent, "重試");
  assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("title"), "複習數量讀取失敗，點選即可重試");

  let resolveRetry!: (value: { due: number; newAvailable: number; reviewedToday: number; total: number }) => void;
  t.mock.method(api, "reviewSummary", () => new Promise(resolve => { resolveRetry = resolve; }));
  await act(async () => { button(window, ".sidebar-retry").click(); });
  assert.equal(card().getAttribute("aria-label"), null);
  assert.equal(card().querySelector(".continue-where")?.textContent, "重試中…");
  assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("aria-label"), "正在重新載入複習數量…");

  await act(async () => { resolveRetry({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }); });
  await waitFor(() => assert.equal(window.document.querySelector(".review-today-card"), null));
  assert.equal(window.document.querySelector(".sidebar-retry"), null);
});

test("English failure copy is used by the sidebar and home retry card", async t => {
  const window = await mount(t, "en", async () => { throw new Error("offline"); });
  await waitFor(() => assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), "Review, couldn't load count"));
  const card = button(window, ".review-today-card");
  assert.equal(card.getAttribute("aria-label"), "Couldn't load review count. Select to try again.");
  assert.equal(card.querySelector("strong")?.textContent, "Couldn't load reviews");
  assert.equal(card.querySelector(".continue-where")?.textContent, "Try again");
  assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("aria-label"), "Reload review count");

  let resolveRetry!: (value: { due: number; newAvailable: number; reviewedToday: number; total: number }) => void;
  t.mock.method(api, "reviewSummary", () => new Promise(resolve => { resolveRetry = resolve; }));
  await act(async () => { card.click(); });
  assert.equal(card.getAttribute("aria-label"), null);
  assert.equal(card.querySelector(".continue-where")?.textContent, "Trying again…");
  assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("aria-label"), "Reloading review count…");

  await act(async () => { resolveRetry({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }); });
  await waitFor(() => assert.equal(window.document.querySelector(".review-today-card"), null));
});

test("the home card retries and renders a recovered positive count", async t => {
  const window = await mount(t, "zh-TW", async () => { throw new Error("offline"); });
  await waitFor(() => assert.equal(button(window, ".review-today-card").querySelector("strong")?.textContent, "無法讀取複習數量"));
  t.mock.method(api, "reviewSummary", async () => ({ due: 2, newAvailable: 0, reviewedToday: 0, total: 2 }));
  await act(async () => { button(window, ".review-today-card").click(); });
  await waitFor(() => assert.equal(window.document.querySelector(".review-state-ready strong")?.textContent, "2 張待複習"));
  assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), "複習，2 張待複習");
});

test("a stale zero summary does not render a zero-count home card", async t => {
  let fail = false;
  const window = await mount(t, "zh-TW", async () => {
    if (fail) throw new Error("offline");
    return { due: 0, newAvailable: 0, reviewedToday: 0, total: 0 };
  });
  await waitFor(() => assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), "複習，目前沒有待複習卡片"));
  fail = true;
  await act(async () => { button(window, 'button[aria-label="知識庫"]').click(); });
  await waitFor(() => assert.equal(window.document.querySelector('a[href="#/review"]')?.getAttribute("aria-label"), "複習，0 張待複習（上次成功的數量）"));
  await act(async () => { button(window, 'button[aria-label="學習"]').click(); });
  await waitFor(() => assert.equal(window.document.querySelector(".review-state-stale"), null));
  assert.equal(window.document.querySelector(".sidebar-retry")?.getAttribute("aria-label"), "重新載入複習數量");
});
