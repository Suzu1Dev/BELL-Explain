import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { exampleLessons } from "../shared/examples.js";
import type { Lesson } from "../shared/types.js";
import type { ChatCall } from "./ai.js";
import { createApp, type AppOptions } from "./app.js";
import type { PageMetrics, ParsedDocument } from "./document-parser.js";
import { DocumentService } from "./documents.js";
import { AppError } from "./errors.js";
import { LearningStore } from "./learning.js";
import type { ProviderService } from "./provider-router.js";
import { LessonStore } from "./store.js";

const parsedDocument: ParsedDocument = {
  units: [{ number: 1, text: "第一頁：閉包與詞法環境。" }],
  unitLabel: "page",
  totalUnits: 2,
  parsedUnits: 2,
  extractedChars: 12,
  warnings: [],
  outline: [],
  imageOnlyUnits: [2],
};

const pageMetrics: PageMetrics[] = [
  { page: 1, images: 0, paths: 0, gaps: 0, sizes: [] },
  { page: 2, images: 1, paths: 0, gaps: 0, sizes: ["800x600"] },
];

function ownLesson(): Lesson {
  const base = structuredClone(exampleLessons[0]);
  const sections = base.sections.map((section, index) => {
    const copy = { ...section, id: `section-${index + 1}` };
    delete copy.codeExample;
    return copy;
  });
  return {
    ...base,
    id: "own-note",
    isDemo: false,
    sections,
    annotations: [],
    followUpQuestions: ["閉包為什麼能記住外層變數？"],
  };
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function setupServer(
  t: TestContext,
  overrides: {
    config?: AppOptions["config"];
    provider?: ProviderService;
    withServices?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "bell-no-model-"));
  const store = new LessonStore(":memory:");
  const lesson = ownLesson();
  store.save(lesson);

  const withServices = overrides.withServices ?? true;
  const learning = withServices ? new LearningStore(join(directory, "learning.sqlite")) : undefined;
  const documents = withServices
    ? new DocumentService({
        directory: join(directory, "docs"),
        parser: async () => parsedDocument,
        inspector: async () => pageMetrics,
        renderer: async () => [],
      })
    : undefined;

  let chatCalls = 0;
  const chat: ChatCall = async () => {
    chatCalls++;
    throw new Error("chat must not be called when AI is unconfigured");
  };

  const server = createServer(
    createApp({
      store,
      examples: exampleLessons,
      lessonV3: true,
      learning,
      documents,
      chat,
      provider: overrides.provider,
      config: overrides.config ?? {
        apiKey: "",
        model: "",
        baseUrl: "https://example.invalid/v1",
      },
    }),
  );
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    await documents?.close();
    learning?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const documentId = documents
    ? (await documents.upload("slides.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal)).id
    : "00000000-0000-4000-8000-000000000000";

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });

  return { lesson, documentId, request, getChatCalls: () => chatCalls };
}

test("AppError keeps two-argument callers without a code and preserves an optional code", () => {
  const plain = new AppError(404, "找不到這篇筆記。");
  assert.equal(plain.status, 404);
  assert.equal(plain.message, "找不到這篇筆記。");
  assert.equal(plain.code, undefined);

  const coded = new AppError(503, "請先連接模型。", "no_model");
  assert.equal(coded.status, 503);
  assert.equal(coded.message, "請先連接模型。");
  assert.equal(coded.code, "no_model");
});

