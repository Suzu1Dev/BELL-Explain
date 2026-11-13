import test from "node:test";
import assert from "node:assert/strict";
import { exampleLessons } from "../shared/examples.js";
import type { GenerateEvent, Source } from "../shared/types.js";
import { generateLesson, type ChatCall } from "./ai.js";
import { AppError, SchemaValidationError } from "./errors.js";
import { applyFixes, normalizeTeaching, REPAIR_ROUNDS } from "./repair.js";
import { liveTeachingSchema, teachingSchema } from "./schema.js";
import { withExample } from "./test-helpers.js";

const analysis = { title: "閉包", scope: "貼上內容", keyConcepts: ["閉包", "詞法環境", "閉包"], explanationPlan: ["理解環境", "理解狀態"], caveats: [] };
const curation = { category: "JavaScript", tags: ["閉包"], connections: [] };
/** A valid live teaching reply built from a demo note, with a scene of two edges. */
function teaching() {
  const value = teachingSchema.parse(withExample(structuredClone(exampleLessons[0]))) as ReturnType<typeof teachingSchema.parse>;
  const [a, b, c] = value.visual.nodes.map((node) => node.id);
  value.visual = {
    ...value.visual,
    kind: "flow",
    scene: { layout: "flow", edges: [{ id: "e1", from: a, to: b, label: "建立", type: "call" }, { id: "e2", from: b, to: c ?? a, label: "回傳", type: "return" }], groups: [] },
  };
  return liveTeachingSchema.parse(value);
}
const source: Source = { kind: "code", label: "貼上的程式碼", content: "const x = 1", scope: "僅分析本次貼上的內容。" };
const signal = () => new AbortController().signal;

test("normalization settles ids and indices without touching text", () => {
  const valid = teaching();
  const broken = structuredClone(valid) as Record<string, any>;
  const nodeA = broken.visual.nodes[0].id;
  delete broken.sections[0].id;
  broken.visual.kind = "closure";
  broken.sections[1].visualStep = 40;
  broken.visual.steps[0].activeNodeIds = [nodeA, nodeA, "ghost"];
  broken.visual.steps[0].activeEdgeIds = ["e1", "missing"];
  broken.visual.steps[0].nodeStates = [{ nodeId: nodeA, value: "1", items: [] }, { nodeId: nodeA, value: "2", items: [] }, { nodeId: "ghost", value: "x", items: [] }];
  broken.visual.scene.edges.push({ id: "e1", from: nodeA, to: "ghost", label: "壞掉", type: "data" });
  broken.visual.scene.groups = [{ id: "g", label: "作用域", nodeIds: [nodeA, "ghost"] }];
  broken.visual.nodes.push({ ...broken.visual.nodes[0], label: "重複的節點" });
  const { value, fixes } = normalizeTeaching(broken);
  // A connection to a node that does not exist is left for the model; it is the only problem left.
  const left = liveTeachingSchema.safeParse(value);
  assert.deepEqual(left.error?.issues.map(issue => issue.path.join(".")), ["visual.scene.edges.2"]);
  const fixed = value as Record<string, any>;
  assert.equal(fixed.sections[0].id, "section-1");
  assert.equal(fixed.sections[1].visualStep, fixed.visual.steps.length - 1);
  assert.deepEqual(fixed.visual.steps[0].activeNodeIds, [nodeA]);
  assert.deepEqual(fixed.visual.steps[0].activeEdgeIds, ["e1"]);
  assert.deepEqual(fixed.visual.steps[0].nodeStates.map((state: { value: string }) => state.value), ["1"]);
  assert.equal(fixed.visual.scene.edges.length, 3, "an edge to a missing node is kept for repair");
  assert.notEqual(fixed.visual.scene.edges[2].id, "e1", "its repeated id is renamed");
  assert.deepEqual(fixed.visual.scene.groups[0].nodeIds, [nodeA]);
  assert.notEqual(fixed.visual.nodes.at(-1).id, nodeA, "a repeated node id is renamed");
  assert.ok(fixes.includes("visual.kind") && fixes.includes("sections.1.visualStep"));
  // Prose and code stay exactly as written.
  assert.deepEqual(fixed.sections.map((section: { body: string; code: string }) => [section.body, section.code]), valid.sections.map((section) => [section.body, section.code]));
  assert.deepEqual(normalizeTeaching(valid).fixes, []);
});

