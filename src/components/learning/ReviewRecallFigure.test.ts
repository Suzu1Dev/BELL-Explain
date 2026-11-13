import test from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { createElement } from "react";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewCardView } from "../../../shared/learning";
import type { Compare, KeyFact, Sequence, StateTable } from "../../../shared/lesson-v3";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
} else {
  register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`);
}

const { default: StateTableView } = await import("./StateTable.js");
const { default: CompareView } = await import("./Compare.js");
const { default: KeyFactView } = await import("./KeyFact.js");
const { default: SequenceView } = await import("./Sequence.js");
const { default: RecallReviewCard } = await import("./RecallReviewCard.js");

const stateFigure: StateTable = {
  kind: "state",
  vars: ["count"],
  rows: [
    { moment: "第 1 次", code: "count++", values: { count: { from: "0", to: "1" } }, output: "1" },
    { moment: "第 2 次", code: "count++", values: { count: { from: "1", to: "2" } }, output: "2" },
    { moment: "第 3 次", code: "count++", values: { count: { from: "2", to: "3" } }, output: "3" },
  ],
};
const compareFigure: Compare = {
  kind: "compare",
  items: [{ title: "counter" }, { title: "anotherCounter" }],
  rows: [{ label: "呼叫 1 次", values: ["1", "11"] }],
  verdict: "格式一樣，`count` 各是各的。",
};
const keyFactFigure: KeyFact = { kind: "keyfact", value: "42", unit: "ms", label: "答案", note: "說明" };
const sequenceFigure: Sequence = {
  kind: "sequence",
  lanes: [{ id: "main", label: "主程式" }],
  events: [
    { lane: "main", label: "first", output: "1" },
    { lane: "main", label: "second", output: "2" },
    { lane: "main", label: "answer", output: "3" },
    { lane: "main", label: "later", output: "4" },
  ],
};

function stateMarkup(reviewRevealed = false) {
  return renderToStaticMarkup(createElement(StateTableView, { figure: stateFigure, predict: true, blank: { kind: "state-output", row: 2 }, interactive: false, review: !reviewRevealed, reviewRevealed }));
}

test("review state keeps the previous value and blanks every new value without a stepper", () => {
  const html = stateMarkup();
  assert.equal((html.match(/v3-blank/g) ?? []).length, 2);
  assert.match(html, /v3-state-from">2</);
  assert.match(html, /v3-state-arrow">→</);
  assert.doesNotMatch(html, /v3-state-to">3</);
  assert.doesNotMatch(html, /v3-figure-position/);
});

test("revealing advances only to the answer row and fills it in place", () => {
  const html = stateMarkup(true);
  assert.doesNotMatch(html, /v3-blank|is-future/);
  assert.match(html, /is-current/);
  assert.match(html, /v3-state-from">2</);
  assert.match(html, /v3-state-to">3</);
  assert.match(html, /v3-state-output"><span class="v3-state-value-content">3</);
  assert.doesNotMatch(html, /v3-figure-position/);
});

test("compare and keyfact conceal only their answers until reveal", () => {
  const compare = (reviewRevealed: boolean) => renderToStaticMarkup(createElement(CompareView, { figure: compareFigure, predict: true, blank: { kind: "compare", item: 1, row: 0 }, review: true, reviewRevealed }));
  assert.match(compare(false), />1</);
  assert.doesNotMatch(compare(false), />11</);
  assert.match(compare(false), /v3-compare-verdict is-concealed" aria-hidden="true"/);
  assert.match(compare(true), />11</);
  assert.match(compare(true), /各是各的/);
  assert.doesNotMatch(compare(true), /v3-blank/);

  const keyfact = (reviewRevealed: boolean) => renderToStaticMarkup(createElement(KeyFactView, { figure: keyFactFigure, predict: true, blank: { kind: "keyfact" }, review: true, reviewRevealed }));
  assert.doesNotMatch(keyfact(false), />42</);
  assert.match(keyfact(false), /v3-blank/);
  assert.match(keyfact(false), /<small>ms</);
  assert.match(keyfact(true), />42</);
});

test("sequence reveal shows the answer event but keeps later events hidden", () => {
  const html = renderToStaticMarkup(createElement(SequenceView, { figure: sequenceFigure, predict: true, blank: { kind: "sequence", event: 2 }, interactive: false, reviewRevealed: true }));
  assert.doesNotMatch(html, /v3-blank/);
  assert.match(html, /v3-pin">3</);
  assert.match(html, />answer</);
  assert.match(html, /aria-hidden="true"><span class="v3-pin">4</);
});

function card(overrides: Partial<ReviewCardView> = {}): ReviewCardView {
  return {
    id: "recall:lesson:s2", lessonId: "lesson", lessonTitle: "Closure", category: "JavaScript", kind: "recall", sectionId: "s2", step: 2,
    prompt: "第三次呼叫 `counter()` 會印出什麼？", hints: ["想想 `count`"], answer: "3。三次呼叫改的都是同一個 `count`。",
    figure: stateFigure, blank: { kind: "state-output", row: 2 }, isNew: true,
    intervals: { 1: 60000, 2: 600000, 3: 86400000, 4: 259200000 }, ...overrides,
  };
}

function cardMarkup(value: ReviewCardView) {
  return renderToStaticMarkup(createElement(RecallReviewCard, {
    card: value, revealed: true, setRevealed: () => {}, hints: false, setHints: () => {}, answerRef: { current: null }, saving: false,
    rate: () => {}, openNote: () => {}, personalAvailable: false, sendToPersonal: () => {},
  }));
}

test("review back formats inline code and keeps one figure for a blank card", () => {
  const html = cardMarkup(card());
  assert.equal((html.match(/class="v3-figure"/g) ?? []).length, 1);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /`/);
  assert.match(html, /<code[^>]*>counter\(\)</);
  assert.match(html, /<code[^>]*>count</);
  assert.match(html, /v3-state-to">3</);
});

test("a card without a blank shows its figure only under the answer", () => {
  const html = cardMarkup(card({ blank: undefined }));
  assert.equal((html.match(/class="v3-figure"/g) ?? []).length, 1);
  assert.match(html, /rc-answer[\s\S]*class="v3-figure"/);
});

test("English review uses localized figure labels and rating intervals", async () => {
  const window = new Window({ url: "http://127.0.0.1/?lang=en" });
  const saved = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  try {
    const html = cardMarkup(card());
    assert.match(html, /Watch count/);
    assert.match(html, />When</);
    assert.match(html, />Output</);
    assert.match(html, /1 min/);
    assert.match(html, /10 min/);
    assert.match(html, /1 day/);
    assert.match(html, /3 days/);
    assert.doesNotMatch(html, /逐步看|時刻|分鐘/);
  } finally {
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
    await window.happyDOM.close();
  }
});
