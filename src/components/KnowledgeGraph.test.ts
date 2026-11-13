import test from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { exampleLessons } from "../../shared/examples.js";
import type { StoredLesson } from "../../shared/lesson-v3.js";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  }`)}`);
}

const { default: KnowledgeGraph, buildKnowledgeGraph, stepSimulation } = await import("./KnowledgeGraph.js");
const { buildLabelSlots, pickLabelSlot } = await import("./KnowledgeScene3D.js");

test("8-slot cartographic label solver avoids overlapping callouts when spheres project close together", () => {
  const cluster = [
    { sx: 420, sy: 300, r: 7, w: 68, h: 16 },
    { sx: 426, sy: 306, r: 6, w: 64, h: 16 },
    { sx: 414, sy: 294, r: 6, w: 62, h: 16 },
    { sx: 432, sy: 298, r: 6, w: 60, h: 16 },
  ];
  const placed: Array<readonly [number, number, number, number]> = cluster.map(c => [
    c.sx - c.r - 3,
    c.sy - c.r - 3,
    c.sx + c.r + 3,
    c.sy + c.r + 3,
  ]);
  const labelBoxes: Array<readonly [number, number, number, number]> = [];

  for (const c of cluster) {
    const slots = buildLabelSlots(c.sx, c.sy, c.r, c.w, c.h);
    const idx = pickLabelSlot(slots, placed, 900, 560, 0, false);
    assert.ok(idx >= 0, "Expected a clear callout slot among 8 directions");
    const s = slots[idx];
    const box = [s.x1, s.y1, s.x2, s.y2] as const;
    placed.push(box);
    labelBoxes.push(box);
  }

  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const a = labelBoxes[i];
      const b = labelBoxes[j];
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      assert.ok(ox <= 0 || oy <= 0, `Expected zero label box overlap between label ${i} and ${j}`);
    }
  }
});

test("buildKnowledgeGraph distributes points on a 3D sphere, separates nodes, and reacts to dragged nodes", () => {
  const graph = buildKnowledgeGraph(exampleLessons, { showTopics: true });
  assert.equal(graph.noteCount, exampleLessons.length);
  assert.ok(graph.topicCount > 0);
  assert.ok(graph.semanticLinkCount > 0);

  const noteNodes = graph.nodes.filter(n => n.kind === "note");
  for (let i = 0; i < noteNodes.length; i++) {
    const a = noteNodes[i];
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z));
    const radius = Math.hypot(a.x, a.y, a.z);
    assert.ok(radius > 80 && radius < 320, `Expected spherical orbital radius in (80, 320), got ${radius}`);
    for (let j = i + 1; j < noteNodes.length; j++) {
      const b = noteNodes[j];
      const dist3d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      assert.ok(dist3d > 54, `Expected separated 3D sphere points, got distance ${dist3d}`);
    }
  }

  const dragged = graph.nodes[0];
  const neighborEdge = graph.edges.find(e => e.from === dragged.id || e.to === dragged.id);
  assert.ok(neighborEdge);
  const neighborId = neighborEdge.from === dragged.id ? neighborEdge.to : neighborEdge.from;
  const neighbor = graph.nodes.find(n => n.id === neighborId)!;
  const beforeX = neighbor.x;

  dragged.x = neighbor.x + 420;
  for (let i = 0; i < 12; i++) stepSimulation(graph.nodes, graph.edges, 0.4, dragged.id);
  assert.ok(neighbor.x > beforeX + 8, "Connected neighbor follows dragged node via 3D spring tension");

  const withoutTopics = buildKnowledgeGraph(exampleLessons, { showTopics: false });
  assert.equal(withoutTopics.topicCount, 0);
  assert.ok(withoutTopics.edges.length > 0);
});

test("KnowledgeGraph opens inspector on selection, deep-links sections, and renders English without CJK", async t => {
  const englishLessons: StoredLesson[] = [
    {
      ...exampleLessons[0],
      id: "en-closure",
      title: "Closures in Practice",
      subtitle: "Lexical scope",
      summary: "Functions retain variables from their outer lexical scope.",
      category: "JavaScript",
      tags: ["closure", "scope"],
      connections: [{ targetId: "en-loop", sectionId: "loop-1", reason: "Callbacks scheduled later still read outer state." }],
    },
    {
      ...exampleLessons[1],
      id: "en-loop",
      title: "Event Loop Scheduling",
      subtitle: "Queues and ticks",
      summary: "Timers enqueue callbacks after the call stack clears.",
      category: "Runtime",
      tags: ["closure", "async"],
      connections: [],
    },
  ];

  const page = new Window({ url: "http://127.0.0.1:21101/?lang=en#/graph" });
  const globals: Record<string, unknown> = {
    window: page, document: page.document, navigator: page.navigator,
    HTMLElement: page.HTMLElement, Element: page.Element, SVGElement: page.SVGElement,
    Event: page.Event, KeyboardEvent: page.KeyboardEvent, MouseEvent: page.MouseEvent,
    ResizeObserver: page.ResizeObserver, matchMedia: page.matchMedia.bind(page),
    requestAnimationFrame: page.requestAnimationFrame.bind(page),
    cancelAnimationFrame: page.cancelAnimationFrame.bind(page),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

  const opened: Array<{ id: string; sectionId?: string }> = [];
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(page.document.body.appendChild(page.document.createElement("div")) as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, desc] of saved) desc ? Object.defineProperty(globalThis, key, desc) : delete (globalThis as Record<string, unknown>)[key];
    await page.happyDOM.close();
  });

  await act(async () => {
    root.render(createElement(KnowledgeGraph, {
      lessons: englishLessons,
      open: (id, sectionId) => opened.push({ id, sectionId }),
      selectTag: () => {},
    }));
  });

  const panel = page.document.querySelector(".kg-panel")!;
  assert.ok(panel);
  assert.ok(panel.querySelector(".kg-orbit-btn"));
  assert.doesNotMatch(panel.outerHTML, /[\u3400-\u9fff]/);

  const firstNote = page.document.querySelector(".kg-node-note");
  assert.ok(firstNote);
  await act(async () => {
    firstNote.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  const inspector = page.document.querySelector(".kg-inspector")!;
  assert.ok(inspector);
  assert.ok(inspector.querySelector(".kg-inspector-layer"));
  assert.match(inspector.textContent || "", /Callbacks scheduled later still read outer state/);
  assert.doesNotMatch(inspector.outerHTML, /[\u3400-\u9fff]/);

  const jumpBtn = inspector.querySelector(".kg-relation-jump") as unknown as HTMLButtonElement;
  assert.ok(jumpBtn);
  await act(async () => { jumpBtn.click(); });
  assert.deepEqual(opened, [{ id: "en-loop", sectionId: "loop-1" }]);
});
