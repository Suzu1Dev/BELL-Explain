import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { DOCUMENT_CONTEXT_CHARS, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_MB } from "../shared/documents.js";
import type { ParsedDocument } from "./document-parser.js";
import { createDocumentRouter, DocumentService } from "./documents.js";
import { AppError } from "./errors.js";

const parsed: ParsedDocument = {
  units: [{ number: 1, text: "HTTP 規格說明：伺服器以狀態碼回傳結果。" }, { number: 2, text: "重試政策：429 代表請求過於頻繁。" }],
  unitLabel: "page", totalUnits: 2, parsedUnits: 2, extractedChars: 40, warnings: [],
};
async function setup(t: TestContext, parser: (path: string, format: Parameters<typeof import("./document-parser.js").parseDocument>[1], signal: AbortSignal) => Promise<ParsedDocument> = async () => parsed) {
  const directory = await mkdtemp(join(tmpdir(), "bell-documents-test-"));
  const service = new DocumentService({ directory, parser });
  const referenced = new Set<string>();
  const app = express();
  app.use("/api", createDocumentRouter(service, id => referenced.has(id)));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(error instanceof AppError ? error.status : 500).json({ error: error instanceof Error ? error.message : "failed" }); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/documents`;
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (body: Buffer | string = "%PDF-1.7 fixture", name = "API 規格.pdf") => fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Document-Name": encodeURIComponent(name) }, body: typeof body === "string" ? body : Uint8Array.from(body) });
  return { service, directory, referenced, url, upload };
}

test("document upload retains original bytes, Unicode name, page citations and metadata across restart", async t => {
  const { service, directory, url, upload } = await setup(t);
  const bytes = Buffer.from("%PDF-1.7 original test bytes");
  const response = await upload(bytes, "../課程/API 規格.pdf");
  assert.equal(response.status, 201);
  const document = await response.json();
  assert.equal(document.name, "API 規格.pdf");
  assert.equal(document.size, bytes.length);
  assert.equal(document.sha256.length, 64);
  assert.match(document.preview, /\[第 1 頁\]/);
  assert.equal(document.parsedUnits, 2);
  assert.equal((await stat(join(directory, document.id))).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, document.id, "document.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, document.id, "original.pdf"))).mode & 0o777, 0o600);
  const restored = new DocumentService({ directory });
  t.after(() => restored.close());
  assert.deepEqual(await restored.get(document.id), document);
  const downloaded = await fetch(`${url}/${document.id}/file`);
  assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
  assert.match(downloaded.headers.get("content-disposition")!, /^attachment;/);
  assert.match(downloaded.headers.get("content-disposition")!, /filename\*=/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const source = await service.sourceForDocument(document.id, "", new AbortController().signal);
  assert.equal(source.kind, "document");
  assert.deepEqual(source.document?.selectedUnits, [1, 2]);
  assert.equal(source.truncated, false);
  assert.match(source.scope!, /僅解析可擷取的文字/);
  assert.equal(await (await fetch(`${url}/${document.id}/text`)).text(), source.content);
});

test("document deletion prevents removing referenced originals and removes abandoned uploads", async t => {
  const { url, upload, referenced, directory } = await setup(t);
  const document = await (await upload()).json();
  referenced.add(document.id);
  assert.equal((await fetch(`${url}/${document.id}`, { method: "DELETE" })).status, 409);
  assert.equal((await fetch(`${url}/${document.id}`)).status, 200);
  referenced.delete(document.id);
  assert.equal((await fetch(`${url}/${document.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${url}/${document.id}`)).status, 404);
  assert.deepEqual(await readdir(directory), []);
});

test("an upload whose stored metadata can no longer be read can still be removed", async t => {
  const { url, upload, directory } = await setup(t);
  const document = await (await upload()).json();
  await writeFile(join(directory, document.id, "document.json"), "{");
  assert.equal((await fetch(`${url}/${document.id}`)).status, 500);
  assert.equal((await fetch(`${url}/${document.id}`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await fetch(`${url}/${document.id}`, { method: "DELETE" })).status, 404);
});

test("file routes reject invalid names, formats, IDs, body types and oversized uploads before parsing", async t => {
  let calls = 0;
  const { upload, url, directory } = await setup(t, async () => { calls++; return parsed; });
  assert.equal((await upload("x", "file.exe")).status, 415);
  assert.equal((await upload("x", "")).status, 400);
  assert.equal((await upload("x", `${"x".repeat(256)}.pdf`)).status, 400);
  assert.equal((await upload("", "empty.txt")).status, 422);
  assert.equal((await fetch(`${url}/not-a-uuid`)).status, 400);
  assert.equal((await fetch(`${url}/f993cc81-8d57-449d-a98f-d4a560acef4f`)).status, 404);
  assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Document-Name": "x.pdf" }, body: "{}" })).status, 415);
  assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Document-Name": "%bad%zz" }, body: "x" })).status, 400);
  const oversized = await upload(Buffer.alloc(DOCUMENT_MAX_BYTES + 1), "large.pdf");
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, new RegExp(`${DOCUMENT_MAX_MB} MB`));
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("failed parsing cleans up binary and metadata and reports actionable errors", async t => {
  const { upload, directory } = await setup(t, async () => { throw new AppError(422, "這份 PDF 已加密，請先解鎖。"); });
  const response = await upload();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /解鎖/);
  assert.deepEqual(await readdir(directory), []);
});

test("upload admission reserves two slots before body reading and abort releases a slot", async t => {
  const { service, directory } = await setup(t);
  const held = (signal: AbortSignal) => new Promise<Buffer>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const first = new AbortController();
  const second = new AbortController();
  const promises = [service.upload("first.pdf", held, first.signal), service.upload("second.pdf", held, second.signal)];
  await assert.rejects(service.upload("third.pdf", Buffer.from("x"), new AbortController().signal), error => error instanceof AppError && error.status === 429);
  first.abort(); second.abort();
  await Promise.all(promises.map(promise => assert.rejects(promise, { name: "AbortError" })));
  const successful = await service.upload("retry.pdf", Buffer.from("x"), new AbortController().signal);
  assert.ok(successful.id);
  assert.equal((await readdir(directory)).length, 1);
});

test("aborting parsing removes the in-progress original and server shutdown aborts workers", async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { service, directory } = await setup(t, async (_path, _format, signal) => {
    started();
    return await new Promise<ParsedDocument>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = service.upload("cancel.pdf", Buffer.from("x"), new AbortController().signal);
  await ready;
  assert.equal((await readdir(directory)).length, 1);
  service.close();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(service.upload("retry.pdf", Buffer.from("x"), new AbortController().signal), error => error instanceof AppError && error.status === 503);
});

test("long documents select focus matches and balanced beginning, middle and end within the context bound", async t => {
  const units = Array.from({ length: 40 }, (_, index) => ({ number: index + 1, text: `${index === 28 ? "idempotency API retry policy. " : "General technical content. "}${"說明內容 ".repeat(950)}` }));
  const { service, upload } = await setup(t, async () => ({ units, unitLabel: "page", totalUnits: 240, parsedUnits: 40, extractedChars: units.reduce((sum, unit) => sum + unit.text.length, 0), warnings: ["只擷取部分頁面的文字。"] }));
  const document = await (await upload()).json();
  const source = await service.sourceForDocument(document.id, "idempotency", new AbortController().signal);
  assert.ok(source.content.length <= DOCUMENT_CONTEXT_CHARS);
  assert.match(source.content, /idempotency/);
  for (const unit of [1, 20, 29, 40]) assert.ok(source.document?.selectedUnits.includes(unit));
  assert.equal(source.truncated, true);
  assert.match(source.scope!, /共 240 頁/);
  assert.match(source.scope!, /已解析 40 頁/);
  assert.match(source.scope!, /不能視為完整逐頁閱讀/);
  assert.match(source.content, /內容略/);
});

test("many short paragraphs retain bounded scope and exact source unit citations", async t => {
  const units = Array.from({ length: 8_000 }, (_, index) => ({ number: index + 1, text: "一段簡短內容" }));
  const { service, upload } = await setup(t, async () => ({ units, unitLabel: "section", totalUnits: units.length, parsedUnits: units.length, extractedChars: 48_000, warnings: [] }));
  const document = await (await upload("text", "notes.docx")).json();
  const source = await service.sourceForDocument(document.id, "", new AbortController().signal);
  assert.ok(source.content.length <= DOCUMENT_CONTEXT_CHARS);
  assert.ok(source.content.length > 40_000, "short paragraphs should still fill the available reading context");
  assert.ok(source.scope!.length <= 20_000);
  assert.ok(source.document?.selectedUnits.includes(8_000));
  assert.match(source.content, /\[第 8000 段\]/);
  assert.equal(source.truncated, true);
});

test("a single long section includes its beginning, middle and end when no focus is specified", async t => {
  const text = `START ${"a".repeat(60_000)} MIDDLE ${"b".repeat(60_000)} END`;
  const { service, upload } = await setup(t, async () => ({ units: [{ number: 1, text }], unitLabel: "section", totalUnits: 1, parsedUnits: 1, extractedChars: text.length, warnings: [] }));
  const document = await (await upload("text", "manual.txt")).json();
  const source = await service.sourceForDocument(document.id, "", new AbortController().signal);
  assert.ok(source.content.length <= DOCUMENT_CONTEXT_CHARS);
  assert.match(source.content, /START/);
  assert.match(source.content, /MIDDLE/);
  assert.match(source.content, /END/);
  assert.match(source.content, /中間內容略/);
});

test("generation leases prevent deleting an original while it is in use", async t => {
  const { service, upload } = await setup(t);
  const document = await (await upload()).json();
  const first = service.acquire(document.id);
  const second = service.acquire(document.id);
  await assert.rejects(service.remove(document.id), error => error instanceof AppError && error.status === 409);
  first(); first();
  await assert.rejects(service.remove(document.id), error => error instanceof AppError && error.status === 409);
  second();
  const removal = service.remove(document.id);
  assert.throws(() => service.acquire(document.id), error => error instanceof AppError && error.status === 409);
  await removal;
  await assert.rejects(service.get(document.id), error => error instanceof AppError && error.status === 404);
});
