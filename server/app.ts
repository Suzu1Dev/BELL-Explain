import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import compression from "compression";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig, GenerateEvent as AnyGenerateEvent, Lesson } from "../shared/types.js";
import { isLessonV3, type StoredLesson } from "../shared/lesson-v3.js";
import {
  createChat,
  generateLesson,
  type AIConfig,
  type ChatCall,
  type ChatImage,
} from "./ai.js";
import { AppError, publicError } from "./errors.js";
import { logEvent } from "./log.js";
import { requestSchema } from "./schema.js";
import { extractSource } from "./sources.js";
import { LessonStore } from "./store.js";
import { ProviderService, createProviderRouter } from "./provider-router.js";
import { KnowledgeService } from "./knowledge.js";
import { createKnowledgeRouter } from "./knowledge-router.js";
import { SyncService } from "./sync.js";
import { createSyncRouter } from "./sync-router.js";
import { addLessonExamples } from "./lesson-examples.js";
import { reformatted } from "./lesson-reformat.js";
import { EXAMPLE_TIMEOUT_MS, GENERATION_TIMEOUT_MS, taskDeadline, withGenerationProgress } from "./generation-progress.js";
import { ANNOTATION_TIMEOUT_MS, MAX_ANNOTATIONS, annotationRequestSchema, annotationTarget, annotationUpdatedAt, assertAnnotationCurrent, cachedAnnotation, explainAnnotation, mergeAnnotation } from "./lesson-annotations.js";
import { validateAllowedOrigins } from "./runtime-config.js";
import { DocumentService, createDocumentRouter } from "./documents.js";
import { LearningStore, createReviewRouter } from "./learning.js";
import { createSuiteRouter, type SuiteLinks } from "./suite.js";
import { registerCodeSandboxRoute } from "./code-sandbox.js";
import { gradeCheck } from "./learning-check.js";
import { JobRegistry, isCancelled } from "./jobs.js";
import { READING_TIMEOUT_MS, runDeepReading } from "./document-reading.js";
import type { CheckEvent, CheckResult } from "../shared/learning.js";

/** Events this server sends: a saved note may be either format. */
type GenerateEvent = AnyGenerateEvent<StoredLesson>;

