import test from "node:test";
import assert from "node:assert/strict";
import { exampleLessons } from "../shared/examples.js";
import { mergeRefreshedLessons } from "../shared/lesson-state.js";

test("a delayed refresh cannot erase a saved annotation or restore a removed one", () => {
  const original = { ...structuredClone(exampleLessons[0]), updatedAt: "2026-10-04T01:00:00.000Z" };
  const saved = { ...original, updatedAt: "2026-10-04T01:00:01.000Z", annotations: [{
    id: "term-note", term: "increment", sourceKey: "summary", quote: "increment",
    explanation: "每次加一", analogy: "按計數器", createdAt: "2026-10-04T01:00:01.000Z",
  }] };
  const current = [saved];
  assert.equal(mergeRefreshedLessons(current, [original]), current);
  const removed = { ...saved, annotations: [], updatedAt: "2026-10-04T01:00:02.000Z" };
  assert.deepEqual(mergeRefreshedLessons([removed], [saved]), [removed]);
  assert.deepEqual(mergeRefreshedLessons([saved], [removed]), [removed]);
  assert.deepEqual(mergeRefreshedLessons([saved], []), []);
  const newNote = { ...original, id: "another-note" };
  assert.deepEqual(mergeRefreshedLessons([saved], [newNote, original]), [newNote, saved]);
});