test("all 6 AI endpoints return HTTP 503 with code 'no_model' when AI is unconfigured", async t => {
  const unconfiguredProvider = {
    status: async () => ({ configured: false, message: "Codex 尚未登入。" }),
    createChat: async () => {
      throw new Error("provider.createChat must not be called when unconfigured");
    },
  } as unknown as ProviderService;

  const modes: Array<{
    name: string;
    config?: AppOptions["config"];
    provider?: ProviderService;
  }> = [
    {
      name: "empty API credentials without provider service",
      config: { apiKey: "", model: "", baseUrl: "https://example.invalid/v1" },
    },
    {
      name: "provider service reporting configured: false",
      config: { apiKey: "unused-key", model: "unused-model", baseUrl: "https://example.invalid/v1" },
      provider: unconfiguredProvider,
    },
  ];

  for (const mode of modes) {
    await t.test(mode.name, async t => {
      const { lesson, documentId, request, getChatCalls } = await setupServer(t, mode);
      const firstBody = lesson.sections[0].body;
      const quote = firstBody.slice(0, Math.min(24, firstBody.length));
      const term = quote.slice(0, Math.min(4, quote.length));

      const endpoints: Array<{
        name: string;
        path: string;
        body: Record<string, unknown>;
        expectedError: string;
      }> = [
        {
          name: "POST /api/lessons/:id/reformat",
          path: `/api/lessons/${lesson.id}/reformat`,
          body: {},
          expectedError: "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API。",
        },
        {
          name: "POST /api/lessons/:id/checks/:index",
          path: `/api/lessons/${lesson.id}/checks/0`,
          body: { answer: "函式保留建立時的詞法環境。" },
          expectedError: "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API，再請模型對照講解。",
        },
        {
          name: "POST /api/lessons/:id/annotations",
          path: `/api/lessons/${lesson.id}/annotations`,
          body: { sourceKey: "section-1:body", term, quote },
          expectedError: "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API，再產生詞句解說。",
        },
        {
          name: "POST /api/lessons/:id/examples",
          path: `/api/lessons/${lesson.id}/examples`,
          body: {},
          expectedError: "請先在模型設定連接 Codex、Claude Code、Antigravity 或 AI API。",
        },
        {
          name: "POST /api/generate",
          path: "/api/generate",
          body: { kind: "concept", content: "閉包與詞法環境", depth: "intermediate" },
          expectedError:
            "AI 尚未設定。請在模型設定中連接 Codex、Claude Code 或 Antigravity，或在 .env 填入 AI_API_KEY 與 AI_MODEL；現在可以體驗精選示範。",
        },
        {
          name: "POST /api/documents/:id/readings",
          path: `/api/documents/${documentId}/readings`,
          body: {},
          expectedError: "請先在模型設定連接 Codex、Claude Code、Antigravity 或支援影像輸入的 AI API，再深度解析檔案。",
        },
      ];

      for (const endpoint of endpoints) {
        const response = await request(endpoint.path, {
          method: "POST",
          body: JSON.stringify(endpoint.body),
        });
        assert.equal(response.status, 503, endpoint.name);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/, endpoint.name);
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(typeof payload.error, "string", endpoint.name);
        assert.ok((payload.error as string).trim().length > 0, endpoint.name);
        assert.deepEqual(
          payload,
          { error: endpoint.expectedError, code: "no_model" },
          endpoint.name,
        );
      }

      assert.equal(getChatCalls(), 0);
      assert.deepEqual(await (await request("/api/jobs")).json(), []);
    });
  }
});

test("AppError responses without a code serialize only { error } and omit code", async t => {
  const { lesson, request } = await setupServer(t);

  const badCheck = await request(`/api/lessons/${lesson.id}/checks/0`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(badCheck.status, 400);
  const badCheckBody = (await badCheck.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(badCheckBody), ["error"]);
  assert.equal("code" in badCheckBody, false);
  assert.equal(badCheckBody.error, "請提供 4,000 字以內的答案。");

  const missingNote = await request("/api/lessons/missing-note/checks/0", {
    method: "POST",
    body: JSON.stringify({ answer: "測試答案" }),
  });
  assert.equal(missingNote.status, 404);
  const missingBody = (await missingNote.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(missingBody), ["error"]);
  assert.equal("code" in missingBody, false);
  assert.equal(missingBody.error, "找不到這篇筆記。");

  const disabled = await setupServer(t, { withServices: false });
  const noLearning = await disabled.request(`/api/lessons/${disabled.lesson.id}/checks`);
  assert.equal(noLearning.status, 503);
  const noLearningBody = (await noLearning.json()) as Record<string, unknown>;
  assert.deepEqual(noLearningBody, { error: "學習紀錄尚未啟用。" });

  const noDocuments = await disabled.request("/api/documents/any-id/readings", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(noDocuments.status, 503);
  const noDocumentsBody = (await noDocuments.json()) as Record<string, unknown>;
  assert.deepEqual(noDocumentsBody, { error: "檔案解說服務尚未啟用。" });
});
