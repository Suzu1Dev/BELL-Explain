import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import type { ReviewCardView } from "../../shared/learning";
import { findMath } from "../../shared/math";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
} else {
  register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`);
}

const { default: MathText, loadMath } = await import("./MathText.js");
const { default: ReviewSession } = await import("./ReviewSession.js");
const { default: Recall } = await import("./learning/Recall.js");

const card: ReviewCardView = {
  id: "recall:lesson:s1", lessonId: "lesson", lessonTitle: "Closure", category: "JavaScript", kind: "recall", sectionId: "s1", step: 1,
  prompt: "What does `count` return?", hints: ["Think about the closure."], answer: "3. Every call updates the same `count`.", isNew: true,
  intervals: { 1: 60000, 2: 600000, 3: 86400000, 4: 259200000 },
};

async function mount(t: TestContext, locale = "zh-TW", cardValue: ReviewCardView | ReviewCardView[] | null = card, options: { fetch?: typeof fetch; remaining?: number } = {}) {
  const window = new Window({ url: `http://127.0.0.1/?lang=${locale}` });
  Object.defineProperty(window.document, "compatMode", { value: "CSS1Compat", configurable: true });
  const globals: Record<string, unknown> = { window, document: window.document, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = options.fetch ?? (async (input: RequestInfo | URL, init?: RequestInit) => {
    const cards = Array.isArray(cardValue) ? cardValue : cardValue ? [cardValue] : [];
    const body = String(input).includes("/review/summary")
      ? { due: options.remaining ?? 2, newAvailable: 0, reviewedToday: cards.length, total: cards.length }
      : init?.method === "POST" ? { due: "2026-11-10T00:10:00.000Z" } : cards;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true }), configurable: true });
  const scroller = window.document.createElement("div");
  scroller.className = "workspace-content";
  const container = window.document.createElement("div");
  scroller.appendChild(container);
  window.document.body.appendChild(scroller);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
    await window.happyDOM.close();
  });
  return { window, root, scroller: scroller as unknown as HTMLElement };
}

test("revealing at 360px focuses and scrolls the answer above the full sticky ratings height", async t => {
  const { window, root, scroller } = await mount(t);
  const scrolls: ScrollIntoViewOptions[] = [];
  window.HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) { if (options) scrolls.push(options); };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.classList.contains("review-ratings") ? 128 : 0; } });
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {}, personalAvailable: false, sendToPersonal() {} })); });
  const reveal = window.document.querySelector(".review-reveal") as unknown as HTMLButtonElement;
  assert.ok(reveal);
  await act(async () => { reveal.click(); });
  assert.equal(window.document.activeElement?.className, "rc-answer");
  assert.deepEqual(scrolls, [{ block: "nearest" }]);
  assert.equal(scroller.style.scrollPaddingBottom, "128px");
});

test("a rated recall can hide its answer with the final bilingual control", async t => {
  const { window, root } = await mount(t);
  const step = { id: "s1", lead: "Closure", body: "A function keeps its scope.", recall: { question: "What is shared?", answer: "The scope. Every call uses it." } };
  const state = { stepId: "s1", rating: "remembered" as const, status: "demo" as const, ratedAt: "2026-11-10T00:00:00.000Z" };
  await act(async () => { root.render(createElement(Recall, { lessonId: "lesson", step, state, loading: false, onRated() {} })); });
  const toggle = window.document.querySelector(".v3-recall-reread") as unknown as HTMLButtonElement;
  assert.equal(toggle.textContent, "顯示答案");
  await act(async () => { toggle.click(); });
  assert.equal(toggle.textContent, "收起答案");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(Boolean(window.document.querySelector(".v3-recall-a")));
  await act(async () => { toggle.click(); });
  assert.equal(toggle.textContent, "顯示答案");
  assert.equal(window.document.querySelector(".v3-recall-a") === null, true);
});

