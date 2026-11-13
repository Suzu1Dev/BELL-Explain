import test from "node:test";
import assert from "node:assert/strict";
import { JobFailure, reformatLesson } from "./api";

test("a reformat job error keeps its HTTP status", async () => {
  const original = globalThis.fetch;
  const body = `${JSON.stringify({ type: "job", id: "reformat-1" })}\n${JSON.stringify({ type: "error", message: "筆記在整理期間已更新或刪除", status: 409 })}\n`;
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  try {
    await assert.rejects(reformatLesson("edited", new AbortController().signal, () => {}), error => {
      assert.ok(error instanceof JobFailure);
      assert.equal(error.status, 409);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("a deleted note's reformat refusal keeps its 404 status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "筆記不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(reformatLesson("deleted", new AbortController().signal, () => {}), error => {
      assert.ok(error instanceof JobFailure);
      assert.equal(error.status, 404);
      assert.equal(error.unknown, false);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("a reformat refused for no connected model keeps the server's no_model code", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "請先在模型設定連接 Codex、Claude Code 或 AI API。", code: "no_model" }), { status: 503, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(reformatLesson("legacy", new AbortController().signal, () => {}), error => {
      assert.ok(error instanceof JobFailure);
      assert.equal(error.status, 503);
      assert.equal(error.code, "no_model");
      assert.equal(error.unknown, false);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