export interface AppOptions {
  store: LessonStore;
  examples: Lesson[];
  config: AIConfig;
  chat?: ChatCall;
  extract?: typeof extractSource;
  distPath?: string;
  provider?: ProviderService;
  knowledge?: KnowledgeService;
  sync?: SyncService;
  documents?: DocumentService;
  learning?: LearningStore;
  /** Lesson and example jobs; shared with the process so shutdown can wait for them. */
  jobs?: JobRegistry;
  generationTimeoutMs?: number;
  progressIntervalMs?: number;
  annotationTimeoutMs?: number;
  allowedOrigins?: readonly string[];
  /** Validated BELL_SUITE_LINKS: sibling browser origins for links only, never allowed origins. */
  suiteLinks?: SuiteLinks;
  /**
   * BELL_LESSON_V3: write new lessons in format 3. Off by default. Once any v3 note, or a note
   * marked 「整理失敗」 (`failedFormat`), is in a shared sync server, every device that predates
   * format 3 stops syncing in both directions until it is upgraded: its pull rejects the page
   * holding that note, so it never reaches its pushes. Old clients cannot be fixed from here.
   * Rollout order: the sync server, then every device on this build, then the v3 reader in
   * the browser, and only then this flag.
   */
  lessonV3?: boolean;
}
const localDevelopmentHosts = [
  "127.0.0.1:3001",
  "localhost:3001",
  "127.0.0.1:5173",
  "localhost:5173",
];
export function createApp(options: AppOptions) {
  const app = express();
  const allowedOrigins = new Set([
    ...localDevelopmentHosts.map(host => `http://${host}`),
    ...validateAllowedOrigins(options.allowedOrigins || []),
  ]);
  const allowedHosts = new Set([...allowedOrigins].map(origin => new URL(origin).host));
  // Lessons and example backfills share two job slots; term explanations and
  // grading have their own, so a long lesson never blocks them.
  const jobs = options.jobs ?? new JobRegistry();
  const JOB_SLOTS = 2;
  // Deep reading has its own single slot, so a long reading never blocks lessons.
  const lessonJobs = () => jobs.running().filter((job) => job.kind !== "reading").length;
  let activeAnnotations = 0;
  let activeChecks = 0;
  const annotationJobs = new Set<string>();
  /** Streams a job: its id first, then past and live events up to the outcome. Closing only stops following. */
  const streamJob = (res: Response, id: string, from = 0) => {
    res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    // During shutdown the connection is not kept for further requests (set before the headers go out).
    if (jobs.shuttingDown) res.setHeader("Connection", "close");
    res.flushHeaders();
    const write = (event: GenerateEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
    write({ type: "job", id });
    let stop: (() => void) | undefined;
    const close = () => { stop?.(); if (!res.destroyed && !res.writableEnded) res.end(); };
    let following = false;
    // A finished job replays and ends during follow(); a live one ends as its outcome is written.
    stop = jobs.follow(id, from, write, () => { if (following) close(); else setImmediate(close); });
    following = true;
    res.on("close", () => stop?.());
  };
  const { store, examples, config } = options;
  const saved = (lesson: StoredLesson) => {
    try {
      options.knowledge?.upsertLesson(lesson);
    } catch {
      console.error("Knowledge indexing deferred until reconciliation.");
    }
    try {
      options.sync?.updatedLesson(lesson);
    } catch {
      console.error("Sync queue deferred until reconciliation.");
    }
  };
  app.disable("x-powered-by");
  // Streamed NDJSON progress must reach the browser as it is written, so it is never compressed.
  app.use(compression({ filter: (req, res) => !String(res.getHeader("Content-Type") || "").includes("ndjson") && compression.filter(req, res) }));
  // Failures, slow requests and writes are logged; the 15-second library poll is not.
  app.use((req, res, next) => {
    const id = randomUUID().slice(0, 8);
    const started = Date.now();
    // Read now: routers strip their mount path from req.path before the response finishes.
    const path = req.path;
    res.locals.requestId = id;
    res.setHeader("X-Request-Id", id);
    res.on("finish", () => {
      const ms = Date.now() - started;
      if (res.statusCode >= 400 || ms >= 2000 || !["GET", "HEAD"].includes(req.method))
        logEvent("http", { id, method: req.method, path, status: res.statusCode, ms });
    });
    next();
  });
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // API answers are private and change often; static files set their own caching below.
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/pdfjs/")) res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    const host = (req.headers.host || "").toLowerCase();
    // The production listener can use another port; loopback browser requests
    // still need an exact Origin match for that listener, including IPv6.
    const loopbackOrigins = ["127.0.0.1", "localhost", "[::1]"].map(
      hostname => new URL(`http://${hostname}:${req.socket.localPort}`).origin,
    );
    const localHost = loopbackOrigins.some(origin => new URL(origin).host === host);
    if (
      (!localHost && !allowedHosts.has(host)) ||
      (req.headers.origin && !allowedOrigins.has(req.headers.origin) && !loopbackOrigins.includes(req.headers.origin)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.status(403).json({ error: "此服務僅接受已設定的學習平台來源。" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  // Character maps, standard fonts and decoders the browser PDF viewer loads on demand.
  const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  for (const folder of ["cmaps", "standard_fonts", "wasm"])
    // Missing or rejected paths fall through to the API 404 response.
    app.use(`/api/pdfjs/${folder}`, express.static(join(pdfjsRoot, folder), { index: false, dotfiles: "deny", maxAge: "1d" }));
  if (options.provider) app.use("/api", createProviderRouter(options.provider));
  if (options.knowledge)
    app.use("/api/knowledge", createKnowledgeRouter(options.knowledge));
  if (options.sync) app.use("/api/sync", createSyncRouter(options.sync));
  if (options.documents) app.use("/api", createDocumentRouter(options.documents,
    // Strict: an unreadable note might still cite the file, so removal is refused.
    id => store.listRaw({ strict: true }).some(lesson => lesson.source.document?.id === id),
    // Removing an unused upload stops its deep reading first, so the file is not left behind.
    {
      stoppable: (id) => jobs.running("reading").filter((item) => item.documentId === id).length,
      stop: async (id) => {
        for (const job of jobs.running("reading").filter((item) => item.documentId === id)) {
          jobs.cancel(job.id, "檔案已移除，深度解析已停止。");
          await jobs.settled(job.id);
        }
      },
    }));
  const release = (() => { try { return basename(realpathSync(process.cwd())); } catch { return "unknown"; } })();
  const version = (() => { try { return (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: string }).version || "unknown"; } catch { return "unknown"; } })();
  registerCodeSandboxRoute(app);
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version, release, uptimeSeconds: Math.round(process.uptime()), lessons: store.listRaw().length });
  });
  app.get("/api/config", async (_req, res) => {
    const status = options.provider
      ? await options.provider.status()
      : {
          configured: Boolean(config.apiKey && config.model),
          model: config.model,
        };
    const value: AppConfig = { ...status, storage: "SQLite · 本機持久儲存", lessonV3: Boolean(options.lessonV3) };
    res.json(value);
  });
  // Revalidated with the ETag Express computes, so an unchanged library poll is a 304.
  app.get("/api/lessons", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.json(store.list()); });
  app.get("/api/lessons/:id", (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    const lesson = store.get(req.params.id);
    if (!lesson) {
      res.status(404).json({ error: "找不到這篇筆記。" });
      return;
    }
    res.json(lesson);
  });
  app.patch("/api/lessons/:id", (req, res) => {
    const input = z
      .object({ favorite: z.boolean() })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "收藏狀態格式不正確。" });
      return;
    }
    const lesson = store.favorite(req.params.id, input.data.favorite);
    if (!lesson) {
      res.status(404).json({ error: "找不到這篇筆記。" });
      return;
    }
    saved(lesson);
    res.json(lesson);
  });
  app.delete("/api/lessons/:id", (req, res) => {
    if (!store.delete(req.params.id)) {
      res.status(404).json({ error: "找不到這篇筆記。" });
      return;
    }
    try {
      options.knowledge?.deleteLesson(req.params.id);
    } catch {
      console.error("Knowledge deletion deferred until reconciliation.");
    }
    try {
      options.sync?.deletedLesson(req.params.id);
    } catch {
      console.error("Sync deletion deferred until reconciliation.");
    }
    res.status(204).end();
  });
  app.delete("/api/lessons/:id/annotations/:annotationId", (req, res) => {
    const current = store.getRaw(req.params.id);
    if (!current) throw new AppError(404, "找不到這篇筆記。");
    const annotations = (current.annotations || []).filter(annotation => annotation.id !== req.params.annotationId);
    if (annotations.length === (current.annotations?.length || 0)) throw new AppError(404, "找不到這個詞句解說。");
    const lesson = { ...current, annotations, updatedAt: annotationUpdatedAt(current) };
    store.save(lesson);
    saved(lesson);
    res.json(store.get(lesson.id) || lesson);
  });
  // Strict: a skipped unreadable note would look deleted and lose its review history.
  if (options.learning) app.use("/api", createReviewRouter(options.learning, () => store.listRaw({ strict: true })));
  // BELL Suite manifest and today feed: behind the guard above like every API, read-only.
  app.use("/api/suite", createSuiteRouter({ store, learning: options.learning, examples, links: options.suiteLinks, allowedOrigins: options.allowedOrigins }));
  const learningStore = () => {
    if (!options.learning) throw new AppError(503, "學習紀錄尚未啟用。");
    return options.learning;
  };
  const checkTarget = (id: string, rawIndex: string) => {
    const lesson = store.getRaw(id);
    if (!lesson) throw new AppError(404, "找不到這篇筆記。");
    // Format 3 has recall per step instead of self-check questions.
    if (isLessonV3(lesson)) throw new AppError(404, "找不到這題自我檢查。");
    const index = Number(rawIndex);
    const question = Number.isInteger(index) ? lesson.followUpQuestions[index] : undefined;
    if (question === undefined) throw new AppError(404, "找不到這題自我檢查。");
    return { lesson, index, question };
  };
  app.get("/api/lessons/:id/checks", (req, res) => {
    const lesson = store.getRaw(req.params.id);
    if (!lesson) throw new AppError(404, "找不到這篇筆記。");
    res.json(learningStore().checks(lesson));
  });
  // Self-assessment against a cached reference answer: no model call.
  app.post("/api/lessons/:id/checks/:index/self", (req, res) => {
    const parsed = z.object({ answer: z.string().max(4000), verdict: z.enum(["correct", "partial", "incorrect", "unanswered"]) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請提供 4,000 字以內的答案與自評結果。");
    const { lesson, index, question } = checkTarget(req.params.id, req.params.index);
    const learning = learningStore();
    if (!learning.reference(lesson.id, index, question)) throw new AppError(409, "這題還沒有參考答案，請先請模型對照講解。");
    // Looking at the answer without writing one counts as not answered, whatever was clicked.
    const verdict = parsed.data.answer.trim() ? parsed.data.verdict : "unanswered";
    res.json(learning.recordAttempt(lesson.id, index, parsed.data.answer, verdict, "self", { review: !lesson.isDemo }));
  });
  // Model grading, only when the learner asks for it.
  app.post("/api/lessons/:id/checks/:index", async (req, res) => {
    const parsed = z.object({ answer: z.string().max(4000) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請提供 4,000 字以內的答案。");
    const { lesson, index, question } = checkTarget(req.params.id, req.params.index);
    const learning = learningStore();
    if (!(options.provider ? (await options.provider.status()).configured : config.apiKey && config.model))
      throw new AppError(503, "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API，再請模型對照講解。", "no_model");
    // The learner may have left while the provider answered; its close event is already past.
    if (res.destroyed) return;
    if (activeChecks >= 2) throw new AppError(429, "已有兩題正在批改，請稍候再試。");
    activeChecks++;
    const controller = new AbortController();
    const deadline = taskDeadline(controller.signal, options.annotationTimeoutMs ?? ANNOTATION_TIMEOUT_MS, "批改已達等待上限，請稍後再試。");
    const signal = deadline.signal;
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", abort);
    res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (event: CheckEvent) => { if (!signal.aborted && !res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
    try {
      emit({ type: "stage", message: "正在對照筆記內容批改你的答案。" });
      const chat = options.chat || (options.provider ? await options.provider.createChat(signal) : createChat(config));
      const progress = withGenerationProgress(chat, (event) => { if (event.type === "stage") emit({ type: "stage", message: event.message }); }, options.progressIntervalMs);
      const graded = await gradeCheck(lesson, question, parsed.data.answer, learning.reference(lesson.id, index, question), progress, signal);
      signal.throwIfAborted();
      learning.saveReference(lesson.id, index, question, graded.reference);
      const attempt = learning.recordAttempt(lesson.id, index, parsed.data.answer, graded.verdict, "model", { review: !lesson.isDemo });
      emit({ type: "checked", result: { ...graded.reference, verdict: graded.verdict, feedback: graded.feedback, attempt } satisfies CheckResult });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.write(`${JSON.stringify({ type: "error", message: publicError(error) } satisfies CheckEvent)}\n`);
    } finally {
      deadline.dispose();
      activeChecks--;
      res.off("close", abort);
      if (!res.destroyed) res.end();
    }
  });
  app.post("/api/lessons/:id/annotations", async (req, res) => {
    if (!req.is("application/json")) throw new AppError(415, "請使用 JSON 格式送出選取的詞句。");
    const parsed = annotationRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "請選取 1–160 字元的詞句與同一段落中最多 4,000 字元的引文。");
    const request = parsed.data;
    let original = store.getRaw(req.params.id);
    if (!original) throw new AppError(404, "找不到這篇筆記。");
    annotationTarget(original, request);
    const sendCached = (lesson: StoredLesson) => {
      res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.end(`${JSON.stringify({ type: "complete", lesson: store.get(lesson.id) || lesson } satisfies GenerateEvent)}\n`);
    };
    if (cachedAnnotation(original, request)) { sendCached(original); return; }
    if ((original.annotations?.length || 0) >= MAX_ANNOTATIONS) throw new AppError(409, "這篇筆記已達 100 個詞句解說，請先刪除不需要的解說。");
    if (!(options.provider ? (await options.provider.status()).configured : config.apiKey && config.model)) {
      throw new AppError(503, "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API，再產生詞句解說。", "no_model");
    }
    if (res.destroyed) return;
    // Provider discovery may await. Recheck the saved source and cached result
    // before spending a model call, and preserve concurrent favorite updates.
    original = assertAnnotationCurrent(original, store.getRaw(original.id), request);
    if (cachedAnnotation(original, request)) { sendCached(original); return; }
    if ((original.annotations?.length || 0) >= MAX_ANNOTATIONS) throw new AppError(409, "這篇筆記已達 100 個詞句解說，請先刪除不需要的解說。");
    const jobKey = JSON.stringify([original.id, request.sourceKey, request.term]);
    if (activeAnnotations >= 2 || annotationJobs.has(jobKey)) throw new AppError(429, "已有兩則詞句解說正在進行，請等待完成後重試。");
    activeAnnotations++;
    annotationJobs.add(jobKey);
    const controller = new AbortController();
    const deadline = taskDeadline(controller.signal, options.annotationTimeoutMs ?? ANNOTATION_TIMEOUT_MS, "詞句解說已達等待上限（預設 15 分鐘），原筆記未變更。請稍後再試。");
    const signal = deadline.signal;
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", abort);
    res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (event: GenerateEvent) => {
      if (!signal.aborted && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      emit({ type: "stage", stage: "teach", message: `正在根據這個段落解釋「${request.term}」。` });
      const chat = options.chat || (options.provider ? await options.provider.createChat(signal) : createChat(config));
      const annotation = await explainAnnotation(original, request, withGenerationProgress(chat, emit, options.progressIntervalMs), signal);
      signal.throwIfAborted();
      const result = mergeAnnotation(original, store.getRaw(original.id), request, annotation);
      if (result.changed) { store.save(result.lesson); saved(result.lesson); }
      emit({ type: "complete", lesson: store.get(result.lesson.id) || result.lesson });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.write(`${JSON.stringify({ type: "error", message: publicError(error) } satisfies GenerateEvent)}\n`);
    } finally {
      deadline.dispose();
      activeAnnotations--;
      annotationJobs.delete(jobKey);
      res.off("close", abort);
      if (!res.destroyed) res.end();
    }
  });
  app.post("/api/lessons/:id/examples", async (req, res) => {
    if (
      !req.is("application/json") ||
      !z.object({}).strict().safeParse(req.body).success
    ) {
      res.status(400).json({ error: "請使用空白 JSON 物件開始補充案例。" });
      return;
    }
    const original = store.getRaw(req.params.id);
    if (!original) {
      res.status(404).json({ error: "找不到這篇筆記。" });
      return;
    }
    if (original.isDemo) {
      res
        .status(400)
        .json({
          error: "精選示範維持原有內容；自己的學習筆記可以補充實作案例。",
        });
      return;
    }
    if (isLessonV3(original)) {
      res.status(409).json({ error: "新格式筆記的程式碼放在每一步的圖解裡，不另外補充實作案例。" });
      return;
    }
    if (original.sections.some((section) => section.codeExample)) {
      // A stale tab may ask again after another device or tab already added a case.
      // Return the saved note without another model call or timestamp mutation.
      res
        .status(200)
        .setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.end(
        `${JSON.stringify({ type: "complete", lesson: store.get(original.id) || original } satisfies GenerateEvent)}\n`,
      );
      return;
    }
    if (
      !(options.provider
        ? (await options.provider.status()).configured
        : config.apiKey && config.model)
    ) {
      res.status(503).json({ error: "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API。", code: "no_model" });
      return;
    }
    // A second tab or device asking for the same note follows the job already running.
    const existingJob = jobs.running("examples").find((job) => job.lessonId === original.id);
    if (existingJob) { streamJob(res, existingJob.id); return; }
    if (jobs.running("examples").length) {
      res.status(429).json({ error: "已有一篇筆記正在補上實作案例，請等它完成後再試。" });
      return;
    }
    if (lessonJobs() >= JOB_SLOTS) {
      res.status(429).json({ error: "已有兩個學習工作進行中，請等待完成後重試。" });
      return;
    }
    const job = jobs.start({ kind: "examples", title: original.title, lessonId: original.id }, async (emit, cancel) => {
      const deadline = taskDeadline(cancel, EXAMPLE_TIMEOUT_MS, "補充實作案例已達 20 分鐘等待上限；原筆記未變更。請稍後再試。");
      const signal = deadline.signal;
      try {
        emit({
          type: "stage",
          stage: "teach",
          message: "正在為概念補上小型完整程式案例、逐段白話解釋與預期結果…",
        });
        const chat =
          options.chat ||
          (options.provider
            ? await options.provider.createChat(signal)
            : createChat(config));
        const enhanced = await addLessonExamples(original, withGenerationProgress(chat, emit, options.progressIntervalMs), signal);
        signal.throwIfAborted();
        const current = store.getRaw(original.id);
        if (
          !current ||
          isLessonV3(current) ||
          JSON.stringify(current.sections) !==
            JSON.stringify(original.sections) ||
          JSON.stringify(current.source) !== JSON.stringify(original.source)
        )
          throw new AppError(
            409,
            "筆記在生成期間已更新或刪除，本次案例未寫入。請重新開啟筆記後再試。",
          );
        const lesson = {
          ...current,
          sections: enhanced.sections,
          updatedAt: enhanced.updatedAt,
        };
        store.save(lesson);
        saved(lesson);
        return { type: "complete", lesson: store.get(lesson.id) || lesson };
      } finally {
        deadline.dispose();
      }
    });
    streamJob(res, job.id);
  });
  // 整理成新格式 (L1.7): write an original-format note again in format 3 from the source it keeps.
  // The note is replaced only once the new one is written; any failure leaves it as it was.
  app.post("/api/lessons/:id/reformat", async (req, res) => {
    if (!options.lessonV3) {
      res.status(409).json({ error: "新格式尚未開啟（BELL_LESSON_V3），目前不能整理成新格式；原筆記未變更。" });
      return;
    }
    const input = z.object({ depth: z.enum(["beginner", "intermediate", "advanced"]).optional() }).strict().safeParse(req.body);
    if (!req.is("application/json") || !input.success) {
      res.status(400).json({ error: "請用 JSON 物件開始整理，例如 {} 或 {\"depth\":\"beginner\"}。" });
      return;
    }
    const original = store.getRaw(req.params.id);
    if (!original) {
      res.status(404).json({ error: "找不到這篇筆記。" });
      return;
    }
    if (original.isDemo) {
      res.status(400).json({ error: "精選示範由人工整理，不重新生成；自己的學習筆記可以整理成新格式。" });
      return;
    }
    if (isLessonV3(original)) {
      // A stale tab, or another device that already rewrote it: return the saved note, no model call.
      res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.end(`${JSON.stringify({ type: "complete", lesson: store.get(original.id) || original } satisfies GenerateEvent)}\n`);
      return;
    }
    if (!original.source.content.trim()) {
      res.status(422).json({ error: "這篇筆記沒有保存原始內容，無法重新整理成新格式；原筆記未變更。" });
      return;
    }
    if (!(options.provider ? (await options.provider.status()).configured : config.apiKey && config.model)) {
      // `code` lets the reader point to Settings instead of suggesting a retry that cannot work.
      res.status(503).json({ error: "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API。", code: "no_model" });
      return;
    }
    const existingJob = jobs.running("reformat").find((job) => job.lessonId === original.id);
    if (existingJob) { streamJob(res, existingJob.id); return; }
    if (lessonJobs() >= JOB_SLOTS) {
      res.status(429).json({ error: "已有兩個學習工作進行中，請等待完成後重試。" });
      return;
    }
    const started = Date.now();
    const job = jobs.start({ kind: "reformat", title: original.title, lessonId: original.id }, async (emit, cancel) => {
      const deadline = taskDeadline(cancel, options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS, "整理成新格式已達整體等待上限（預設 30 分鐘）；原筆記未變更，請稍後再試。");
      const signal = deadline.signal;
      try {
        emit({ type: "stage", stage: "read", message: "正在用這篇筆記保存的原始內容重新整理；完成前原筆記不會變動。" });
        const chat = options.chat || (options.provider ? await options.provider.createChat(signal) : createChat(config));
        const parent = original.parentLessonId ? store.getRaw(original.parentLessonId) : undefined;
        const written = await generateLesson(
          { kind: original.source.kind, content: original.source.content, depth: input.data.depth ?? "intermediate" },
          original.source,
          store.list().filter((lesson) => lesson.id !== original.id),
          withGenerationProgress(chat, emit, options.progressIntervalMs),
          signal,
          emit,
          [],
          {
            ...(parent ? { continuesFrom: { title: parent.title, summary: isLessonV3(parent) ? parent.answer : parent.summary } } : {}),
            format: 3,
            fallback: false,
          },
        );
        signal.throwIfAborted();
        const current = store.getRaw(original.id);
        if (!current || isLessonV3(current) || JSON.stringify(current.sections) !== JSON.stringify(original.sections) || JSON.stringify(current.source) !== JSON.stringify(original.source))
          throw new AppError(409, "筆記在整理期間已更新或刪除，新格式未寫入；請重新開啟筆記後再試。");
        const { note, linked, dropped } = reformatted(current, written, store.listRaw());
        if (dropped) emit({ type: "stage", stage: "organize", message: `有 ${dropped} 則詞句解說引用的文字已不在新內容裡，沒有搬過去。` });
        // Synchronous SQLite commits, before the completion event is emitted.
        store.save(note);
        saved(note);
        for (const other of linked) { store.save(other); saved(other); }
        logEvent("lesson.reformatted", { id: note.id, steps: note.steps.length, annotations: note.annotations?.length ?? 0, dropped, linked: linked.length, ms: Date.now() - started });
        return { type: "complete", lesson: store.get(note.id) || note };
      } catch (error) {
        const reason = isCancelled(cancel) ? "cancelled" : error instanceof AppError ? `${error.name}:${error.status}` : error instanceof Error ? error.name : "unknown";
        logEvent("lesson.reformat.failed", { id: original.id, ms: Date.now() - started, reason });
        if (signal.aborted) throw error;
        // Every failure says the note was left as it was, including a provider's own message.
        const message = publicError(error);
        throw new AppError(error instanceof AppError ? error.status : 500, message.includes("原筆記未變更") ? message : error instanceof AppError ? `${message}原筆記未變更。` : "整理成新格式時遇到問題；原筆記未變更，請稍後再試。");
      } finally {
        deadline.dispose();
      }
    });
    streamJob(res, job.id);
  });
  app.post("/api/generate", async (req, res) => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: "請使用 JSON 格式送出輸入。" });
      return;
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "輸入格式不正確。請提供有效的內容、Repo 索引，或已上傳的檔案。",
      });
      return;
    }
    const request = parsed.data;
    if (
      !request.exampleId &&
      !(options.provider
        ? (await options.provider.status()).configured
        : config.apiKey && config.model)
    ) {
      res.status(503).json({
        error:
          "AI 尚未設定。請在模型設定中連接 Codex、Claude Code 或 Antigravity，或在 .env 填入 AI_API_KEY 與 AI_MODEL；現在可以體驗精選示範。",
        code: "no_model",
      });
      return;
    }
    if (lessonJobs() >= JOB_SLOTS) {
      res
        .status(429)
        .json({ error: "已有兩個學習工作進行中，請等待完成後重試。" });
      return;
    }
    const generationStarted = Date.now();
    const title = request.question?.trim().slice(0, 80) ||
      (request.exampleId ? examples.find((item) => item.id === request.exampleId)?.title : undefined) ||
      (request.kind === "document" ? "檔案解說" : request.kind === "repo" && !request.content.trim() ? "Repo 解說" : request.content.trim().split("\n")[0].slice(0, 80)) ||
      "新的解說";
    const job = jobs.start({ kind: "generate", title }, async (emit, cancel) => {
      const deadline = taskDeadline(
        cancel,
        options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS,
        `這次解說已達整體等待上限（預設 30 分鐘），尚未儲存不完整的筆記。${request.kind === "repo" ? "Repo 索引仍保留，可指定想了解的模組後重試。" : "可縮小學習範圍後重試。"}`,
      );
      const signal = deadline.signal;
      let releaseDocument: (() => void) | undefined;
      try {
        let lesson: StoredLesson;
        if (request.exampleId) {
          const curated = examples.find((item) => item.id === request.exampleId);
          if (!curated) throw new AppError(404, "找不到指定的精選示範。");
          emit({
            type: "stage",
            stage: "read",
            message: "正在載入人工編寫的精選示範；此流程不呼叫 AI。",
          });
          emit({
            type: "stage",
            stage: "analyze",
            message: "載入示範中已整理的概念與學習路徑。",
          });
          emit({
            type: "stage",
            stage: "teach",
            message: "載入示範解說、程式碼與互動動畫。",
          });
          emit({
            type: "stage",
            stage: "organize",
            message: "將精選示範與既有知識庫連結並儲存。",
          });
          lesson = structuredClone(store.getRaw(curated.id) || curated);
          lesson.isDemo = true;
        } else {
          if (request.kind === "document") {
            if (!options.documents) throw new AppError(503, "檔案解說服務尚未啟用。");
            releaseDocument = options.documents.acquire(request.documentId!);
          }
          emit({
            type: "stage",
            stage: "read",
            message:
              request.kind === "repo"
                ? "正在建立完整檔案樹索引，再從中檢索相關程式片段。"
                : request.kind === "url"
                  ? "正在讀取公開網頁中的靜態文字。"
                  : request.kind === "document"
                    ? "正在依學習重點整理文件內容與來源頁碼。"
                    : "正在整理你提供的內容。",
          });
          let images: ChatImage[] = [];
          const documentInput = request.kind === "document"
            ? await options.documents!.lessonInput(request.documentId!, {
                question: request.question || "", range: request.documentRange,
                visual: request.documentVisual, password: request.documentPassword,
              }, signal, (message) => emit({ type: "stage", stage: "read", message }))
            : undefined;
          if (documentInput) images = documentInput.images.map((image) => ({ mimeType: image.mimeType, data: image.data, label: `第 ${image.page} 頁影像` }));
          const source =
            documentInput
              ? documentInput.source
              : options.knowledge && request.indexedRepoId
              ? await options.knowledge.sourceForRepository(
                  request.indexedRepoId,
                  request.question || request.content,
                  signal,
                )
              : options.knowledge && request.kind === "repo"
                ? await options.knowledge.ensureRepositorySource(
                    request.content,
                    request.question || "專案架構、入口、主要資料流與模組關係",
                    signal,
                    (message) => emit({ type: "stage", stage: "read", message }),
                  )
                : await (options.extract || extractSource)(request, signal);
          const chat =
            options.chat ||
            (options.provider
              ? await options.provider.createChat(signal)
              : createChat(config));
          const parent = request.parentLessonId ? store.getRaw(request.parentLessonId) : undefined;
          lesson = await generateLesson(
            request,
            source,
            store.list(),
            withGenerationProgress(chat, emit, options.progressIntervalMs),
            signal,
            emit,
            images,
            {
              ...(parent ? { continuesFrom: { title: parent.title, summary: isLessonV3(parent) ? parent.answer : parent.summary } } : {}),
              ...(options.lessonV3 ? { format: 3 as const } : {}),
            },
          );
          if (parent) lesson.parentLessonId = parent.id;
        }
        signal.throwIfAborted();
        // Synchronous SQLite commit happens before the completion event is emitted.
        store.save(lesson);
        saved(lesson);
        if (!lesson.isDemo) logEvent("lesson.generated", { id: lesson.id, kind: request.kind, depth: request.depth, ms: Date.now() - generationStarted, ...(isLessonV3(lesson) ? { format: 3, steps: lesson.steps.length } : { sections: lesson.sections.length }) });
        return { type: "complete", lesson: store.get(lesson.id) || lesson };
      } catch (error) {
        logEvent("lesson.failed", { kind: request.kind, depth: request.depth, ms: Date.now() - generationStarted,
          reason: isCancelled(cancel) ? "cancelled" : error instanceof AppError ? `${error.name}:${error.status}` : error instanceof Error ? error.name : "unknown",
          ...(error instanceof Error && "stage" in error ? { stage: (error as { stage?: string }).stage } : {}) });
        throw error;
      } finally {
        deadline.dispose();
        releaseDocument?.();
      }
    });
    streamJob(res, job.id);
  });
  // Deep reading: the model reads the figure, formula and scanned pages of a PDF once,
  // and lessons, page choice and search use that transcription afterwards.
  app.post("/api/documents/:id/readings", async (req, res) => {
    const documents = options.documents;
    if (!documents) throw new AppError(503, "檔案解說服務尚未啟用。");
    const parsed = z.object({
      range: z.object({ start: z.number().int().min(1), end: z.number().int().min(1) }).strict().optional(),
      // Only for rendering an encrypted PDF during this job; never stored.
      password: z.string().min(1).max(256).optional(),
      redo: z.boolean().optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, "請提供有效的頁碼範圍。");
    const id = req.params.id;
    await documents.file(id);
    if (!(options.provider ? (await options.provider.status()).configured : config.apiKey && config.model))
      throw new AppError(503, "請先在模型設定連接 Codex、Claude Code、Antigravity 或支援影像輸入的 AI API，再深度解析檔案。", "no_model");
    // A second tab or device asking for the same file follows the reading in progress.
    const existing = jobs.running("reading").find((job) => job.documentId === id);
    if (existing) { streamJob(res, existing.id); return; }
    if (jobs.running("reading").length) throw new AppError(429, "已有一份檔案正在深度解析，請等它完成或取消後再試。");
    const request = new AbortController();
    res.once("close", () => { if (!res.headersSent) request.abort(); });
    const plan = await documents.readingPlan(id, parsed.data, request.signal);
    if (!plan.pages.length) throw new AppError(409, "這個範圍沒有需要深度解析的頁面（可能都已解析完成）。");
    // Checked again: finding the pages may have taken a moment.
    const joined = jobs.running("reading").find((job) => job.documentId === id);
    if (joined) { streamJob(res, joined.id); return; }
    if (jobs.running("reading").length) throw new AppError(429, "已有一份檔案正在深度解析，請等它完成或取消後再試。");
    const release = documents.acquire(id);
    let job;
    try {
      job = jobs.start({ kind: "reading", title: plan.name, documentId: id }, async (emit, cancel) => {
        const deadline = taskDeadline(cancel, READING_TIMEOUT_MS, "深度解析已達 2 小時上限；已完成的頁面都已保存，可再按一次繼續解析剩下的頁面。");
        try {
          emit({ type: "stage", stage: "read", message: `準備深度解析 ${plan.pages.length} 頁。` });
          const chat = options.chat || (options.provider ? await options.provider.createChat(deadline.signal) : createChat(config));
          const result = await runDeepReading(documents, id, plan, parsed.data.password, chat, deadline.signal, emit, options.progressIntervalMs);
          logEvent("document.read", { id, pages: result.pages, more: result.more });
          return { type: "read", documentId: id, pages: result.pages };
        } finally {
          deadline.dispose();
          release();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
    streamJob(res, job.id);
  });
  app.get("/api/jobs", (_req, res) => { res.json(jobs.list()); });
  app.get("/api/jobs/:id", (req, res) => {
    const view = jobs.get(req.params.id) ?? jobs.outcome(req.params.id);
    if (!view) throw new AppError(404, "找不到這個工作，伺服器可能已重新啟動。");
    res.json(view);
  });
  app.get("/api/jobs/:id/events", (req, res) => {
    if (!jobs.get(req.params.id)) {
      // Events are gone but the outcome is known: answer with it, so a device that
      // slept for a long time is told the truth about its lesson.
      const ended = jobs.outcome(req.params.id);
      if (!ended) throw new AppError(404, "找不到這個工作，伺服器可能已重新啟動。");
      const lesson = ended.status === "done" && ended.lessonId ? store.get(ended.lessonId) : undefined;
      res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      const outcome: GenerateEvent = ended.status === "done" && ended.kind === "reading" && ended.documentId
        ? { type: "read", documentId: ended.documentId, pages: ended.pagesRead ?? 0 }
        : lesson
        ? { type: "complete", lesson }
        : { type: "error", message: ended.status === "done" ? "這次工作已完成，但筆記已不在知識庫中。" : ended.error || "這次工作沒有完成。" };
      res.end(`${JSON.stringify({ type: "job", id: ended.id } satisfies GenerateEvent)}\n${JSON.stringify(outcome)}\n`);
      return;
    }
    const from = Number(req.query.from ?? 0);
    streamJob(res, req.params.id, Number.isInteger(from) && from >= 0 ? from : 0);
  });
  // Leaving the page no longer stops a lesson; this does.
  app.delete("/api/jobs/:id", (req, res) => {
    if (!jobs.get(req.params.id)) throw new AppError(404, "找不到這個工作，伺服器可能已重新啟動。");
    jobs.cancel(req.params.id);
    res.status(204).end();
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "找不到此 API。" }),
  );
  const dist = options.distPath ? resolve(options.distPath) : fileURLToPath(new URL("../dist", import.meta.url));
  if (existsSync(resolve(dist, "index.html"))) {
    // Hashed build assets never change; the HTML that names them is always revalidated.
    app.use(express.static(dist, { setHeaders: (res, path) => res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache") }));
    app.use("/assets", (_req, res) => {
      res.status(404).type("text/plain").set("Cache-Control", "no-store").send("Not found");
    });
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(dist, "index.html"), { headers: { "Cache-Control": "no-cache" } }),
    );
  }
  app.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const bodyType = (error as { type?: string }).type;
      if (!(error instanceof AppError) && bodyType !== "entity.too.large" && bodyType !== "entity.parse.failed")
        logEvent("error", { id: res.locals.requestId, method: req.method, path: req.path, errorClass: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message.slice(0, 300) : undefined, stack: error instanceof Error ? error.stack?.split("\n").slice(0, 8).join("\n") : undefined });
      else if (error instanceof AppError && error.status >= 500)
        logEvent("error", { id: res.locals.requestId, method: req.method, path: req.path, errorClass: error.name, status: error.status });
      if (res.headersSent) {
        res.end();
        return;
      }
      const bodyError = error as { type?: string };
      const status =
        error instanceof AppError
          ? error.status
          : bodyError.type === "entity.too.large"
            ? 413
            : bodyError.type === "entity.parse.failed"
              ? 400
              : 500;
      res.status(status).json({
        error:
          error instanceof AppError
            ? publicError(error)
            : status === 413
            ? "輸入內容過大。"
            : status === 400
              ? "JSON 格式不正確。"
              : publicError(error),
        ...(error instanceof AppError && error.code ? { code: error.code } : {}),
      });
    },
  );
  return app;
}
