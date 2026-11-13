import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import type { Figure, LessonNoteV3, LessonV3, Sequence, StateTable } from "../../shared/lesson-v3.js";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  }`)}`);
}

const { default: FigureView } = await import("./learning/Figure.js");
const { default: LessonV3Reader } = await import("./learning/LessonV3Reader.js");
const localized = JSON.parse(readFileSync(new URL("../../server/fixtures/closure-lesson.json", import.meta.url), "utf8")) as Record<"zh-TW" | "en", LessonV3>;
const closure = localized["zh-TW"];
const sequence: Sequence = {
  kind: "sequence",
  lanes: [{ id: "sync", label: "同步程式" }, { id: "micro", label: "微任務" }, { id: "timer", label: "計時器" }],
  events: [{ lane: "sync", label: "log A", output: "A" }, { lane: "sync", label: "log B", output: "B" }, { lane: "micro", label: "then C", output: "C" }, { lane: "timer", label: "timeout D", output: "D" }],
  caption: "同步程式先跑完，再清空微任務，最後才輪到計時器。",
};
const figures: Figure[] = [
  closure.steps[0].figure!, closure.steps[1].figure!, closure.steps[2].figure!, sequence,
  { kind: "timeline", unit: "ms", span: 600, rows: [
    { label: "輸入", marks: [{ at: 0, label: "r" }, { at: 100, label: "re" }, { at: 200, label: "rea" }] },
    { label: "計時 1", ranges: [{ from: 0, to: 300, state: "cancel" }] },
    { label: "計時 2", ranges: [{ from: 100, to: 400, state: "cancel" }] },
    { label: "計時 3", ranges: [{ from: 200, to: 500, state: "wait", label: "300 ms" }], fire: { at: 500, label: "搜尋" } },
  ], caption: "打了三個字只搜尋一次：最後一次輸入後 300 ms。" },
  { kind: "keyfact", value: "0", unit: "ms", label: "不等於立刻執行", note: "`setTimeout(fn, 0)` 要等同步程式和微任務都跑完，才輪到它。" },
  { kind: "d2", title: "PLT / GOT 延遲綁定", source: "direction: right\ncaller: 呼叫端 {\n  call: `call puts@plt`\n}\nstubs: 跳板與表 {\n  plt: `.plt` · 間接跳轉\n  got: `.got.plt` · 目標位址\n}\ncaller.call -> stubs.plt: 1. 進入跳板\nstubs.plt -> stubs.got: 2. 查表跳轉", caption: "首次未綁定時轉交 `ld.so` 寫回真實位址。" },
  { kind: "rubik-2x2", title: "2×2 角塊狀態實驗室", caption: "依固定數學規則繪製的互動示意。", setupMoves: ["D"], view: "moves" },
];
const stored = (lesson: LessonV3 = closure): LessonNoteV3 => ({
  ...lesson, id: "v3-closure", category: "JavaScript", tags: ["閉包"],
  source: { kind: "code", label: lesson.source.label, content: "const count = 0;", scope: "測試原文", url: lesson.source.url },
  connections: [], createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", isDemo: true, favorite: false,
});

function markup(figure: Figure, predict = false) {
  const blank = figure.kind === "state" ? { kind: "state-output", row: 3 } as const
    : figure.kind === "sequence" ? { kind: "sequence", event: 3 } as const
      : figure.kind === "compare" ? { kind: "compare", item: 1, row: 2 } as const
        : figure.kind === "keyfact" ? { kind: "keyfact" } as const : undefined;
  return renderToStaticMarkup(createElement(FigureView, { figure, predict, blank }));
}

test("all six figures render structured selectable content without canvas or injected HTML", () => {
  for (const figure of figures) {
    const html = markup(figure);
    assert.match(html, /v3-figure/, figure.kind);
    assert.doesNotMatch(html, /<canvas|data:html|javascript:/i, figure.kind);
  }
  assert.equal((markup(figures[0]).match(/v3-code-notes/g) || []).length, 1);
  assert.match(markup(figures[0]), /is-focused/);
  assert.match(markup(figures[2]), /is-wrong|v3-compare-item/);
  assert.match(markup(figures[4]), /left:34%/);
  assert.match(markup(figures[5]), /0<!-- -->|<small>ms/);
  const malicious = structuredClone(closure);
  malicious.title = "<img src=x onerror=alert(1)>";
  malicious.steps[0].body = "<script>alert(1)</script>";
  const firstFigure = malicious.steps[0].figure;
  if (firstFigure?.kind === "annotated-code") firstFigure.notes[0]!.text = "<svg onload=alert(1)>";
  const page = renderToStaticMarkup(createElement(LessonV3Reader, { lesson: stored(malicious), lessons: [], jump: 0, open() {}, favorite() {}, remove() {}, followUp() {}, notify() {}, personalAvailable: false, sendToPersonal() {}, onLessonChange() {}, toggleTheme() {} }));
  assert.doesNotMatch(page, /<img|<script|<svg onload/i);
  assert.match(page, /&lt;img src=x/);
});

test("predict mode blanks only a future answer; compare and keyfact stay visible in P2", () => {
  const state = markup(figures[1], true);
  assert.match(state, /第 3 步，共 4 步/);
  assert.match(state, /v3-blank/);
  assert.match(state, /is-future/);
  const sequenceHtml = markup(sequence, true);
  assert.match(sequenceHtml, /第 3 步，共 4 步/);
  assert.match(sequenceHtml, /v3-blank/);
  assert.doesNotMatch(markup(figures[2], true), /v3-blank/);
  const keyfact = markup(figures[5], true);
  assert.doesNotMatch(keyfact, /v3-blank|v3-figure-head/);
  assert.match(keyfact, /0<!-- -->|<small>ms/);
  assert.match(markup(figures[4]), /時間軸 · 等待 300 ms/);
  assert.doesNotMatch(markup(figures[4]), /等待 600 ms/);
  const noTarget = renderToStaticMarkup(createElement(FigureView, { figure: figures[1], predict: true }));
  assert.doesNotMatch(noTarget, /v3-blank/);
});

