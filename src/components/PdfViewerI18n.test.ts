import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";

const pdfjsSource = `
export const GlobalWorkerOptions = {};
export const PasswordResponses = { INCORRECT_PASSWORD: 2 };
export class TextLayer { async render() {} cancel() {} }
export function getDocument(options) { return globalThis.__pdfViewerGetDocument(options); }
`;
const pdfjsUrl = `data:text/javascript,${encodeURIComponent(pdfjsSource)}`;
const workerUrl = `data:text/javascript,${encodeURIComponent('export default "mock-worker";')}`;
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 23)) {
  registerHooks({
    resolve(url, context, next) {
      if (url === "pdfjs-dist") return { url: pdfjsUrl, shortCircuit: true };
      if (url.startsWith("pdfjs-dist/build/pdf.worker.min.mjs")) return { url: workerUrl, shortCircuit: true };
      return next(url, context);
    },
    load(url, context, next) {
      if (/\.css(\?|$)/.test(url)) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    },
  });
} else {
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(url, context, next) {
      if (url === "pdfjs-dist") return { url: ${JSON.stringify(pdfjsUrl)}, shortCircuit: true };
      if (url.startsWith("pdfjs-dist/build/pdf.worker.min.mjs")) return { url: ${JSON.stringify(workerUrl)}, shortCircuit: true };
      return next(url, context);
    }
    export async function load(url, context, next) {
      if (/\\.css(\\?|$)/.test(url)) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    }
  `)}`);
}

const { default: PdfViewer } = await import("./PdfViewer.js");

const canonicalZhTw = {
  toolbarAria: "PDF 檢視工具",
  prevPage: "上一頁",
  currentPageAria: "目前頁碼",
  nextPage: "下一頁",
  zoomOut: "縮小",
  fitWidth: "符合寬度",
  zoomIn: "放大",
  downloadOriginal: "下載原始 PDF",
  documentAria: "PDF 原文：{fileName}",
  pageAria: "第 {page} 頁",
  loading: "正在開啟 PDF…",
  passwordTitle: "這份 PDF 有密碼保護",
  passwordRetryTitle: "密碼不正確，請再試一次",
  passwordPrivacyHint: "密碼只在這個瀏覽器中用來開啟檔案，不會傳到伺服器或儲存。",
  passwordInputAria: "PDF 密碼",
  unlockAction: "開啟",
  missingTitle: "這台伺服器沒有原始 PDF",
  missingBody: "筆記可能來自另一個裝置的同步。解說與擷取文字仍可閱讀；原檔保存在上傳時的伺服器。",
  errorTitle: "無法開啟 PDF",
  errorBody: "檔案可能已損毀或格式不受支援。",
  reopenAction: "重新開啟",
};
const strings = JSON.parse(readFileSync(new URL("../copy/pdf-viewer-strings.json", import.meta.url), "utf8")) as {
  "zh-TW": { pdfViewer: typeof canonicalZhTw };
  en: { pdfViewer: Record<keyof typeof canonicalZhTw, string> };
};
const nativeSetTimeout = globalThis.setTimeout;
type PasswordHandler = (submit: (password: string) => void, reason: number) => void;

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function mount(t: TestContext, locale: "zh-TW" | "en", task: unknown | (() => unknown)) {
  const window = new Window({ url: `http://127.0.0.1/?lang=${locale}` });
  window.document.documentElement.lang = locale;
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true }), configurable: true });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    ResizeObserver: Observer,
    IntersectionObserver: Observer,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    __pdfViewerGetDocument: () => typeof task === "function" ? task() : task,
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const container = window.document.body.appendChild(window.document.createElement("div"));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await window.happyDOM.close();
  });
  await act(async () => {
    root.render(createElement(PdfViewer, { documentId: "doc", fileName: "lesson.pdf" }));
  });
  return window.document as unknown as Document;
}

async function waitFor(check: () => void) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => { await new Promise(resolve => nativeSetTimeout(resolve, 10)); });
    }
  }
}

function byAria(document: Document, label: string) {
  const element = [...document.querySelectorAll("[aria-label]")].find(item => item.getAttribute("aria-label") === label);
  assert.ok(element, `Missing aria-label: ${label}`);
  return element;
}

function assertDecorativeSvgs(document: Document) {
  const icons = [...document.querySelectorAll("svg")];
  assert.ok(icons.length > 0);
  for (const icon of icons) assert.equal(icon.getAttribute("aria-hidden"), "true");
}

function readyTask() {
  return {
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }) }),
    }),
    async destroy() {},
  };
}

function pendingTask() {
  return { promise: new Promise(() => {}), async destroy() {} };
}

test("all 21 PDF viewer keys have locale parity and English contains no CJK", () => {
  const zh = strings["zh-TW"].pdfViewer;
  const en = strings.en.pdfViewer;
  assert.equal(Object.keys(zh).length, 21);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [key, value] of Object.entries(en)) assert.doesNotMatch(value, /[\u3400-\u9fff\uf900-\ufaff]/, key);
});

test("zh-TW PDF viewer copy is preserved byte-for-byte", () => {
  assert.deepEqual(strings["zh-TW"].pdfViewer, canonicalZhTw);
});

