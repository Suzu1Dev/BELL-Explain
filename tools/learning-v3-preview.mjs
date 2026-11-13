import { readFileSync } from "node:fs";
import { exampleLessons } from "../shared/examples.ts";

const localized = JSON.parse(readFileSync(new URL("../server/fixtures/closure-lesson.json", import.meta.url), "utf8"));
const closure = localized["zh-TW"];
const now = "2026-11-09T00:00:00.000Z";
const gallery = {
  "annotated-code": {
    kind: "annotated-code", file: "debounce.js", language: "javascript",
    source: "function debounce(fn, wait) {\n  let timerId;\n  return (...args) => {\n    clearTimeout(timerId);\n    timerId = setTimeout(() => fn(...args), wait);\n  };\n}",
    focus: [2, 4, 5],
    notes: [
      { line: 2, text: "每次輸入都共用這一個 `timerId`，它活在閉包裡。" },
      { line: 4, text: "先取消上一次還沒到時間的計時。" },
      { line: 5, text: "重新開始倒數，停手 `wait` 毫秒後才真的執行。" },
    ],
  },
  state: {
    kind: "state", vars: ["i", "sum"], rows: [
      { moment: "第 1 圈", code: "sum += i", values: { i: { to: "1" }, sum: { from: "0", to: "1" } } },
      { moment: "第 2 圈", code: "sum += i", values: { i: { to: "2" }, sum: { from: "1", to: "3" } } },
      { moment: "第 3 圈", code: "sum += i", values: { i: { to: "3" }, sum: { from: "3", to: "6" } } },
    ], caption: "先想再看開啟時，下一格會先挖空。",
  },
  compare: {
    kind: "compare", items: [{ title: "常見誤解", tone: "wrong" }, { title: "實際上", tone: "right" }], rows: [
      { label: "記住的", values: ["建立當下的值", "變數本身，可讀可寫"] },
      { label: "第 2 次", values: ["還是印出 `1`", "印出 `2`"] },
    ], verdict: "閉包不是快照，是一條通往變數的路。",
  },
  sequence: {
    kind: "sequence", lanes: [{ id: "sync", label: "同步程式" }, { id: "micro", label: "微任務" }, { id: "timer", label: "計時器" }],
    events: [{ lane: "sync", label: "log A", output: "A" }, { lane: "sync", label: "log B", output: "B" }, { lane: "micro", label: "then C", output: "C" }, { lane: "timer", label: "timeout D", output: "D" }],
    caption: "同步程式先跑完，再清空微任務，最後才輪到計時器。",
  },
  timeline: {
    kind: "timeline", unit: "ms", span: 600, rows: [
      { label: "輸入", marks: [{ at: 0, label: "r" }, { at: 100, label: "re" }, { at: 200, label: "rea" }] },
      { label: "計時 1", ranges: [{ from: 0, to: 300, state: "cancel" }] },
      { label: "計時 2", ranges: [{ from: 100, to: 400, state: "cancel" }] },
      { label: "計時 3", ranges: [{ from: 200, to: 500, state: "wait", label: "300 ms" }], fire: { at: 500, label: "搜尋" } },
    ], caption: "打了三個字只搜尋一次：最後一次輸入後 300 ms。",
  },
  keyfact: { kind: "keyfact", value: "0", unit: "ms", label: "不等於立刻執行", note: "`setTimeout(fn, 0)` 要等同步程式和微任務都跑完，才輪到它。" },
};
const blanks = {
  state: { kind: "state", row: 2, var: "sum" },
  sequence: { kind: "sequence", event: 3 },
  keyfact: { kind: "keyfact" },
};
function note(id, figure, locale = "zh-TW") {
  const value = structuredClone(localized[locale]);
  Object.assign(value, {
    id, category: "JavaScript", tags: ["JavaScript", "v3"], connections: [], createdAt: now, updatedAt: now, isDemo: true, favorite: false,
    source: { kind: "code", label: value.source.label, content: "const count = 0;", scope: "P2 實際畫面驗收 fixture" },
  });
  if (figure) {
    value.steps[2].figure = figure;
    value.steps[2].recall.blank = blanks[figure.kind];
  }
  return value;
}
export const v3Cases = [
  { id: "closure", selector: ".v3-lesson-document", fullPage: true },
  ...Object.entries(gallery).map(([kind, figure]) => ({ id: kind, selector: "#section-s3 .v3-figure", figure })),
];
const longText = "很長的英文標籤 Supercalifragilistic ".repeat(4);
const longFigures = Object.fromEntries(Object.entries(gallery).map(([kind, figure]) => {
  const value = structuredClone(figure);
  if (kind === "annotated-code") value.notes[0].text = longText;
  if (kind === "state") value.rows[0].moment = longText;
  if (kind === "compare") value.items[0].title = longText;
  if (kind === "sequence") value.lanes[0].label = longText;
  if (kind === "timeline") value.rows[0].label = longText;
  if (kind === "keyfact") value.label = longText;
  return [kind, value];
}));
export const longCases = Object.entries(longFigures).map(([kind, figure]) => ({ id: `long-${kind}`, selector: "#section-s3 .v3-figure", figure }));
export const offCases = Object.entries(gallery).map(([kind, figure]) => ({ id: `off-${kind}`, selector: "#section-s3 .v3-figure", figure, predict: "off" }));
const englishFigures = {
  compare: localized.en.steps[2].figure,
  sequence: {
    kind: "sequence", lanes: [{ id: "stack", label: "Call stack" }, { id: "micro", label: "Microtasks" }, { id: "macro", label: "Macrotasks" }],
    events: [{ lane: "stack", label: "log A", output: "A" }, { lane: "stack", label: "log B", output: "B" }, { lane: "micro", label: "then C", output: "C" }, { lane: "macro", label: "timeout D", output: "D" }],
    caption: "Synchronous work finishes, then microtasks, then the timer.",
  },
  timeline: {
    kind: "timeline", unit: "ms", span: 600, rows: [
      { label: "Input", marks: [{ at: 0, label: "r" }, { at: 100, label: "re" }, { at: 200, label: "rea" }] },
      { label: "Timer 1", ranges: [{ from: 0, to: 300, state: "cancel" }] },
      { label: "Timer 2", ranges: [{ from: 100, to: 400, state: "cancel" }] },
      { label: "Timer 3", ranges: [{ from: 200, to: 500, state: "wait", label: "300 ms" }], fire: { at: 500, label: "Search" } },
    ], caption: "Three keystrokes, one search: 300 ms after the last input.",
  },
};
export const englishCases = Object.entries(englishFigures).map(([kind, figure]) => ({ id: `english-${kind}`, selector: "#section-s3 .v3-figure", figure, locale: "en" }));
const notes = [...v3Cases, ...longCases, ...offCases, ...englishCases].map(item => note(item.id, item.figure, item.locale));
export async function installPreviewFixtures(page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/lessons" ? [...notes, ...exampleLessons.map((lesson, index) => index === 0 ? { ...lesson, failedFormat: 3 } : lesson)]
      : path === "/api/config" ? { configured: false, model: "", storage: "SQLite" }
        : path === "/api/suite/manifest" ? { schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }
          : path === "/api/jobs" || path === "/api/repositories" || path === "/api/review/due" ? []
            : path === "/api/review/summary" ? { due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }
              : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
}
export const legacyCases = [{ id: "demo-closure", selector: ".reader-document", fullPage: true }];
