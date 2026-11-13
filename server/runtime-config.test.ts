import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { readRuntimeConfig, validateAllowedOrigins } from "./runtime-config.js";
import { createApp } from "./app.js";
import { LessonStore } from "./store.js";
import { exampleLessons } from "../shared/examples.js";

test("runtime defaults retain the local listener and require explicit remote origins", () => {
  assert.deepEqual(readRuntimeConfig({}), { host: "127.0.0.1", port: 3001, allowedOrigins: [], suiteLinks: {}, lessonV3: false });
  assert.deepEqual(readRuntimeConfig({ BELL_HOST: "100.64.0.10", BELL_PORT: "20001", BELL_ALLOWED_ORIGINS: "http://100.64.0.10:20001, https://bell.example.com,https://bell.example.com:443" }), {
    host: "100.64.0.10", port: 20001, allowedOrigins: ["http://100.64.0.10:20001", "https://bell.example.com"], suiteLinks: {}, lessonV3: false,
  });
  assert.equal(readRuntimeConfig({ BELL_HOST: "::1", BELL_PORT: "65535" }).host, "::1");
  assert.equal(readRuntimeConfig({ BELL_HOST: "box" }).host, "box");
  assert.deepEqual(validateAllowedOrigins(["http://[::1]:20001"]), ["http://[::1]:20001"]);
});

test("format-3 notes stay off unless BELL_LESSON_V3=1", () => {
  assert.equal(readRuntimeConfig({}).lessonV3, false);
  assert.equal(readRuntimeConfig({ BELL_LESSON_V3: "" }).lessonV3, false);
  assert.equal(readRuntimeConfig({ BELL_LESSON_V3: "0" }).lessonV3, false);
  assert.equal(readRuntimeConfig({ BELL_LESSON_V3: " 1 " }).lessonV3, true);
  for (const value of ["true", "yes", "on", "2", "v3"]) assert.throws(() => readRuntimeConfig({ BELL_LESSON_V3: value }), /BELL_LESSON_V3/, value);
});

test("invalid listener addresses and ports fail during runtime configuration", () => {
  for (const host of ["", "*", "https://host", "host:20001", "host/path", "host name", "[::1]", "256.1.2.3", "-host", "host."]) {
    assert.throws(() => readRuntimeConfig({ BELL_HOST: host }), /BELL_HOST/, host);
  }
  for (const port of ["", "0", "65536", "-1", "20.5", "2e4", "20001x", "Infinity"]) {
    assert.throws(() => readRuntimeConfig({ BELL_PORT: port }), /BELL_PORT/, port);
  }
});

test("origin configuration rejects paths, wildcards, credentials, and malformed entries", () => {
  for (const origin of [
    "*", "https://*.example.com", "example.com", "file:///tmp", "ftp://example.com",
    "https://user:secret@example.com", "https://@example.com", "https://example.com/",
    "https://example.com/path", "https://example.com?x=1", "https://example.com#part",
    "https://example.com\\path", "https://exam ple.com", "https://example.com:",
    "https://example.com:99999", "https://example.com,", "https://example.com,,http://localhost",
  ]) {
    assert.throws(() => readRuntimeConfig({ BELL_ALLOWED_ORIGINS: origin }), /BELL_ALLOWED_ORIGINS/, origin);
  }
  assert.throws(() => validateAllowedOrigins(Array.from({ length: 33 }, (_, index) => `https://host${index}.example.com`)), /BELL_ALLOWED_ORIGINS/);
});

async function setup(t: TestContext, allowedOrigins: string[] = []) {
  const store = new LessonStore(":memory:", exampleLessons);
  const server = createServer(createApp({ store, examples: exampleLessons, config: { apiKey: "", model: "", baseUrl: "https://api.openai.com/v1" }, allowedOrigins }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  // Node fetch can normalize protected headers; raw HTTP exercises the actual
  // Host, Origin, and Fetch Metadata values received from a browser/proxy.
  const request = (headers: Record<string, string>, method = "GET") => new Promise<{ status: number }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: `/api/lessons${method === "DELETE" ? "/demo-closure" : ""}`, method, headers }, response => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode! }));
    });
    request.once("error", reject);
    request.end();
  });
  return { request, port, store };
}

test("configured remote origin permits browser requests and retains Host/Origin/cross-site rejection", async t => {
  const { request, store } = await setup(t, ["http://100.64.0.10:20001", "https://bell.example.com"]);
  assert.equal((await request({ host: "100.64.0.10:20001", origin: "http://100.64.0.10:20001", "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await request({ host: "bell.example.com", origin: "https://bell.example.com" })).status, 200);
  assert.equal((await request({ host: "100.64.0.10:20001" })).status, 200);
  const rejectedHeaders: Record<string, string>[] = [
    { host: "unconfigured.example.com", origin: "http://100.64.0.10:20001" },
    { host: "100.64.0.10:20002", origin: "http://100.64.0.10:20001" },
    { host: "100.64.0.10:20001", origin: "http://100.64.0.10:20002" },
    { host: "100.64.0.10:20001", origin: "https://unconfigured.example.com" },
    { host: "100.64.0.10:20001", origin: "null" },
    { host: "100.64.0.10:20001", origin: "http://100.64.0.10:20001", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of rejectedHeaders) {
    assert.equal((await request(headers, "DELETE")).status, 403);
  }
  assert.ok(store.get("demo-closure"), "rejected requests must not mutate notes");
});

test("loopback browsers work on the actual listener port without broadening remote access", async t => {
  const { request, port } = await setup(t);
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal((await request({ host: `${hostname}:${port}`, origin: `http://${hostname}:${port}` })).status, 200);
  }
  assert.equal((await request({ host: `localhost:${port}`, origin: `http://localhost:${port === 65535 ? 65534 : port + 1}` })).status, 403);
  assert.equal((await request({ host: "100.64.0.10:20001", origin: "http://100.64.0.10:20001" })).status, 403);
  for (const host of ["127.0.0.1:3001", "localhost:3001", "127.0.0.1:5173", "localhost:5173"]) {
    assert.equal((await request({ host, origin: `http://${host}` })).status, 200);
  }
});