test("an invalid teacher reply is repaired by a patch to just the reported paths", async () => {
  const calls: Array<{ role: string; instruction: string; data: any }> = [];
  const bad = teaching() as Record<string, any>;
  const index = bad.sections.findIndex((section: { codeExample?: unknown }) => section.codeExample);
  bad.sections[index].codeExample.walkthrough[1].endLine = 99;
  bad.title = "";
  const events: GenerateEvent[] = [];
  const chat: ChatCall = async (role, instruction, data) => {
    calls.push({ role, instruction, data });
    if (role === "分析代理") return analysis;
    if (role === "知識整理代理") return curation;
    if (!instruction.startsWith("你上一次的 JSON 回覆有結構問題")) return bad;
    const lines = bad.sections[index].code.split("\n").length;
    // A fix outside the reported problems (the summary) is ignored.
    return { fixes: [
      { path: ["title"], value: "閉包如何記住變數" },
      { path: ["summary"], value: "被改寫的摘要" },
      { path: ["sections", index, "codeExample", "walkthrough", 1, "endLine"], value: lines },
    ] };
  };
  const lesson = await generateLesson({ kind: "code", content: "x", depth: "intermediate" }, source, [], chat, signal(), (event) => events.push(event));
  assert.equal(lesson.title, "閉包如何記住變數");
  assert.equal(lesson.summary, teaching().summary);
  // One repair call covers the empty title and the walkthrough line past the end of the code.
  assert.deepEqual(calls.map((call) => call.role), ["分析代理", "教學代理", "教學代理", "知識整理代理"]);
  const paths = calls[2].data.issues.map((issue: { path: unknown[] }) => issue.path.join("."));
  assert.ok(paths.includes("title") && paths.includes(`sections.${index}.codeExample.walkthrough`), paths.join(", "));
  assert.ok(calls[2].data.output, "the whole reply is sent when it is small");
  assert.ok(events.some((event) => event.type === "stage" && /教學代理的回覆有 \d+ 處格式問題/.test(event.message)));
});

test("a reply that stays invalid fails as before after the repair rounds, and abort wins over repair", async () => {
  let repairs = 0;
  const chat: ChatCall = async (role, instruction) => {
    if (role === "分析代理") return analysis;
    if (instruction.startsWith("你上一次的 JSON 回覆有結構問題")) { repairs++; return { fixes: [{ path: ["title"], value: "" }] }; }
    return { ...teaching(), title: "" };
  };
  await assert.rejects(generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], chat, signal(), () => {}), (error) => error instanceof SchemaValidationError && error.stage === "教學代理");
  assert.equal(repairs, REPAIR_ROUNDS);
  // A reply that is not a patch at all ends the repair at once.
  let calls = 0;
  await assert.rejects(generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], async (role) => { calls++; return role === "分析代理" ? analysis : { title: "" }; }, signal(), () => {}), SchemaValidationError);
  assert.equal(calls, 3);
  const controller = new AbortController();
  await assert.rejects(generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], async (role, instruction) => {
    if (role === "分析代理") return analysis;
    if (instruction.startsWith("你上一次的 JSON 回覆有結構問題")) throw new Error("should not be asked");
    controller.abort();
    return { title: "" };
  }, controller.signal, () => {}), { name: "AbortError" });
});

test("a rate limit while asking for a repair ends the job with that error", async () => {
  let calls = 0;
  await assert.rejects(generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], async (role, instruction) => {
    calls++;
    if (role === "分析代理") return analysis;
    if (instruction.startsWith("你上一次的 JSON 回覆有結構問題")) throw new AppError(429, "rate limited");
    return { ...teaching(), title: "" };
  }, signal(), () => {}), (error) => error instanceof AppError && !(error instanceof SchemaValidationError) && error.status === 429);
  assert.equal(calls, 3);
});

