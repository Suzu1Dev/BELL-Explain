import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import type { StoredLesson } from "../../shared/lesson-v3.js";
import { fillAnnotationCard } from "../copy/annotation-card.js";

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
const strings = JSON.parse(readFileSync(new URL("../copy/annotation-card-strings.json", import.meta.url), "utf8")) as Record<"zh-TW" | "en", Record<string, string>>;
const canonical06f86ffe = {
  "zh-TW": {
    cardLabel: "詞句解釋",
    closeCardAria: "關閉詞句解釋",
    analogyHeading: "換個說法",
    exampleHeading: "小例子",
    savedBadge: "已存入這篇筆記",
    removeAction: "移除",
    removeTermAria: "移除「{term}」的解釋",
    loadingMessage: "正在依這段內容準備白話解釋…",
    incompleteError: "回傳的解釋不完整，請重試。",
    explainFailedError: "無法產生解釋，請稍後重試。",
    streamInterruptedError: "解釋連線中斷，尚未確認是否儲存。請重新載入筆記後再試。",
    removeFailedError: "移除失敗，請重試。",
    retryExplainAction: "重新解釋",
    cancelAction: "取消",
  },
  en: {
    cardLabel: "Explanation",
    closeCardAria: "Close explanation",
    analogyHeading: "In other words",
    exampleHeading: "Quick example",
    savedBadge: "Saved to this note",
    removeAction: "Remove",
    removeTermAria: "Remove explanation for “{term}”",
    loadingMessage: "Preparing a plain-language explanation for this passage…",
    incompleteError: "The explanation came back incomplete. Please try again.",
    explainFailedError: "Couldn't prepare an explanation. Please try again in a moment.",
    streamInterruptedError: "Connection lost before we could confirm it saved. Please reload this note before trying again.",
    removeFailedError: "Couldn't remove. Please try again.",
    retryExplainAction: "Try again",
    cancelAction: "Cancel",
  },
};
const han = /[\u3400-\u9fff\uf900-\ufaff]/;
const baseLesson: StoredLesson = {
  format: 3,
  id: "annotation-card",
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
  annotations: [],
};
const savedLesson: StoredLesson = {
  ...baseLesson,
  annotations: [{
    id: "annotation-1",
    term: "Closure",
    explanation: "A function with its surrounding scope.",
    analogy: "A backpack for values.",
    example: "const remember = () => value;",
    sourceKey: "s1:body",
    quote: "Closure",
    createdAt: "2026-11-11T00:00:00.000Z",
  }],
};

test("annotation card matches all 14 canonical keys with locale parity and no English Han characters", () => {
  for (const locale of ["zh-TW", "en"] as const) assert.equal(Object.keys(strings[locale]).length, 14);
  assert.deepEqual(Object.keys(strings.en).sort(), Object.keys(strings["zh-TW"]).sort());
  for (const [key, value] of Object.entries(strings.en)) {
    assert.doesNotMatch(value, han, key);
    assert.deepEqual(value.match(/\{\w+\}/g) ?? [], strings["zh-TW"][key]?.match(/\{\w+\}/g) ?? [], key);
  }
  assert.deepEqual(strings, canonical06f86ffe);
});

test("annotation card interpolation preserves curly quotes, dollar patterns, and unknown placeholders", () => {
  assert.equal(fillAnnotationCard(strings.en.removeTermAria, { term: "$1" }), "Remove explanation for “$1”");
  assert.equal(fillAnnotationCard(strings["zh-TW"].removeTermAria, { term: "$&" }), "移除「$&」的解釋");
  assert.equal(fillAnnotationCard("{term} {missing}", { term: "$`" }), "$` {missing}");
});

