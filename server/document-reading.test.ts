import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleLessons } from "../shared/examples.js";
import type { DocumentPreview } from "../shared/documents.js";
import type { GenerateEvent } from "../shared/types.js";
import { createApp } from "./app.js";
import type { ChatCall, ChatImage } from "./ai.js";
import type { PageMetrics, ParsedDocument, RenderedPage } from "./document-parser.js";
import { DocumentService, visualPages } from "./documents.js";
import { AppError } from "./errors.js";
import { JobRegistry } from "./jobs.js";
import { LessonStore } from "./store.js";

// Every page draws the template (one logo, four paths, a header spread across the line).
const LOGO = "300x80";
// The logo is one image reused on every page: pdf.js shares its id from the second use on.
const logo = (page: number) => (page === 1 ? [] : [`d1_img_p0_1=${LOGO}`]);
const plain = (page: number): PageMetrics => ({ page, images: 1, paths: 4, gaps: 1, sizes: [LOGO], shared: logo(page) });
const metrics: PageMetrics[] = [
  plain(1), plain(2),
  { page: 3, images: 1, paths: 12, gaps: 3, sizes: [LOGO], shared: logo(3) }, // a formula drawn as graphics, leaving gaps in a line
  plain(4),
  { page: 5, images: 1, paths: 60, gaps: 1, sizes: [LOGO], shared: logo(5) }, // a diagram
  { page: 6, images: 3, paths: 4, gaps: 1, sizes: [LOGO, "800x600", "640x480"], shared: logo(6) }, // screenshots
  plain(7), plain(8),
];

test("visual pages are measured against the template, so logos and headers do not count", () => {
  const pages = visualPages(metrics, [8]);
  assert.deepEqual(pages.map(item => item.page).sort((a, b) => a - b), [3, 5, 6, 8]);
  assert.equal(pages[0].page, 8, "a page without a text layer comes first");
  assert.deepEqual(visualPages([plain(1), plain(2), plain(3)]), []);
});

