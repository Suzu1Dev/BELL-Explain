import test from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { EXPLAIN_HANDOFF_KEY, type SuiteManifest } from "../lib/suite.js";

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

test("Explain waits for its linked source and replaces an old draft on every handoff URL", async t => {
  const window = new Window({ url: "http://127.0.0.1:21115/#/explain?text=%E8%88%8A%E8%8D%89%E7%A8%BF&title=%E8%88%8A%E6%A8%99%E9%A1%8C&from=personal&back=%23%2Ftoday" });
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

  let resolveManifest!: (value: SuiteManifest) => void;
  const manifest = new Promise<SuiteManifest>(resolve => { resolveManifest = resolve; });
  t.mock.method(api, "suiteManifest", () => manifest);
  t.mock.method(api, "lessons", async () => []);
  t.mock.method(api, "config", async () => ({ configured: false, model: "", storage: "SQLite" }));
  t.mock.method(api, "jobs", async () => []);
  t.mock.method(api, "reviewSummary", async () => ({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }));
  let generateCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    generateCalls++;
    return new Response(null, { status: 500 });
  });

  await act(async () => { root.render(createElement(App)); });
  const chip = window.document.querySelector(".suite-source-chip");
  assert.equal(chip?.textContent, "正在確認交接來源…");
  assert.equal(window.document.querySelector(".suite-back-link") === null, true, "unexpected Suite back link");

  await act(async () => {
    resolveManifest({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: { personal: "http://127.0.0.1:21103" } });
    await manifest;
  });
  const draft = () => window.document.querySelector('textarea[aria-label="編輯交接草稿"]') as unknown as HTMLTextAreaElement | null;
  assert.equal(draft()?.getAttribute("dir"), "auto");
  assert.equal(draft()?.value, "舊草稿");
  assert.equal(window.document.querySelector(".suite-source-chip")?.textContent, "來自 BELL Personal「舊標題」");
  assert.equal(window.document.querySelector(".suite-back-link")?.getAttribute("href"), "http://127.0.0.1:21103/#/today");
  assert.equal(JSON.parse(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY) || "null")?.text, "舊草稿");

  await act(async () => {
    window.location.hash = "#/explain?text=a&text=b&from=personal";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(window.location.hash, "#/explain");
  assert.equal(draft()?.value, "");
  assert.equal(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY), null);
  assert.equal(window.document.querySelector(".suite-back-link") === null, true, "unexpected Suite back link");
  await waitFor(() => assert.match(window.document.querySelector(".suite-source-banner [role=\"alert\"]")?.textContent || "", /重複欄位/, window.document.querySelector(".suite-source-banner")?.outerHTML));
  assert.doesNotMatch(window.document.body.textContent || "", /設定 AI 服務/);

  await act(async () => {
    window.location.hash = "#/explain?text=%E8%88%8A%E8%8D%89%E7%A8%BF&from=personal&back=%23%2Ftoday";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(draft()?.value, "舊草稿");
  assert.equal(JSON.parse(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY) || "null")?.text, "舊草稿");

  await act(async () => {
    window.location.hash = "#/explain?from=personal&back=%23%2Ftasks";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(draft()?.value, "");
  assert.equal(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY), null);
  assert.equal(window.document.querySelector(".suite-back-link") === null, true, "unexpected Suite back link");
  assert.equal(window.document.querySelector(".suite-source-chip")?.textContent, "BELL Explain");
  await waitFor(() => assert.match(window.document.querySelector('.suite-source-error')?.textContent || "", /沒有草稿文字/));
  const closeError = window.document.querySelector('button[aria-label="關閉交接錯誤提示"]') as unknown as HTMLButtonElement;
  assert.ok(closeError);
  await act(async () => { closeError.click(); });
  assert.equal(window.document.querySelector('.suite-source-error') === null, true, "dismissed handoff error must leave the document");
  assert.equal(window.document.activeElement === window.document.querySelector("textarea"), true, "dismiss must restore focus to the handoff editor");
  assert.equal(draft()?.value, "");
  assert.equal(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY), null);
  assert.equal(generateCalls, 0);

  await act(async () => {
    window.location.hash = "#/explain?text=%E8%88%8A%E8%8D%89%E7%A8%BF&from=personal";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(draft()?.value, "舊草稿");

  await act(async () => {
    window.location.hash = "#/explain?from=personal&from=pr";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(draft()?.value, "");
  assert.equal(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY), null);
  await waitFor(() => assert.match(window.document.querySelector('.suite-source-error')?.textContent || "", /重複欄位/));

  await act(async () => {
    window.location.hash = "#/explain?text=%E8%88%8A%E8%8D%89%E7%A8%BF&from=personal";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(draft()?.value, "舊草稿");

  await act(async () => {
    window.location.hash = "#/explain";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(draft()?.value, "舊草稿");
  assert.equal(JSON.parse(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY) || "null")?.text, "舊草稿");

  await act(async () => {
    window.location.hash = "#/note/missing/section?from=personal";
    window.dispatchEvent(new window.HashChangeEvent("hashchange"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY) !== null, true);
  assert.equal(JSON.parse(window.sessionStorage.getItem(EXPLAIN_HANDOFF_KEY) || "null")?.text, "舊草稿");
});

test("generation is single-flight across clicks and shortcuts, with retries after cancellation and failure", async t => {
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

  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }));
  t.mock.method(api, "lessons", async () => []);
  t.mock.method(api, "config", async () => ({ configured: true, model: "test-double", storage: "SQLite" }));
  t.mock.method(api, "jobs", async () => []);
  t.mock.method(api, "reviewSummary", async () => ({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }));

  const pending: Array<{ resolve: (response: Response) => void; stream?: ReadableStreamDefaultController<Uint8Array> }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/generate");
    assert.equal(init?.method, "POST");
    return new Promise<Response>(resolve => { pending.push({ resolve }); });
  });
  const encoder = new TextEncoder();
  const start = (index: number) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      pending[index].stream = controller;
      controller.enqueue(encoder.encode(`{"type":"job","id":"job-${index + 1}"}\n`));
    } });
    pending[index].resolve(new Response(stream, { status: 200 }));
  };
  const fail = (index: number, message: string) => {
    const stream = pending[index].stream;
    assert.ok(stream);
    stream.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message })}\n`));
    stream.close();
  };
  t.mock.method(api, "cancelJob", async () => { fail(0, "已取消"); });

  await act(async () => { root.render(createElement(App)); });
  const textarea = window.document.querySelector("textarea") as unknown as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea, "const answer = 42;");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  const generateButton = () => window.document.querySelector(".generate-button") as unknown as HTMLButtonElement;
  await act(async () => {
    generateButton().click();
    generateButton().click();
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }) as unknown as Event);
    generateButton().click();
  });
  assert.equal(pending.length, 1);
  await act(async () => { start(0); });
  assert.equal(window.document.querySelector(".generation-title button")?.textContent, "取消");

  await act(async () => {
    (window.document.querySelector(".generation-title button") as unknown as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(generateButton().disabled, false);

  await act(async () => { generateButton().click(); });
  assert.equal(pending.length, 2);
  await act(async () => {
    start(1);
    fail(1, "測試失敗");
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(generateButton().disabled, false);
  assert.match(window.document.querySelector(".generation-error")?.textContent || "", /測試失敗/);

  await act(async () => { generateButton().click(); });
  assert.equal(pending.length, 3);
  await act(async () => {
    start(2);
    fail(2, "測試結束");
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(generateButton().disabled, false);
});