test("over-limit content remains text and every kind has wrapping or scrolling styles", () => {
  const long = "非常長的內容<安全>".repeat(30);
  const expanded = figures.map(figure => {
    const copy = structuredClone(figure);
    if (copy.kind === "annotated-code") copy.notes[0].text = long;
    if (copy.kind === "state") copy.rows[0].moment = long;
    if (copy.kind === "compare") copy.items[0].title = long;
    if (copy.kind === "sequence") copy.lanes[0].label = long;
    if (copy.kind === "timeline") copy.rows[0].label = long;
    if (copy.kind === "keyfact") copy.label = long;
    if (copy.kind === "d2") copy.title = long;
    if (copy.kind === "rubik-2x2") copy.title = long;
    return copy;
  });
  for (const figure of expanded) {
    const html = markup(figure);
    assert.match(html, /非常長的內容/);
    assert.doesNotMatch(html, /<安全>/);
  }
});

async function mount(t: TestContext, figure: StateTable | Sequence) {
  const window = new Window({ url: "http://127.0.0.1/" });
  const globals: Record<string, unknown> = { window, document: window.document, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
    await window.happyDOM.close();
  });
  const blank = figure.kind === "state" ? { kind: "state-output", row: 3 } as const : { kind: "sequence", event: 3 } as const;
  await act(async () => { root.render(createElement(FigureView, { figure, predict: true, blank })); });
  return { window, root };
}

for (const [name, figure] of [["state", figures[1] as StateTable], ["sequence", sequence]] as const) {
  test(`${name} supports Left, Right and Home with a polite step announcement`, async t => {
    const page = await mount(t, figure);
    const frame = page.window.document.querySelector(".v3-figure") as unknown as HTMLElement;
    const position = () => page.window.document.querySelector("[aria-live='polite']")?.textContent;
    const key = (key: string) => frame.dispatchEvent(new page.window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
    assert.equal(position(), "第 3 步，共 4 步");
    await act(async () => { key("ArrowRight"); });
    assert.equal(position(), "第 4 步，共 4 步");
    assert.equal(frame.querySelectorAll(".v3-blank").length, 0, "stepping onto the answer reveals it");
    if (name === "state") assert.equal(frame.querySelector("tbody tr:last-child .v3-state-output")?.textContent, "3");
    else assert.match(frame.querySelector(".v3-sequence-event:last-of-type")?.textContent || "", /timeout D/);
    await act(async () => { key("ArrowLeft"); });
    assert.equal(position(), "第 3 步，共 4 步");
    await act(async () => { key("Home"); });
    assert.equal(position(), "第 1 步，共 4 步");
  });
}

test("the closure fixture uses the v3 reader with no environment flag", () => {
  delete process.env.BELL_LESSON_V3;
  const html = renderToStaticMarkup(createElement(LessonV3Reader, { lesson: stored(), lessons: [stored()], jump: 0, open() {}, favorite() {}, remove() {}, followUp() {}, notify() {}, personalAvailable: false, sendToPersonal() {}, onLessonChange() {}, toggleTheme() {} }));
  assert.equal((html.match(/class="v3-step"/g) || []).length, 3);
  assert.match(html, /v3-code-notes|v3-state-table|v3-compare/);
  assert.doesNotMatch(html, /concept-animation|explanation-section/);
});

test("sequence, compare, d2 and timeline format inline code without raw backticks and stagger close marks", () => {
  const seqWithCode: Sequence = {
    kind: "sequence",
    lanes: [{ id: "ld", label: "Linker (`ld`)" }, { id: "kern", label: "Kernel (`execve`)" }],
    events: [
      { lane: "ld", label: "合併 `.o` 與程式庫", output: "`a.out`" },
      { lane: "kern", label: "`execve` 載入 `PT_LOAD`" },
      { lane: "kern", label: "移交控制權給 `main`" },
    ],
  };
  const seqText = markup(seqWithCode).replace(/<[^>]*>/g, "");
  assert.doesNotMatch(seqText, /`/);
  assert.match(markup(seqWithCode), /<code[^>]*>\.o<\/code>/);

  const cmpHtml = markup({
    kind: "compare",
    items: [{ title: "Strong Symbol" }, { title: "Weak Symbol" }],
    rows: [{ label: "常見 `nm` 類別", values: ["`T` / `D`", "`W` / `V`"] }],
  });
  assert.doesNotMatch(cmpHtml.replace(/<[^>]*>/g, ""), /`/);
  assert.match(cmpHtml, /<code[^>]*>nm<\/code>/);

  const d2Html = markup(figures[6]);
  assert.match(d2Html, /v3-d2-canvas/);
  assert.match(d2Html, /<code[^>]*>call puts@plt<\/code>/);
  assert.doesNotMatch(d2Html.replace(/<[^>]*>/g, ""), /`/);

  const rubikHtml = markup(figures[7]);
  assert.match(rubikHtml, /v3-rubik-figure/);
  assert.match(rubikHtml, /144,342/);

  const closeTimeline = markup({
    kind: "timeline",
    unit: "ms",
    span: 600,
    rows: [{ label: "輸入", marks: [{ at: 100, label: "a" }, { at: 120, label: "ab" }] }],
  });
  assert.match(closeTimeline, /is-staggered/);
  assert.match(closeTimeline, /data-stagger="upper"/);
});
