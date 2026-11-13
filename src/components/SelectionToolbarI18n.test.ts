import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import type { StoredLesson } from "../../shared/lesson-v3.js";

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

const { default: ReadingAnnotations, AnnotatedText } = await import("./ReadingAnnotations.js");
const strings = JSON.parse(readFileSync(new URL("../copy/selection-toolbar-strings.json", import.meta.url), "utf8")) as Record<"zh-TW" | "en", Record<string, string>>;
const lesson: StoredLesson = {
  format: 3,
  id: "selection-toolbar",
  title: "Closure",
  question: "Closure?",
  answer: "Closure",
  steps: [],
  followUps: [],
  source: { kind: "concept", label: "Closure", content: "Closure" },
  category: "JavaScript",
  tags: [],
  connections: [],
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  isDemo: true,
  favorite: false,
  annotations: [{
    id: "annotation-1",
    term: "Closure",
    explanation: "Explanation",
    analogy: "Analogy",
    sourceKey: "s1:body",
    quote: "Closure",
    createdAt: "2026-11-11T00:00:00.000Z",
  }],
};

test("selection toolbar has 11 matching keys and placeholders, with no CJK in English", () => {
  const zh = strings["zh-TW"];
  const en = strings.en;
  assert.equal(Object.keys(zh).length, 11);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(zh)) {
    assert.deepEqual(en[key]?.match(/\{\w+\}/g) ?? [], zh[key]?.match(/\{\w+\}/g) ?? [], key);
    assert.doesNotMatch(en[key]!, /[\u3400-\u9fff\uf900-\ufaff]/, key);
  }
  assert.equal(zh.termTriggerAria, "查看「{term}」的解釋");
  assert.equal(en.termTriggerAria, "View explanation for “{term}”");
});

test("selection toolbar wraps through 360px and keeps 44px touch targets at 760px", () => {
  const css = readFileSync(new URL("./reading-annotations.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*?\.reading-selection-toolbar \{ flex-wrap: wrap; max-width: calc\(100vw - 24px\); \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.reading-selection-toolbar button, \.reading-explanation-card button \{ min-height: 44px; \}/);
  assert.match(css, /\.reading-annotation-icon \{ min-width: 44px; \}/);
});

async function mount(t: TestContext, locale: "zh-TW" | "en") {
  const window = new Window({ url: `http://127.0.0.1/${locale === "en" ? "?lang=en" : ""}` });
  window.document.documentElement.lang = locale;
  let clipboardFails = false;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { if (clipboardFails) throw new Error("denied"); } },
  });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    ResizeObserver: window.ResizeObserver,
    Element: window.Element,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
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
  const render = async (personalAvailable: boolean) => {
    await act(async () => {
      root.render(createElement(ReadingAnnotations, {
        lesson,
        onLessonChange() {},
        personalAvailable,
        sendToPersonal() {},
        children: createElement(AnnotatedText, { text: "Closure", sourceKey: "s1:body" }),
      }));
    });
  };
  const selectTerm = async () => {
    const mark = window.document.querySelector(".reading-annotation-mark")!;
    const range = window.document.createRange();
    range.selectNodeContents(mark.firstChild!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      window.document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
  };
  await render(true);
  return { window, render, selectTerm, failClipboard: () => { clipboardFails = true; } };
}

for (const locale of ["zh-TW", "en"] as const) {
  test(`${locale} renders linked and unlinked handoff, copy feedback, and term labels`, async t => {
    const page = await mount(t, locale);
    const copy = strings[locale];
    const document = page.window.document;
    assert.equal(document.querySelector(".reading-annotation-mark")?.getAttribute("aria-label"), copy.termTriggerAria.replace("{term}", "Closure"));
    await page.selectTerm();
    const toolbar = () => document.querySelector(".reading-selection-toolbar");
    assert.equal(toolbar()?.getAttribute("aria-label"), copy.toolbarLabel);
    assert.equal(document.querySelector(".reading-explain-action")?.getAttribute("title"), copy.explainTitle);
    assert.match(document.querySelector(".reading-explain-action")?.textContent || "", new RegExp(copy.explain));
    assert.equal(document.querySelector(".reading-personal-action")?.getAttribute("title"), copy.sendToPersonalTitle);
    assert.equal((document.querySelector(".reading-personal-action") as unknown as HTMLButtonElement).disabled, false);
    assert.match(document.querySelector(".reading-personal-action")?.textContent || "", new RegExp(copy.sendToPersonal));
    assert.equal(document.querySelector(".reading-annotation-icon")?.getAttribute("aria-label"), copy.closeToolbarAria);
    assert.equal(document.querySelector(".reading-copy-action")?.textContent, copy.copy);

    await act(async () => { (document.querySelector(".reading-copy-action") as unknown as HTMLButtonElement).click(); });
    assert.equal(document.querySelector(".reading-copy-action")?.textContent, copy.copied);
    page.failClipboard();
    await act(async () => { (document.querySelector(".reading-copy-action") as unknown as HTMLButtonElement).click(); });
    assert.equal(document.querySelector(".reading-copy-action")?.textContent, copy.copyFailed);

    await page.render(false);
    await page.selectTerm();
    assert.equal(document.querySelector(".reading-personal-action")?.getAttribute("title"), copy.sendToPersonalUnlinkedTitle);
    assert.equal((document.querySelector(".reading-personal-action") as unknown as HTMLButtonElement).disabled, true);
  });
}
