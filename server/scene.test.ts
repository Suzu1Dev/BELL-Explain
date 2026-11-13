import { withExample } from "./test-helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { teachingSchema, liveTeachingSchema } from "./schema.js";
import { exampleLessons } from "../shared/examples.js";

function teaching() {
  const lesson = structuredClone(exampleLessons[0]);
  lesson.visual.kind = "flow";
  const [from, to] = lesson.visual.nodes.map((node) => node.id);
  lesson.visual.scene = {
    layout: "memory",
    edges: [
      { id: "reference", from, to, type: "reference", label: "保留參照" },
    ],
    groups: [{ id: "scope", label: "詞法環境", nodeIds: [from] }],
  };
  lesson.visual.steps[0].activeEdgeIds = ["reference"];
  lesson.visual.steps[0].nodeStates = [
    { nodeId: from, value: "count = 0", items: ["count: 0"] },
  ];
  return withExample(lesson);
}

test("scene layouts preserve declared edges and per-step values, legacy notes remain readable", () => {
  for (const layout of [
    "flow",
    "sequence",
    "memory",
    "layers",
    "timeline",
  ] as const) {
    const value = teaching();
    value.visual.scene!.layout = layout;
    const parsed = liveTeachingSchema.parse(value);
    assert.equal(parsed.visual.scene.layout, layout);
    assert.equal(parsed.visual.steps[0].nodeStates?.[0].value, "count = 0");
    assert.equal(parsed.visual.scene.edges[0].type, "reference");
  }
  assert.equal(teachingSchema.safeParse(exampleLessons[0]).success, true);
  const legacy = teaching();
  delete legacy.visual.scene;
  assert.equal(liveTeachingSchema.safeParse(legacy).success, false);
});

test("unknown, duplicate and self-referential scene edges cannot reach the renderer", () => {
  for (const mutate of [
    (value: ReturnType<typeof teaching>) => {
      value.visual.scene!.edges[0].to = "unknown";
    },
    (value: ReturnType<typeof teaching>) => {
      value.visual.scene!.edges[0].to = value.visual.scene!.edges[0].from;
    },
    (value: ReturnType<typeof teaching>) => {
      value.visual.scene!.edges.push({ ...value.visual.scene!.edges[0] });
    },
    (value: ReturnType<typeof teaching>) => {
      value.visual.steps[0].activeEdgeIds = ["unknown"];
    },
    (value: ReturnType<typeof teaching>) => {
      value.visual.scene!.groups[0].nodeIds = ["unknown"];
    },
  ]) {
    const value = teaching();
    mutate(value);
    assert.equal(liveTeachingSchema.safeParse(value).success, false);
  }
});

test("scene state frames reject invalid nodes and duplicate values for the same node", () => {
  let value = teaching();
  value.visual.steps[0].nodeStates![0].nodeId = "unknown";
  assert.equal(liveTeachingSchema.safeParse(value).success, false);
  value = teaching();
  value.visual.steps[0].nodeStates!.push({
    ...value.visual.steps[0].nodeStates![0],
  });
  assert.equal(liveTeachingSchema.safeParse(value).success, false);
  value = teaching();
  value.visual.steps[0].nodeStates![0].items = Array(6).fill("item");
  assert.equal(liveTeachingSchema.safeParse(value).success, false);
});
