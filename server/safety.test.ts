import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exampleLessons } from "../shared/examples.js";
import type { Lesson } from "../shared/types.js";
import { createApp } from "./app.js";
import { BASELINE, migrate } from "./db/migrate.js";
import { schemaFailure } from "./errors.js";
import { loggedChat } from "./provider-router.js";
import { LessonStore } from "./store.js";

function directory(t: TestContext, prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    // Snapshots are read-only on purpose; make them removable for cleanup.
    spawnSync("chmod", ["-R", "u+w", path]);
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
/** Collects BELL log lines written while `run` executes. */
async function logs<T>(run: () => Promise<T> | T): Promise<{ result: T; lines: Array<Record<string, unknown>> }> {
  const lines: Array<Record<string, unknown>> = [];
  const write = process.stdout.write.bind(process.stdout);
  const previous = process.env.BELL_LOG;
  process.env.BELL_LOG = "on";
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith("{\"time\"")) { lines.push(JSON.parse(text)); return true; }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try { return { result: await run(), lines }; }
  finally { process.stdout.write = write; if (previous === undefined) delete process.env.BELL_LOG; else process.env.BELL_LOG = previous; }
}

test("migrations record the baseline, refuse newer databases and roll back failed steps", async t => {
  const path = join(directory(t, "bell-migrate-"), "data.sqlite");
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  assert.equal(migrate(db, "測試", BASELINE, path), 1);
  assert.equal(existsSync(`${path}.before-v1`), false, "recording the baseline needs no copy");
  const steps = [...BASELINE, { version: 2, up: (target: DatabaseSync) => target.exec("ALTER TABLE items ADD COLUMN note TEXT") }];
  assert.equal(migrate(db, "測試", steps, path), 2);
  assert.ok(existsSync(`${path}.before-v2`), "a data migration keeps a copy first");
  assert.throws(() => migrate(db, "測試", BASELINE, path), /版本 2 比這個 BELL 版本支援的 1 新/);
  const failing = [...steps, { version: 3, up: (target: DatabaseSync) => { target.exec("CREATE TABLE extra (id TEXT)"); throw new Error("boom"); } }];
  assert.throws(() => migrate(db, "測試", failing, path), /boom/);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='extra'").get(), undefined);
});

test("deleted notes go to the trash and an unreadable row is skipped instead of breaking the library", async t => {
  const dir = directory(t, "bell-store-");
  const store = new LessonStore(join(dir, "bell.sqlite"), exampleLessons);
  t.after(() => store.close());
  const lesson = exampleLessons[0];
  assert.equal(store.delete(lesson.id), true);
  const [trashed] = readdirSync(join(dir, "trash"));
  assert.equal((JSON.parse(readFileSync(join(dir, "trash", trashed), "utf8")) as Lesson).id, lesson.id);
  assert.equal(statSync(join(dir, "trash", trashed)).mode & 0o777, 0o600);
  assert.equal(store.delete("missing"), false);
  // Trash older than the retention period is removed when the store opens.
  const { utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 31 * 86_400_000);
  writeFileSync(join(dir, "trash", "old-note.json"), "{}");
  utimesSync(join(dir, "trash", "old-note.json"), old, old);
  new LessonStore(join(dir, "bell.sqlite"), []).close();
  assert.deepEqual(readdirSync(join(dir, "trash")), [trashed]);
  const raw = new DatabaseSync(join(dir, "bell.sqlite"));
  raw.prepare("INSERT INTO lessons (id, json, updated_at) VALUES ('broken', '{not json', 'x')").run();
  raw.close();
  const { result, lines } = await logs(() => store.listRaw());
  assert.equal(result.length, exampleLessons.length - 1);
  assert.deepEqual(lines.map(line => [line.event, line.id]), [["store.unreadable", "broken"]]);
  assert.equal((new DatabaseSync(join(dir, "bell.sqlite")).prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
});

test("validation failures log field paths and codes but never the model's values", async () => {
  const { lines } = await logs(() => {
    const error = schemaFailure("教學代理", "教學代理回傳的結構不完整", { issues: [{ path: ["sections", 2, "visualStep"], code: "too_big" }] });
    assert.equal(error.status, 502);
    assert.deepEqual(error.issues, [{ path: "sections.2.visualStep", code: "too_big" }]);
  });
  assert.deepEqual(lines.map(({ event, stage, issues }) => ({ event, stage, issues })), [{ event: "schema.invalid", stage: "教學代理", issues: [{ path: "sections.2.visualStep", code: "too_big" }] }]);
});

test("every model call logs its role, outcome, duration and reported token usage", async () => {
  const chat = loggedChat(async (_role, _instruction, _data, _signal, onProgress) => {
    onProgress?.({ phase: "writing", outputChars: 12, usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340 } });
    return { ok: true };
  }, { provider: "claude", model: "claude-opus-5-5", effort: "medium" });
  const failing = loggedChat(async () => { throw new DOMException("stop", "AbortError"); }, { provider: "codex", model: "m", effort: "low" });
  const seen: string[] = [];
  const { lines } = await logs(async () => {
    await chat("教學代理", "x", { secret: "SOURCE TEXT" }, new AbortController().signal, progress => seen.push(progress.phase));
    await assert.rejects(failing("分析代理", "x", {}, new AbortController().signal));
  });
  assert.deepEqual(seen, ["writing"]);
  assert.deepEqual(lines.map(({ event, role, outcome, usage, model }) => ({ event, role, outcome, usage, model })), [
    { event: "gen.call", role: "教學代理", outcome: "ok", usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340 }, model: "claude-opus-5-5" },
    { event: "gen.call", role: "分析代理", outcome: "AbortError", usage: undefined, model: "m" },
  ]);
  assert.equal(JSON.stringify(lines).includes("SOURCE TEXT"), false);
});