test("a failed curator files the note under the analysis instead of losing it", async () => {
  for (const curator of [async () => ({ category: "" }), async () => { throw new Error("curator timed out"); }]) {
    const events: GenerateEvent[] = [];
    const lesson = await generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], async (role, ...rest) => (role === "分析代理" ? analysis : role === "知識整理代理" ? curator() : teaching()), signal(), (event) => events.push(event));
    assert.equal(lesson.category, "閉包");
    assert.deepEqual(lesson.tags, ["閉包", "詞法環境"]);
    assert.deepEqual(lesson.connections, []);
    assert.ok(events.some((event) => event.type === "stage" && /先以分析出的關鍵概念分類/.test(event.message)));
  }
  // Cancelling during curation still cancels.
  const controller = new AbortController();
  await assert.rejects(generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], async (role) => {
    if (role === "知識整理代理") { controller.abort(); throw new DOMException("aborted", "AbortError"); }
    return role === "分析代理" ? analysis : teaching();
  }, controller.signal, () => {}), { name: "AbortError" });
});

test("keys a strict schema does not know are dropped without asking the model", async () => {
  let repairs = 0;
  const reply = { ...teaching(), document: { id: "copied from the input" } } as Record<string, any>;
  reply.sections[0].note = "extra";
  const chat: ChatCall = async (role, instruction) => {
    if (role === "分析代理") return analysis;
    if (role === "知識整理代理") return curation;
    if (instruction.startsWith("你上一次的 JSON 回覆有結構問題")) { repairs++; return undefined; }
    return reply;
  };
  const lesson = await generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], chat, signal(), () => {});
  assert.equal(repairs, 0);
  assert.equal("document" in lesson, false);
  assert.equal("note" in lesson.sections[0], false);
});

test("patches cannot reach prototypes or paths outside the reported issues", () => {
  const target: Record<string, any> = { sections: [{ heading: "a" }], title: "t" };
  const applied = applyFixes(target, [
    { path: ["__proto__", "polluted"], value: true },
    { path: ["sections", 0, "constructor", "prototype", "polluted"], value: true },
    { path: ["title"], value: "changed" },
    { path: ["sections", 0, "heading"], value: "b" },
    { path: ["sections", 1, "heading"], value: "new" },
  ], [["sections", 0], ["sections", 1]]);
  assert.equal(applied, 2);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(target.title, "t");
  assert.deepEqual(target.sections, [{ heading: "b" }, { heading: "new" }]);
});

test("invalid node and edge ids are renamed together with every reference to them", () => {
  const value = teaching() as Record<string, any>;
  const ids = value.visual.nodes.map((node: { id: string }) => node.id);
  const numbered = new Map<string, string>(ids.map((id: string, index: number) => [id, String(index + 1)]));
  const rename = (id: string): string => numbered.get(id) ?? id;
  value.visual.nodes.forEach((node: { id: string }) => { node.id = rename(node.id); });
  value.visual.scene.edges.forEach((edge: Record<string, string>, index: number) => { edge.from = rename(edge.from); edge.to = rename(edge.to); edge.id = `${edge.from}->${edge.to}#${index}`; });
  value.visual.scene.groups = [{ id: "g", label: "作用域", nodeIds: [rename(ids[0])] }];
  value.visual.steps.forEach((step: Record<string, any>, index: number) => {
    step.activeNodeIds = step.activeNodeIds.map(rename);
    step.activeEdgeIds = [value.visual.scene.edges[index % value.visual.scene.edges.length].id];
    step.nodeStates = [{ nodeId: rename(ids[0]), value: `v${index}`, items: [] }];
  });
  const { value: normalized } = normalizeTeaching(value);
  const result = liveTeachingSchema.safeParse(normalized);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  const fixed = normalized as Record<string, any>;
  assert.equal(fixed.visual.scene.edges.length, value.visual.scene.edges.length, "no connection is lost");
  assert.ok(fixed.visual.steps.every((step: { activeEdgeIds: string[]; nodeStates: unknown[] }) => step.activeEdgeIds.length === 1 && step.nodeStates.length === 1));
  assert.deepEqual(fixed.visual.scene.groups[0].nodeIds, [fixed.visual.nodes[0].id]);
});

test("a repair that renames a node carries its references along", () => {
  const before = teaching() as Record<string, any>;
  const old = before.visual.nodes[0].id;
  const after = structuredClone(before);
  after.visual.nodes[0].id = "renamedNode";
  const { value } = normalizeTeaching(after, before);
  const fixed = value as Record<string, any>;
  assert.equal(liveTeachingSchema.safeParse(value).success, true);
  assert.ok(!JSON.stringify(fixed.visual.scene).includes(`"${old}"`));
  assert.ok(fixed.visual.steps.some((step: { activeNodeIds: string[] }) => step.activeNodeIds.includes("renamedNode")) || !before.visual.steps.some((step: { activeNodeIds: string[] }) => step.activeNodeIds.includes(old)));
});