for (const [locale, expected] of Object.entries({
  en: {
    kind: "Section", badge: "New", prompt: "What is this section about?", hint: "Hint", reveal: "Show answer Space",
    actions: ["Jump to this section", "Send to Personal"], gradesAria: "Rate your recall",
    gradeHints: ["Didn't remember", "Took some effort", "Remembered", "Instant recall"], intervals: ["in 1 min", "in 10 min", "in 1 day", "in 3 days"],
  },
  "zh-TW": {
    kind: "段落回想", badge: "新卡", prompt: "這一段在講什麼？", hint: "提示", reveal: "顯示答案 Space",
    actions: ["回到筆記這一段", "送到 Personal"], gradesAria: "評分",
    gradeHints: ["想不起來", "想了一下才想起", "想起來了", "一看就會"], intervals: ["1 分鐘後", "10 分鐘後", "1 天後", "3 天後"],
  },
})) test(`legacy review localizes its interface for ${locale}`, async t => {
  const { window, root } = await mount(t, locale, { ...card, kind: "section" });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {}, personalAvailable: false, sendToPersonal() {} })); });
  assert.equal(window.document.querySelector(".review-kind")?.textContent, expected.kind);
  assert.equal(window.document.querySelector(".review-new")?.textContent, expected.badge);
  assert.equal(window.document.querySelector(".review-prompt")?.textContent, expected.prompt);
  assert.equal(window.document.querySelector(".review-hint-button")?.textContent, expected.hint);
  const reveal = window.document.querySelector(".review-reveal") as unknown as HTMLButtonElement;
  assert.equal(reveal.textContent, expected.reveal);
  await act(async () => { reveal.click(); });
  assert.deepEqual([...window.document.querySelectorAll(".review-open")].map(element => element.textContent), expected.actions);
  assert.equal(window.document.querySelector(".review-ratings")?.getAttribute("aria-label"), expected.gradesAria);
  assert.deepEqual([...window.document.querySelectorAll(".review-rating")].map(element => element.getAttribute("title")), expected.gradeHints);
  assert.deepEqual([...window.document.querySelectorAll(".review-rating small")].map(element => element.textContent), expected.intervals);
  if (locale === "en") assert.doesNotMatch(window.document.body.textContent || "", /\p{Script=Han}/u);
});

for (const [locale, term, expectedKind, expectedPrompt] of [
  ["en", "closure", "Fill in", "What does “closure” mean here?"],
  ["zh-TW", "閉包", "詞句填空", "「閉包」在這段裡是什麼意思？"],
] as const) test(`term review card localizes prompt for ${locale}`, async t => {
  const termCard: ReviewCardView = {
    ...card,
    id: "term:lesson:ann-1",
    kind: "term",
    term,
    prompt: `「${term}」在這段裡是什麼意思？`,
    context: locale === "en" ? "A ___ keeps access to its outer lexical scope." : "＿＿＿能記住外層詞法作用域。",
    hints: [],
    answer: locale === "en" ? "A function bundled with its lexical scope." : "函式連同建立時的詞法環境。",
  };
  const { window, root } = await mount(t, locale, termCard);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {}, personalAvailable: false, sendToPersonal() {} })); });
  assert.equal(window.document.querySelector(".review-kind")?.textContent, expectedKind);
  assert.equal(window.document.querySelector(".review-prompt")?.textContent, expectedPrompt);
  if (locale === "en") assert.doesNotMatch(window.document.body.textContent || "", /\p{Script=Han}/u);
  const reveal = window.document.querySelector(".review-reveal") as unknown as HTMLButtonElement;
  await act(async () => { reveal.click(); });
  if (locale === "en") assert.doesNotMatch(window.document.body.textContent || "", /\p{Script=Han}/u);
});

test("term review card falls back to card.prompt when term is absent", async t => {
  const fallbackCard: ReviewCardView = {
    ...card,
    id: "term:lesson:legacy",
    kind: "term",
    prompt: "Custom fallback prompt?",
    context: "A ___ keeps state.",
    hints: [],
  };
  const { window, root } = await mount(t, "en", fallbackCard);
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  assert.equal(window.document.querySelector(".review-prompt")?.textContent, "Custom fallback prompt?");
});

const mathTerm = String.raw`\(\nabla f\)`;
const mathTermCard: ReviewCardView = {
  ...card,
  id: "term:lesson:math",
  lessonTitle: "Vector Calculus",
  category: "Math",
  kind: "term",
  term: mathTerm,
  prompt: `「${mathTerm}」在這段裡是什麼意思？`,
  context: "The gradient ___ points in the direction of steepest ascent.",
  hints: [],
  answer: "The gradient vector of f.",
};

