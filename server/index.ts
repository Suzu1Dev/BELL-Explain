import { resolve, dirname, join } from "node:path";
import { exampleLessons } from "../shared/examples.js";
import { createApp } from "./app.js";
import { LessonStore } from "./store.js";
import { ProviderSettingsStore } from "./provider-settings.js";
import { ProviderService } from "./provider-router.js";
import { KnowledgeService } from "./knowledge.js";
import { createSyncService } from "./sync.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { DocumentService } from "./documents.js";
import { LearningStore } from "./learning.js";
import { JobRegistry } from "./jobs.js";

// Validate deployment settings before opening or creating persistent data.
const runtime = readRuntimeConfig();
const store = new LessonStore(
  resolve(process.env.BELL_DATA_PATH || "data/bell.sqlite"),
  exampleLessons,
);
const dataDir = dirname(
  resolve(process.env.BELL_DATA_PATH || "data/bell.sqlite"),
);
const config = {
  apiKey: process.env.AI_API_KEY?.trim() || "",
  baseUrl: process.env.AI_BASE_URL?.trim() || "https://api.openai.com/v1",
  model: process.env.AI_MODEL?.trim() || "",
};
const providerStore = new ProviderSettingsStore(
  join(dataDir, "settings.sqlite"),
);
const provider = new ProviderService({
  store: providerStore,
  apiConfig: config,
});
const knowledge = new KnowledgeService({
  dbPath: join(dataDir, "knowledge.sqlite"),
  cacheDir: join(dataDir, "index-cache"),
});
const documents = new DocumentService({ directory: join(dataDir, "documents") });
const learning = new LearningStore(join(dataDir, "learning.sqlite"));
const jobs = new JobRegistry();
// On stop, running lessons get this long to finish (the unit allows 20 s in total).
const drainSeconds = Math.max(0, Number(process.env.BELL_DRAIN_SECONDS ?? 10)) || 0;
knowledge.reconcileLessons(store.listRaw());
const sync = createSyncService({
  path: join(dataDir, "sync.sqlite"),
  lessons: {
    // Strict: an unreadable row must stop sync, not be pushed as a deletion.
    list: () => store.listRaw({ strict: true }),
    get: (id) => store.getRaw(id, { strict: true }),
    save: (lesson) => store.save(lesson),
    delete: (id) => {
      store.delete(id);
    },
  },
  onRemoteChange: (lesson, id) => {
    if (lesson) knowledge.upsertLesson(lesson);
    else knowledge.deleteLesson(id);
  },
});
const app = createApp({
  store,
  examples: exampleLessons,
  config,
  provider,
  knowledge,
  documents,
  learning,
  jobs,
  sync,
  allowedOrigins: runtime.allowedOrigins,
  suiteLinks: runtime.suiteLinks,
  lessonV3: runtime.lessonV3,
});
const server = app.listen(runtime.port, runtime.host, () =>
  console.log(`BELL Explain: http://${runtime.host.includes(":") ? `[${runtime.host}]` : runtime.host}:${runtime.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    setTimeout(() => process.exit(0), (drainSeconds + 6) * 1000).unref();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.drain(drainSeconds * 1000);
    // Let followers receive the outcome of a job that just finished before cutting them off.
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await documents.close();
    await sync.close();
    await knowledge.close();
    providerStore.close();
    learning.close();
    store.close();
    process.exit(0);
  });