test("patch paths cannot grow arrays, set length or step through non-containers", () => {
  const target: Record<string, any> = { keyConcepts: ["a"], sections: [{ codeExample: { walkthrough: [] } }], title: null };
  const allowed = [["keyConcepts"], ["sections", 0, "codeExample"], ["title"]];
  const applied = applyFixes(target, [
    { path: ["keyConcepts", "9000000"], value: "x" },
    { path: ["keyConcepts", "length"], value: 1e9 },
    { path: ["keyConcepts", 70], value: "x" },
    { path: ["sections", 0, "codeExample", "walkthrough", "0", "endLine"], value: 3 },
    { path: ["title", "nested"], value: "x" },
    { path: ["keyConcepts", 1], value: "b" },
  ], allowed);
  assert.equal(applied, 2);
  assert.deepEqual(target.keyConcepts, ["a", "b"]);
  assert.deepEqual(target.sections[0].codeExample.walkthrough, [{ endLine: 3 }]);
  assert.equal(target.title, null);
});

test("a reply that is not an object fails at once, and a missing language can be repaired", async () => {
  let repairs = 0;
  const chatFor = (reply: unknown, fixes?: unknown): ChatCall => async (role, instruction) => {
    if (role === "分析代理") return analysis;
    if (role === "知識整理代理") return curation;
    if (instruction.startsWith("你上一次的 JSON 回覆有結構問題")) { repairs++; return fixes; }
    return reply;
  };
  await assert.rejects(generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], chatFor(null), signal(), () => {}), SchemaValidationError);
  assert.equal(repairs, 0);
  const bad = teaching() as Record<string, any>;
  const index = bad.sections.findIndex((section: { codeExample?: unknown }) => section.codeExample);
  bad.sections[index].language = "";
  const lesson = await generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], chatFor(bad, { fixes: [{ path: ["sections", index, "language"], value: "javascript" }] }), signal(), () => {});
  assert.equal(lesson.sections[index].language, "javascript");
  assert.equal(repairs, 1);
});

test("a repair that removes a node is not mistaken for a rename", () => {
  const before = teaching() as Record<string, any>;
  before.visual.nodes.push({ ...before.visual.nodes[0], id: "extraNode", label: "多出來的節點" });
  const removed = before.visual.nodes[0].id;
  const after = structuredClone(before);
  after.visual.nodes.splice(0, 1);
  const { value } = normalizeTeaching(after, before);
  const fixed = value as Record<string, any>;
  // References to the removed node are not moved onto the node that shifted into its place.
  const shifted = after.visual.nodes[0].id;
  const pointsAtRemoved = JSON.stringify(fixed.visual.scene.edges).includes(`"${removed}"`);
  const movedOntoShifted = fixed.visual.scene.edges.filter((edge: Record<string, string>) => edge.from === shifted || edge.to === shifted).length
    > before.visual.scene.edges.filter((edge: Record<string, string>) => edge.from === shifted || edge.to === shifted).length;
  assert.equal(movedOntoShifted, false);
  assert.ok(pointsAtRemoved || !JSON.stringify(before.visual.scene.edges).includes(`"${removed}"`), "stale references stay for repair");
});

test("connections the model cannot fix are dropped as a last resort instead of losing the lesson", async () => {
  const bad = teaching() as Record<string, any>;
  bad.visual.scene.edges.push({ id: "ghostEdge", from: bad.visual.nodes[0].id, to: "ghost", label: "壞掉", type: "data" });
  bad.visual.steps[0].activeEdgeIds = ["ghostEdge"];
  let repairs = 0;
  const lesson = await generateLesson({ kind: "code", content: "x", depth: "beginner" }, source, [], async (role, instruction) => {
    if (role === "分析代理") return analysis;
    if (role === "知識整理代理") return curation;
    if (instruction.startsWith("你上一次的 JSON 回覆有結構問題")) { repairs++; throw new Error("provider down"); }
    return bad;
  }, signal(), () => {});
  assert.equal(repairs, 1);
  assert.ok(lesson.visual.scene!.edges.every(edge => edge.id !== "ghostEdge"));
  assert.ok(!lesson.visual.steps[0].activeEdgeIds?.includes("ghostEdge"));
});