test("English term review card renders KaTeX math inside curly quotes and glues trailing ” in .math-glue", async t => {
  assert.equal(await loadMath(), true);
  assert.equal(findMath(`What does "${mathTerm}" mean here?`).length, 0);
  assert.equal(findMath(`What does “${mathTerm}” mean here?`).length, 1);

  const { window, root } = await mount(t, "en", mathTermCard);
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  const promptEl = window.document.querySelector(".review-prompt");
  assert.equal(promptEl?.querySelectorAll(".katex").length, 1);
  const glueEl = promptEl?.querySelector(".math-glue") as unknown as HTMLElement | null;
  assert.ok(glueEl);
  assert.equal(glueEl.style.whiteSpace, "nowrap");
  assert.equal(glueEl.querySelector(".math")?.getAttribute("data-math-source"), mathTerm);
  assert.match(glueEl.innerHTML, /^<span class="math" data-math-source="\\\(\\nabla f\\\)">.*<\/span>”$/);
  assert.match(promptEl?.innerHTML || "", /^What does “<span class="math-glue"/);
  assert.match(promptEl?.innerHTML || "", /”<\/span> mean here\?$/);
  assert.doesNotMatch(window.document.body.textContent || "", /\p{Script=Han}/u);
});

test("MathText glues closing curly quotes ” and ’ to inline KaTeX while leaving ASCII comma unglued", async t => {
  assert.equal(await loadMath(), true);
  const { window, root } = await mount(t, "en");
  await act(async () => {
    root.render(createElement("div", null,
      createElement("p", { className: "double-curly" }, createElement(MathText, { text: `What does “${mathTerm}” mean here?` })),
      createElement("p", { className: "single-curly" }, createElement(MathText, { text: String.raw`Term ‘\(x\)’ next` })),
      createElement("p", { className: "ascii-comma" }, createElement(MathText, { text: String.raw`Let \(x\), then` })),
    ));
  });
  const doubleGlue = window.document.querySelector(".double-curly .math-glue") as unknown as HTMLElement | null;
  assert.ok(doubleGlue);
  assert.equal(doubleGlue.style.whiteSpace, "nowrap");
  assert.ok(doubleGlue.innerHTML.endsWith("</span>”"));

  const singleGlue = window.document.querySelector(".single-curly .math-glue") as unknown as HTMLElement | null;
  assert.ok(singleGlue);
  assert.equal(singleGlue.style.whiteSpace, "nowrap");
  assert.ok(singleGlue.innerHTML.endsWith("</span>’"));

  const commaEl = window.document.querySelector(".ascii-comma");
  assert.equal(commaEl?.querySelectorAll(".math-glue").length, 0);
  assert.doesNotMatch(commaEl?.innerHTML || "", /math-glue/);
});

for (const [label, flags] of [
  ["code", { code: true }],
  ["plainTerm", { plainTerm: true }],
] as const) test(`English term review card keeps ${label} math-like terms as literal text`, async t => {
  assert.equal(await loadMath(), true);
  const { window, root } = await mount(t, "en", { ...mathTermCard, ...flags });
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  const promptEl = window.document.querySelector(".review-prompt");
  assert.equal(promptEl?.textContent, `What does “${mathTerm}” mean here?`);
  assert.equal(promptEl?.querySelectorAll(".katex, [data-math-source]").length, 0);
});

test("review stylesheets declare overflow-wrap: anywhere directly on .review-prompt and .review-context", async t => {
  const longIdentifier = "useSyncExternalStoreWithSelector";
  const longTermCard: ReviewCardView = {
    ...card,
    id: "term:lesson:long-id",
    kind: "term",
    term: longIdentifier,
    code: true,
    prompt: `「${longIdentifier}」在這段裡是什麼意思？`,
    context: "Calling ___ with subscribeStoreWithoutTearingOnConcurrentRender snapshots external state.",
    hints: [],
    answer: "A React hook for subscribing to external stores with selector memoization.",
  };
  const { window, root } = await mount(t, "en", longTermCard);
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  const promptEl = window.document.querySelector(".review-prompt") as unknown as Element | null;
  const contextEl = window.document.querySelector(".review-context") as unknown as Element | null;
  assert.ok(promptEl);
  assert.ok(contextEl);
  assert.equal(promptEl.textContent, `What does “${longIdentifier}” mean here?`);

  for (const cssUrl of [
    new URL("./review-session.css", import.meta.url),
    new URL("../precise-legacy.css", import.meta.url),
  ]) {
    const cssText = readFileSync(cssUrl, "utf8");
    const styleEl = window.document.createElement("style");
    // Neutralize ancestor .review-card inheritance so both selectors must declare overflow-wrap: anywhere themselves.
    styleEl.textContent = `${cssText}\n.review-card { overflow-wrap: normal; }`;
    window.document.head.appendChild(styleEl);
    try {
      assert.equal(window.getComputedStyle(promptEl as never).getPropertyValue("overflow-wrap"), "anywhere", cssUrl.pathname);
      assert.equal(window.getComputedStyle(contextEl as never).getPropertyValue("overflow-wrap"), "anywhere", cssUrl.pathname);
    } finally {
      styleEl.remove();
    }
  }
});

