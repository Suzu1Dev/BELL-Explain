import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exampleLessons } from "../shared/examples.js";
import type { Lesson } from "../shared/types.js";

// Components import their stylesheets; outside the bundler those load as empty modules.
register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`);
const { default: ConceptAnimation } = await import("../src/components/ConceptAnimation.js");
const { lastRead, saveReadingProgress } = await import("../src/lib/reading-progress.js");

type Visual = Lesson["visual"];
const scene = (states: Array<Array<{ nodeId: string; value: string }>>, output = ""): Visual => ({
  kind: "flow",
  title: "佇列加總",
  caption: "示意",
  nodes: [{ id: "queue", label: "佇列", detail: "等待處理的數字" }, { id: "result", label: "結果", detail: "目前的總和" }],
  steps: states.map((nodeStates, index) => ({
    title: `第 ${index + 1} 步`,
    description: `第 ${index + 1} 步的說明`,
    activeNodeIds: ["queue"],
    output: index === states.length - 1 ? output : "",
    activeEdgeIds: [],
    nodeStates: nodeStates.map((state) => ({ ...state, items: [] })),
  })),
  scene: { layout: "flow", edges: [], groups: [] },
});
const render = (visual: Visual, step: number, predict = true) =>
  renderToStaticMarkup(createElement(ConceptAnimation, { visual, step, onStepChange: () => {}, predict }));

test("predict mode hides a state that first appears in a step, and does not reveal which states change", () => {
  // Only a new state: the step is still masked.
  const onlyNew = render(scene([[{ nodeId: "queue", value: "[]" }], [{ nodeId: "queue", value: "[]" }, { nodeId: "result", value: "sum = 6" }]]), 1);
  assert.match(onlyNew, /先預測：這一步之後/);
  assert.doesNotMatch(onlyNew, /sum = 6|第 2 步的說明/);
  // A changed and a new state: both hidden, and nothing marks which ones changed.
  const both = render(scene([[{ nodeId: "queue", value: "[]" }], [{ nodeId: "queue", value: "[1]" }, { nodeId: "result", value: "sum = 6" }]]), 1);
  assert.doesNotMatch(both, /sum = 6|\[1\]/);
  assert.doesNotMatch(both, /sa-node-changed|sa-change-dot|個狀態更新/);
  // Without predict mode the same step shows its values and what changed.
  const open = render(scene([[{ nodeId: "queue", value: "[]" }], [{ nodeId: "queue", value: "[1]" }, { nodeId: "result", value: "sum = 6" }]]), 1, false);
  assert.match(open, /sum = 6/);
  assert.match(open, /2 個狀態更新/);
  // The first step is the starting point: nothing is marked as changed.
  const first = render(scene([[{ nodeId: "queue", value: "[]" }, { nodeId: "result", value: "0" }], [{ nodeId: "queue", value: "[1]" }]]), 0, false);
  assert.doesNotMatch(first, /sa-node-changed|sa-change-dot|個狀態更新|本步狀態已更新/);
});

test("predict mode also holds back the output of legacy animations", () => {
  const legacy = exampleLessons.find((lesson) => !lesson.visual.scene && lesson.visual.steps.some((step, index) => index > 0 && step.output))!;
  const step = legacy.visual.steps.findIndex((item, index) => index > 0 && item.output);
  const masked = render(legacy.visual, step);
  assert.match(masked, /先預測：這一步會發生什麼/);
  assert.ok(!masked.includes(legacy.visual.steps[step].description));
  assert.ok(render(legacy.visual, step, false).includes(legacy.visual.steps[step].description));
  // The first step is the starting point and is never hidden.
  assert.doesNotMatch(render(legacy.visual, 0), /先預測/);
});

test("returning to a note read a moment ago makes it the one to continue", () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) } });
  const [a, b] = exampleLessons.map((lesson, index) => ({ ...lesson, id: `note-${index}`, isDemo: false }));
  const realNow = Date.now;
  let now = Date.parse("2026-10-08T00:00:00Z");
  Date.now = () => now;
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...args: ConstructorParameters<typeof Date>) { super(...(args.length ? args : [now] as unknown as ConstructorParameters<typeof Date>)); } static now() { return now; } } as DateConstructor;
  try {
    saveReadingProgress(a.id, a.sections[1].id, 1, a.sections.length);
    now += 10_000;
    saveReadingProgress(b.id, b.sections[0].id, 0, b.sections.length);
    now += 20_000;
    saveReadingProgress(a.id, a.sections[1].id, 1, a.sections.length);
    assert.equal(lastRead([a, b])?.lesson.id, a.id);
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});


test("diagram labels remain whole without unreadable English microcopy", () => {
  const lesson = exampleLessons.find((item) => item.visual.kind === "closure" && ["factory", "environment", "counter", "another"].every((id) => item.visual.nodes.some((node) => node.id === id)))!;
  const markup = renderToStaticMarkup(createElement(ConceptAnimation, { visual: lesson.visual, step: 0, onStepChange: () => {}, curated: true }));
  assert.match(markup, /anotherCounter\(\)/);
  assert.match(markup, /width="176"/);
  assert.match(markup, /viewBox="0 0 384 300"/);
  assert.match(markup, /y="279"/);
  assert.match(markup, /y="240"/);
  assert.doesNotMatch(markup, /anotherCounte…|SHARED ENVIRONMENT|NEW ENVIRONMENT|FOLLOW THE EXPLANATION|CONNECTED STAGES|viz-node-index|viz-node-dot|>OUTPUT</);
});