test("annotation card uses Precise tokens, readable CJK sizes, and mobile touch targets", () => {
  const css = readFileSync(new URL("./reading-annotations.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-2])px\b/);
  assert.match(css, /\.reading-explanation-footer button \{[^}]*white-space: nowrap;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.reading-selection-toolbar button, \.reading-explanation-card button \{ min-height: 44px; \}/);
  assert.match(css, /\.reading-annotation-icon \{ min-width: 44px; \}/);
});

async function mount(t: TestContext, locale: "zh-TW" | "en", lesson: StoredLesson, fetchImpl: typeof fetch = async () => { throw "offline"; }) {
  const window = new Window({ url: `http://127.0.0.1/${locale === "en" ? "?lang=en" : ""}` });
  window.document.documentElement.lang = locale;
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
    fetch: fetchImpl,
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
  await act(async () => {
    root.render(createElement(ReadingAnnotations, {
      lesson,
      onLessonChange() {},
      children: createElement(AnnotatedText, { text: "Closure", sourceKey: "s1:body" }),
    }));
  });
  const selectTerm = async () => {
    const source = window.document.querySelector("[data-annotation-source]")!;
    const range = window.document.createRange();
    range.selectNodeContents(source);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      window.document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
  };
  const explain = async () => {
    await selectTerm();
    await act(async () => {
      (window.document.querySelector(".reading-explain-action") as unknown as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  return { window, explain };
}

for (const locale of ["zh-TW", "en"] as const) {
  test(`${locale} renders saved card and remove failure with canonical copy`, async t => {
    const page = await mount(t, locale, savedLesson);
    const document = page.window.document;
    const copy = strings[locale];
    await act(async () => { (document.querySelector(".reading-annotation-mark") as unknown as HTMLElement).click(); });
    const card = () => document.querySelector(".reading-explanation-card")!;
    assert.equal(document.querySelector(".reading-explanation-label")?.textContent?.trim(), copy.cardLabel);
    assert.equal(document.querySelector(".reading-explanation-header button")?.getAttribute("aria-label"), copy.closeCardAria);
    assert.match(document.querySelector(".reading-explanation-analogy > span")?.textContent || "", new RegExp(copy.analogyHeading));
    assert.equal(document.querySelector(".reading-explanation-example > span")?.textContent, copy.exampleHeading);
    assert.match(document.querySelector(".reading-explanation-footer > span")?.textContent || "", new RegExp(copy.savedBadge));
    const remove = document.querySelector(".reading-explanation-footer button")!;
    assert.equal(remove.getAttribute("aria-label"), fillAnnotationCard(copy.removeTermAria, { term: "Closure" }));
    assert.match(remove.textContent || "", new RegExp(copy.removeAction));
    if (locale === "en") assert.doesNotMatch(card().textContent || "", han);

    await act(async () => {
      (remove as unknown as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector(".reading-explanation-error")?.textContent, copy.removeFailedError);
    if (locale === "en") assert.doesNotMatch(card().textContent || "", han);
  });

  test(`${locale} renders loading and cancel with canonical copy`, async t => {
    const page = await mount(t, locale, baseLesson, () => new Promise<Response>(() => {}));
    const document = page.window.document;
    const copy = strings[locale];
    await page.explain();
    assert.equal(document.querySelector(".reading-explanation-status p")?.textContent, copy.loadingMessage);
    assert.equal(document.querySelector(".reading-explanation-actions button")?.textContent, copy.cancelAction);
    if (locale === "en") assert.doesNotMatch(document.querySelector(".reading-explanation-card")?.textContent || "", han);
    await act(async () => { (document.querySelector(".reading-explanation-actions button") as unknown as HTMLButtonElement).click(); });
    assert.equal(document.querySelector(".reading-explanation-card"), null);
  });

  for (const state of ["incomplete", "failed", "interrupted"] as const) {
    test(`${locale} renders ${state} explanation failure with canonical copy`, async t => {
      const copy = strings[locale];
      const expected = state === "incomplete" ? copy.incompleteError : state === "failed" ? copy.explainFailedError : copy.streamInterruptedError;
      const fetchImpl = state === "failed" ? async () => { throw "offline"; }
        : async () => new Response(state === "incomplete" ? `${JSON.stringify({ type: "complete", lesson: baseLesson })}\n` : "", { status: 200 });
      const page = await mount(t, locale, baseLesson, fetchImpl as typeof fetch);
      const document = page.window.document;
      await page.explain();
      assert.equal(document.querySelector(".reading-explanation-status p")?.textContent, expected);
      assert.equal(document.querySelector(".reading-explanation-actions button")?.textContent, copy.retryExplainAction);
      if (locale === "en") assert.doesNotMatch(document.querySelector(".reading-explanation-card")?.textContent || "", han);
    });
  }
}