for (const [locale, title, action] of [
  ["en", "All caught up for today", "Open Library"],
  ["zh-TW", "今天沒有到期的複習", "前往知識庫"],
]) test(`empty review localizes its interface for ${locale}`, async t => {
  const { window, root } = await mount(t, locale, null);
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  assert.equal(window.document.querySelector("h2")?.textContent, title);
  assert.equal(window.document.querySelector("a")?.textContent?.trim(), action);
});

for (const [locale, loadError, rateError] of [
  ["en", "Couldn't load your review cards. Try again.", "Couldn't save your rating. Try again."],
  ["zh-TW", "暫時載入不了複習題目，請再試一次。", "評分沒存成功，請再按一次。"],
]) {
  for (const [mode, failingFetch] of [
    ["500", async () => new Response(JSON.stringify({ error: "服務暫時無法回應，請稍後再試。" }), { status: 500, headers: { "Content-Type": "application/json" } })],
    ["offline", async () => { throw new TypeError("Failed to fetch"); }],
  ] as const) test(`load ${mode} shows localized copy for ${locale}`, async t => {
    const { window, root } = await mount(t, locale, card, { fetch: failingFetch });
    await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
    assert.equal(window.document.querySelector(".page-error span")?.textContent, loadError);
  });

  test(`rate 500 shows localized copy for ${locale}`, async t => {
    const failingFetch: typeof fetch = async (_input, init) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "服務暫時無法回應，請稍後再試。" }), { status: 500, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify([{ ...card, kind: "section" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    const { window, root } = await mount(t, locale, card, { fetch: failingFetch });
    window.HTMLElement.prototype.scrollIntoView = () => {};
    await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
    await act(async () => { (window.document.querySelector(".review-reveal") as unknown as HTMLButtonElement).click(); });
    await act(async () => { (window.document.querySelector(".rating-3") as unknown as HTMLButtonElement).click(); });
    assert.equal(window.document.querySelector(".page-error span")?.textContent, rateError);
  });
}

test("completed review uses singular copy for one card, one Again and one remaining", async t => {
  const { window, root } = await mount(t, "en", { ...card, kind: "section" }, { remaining: 1 });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  await act(async () => { (window.document.querySelector(".review-reveal") as unknown as HTMLButtonElement).click(); });
  await act(async () => { (window.document.querySelector(".rating-1") as unknown as HTMLButtonElement).click(); });
  assert.equal(window.document.querySelector("h2")?.textContent, "1 card done for today.");
  assert.equal(window.document.querySelector(".review-done p")?.textContent, "You marked 1 card as Again, so it'll come back in a few minutes.");
  assert.equal(window.document.querySelector(".review-done-actions button")?.textContent, "Review 1 card due now");
  assert.equal(window.document.querySelector(".review-done-actions a")?.textContent?.trim(), "Back to Home");
});

test("completed review uses plural copy for multiple Again and remaining cards", async t => {
  const cards = [0, 1].map(index => ({ ...card, id: `section:lesson:${index}`, kind: "section" as const }));
  const { window, root } = await mount(t, "en", cards, { remaining: 2 });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => { root.render(createElement(ReviewSession, { openNote() {}, onReviewed() {} })); });
  for (let index = 0; index < cards.length; index++) {
    await act(async () => { (window.document.querySelector(".review-reveal") as unknown as HTMLButtonElement).click(); });
    await act(async () => { (window.document.querySelector(".rating-1") as unknown as HTMLButtonElement).click(); });
  }
  assert.equal(window.document.querySelector("h2")?.textContent, "All 2 cards done for today.");
  assert.equal(window.document.querySelector(".review-done p")?.textContent, "You marked 2 cards as Again, so they'll come back in a few minutes.");
  assert.equal(window.document.querySelector(".review-done-actions button")?.textContent, "Review 2 cards due now");
});