test("PDF viewer styles use semantic tokens and compact responsive toolbar rules", () => {
  const css = readFileSync(new URL("./pdf-viewer.css", import.meta.url), "utf8");
  for (const token of ["--chrome", "--raised", "--raised-2", "--panel", "--line", "--line-2", "--text", "--text-2", "--text-3", "--explain", "--explain-text", "--explain-on", "--focus", "--text-ui", "--lh-ui", "--text-body", "--lh-body", "--text-micro", "--font-mono"]) {
    assert.match(css, new RegExp(`var\\(${token}(?:,|\\))`), token);
  }
  assert.doesNotMatch(css, /#(?:263449|56647b|7d889a|375be9|5273e9|d7deea)\b/i);
  assert.doesNotMatch(css, /font-size:(?:10|11|12)px/);
  assert.match(css, /\.pdf-viewer\{container-type:inline-size/);
  assert.match(css, /@container \(max-width: 370px\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /\.pdf-zoom > span\{display:none\}/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /min-height:var\(--row-touch,44px\)/);
  assert.match(css, /\.pdf-password input\{font-size:16px\}/);
});

for (const locale of ["zh-TW", "en"] as const) {
  test(`${locale} renders toolbar controls and document/page landmarks`, async t => {
    const copy = strings[locale].pdfViewer;
    const document = await mount(t, locale, readyTask());
    await waitFor(() => assert.ok(document.querySelector(".pdf-page")));
    assert.equal(document.querySelector(".pdf-toolbar")?.getAttribute("aria-label"), copy.toolbarAria);
    for (const label of [copy.prevPage, copy.nextPage, copy.zoomOut, copy.zoomIn, copy.downloadOriginal]) {
      assert.equal(byAria(document, label).getAttribute("title"), label);
    }
    for (const button of document.querySelectorAll(".pdf-toolbar button")) assert.equal(button.getAttribute("type"), "button");
    const pageInput = byAria(document, copy.currentPageAria);
    const pagesId = pageInput.getAttribute("aria-describedby");
    assert.ok(pagesId);
    assert.equal(document.getElementById(pagesId)?.textContent, "/ 1");
    assert.equal(document.querySelector(".pdf-zoom")?.textContent, copy.fitWidth);
    assert.equal(document.querySelector(".pdf-zoom > span")?.textContent, copy.fitWidth);
    assert.equal(document.querySelector(".pdf-zoom")?.getAttribute("aria-label"), copy.fitWidth);
    assert.equal(document.querySelector(".pdf-zoom")?.getAttribute("title"), copy.fitWidth);
    assert.equal(document.querySelector(".pdf-scroller")?.getAttribute("aria-label"), copy.documentAria.replace("{fileName}", "lesson.pdf"));
    assert.equal(document.querySelector(".pdf-page")?.getAttribute("aria-label"), copy.pageAria.replace("{page}", "1"));
    await act(async () => (byAria(document, copy.zoomIn) as HTMLButtonElement).click());
    assert.equal(document.querySelector(".pdf-zoom")?.getAttribute("aria-label"), `125% · ${copy.fitWidth}`);
    assertDecorativeSvgs(document);
  });

  test(`${locale} renders loading copy`, async t => {
    const copy = strings[locale].pdfViewer;
    const document = await mount(t, locale, pendingTask());
    assert.equal(document.querySelector(".pdf-state")?.textContent, copy.loading);
    assert.equal(document.querySelector(".pdf-state")?.getAttribute("role"), "status");
    assertDecorativeSvgs(document);
  });

  test(`${locale} renders initial and retry password states`, async t => {
    const copy = strings[locale].pdfViewer;
    const requests: PasswordHandler[] = [];
    const task = {
      promise: new Promise(() => {}),
      set onPassword(handler: PasswordHandler) { requests.push(handler); },
      async destroy() {},
    };
    const document = await mount(t, locale, task);
    await waitFor(() => assert.equal(requests.length, 1));
    await act(async () => requests[0](() => {}, 1));
    assert.equal(document.querySelector(".pdf-password strong")?.textContent, copy.passwordTitle);
    assert.equal(document.querySelector(".pdf-password strong")?.getAttribute("role"), null);
    assert.equal(document.querySelector(".pdf-password span")?.textContent, copy.passwordPrivacyHint);
    assert.equal(byAria(document, copy.passwordInputAria).getAttribute("aria-invalid"), null);
    assert.equal(document.querySelector(".document-choose")?.textContent, copy.unlockAction);
    assert.equal(document.querySelector(".document-choose")?.getAttribute("type"), "submit");
    assertDecorativeSvgs(document);
    await act(async () => requests[0](() => {}, 2));
    assert.equal(document.querySelector(".pdf-password strong")?.textContent, copy.passwordRetryTitle);
    assert.equal(document.querySelector(".pdf-password strong")?.getAttribute("role"), "alert");
    assert.equal(byAria(document, copy.passwordInputAria).getAttribute("aria-invalid"), "true");
    assertDecorativeSvgs(document);
  });

  test(`${locale} renders missing-PDF copy`, async t => {
    const copy = strings[locale].pdfViewer;
    const document = await mount(t, locale, () => ({ promise: Promise.reject({ status: 404 }), async destroy() {} }));
    await waitFor(() => assert.equal(document.querySelector(".pdf-state strong")?.textContent, copy.missingTitle));
    assert.equal(document.querySelector(".pdf-state")?.getAttribute("role"), "status");
    assert.equal(document.querySelector(".pdf-state span")?.textContent, copy.missingBody);
    assertDecorativeSvgs(document);
  });

  test(`${locale} renders open-error copy and reopen action`, async t => {
    const copy = strings[locale].pdfViewer;
    const document = await mount(t, locale, () => ({ promise: Promise.reject({ status: 500 }), async destroy() {} }));
    await waitFor(() => assert.equal(document.querySelector(".pdf-state strong")?.textContent, copy.errorTitle));
    assert.equal(document.querySelector(".pdf-state")?.getAttribute("role"), "alert");
    assert.equal(document.querySelector(".pdf-state span")?.textContent, copy.errorBody);
    assert.equal(document.querySelector(".text-button")?.textContent, copy.reopenAction);
    assert.equal(document.querySelector(".text-button")?.getAttribute("type"), "button");
    assertDecorativeSvgs(document);
  });
}
