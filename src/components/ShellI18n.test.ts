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

async function mount(t: TestContext, locale: "en" | "zh-TW") {
  const window = new Window({ url: `http://127.0.0.1:21115/${locale === "en" ? "?lang=en" : ""}#/home` });
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
  t.mock.method(globalThis, "setInterval", ((callback: () => void, timeout?: number) => 1) as typeof setInterval);
  t.mock.method(api, "lessons", async () => [{ ...exampleLessons[0], category: "JavaScript", favorite: true }]);
  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "Learn", links: {} }));
  t.mock.method(api, "config", async () => ({ configured: false, model: "", storage: "SQLite" }));
  t.mock.method(api, "jobs", async () => []);
  t.mock.method(api, "reviewSummary", async () => ({ due: 1, newAvailable: 0, reviewedToday: 0, total: 1 }));
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
  await waitFor(() => assert.ok(window.document.querySelector(".connection-status")));
  return window;
}

test("English mode localizes the complete shell, document metadata, and singular counts", async t => {
  const window = await mount(t, "en");
  const document = window.document;
  assert.equal(document.documentElement.lang, "en");
  assert.equal(document.title, "BELL Explain — Make understanding happen");
  assert.deepEqual([...document.querySelectorAll(".sidebar .nav-item .nav-label")].map(element => element.textContent), ["Learn", "Review", "Library", "Repo Index", "Knowledge Map", "Saved"]);
  assert.equal(document.querySelector(".connection-status")?.textContent, "AI not connected · Settings");
  assert.equal(document.querySelector('.nav-item[aria-label="Review, 1 card due"]') !== null, true);
  assert.equal(document.querySelector('.nav-item[aria-label="Library"]')?.getAttribute("title"), "Library · 1 note");
  assert.equal(document.querySelector('.nav-item[aria-label="Saved"]')?.getAttribute("title"), "Saved · 1 note");
  assert.equal(document.querySelector(".home-intro .eyebrow")?.textContent?.trim(), "A LITTLE CURIOSITY, A LOT OF POSSIBILITY");
  assert.equal(document.querySelector(".home-intro .underlined-word")?.textContent, "an answer that clicks");
  assert.doesNotMatch(document.querySelector(".home-intro")?.textContent || "", /[㐀-鿿]/);
  assert.equal(document.querySelectorAll(".home-intro .intro-art .art-node").length, 3);
  for (const shell of document.querySelectorAll(".sidebar, .topbar")) {
    assert.doesNotMatch(shell.textContent || "", /[㐀-鿿]/);
    for (const element of [shell, ...shell.querySelectorAll("[aria-label], [title], [placeholder]")]) {
      for (const attribute of ["aria-label", "title", "placeholder"]) {
        assert.doesNotMatch(element.getAttribute(attribute) || "", /[㐀-鿿]/);
      }
    }
  }
  await act(async () => { (document.querySelector(".mobile-menu") as unknown as HTMLButtonElement).click(); });
  assert.equal(document.querySelector(".nav-scrim")?.getAttribute("aria-label"), "Close navigation");
});

test("zh-TW keeps the existing shell copy and document metadata", async t => {
  const window = await mount(t, "zh-TW");
  const document = window.document;
  assert.equal(document.documentElement.lang, "zh-Hant");
  assert.equal(document.title, "BELL Explain — 讓理解發生");
  assert.deepEqual([...document.querySelectorAll(".sidebar .nav-item .nav-label")].map(element => element.textContent), ["學習", "複習", "知識庫", "Repo 索引", "知識圖譜", "收藏"]);
  assert.equal(document.querySelector(".connection-status")?.textContent, "Codex 未連接 · 設定");
  assert.equal(document.querySelector('.nav-item[aria-label="複習，1 張待複習"]') !== null, true);
  assert.equal(document.querySelector('.nav-item[aria-label="知識庫"]')?.getAttribute("title"), "知識庫 · 1 篇筆記");
  assert.equal(document.querySelector('.nav-item[aria-label="收藏"]')?.getAttribute("title"), "收藏 · 1 篇筆記");
  assert.equal(document.querySelector(".home-intro .eyebrow")?.textContent?.trim(), "A LITTLE CURIOSITY, A LOT OF POSSIBILITY");
  assert.equal(document.querySelector(".home-intro h1")?.textContent, "讓每一個「為什麼」，都有看得懂的答案。");
  assert.equal(document.querySelector(".home-intro p")?.textContent, "貼上程式碼、文章，或上傳一份文件。從第一次理解，到下一次想起。");
  assert.equal(document.querySelectorAll(".home-intro .intro-art .art-node").length, 3);
  assert.equal(document.querySelector(".suite-grid-icon"), null);
  assert.equal(document.querySelector(".suite-switcher-trigger"), null);
  const brandButton = document.querySelector(".suite-sidebar-brand .suite-workspace-button");
  assert.equal(brandButton?.textContent, "BELL Explain");
  assert.equal(brandButton?.getAttribute("aria-label"), "切換 BELL 產品");
  assert.equal(document.querySelector(".topbar-title .suite-switcher-mobile")?.getAttribute("aria-label"), "切換 BELL 產品");
});