test("health reports the running release; failures and writes are logged with a request id", async t => {
  const store = new LessonStore(":memory:", exampleLessons);
  const app = createApp({ store, examples: exampleLessons, config: { apiKey: "", baseUrl: "https://example.test/v1", model: "" } });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { host: "127.0.0.1:3001" };
  const { result, lines } = await logs(async () => {
    const health = await (await fetch(`${base}/api/health`, { headers })).json();
    const missing = await fetch(`${base}/api/lessons/nope`, { headers });
    await fetch(`${base}/api/lessons`, { headers });
    return { health, missing };
  });
  assert.equal(result.health.status, "ok");
  assert.equal(result.health.lessons, exampleLessons.length);
  assert.equal(typeof result.health.release, "string");
  assert.ok(result.missing.headers.get("x-request-id"));
  // The successful library poll is not logged; the 404 is.
  assert.deepEqual(lines.filter(line => line.event === "http").map(line => [line.path, line.status, line.id]), [["/api/lessons/nope", 404, result.missing.headers.get("x-request-id")]]);
});

const python = ["/usr/bin/python3", "python3"].find(candidate => spawnSync(candidate, ["--version"]).status === 0);
test("online snapshots copy notes, cited uploads and repo caches, skip models, and become read-only; prune keeps recent days and weeks", { skip: !python && "python3 is not installed" }, async t => {
  const root = directory(t, "bell-backup-");
  const data = join(root, "data");
  const store = new LessonStore(join(data, "bell.sqlite"), exampleLessons);
  const id = "11111111-2222-4333-8444-555555555555";
  store.save({ ...exampleLessons[0], id: "pdf-lesson", isDemo: false, source: { ...exampleLessons[0].source, kind: "document", document: { id } as never } });
  store.close();
  mkdirSync(join(data, "documents", id), { recursive: true });
  writeFileSync(join(data, "documents", id, "document.json"), "{}");
  writeFileSync(join(data, "documents", id, "original.pdf"), "%PDF-1.7");
  mkdirSync(join(data, "index-cache", "models"), { recursive: true });
  writeFileSync(join(data, "index-cache", "models", "weights.onnx"), "x".repeat(1000));
  mkdirSync(join(data, "index-cache", "repositories", "repo"), { recursive: true });
  writeFileSync(join(data, "index-cache", "repositories", "repo", "HEAD"), "ref: refs/heads/main\n");
  const script = new URL("../deployment/migrate-data.py", import.meta.url).pathname;
  const backups = join(root, "backups");
  const result = JSON.parse(execFileSync(python!, [script, "snapshot", data, "--online", "--into", backups], { encoding: "utf8" }));
  assert.equal(result.citedDocuments, 1);
  assert.deepEqual(result.skipped, ["index-cache/models"]);
  const snapshot = result.snapshot as string;
  assert.ok(existsSync(join(snapshot, "documents", id, "original.pdf")));
  assert.ok(existsSync(join(snapshot, "index-cache", "repositories", "repo", "HEAD")));
  assert.equal(existsSync(join(snapshot, "index-cache", "models")), false);
  assert.equal(statSync(snapshot).mode & 0o777, 0o500);
  assert.equal(statSync(join(snapshot, "bell.sqlite")).mode & 0o777, 0o400);
  const copy = new DatabaseSync(join(snapshot, "bell.sqlite"), { readOnly: true });
  assert.ok(copy.prepare("SELECT 1 FROM lessons WHERE id='pdf-lesson'").get());
  copy.close();
  assert.deepEqual(readdirSync(snapshot).filter(name => /-(wal|shm)$/.test(name)), [], "copies leave no WAL sidecars");
  // Restore gives a writable data directory that BELL can use again.
  const restored = join(root, "restored");
  execFileSync(python!, [script, "restore", snapshot, restored]);
  assert.equal(existsSync(join(restored, "manifest.json")), false);
  const reopened = new LessonStore(join(restored, "bell.sqlite"), []);
  reopened.save({ ...exampleLessons[1], id: "after-restore" });
  assert.ok(reopened.getRaw("after-restore"));
  reopened.close();
  assert.throws(() => execFileSync(python!, [script, "restore", snapshot, restored], { stdio: "pipe" }), /exists/);
  // A failed snapshot leaves nothing behind, and a pre-deploy snapshot is never pruned.
  writeFileSync(join(data, "broken.sqlite"), "not a database");
  assert.throws(() => execFileSync(python!, [script, "snapshot", data, "--online", "--into", backups], { stdio: "pipe" }));
  rmSync(join(data, "broken.sqlite"));
  assert.deepEqual(readdirSync(backups), [snapshot.split("/").at(-1)]);
  const predeploy = JSON.parse(execFileSync(python!, [script, "snapshot", data, "--online", "--into", backups, "--prefix", "pre-deploy"], { encoding: "utf8" })).snapshot as string;
  assert.match(predeploy, /\/pre-deploy-\d{8}-\d{6}$/);
  // Old automatic snapshots: keep the newest per day for 2 days and per ISO week for 2 weeks; never touch manual ones.
  for (const name of ["auto-20260901-010000", "auto-20260915-010000", "auto-20260916-010000", "auto-20260929-010000", "auto-20260930-010000", "auto-20260930-120000", "auto-20261001-090000", "manual-before-upgrade"]) {
    mkdirSync(join(backups, name, "nested"), { recursive: true });
    writeFileSync(join(backups, name, "nested", "file"), "x");
    // The 2026-10-01 folder is an interrupted old-style snapshot without a manifest.
    if (name !== "auto-20261001-090000") writeFileSync(join(backups, name, "manifest.json"), "{}");
    chmodSync(join(backups, name, "nested", "file"), 0o400);
    chmodSync(join(backups, name, "nested"), 0o500);
  }
  const pruned = JSON.parse(execFileSync(python!, [script, "prune", backups, "--keep-daily", "2", "--keep-weekly", "2"], { encoding: "utf8" }));
  const newest = snapshot.split("/").at(-1);
  assert.deepEqual(pruned.removed.sort(), ["auto-20260901-010000", "auto-20260915-010000", "auto-20260916-010000", "auto-20260929-010000", "auto-20260930-010000", "auto-20261001-090000"]);
  assert.deepEqual(readdirSync(backups).sort(), ["auto-20260930-120000", newest, "manual-before-upgrade", predeploy.split("/").at(-1)].sort());
});