test("short files and decks with a figure on most slides still have visual pages", () => {
  // One page with a chart: nothing to compare with, but the figure and drawings count.
  assert.deepEqual(visualPages([{ page: 1, images: 1, paths: 80, gaps: 0, sizes: ["600x400"] }]).map(item => item.page), [1]);
  assert.deepEqual(visualPages([{ page: 1, images: 0, paths: 80, gaps: 0, sizes: [] }]).map(item => item.page), [1], "a vector chart");
  // Figures on 9 of 10 slides: each figure has its own size, so none looks like a template.
  const deck = Array.from({ length: 10 }, (_, index): PageMetrics => ({ page: index + 1, images: index ? 2 : 1, paths: 4, gaps: 1, sizes: index ? [LOGO, `${500 + index}x400`] : [LOGO] }));
  assert.deepEqual(visualPages(deck).map(item => item.page).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // A ruled table's many cell gaps do not outrank a figure.
  const table: PageMetrics = { page: 11, images: 1, paths: 30, gaps: 40, sizes: [LOGO] };
  const ranked = visualPages([...deck, table]);
  assert.ok(ranked.findIndex(item => item.page === 11) > ranked.findIndex(item => item.page === 2));
});

const parsed: ParsedDocument = {
  units: [1, 2, 3, 4, 5, 6, 7].map(number => ({ number, text: number === 3 ? "傳播延遲 =   ，因此至少要送出   位元。" : `第 ${number} 頁：乙太網路。` })),
  unitLabel: "page", totalUnits: 8, parsedUnits: 8, extractedChars: 120, warnings: [], outline: [], imageOnlyUnits: [8],
};
const reply = (pages: number[]) => ({ pages: pages.map(page => ({
  page,
  text: page === 3 ? "傳播延遲 \\(\\tau\\)，因此至少要送出 \\(2\\tau R\\) 位元。" : `第 ${page} 頁的完整轉寫`,
  visuals: page === 5 ? [{ kind: "diagram", description: "交換器連接三台主機，箭頭表示訊框轉送方向。" }] : [],
})) });

async function setup(t: TestContext, chat: ChatCall, jobs = new JobRegistry()) {
  const directory = await mkdtemp(join(tmpdir(), "bell-reading-"));
  const rendered: Array<{ required: number[]; candidates: number[]; ranked?: boolean; maxEdge?: number }> = [];
  const documents = new DocumentService({
    directory,
    parser: async () => parsed,
    inspector: async () => metrics,
    renderer: async (_path, pages, _signal, options) => {
      rendered.push({ required: pages.required, candidates: pages.candidates, ranked: pages.ranked, maxEdge: options?.maxEdge });
      const chosen = [...pages.required, ...(pages.ranked ? pages.candidates : [])].slice(0, pages.limit);
      return chosen.map((page): RenderedPage => ({ page, mimeType: "image/png", data: "iVBORw0KGgo=", width: 10, height: 14 }));
    },
  });
  const store = new LessonStore(":memory:", exampleLessons);
  const server = createServer(createApp({ store, examples: exampleLessons, documents, jobs, chat, progressIntervalMs: 10_000,
    config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "m" } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await documents.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const preview = await documents.upload("講義.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal);
  const read = (body: unknown = {}) => fetch(`${base}/documents/${preview.id}/readings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line) as GenerateEvent);
  const current = async () => (await (await fetch(`${base}/documents/${preview.id}`)).json()) as DocumentPreview;
  return { documents, preview, rendered, read, events, current, base };
}

test("a deep reading reads the visual pages once, a few per call, and lessons use it afterwards", async t => {
  const calls: Array<{ pages: number[]; images: string[] }> = [];
  const chat: ChatCall = async (_role, _instruction, data, _signal, _progress, images: ChatImage[] = []) => {
    const pages = (data as { pages: Array<{ page: number }> }).pages.map(page => page.page);
    calls.push({ pages, images: images.map(image => image.label) });
    return reply(pages);
  };
  const { documents, preview, rendered, read, events, current } = await setup(t, chat);
  assert.deepEqual(preview.visualUnits, [8, 6, 5, 3], "most visual first: scans, figures, diagrams, then formulas");
  assert.deepEqual(preview.readUnits, []);
  const outcome = await events(await read());
  assert.equal(outcome[0].type, "job");
  assert.deepEqual(outcome.at(-1), { type: "read", documentId: preview.id, pages: 4 });
  assert.deepEqual(calls.map(call => call.pages), [[3, 5, 6, 8]]);
  assert.deepEqual(calls[0].images, ["第 3 頁影像", "第 5 頁影像", "第 6 頁影像", "第 8 頁影像"]);
  assert.equal(rendered[0].maxEdge, 1600, "rendered large enough for formulas");
  assert.deepEqual((await current()).readUnits, [3, 5, 6, 8]);
  // Nothing left: refused before any model call.
  const again = await read();
  assert.equal(again.status, 409);
  assert.equal(calls.length, 1);
  // A lesson uses the transcription: formulas, figure descriptions and the scan page's text.
  rendered.length = 0;
  const { source, images } = await documents.lessonInput(preview.id, { question: "", visual: true }, t.signal);
  assert.match(source.content, /\\\(2\\tau R\\\)/);
  assert.match(source.content, /示意圖：交換器連接三台主機/);
  assert.match(source.content, /\[第 8 頁\]\n第 8 頁的完整轉寫/);
  assert.match(source.scope ?? "", /深度解析的模型轉寫/);
  // Read pages need no image any more.
  assert.equal(images.length, 0);
  assert.deepEqual(rendered[0], { required: [], candidates: [], ranked: true, maxEdge: undefined });
});

test("without a reading, page images go to the most visual pages and the rest are named", async t => {
  const { documents, preview, rendered } = await setup(t, async () => ({}));
  const { source } = await documents.lessonInput(preview.id, { question: "", visual: true }, t.signal);
  assert.deepEqual(rendered[0].required, [8]);
  assert.deepEqual(rendered[0].candidates, [6, 5, 3]);
  assert.equal(rendered[0].ranked, true);
  assert.match(source.scope ?? "", /另附 4 頁頁面影像/);
});

test("stopping a deep reading keeps the pages already read; the next run continues", async t => {
  let calls = 0;
  const chat: ChatCall = async (_role, _instruction, data, signal) => {
    calls++;
    const pages = (data as { pages: Array<{ page: number }> }).pages.map(page => page.page);
    if (calls === 1) return reply(pages);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  // Twelve visual pages among thirty make three batches.
  const many: PageMetrics[] = Array.from({ length: 30 }, (_, index) => index < 12 ? { page: index + 1, images: 3, paths: 4, gaps: 1 } : plain(index + 1));
  const { read, current, base } = await setupWith(t, chat, many);
  const response = await read();
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const { id } = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]) as { id: string };
  while (calls < 2) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await fetch(`${base}/jobs/${id}`, { method: "DELETE" })).status, 204);
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual((await current()).readUnits, [1, 2, 3, 4]);
});

async function setupWith(t: TestContext, chat: ChatCall, pages: PageMetrics[]) {
  const directory = await mkdtemp(join(tmpdir(), "bell-reading-"));
  const documents = new DocumentService({
    directory,
    parser: async () => ({ ...parsed, units: pages.map(page => ({ number: page.page, text: `第 ${page.page} 頁` })), totalUnits: pages.length, parsedUnits: pages.length, imageOnlyUnits: [] }),
    inspector: async () => pages,
    renderer: async (_path, request) => request.required.map((page): RenderedPage => ({ page, mimeType: "image/png", data: "iVBORw0KGgo=", width: 10, height: 14 })),
  });
  const store = new LessonStore(":memory:", exampleLessons);
  const server = createServer(createApp({ store, examples: exampleLessons, documents, chat, progressIntervalMs: 10_000,
    config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "m" } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await documents.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const preview = await documents.upload("講義.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal);
  const read = (body: unknown = {}) => fetch(`${base}/documents/${preview.id}/readings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line) as GenerateEvent);
  const current = async () => (await (await fetch(`${base}/documents/${preview.id}`)).json()) as DocumentPreview;
  return { documents, preview, read, events, current, base };
}

test("deep reading respects the page range, the single reading slot, and does not block lessons", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const chat: ChatCall = async (role, _instruction, data, signal) => {
    if (role !== "文件深度解析代理") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await gate;
    return reply((data as { pages: Array<{ page: number }> }).pages.map(page => page.page));
  };
  const { preview, read, events, current, base } = await setup(t, chat);
  const ranged = read({ range: { start: 5, end: 6 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  // A second reading of the same file joins the first; a lesson still starts.
  const joined = read({ range: { start: 1, end: 8 } });
  const lesson = await fetch(`${base}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "code", depth: "beginner", content: "let x = 1;" }) });
  assert.equal(lesson.status, 200);
  const lessonReader = lesson.body!.getReader();
  const lessonJob = JSON.parse(new TextDecoder().decode((await lessonReader.read()).value).split("\n")[0]) as { id: string };
  await fetch(`${base}/jobs/${lessonJob.id}`, { method: "DELETE" });
  await lessonReader.cancel();
  release();
  const [first, second] = await Promise.all([events(await ranged), events(await joined)]);
  assert.deepEqual(first.at(-1), { type: "read", documentId: preview.id, pages: 2 });
  assert.deepEqual(second[0], first[0], "the same job");
  assert.deepEqual((await current()).readUnits, [5, 6]);
  assert.equal((await read({ range: { start: 9, end: 9 } })).status, 400);
});

/** An app with every document dependency replaceable, for the edge cases below. */
async function appWith(t: TestContext, options: {
  chat?: ChatCall; pages?: number; parsedPages?: number; encrypted?: boolean;
  inspector?: ConstructorParameters<typeof DocumentService>[0]["inspector"]; inspectTimeoutMs?: number; progressIntervalMs?: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), "bell-reading-"));
  const pages = options.pages ?? 6;
  const parsedPages = options.parsedPages ?? pages;
  const documents = new DocumentService({
    directory,
    parser: async () => ({ units: Array.from({ length: parsedPages }, (_, index) => ({ number: index + 1, text: `第 ${index + 1} 頁` })),
      unitLabel: "page", totalUnits: pages, parsedUnits: parsedPages, extractedChars: 10, warnings: [], outline: [], imageOnlyUnits: [], encrypted: options.encrypted }),
    inspector: options.inspector ?? (async (_path, _signal, request) => Array.from({ length: Math.min(pages, request?.limit ?? pages) }, (_, index) => index === 1 ? { page: 2, images: 1, paths: 4, gaps: 0, sizes: ["900x700"] } : { page: index + 1, images: 0, paths: 4, gaps: 0, sizes: [] })),
    inspectTimeoutMs: options.inspectTimeoutMs,
    renderer: async (_path, request) => request.required.map((page): RenderedPage => ({ page, mimeType: "image/png", data: "iVBORw0KGgo=", width: 10, height: 14 })),
  });
  const store = new LessonStore(":memory:", exampleLessons);
  const server = createServer(createApp({ store, examples: exampleLessons, documents, chat: options.chat ?? (async () => ({})), progressIntervalMs: options.progressIntervalMs ?? 10_000,
    config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "m" } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await documents.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const upload = () => documents.upload("講義.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal, options.encrypted ? { password: "right" } : {});
  const read = (id: string, body: unknown = {}) => fetch(`${base}/documents/${id}/readings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line) as GenerateEvent);
  return { documents, base, upload, read, events };
}
const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
/** Fails after a wall-clock bound far above any normal delay, instead of hanging until the test timeout. */
async function within<T>(promise: Promise<T>, what: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
/** Polls until the check holds, with the same generous bound, so a busy machine only makes it slower. */
async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(`Timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("a slow inspection never fails an upload, and opening the file does not wait for it", async t => {
  // The background inspection stays open until release(), so the outcome does not depend on machine speed.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const inspecting = new Promise<void>(resolve => { started = resolve; });
  const { documents, upload } = await appWith(t, {
    inspectTimeoutMs: 30,
    inspector: async (_path, signal) => {
      calls++;
      if (calls === 1) return waitForAbort(signal);
      started();
      await Promise.race([gate, waitForAbort(signal)]);
      return [{ page: 1, images: 1, paths: 4, gaps: 0, sizes: ["900x700"] }];
    },
  });
  const preview = await upload();
  assert.equal(preview.visualUnits, undefined, "deferred, not failed");
  // The inspection cannot finish before release(), so get() resolving at all shows it did not wait.
  assert.equal((await within(documents.get(preview.id), "the preview waited for the inspection")).visualUnits, undefined);
  await within(inspecting, "opening the file did not start a background inspection");
  release();
  await eventually(async () => (await documents.get(preview.id)).visualUnits !== undefined, "the background inspection was not stored");
  assert.deepEqual((await documents.get(preview.id)).visualUnits, [1], "inspected in the background meanwhile");
  assert.equal(calls, 2, "checking again while it ran did not start another inspection");
});

test("a wrong password is reported as such and does not block later inspection", async t => {
  const { documents, upload } = await appWith(t, {
    encrypted: true,
    inspector: async (_path, _signal, request) => {
      if (request?.password !== "right") throw new AppError(423, "PDF 密碼不正確，請重新輸入。");
      return [{ page: 2, images: 1, paths: 4, gaps: 0, sizes: ["900x700"] }];
    },
  });
  // The upload used the right password; simulate a file stored before inspection existed.
  const preview = await upload();
  const path = join((documents as unknown as { directory: string }).directory, preview.id, "document.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  delete stored.metrics;
  await writeFile(path, JSON.stringify(stored));
  await assert.rejects(documents.readingPlan(preview.id, { password: "wrong" }, t.signal), /密碼不正確/);
  const plan = await documents.readingPlan(preview.id, { password: "right" }, t.signal);
  assert.deepEqual(plan.pages.map(page => page.page), [2]);
});

test("blank pages count as read, pages past the parsed ones are ignored, and progress names the batch", async t => {
  const stages: string[] = [];
  const { upload, read, events, documents } = await appWith(t, {
    pages: 8, parsedPages: 6, progressIntervalMs: 15,
    inspector: async (_path, _signal, request) => {
      assert.equal(request?.limit, 6, "only parsed pages are inspected");
      return [1, 2, 3, 4, 5, 6, 7, 8].map(page => ({ page, images: page === 2 || page === 8 ? 1 : 0, paths: 4, gaps: 0, sizes: page === 2 || page === 8 ? [`9${page}0x700`] : [] }));
    },
    chat: async (_role, _instruction, data) => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { pages: (data as { pages: Array<{ page: number }> }).pages.map(({ page }) => ({ page, text: "", visuals: [] })) };
    },
  });
  const preview = await upload();
  assert.deepEqual(preview.visualUnits, [2]);
  const outcome = await events(await read(preview.id));
  for (const event of outcome) if (event.type === "stage") stages.push(event.message);
  assert.deepEqual(outcome.at(-1), { type: "read", documentId: preview.id, pages: 1 });
  assert.ok(stages.some(message => /正在深度解析第 2 頁（已完成 0\/1 頁）：模型/.test(message)), stages.join("\n"));
  assert.deepEqual((await documents.get(preview.id)).readUnits, [2]);
  assert.equal((await read(preview.id)).status, 409, "the blank page is not read again");
  const { source } = await documents.lessonInput(preview.id, { question: "" }, t.signal);
  assert.match(source.content, /\[第 2 頁\]\n第 2 頁/, "a blank reading keeps the text layer");
  assert.doesNotMatch(source.scope ?? "", /深度解析的模型轉寫/);
});

test("removing an unused upload stops its deep reading and removes the file", async t => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { upload, read, base, documents } = await appWith(t, { chat: async (_role, _instruction, _data, signal) => { started(); return waitForAbort(signal); } });
  const preview = await upload();
  const response = await read(preview.id);
  const reader = response.body!.getReader();
  await running;
  const removed = await fetch(`${base}/documents/${preview.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  await reader.cancel();
  await assert.rejects(documents.get(preview.id), /找不到這份原始檔案/);
});

test("figures that share a pixel size still count; only an image the PDF reuses across pages is the template", () => {
  // pdf.js reports a reused image with one shared id from its second use on; its first use is local.
  const logo = (page: number) => page === 1 ? [] : [`d1_img_p0_1=${LOGO}`];
  const deck = Array.from({ length: 10 }, (_, index): PageMetrics => {
    const page = index + 1;
    const chart = page % 2 === 1 && page > 1;
    return { page, images: chart ? 2 : 1, paths: 4, gaps: 1, sizes: chart ? [LOGO, "640x480"] : [LOGO], shared: logo(page) };
  });
  assert.deepEqual(visualPages(deck).map(item => item.page).sort((a, b) => a - b), [3, 5, 7, 9]);
  // A three-page handout with two different charts of the same size.
  const handout: PageMetrics[] = [1, 2, 3].map(page => ({ page, images: page > 1 ? 1 : 0, paths: 4, gaps: 0, sizes: page > 1 ? ["640x480"] : [], shared: [] }));
  assert.deepEqual(visualPages(handout).map(item => item.page).sort((a, b) => a - b), [2, 3]);
});

test("removing a file in use by a lesson is refused before its deep reading is touched", async t => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { upload, read, base, documents } = await appWith(t, { chat: async (_role, _instruction, _data, signal) => { started(); return waitForAbort(signal); } });
  const preview = await upload();
  const reader = (await read(preview.id)).body!.getReader();
  await running;
  // A lesson from this file holds it too.
  const release = documents.acquire(preview.id);
  const refused = await fetch(`${base}/documents/${preview.id}`, { method: "DELETE" });
  assert.equal(refused.status, 409);
  const jobs = await (await fetch(`${base}/jobs`)).json();
  assert.equal(jobs.find((job: { kind: string }) => job.kind === "reading")?.status, "running", "the reading was not stopped for nothing");
  release();
  // With only the reading left, removal stops it with a message saying why.
  assert.equal((await fetch(`${base}/documents/${preview.id}`, { method: "DELETE" })).status, 204);
  const text = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array()) + new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  void text;
  const ended = (await (await fetch(`${base}/jobs`)).json()).find((job: { kind: string }) => job.kind === "reading");
  assert.equal(ended.status, "cancelled");
  assert.match(ended.error, /檔案已移除/);
  await reader.cancel();
});

test("a lesson saved while a removal waits for the reading to stop keeps its file", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bell-reading-"));
  const documents = new DocumentService({ directory, parser: async () => parsed, inspector: async () => metrics,
    renderer: async (_path, request) => request.required.map((page): RenderedPage => ({ page, mimeType: "image/png", data: "", width: 1, height: 1 })) });
  t.after(async () => { await documents.close(); await rm(directory, { recursive: true, force: true }); });
  const preview = await documents.upload("講義.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal);
  const reading = documents.acquire(preview.id);
  let cited = false;
  await assert.rejects(documents.remove(preview.id, {
    stoppable: () => 1,
    // Meanwhile a lesson citing the file is saved, then the reading lets go.
    stop: async () => { cited = true; reading(); },
    isReferenced: () => cited,
  }), /已用於筆記/);
  assert.equal((await documents.get(preview.id)).id, preview.id);
  // No new lease while a removal is in progress.
  const pending = documents.remove(preview.id, { stoppable: () => 0 });
  assert.throws(() => documents.acquire(preview.id), /正在移除/);
  await pending;
});

test("a blank reading of a scanned page leaves its page image in lessons", async t => {
  const { documents, preview } = await (async () => {
    const directory = await mkdtemp(join(tmpdir(), "bell-reading-"));
    const service = new DocumentService({ directory, parser: async () => parsed, inspector: async () => metrics,
      renderer: async (_path, request) => request.required.map((page): RenderedPage => ({ page, mimeType: "image/png", data: "", width: 1, height: 1 })) });
    t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
    return { documents: service, preview: await service.upload("講義.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal) };
  })();
  await documents.saveReadings(preview.id, [{ page: 8, text: "", visuals: [], at: new Date().toISOString() }]);
  const { images, source } = await documents.lessonInput(preview.id, { question: "", visual: true, range: { start: 7, end: 8 } }, t.signal);
  assert.deepEqual(images.map(image => image.page), [8]);
  assert.match(source.content, /\[第 8 頁\]/);
});
