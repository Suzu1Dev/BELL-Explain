import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Lesson } from "../shared/types.js";
import { isLessonV3, lessonPartIds, type StoredLesson } from "../shared/lesson-v3.js";
import { BASELINE, migrate } from "./db/migrate.js";
import { logEvent } from "./log.js";
import { AppError } from "./errors.js";

/** Deleted notes stay recoverable in data/trash for this long, then disappear for good. */
export const TRASH_DAYS = 30;
/** Strict reads refuse to guess: a row that exists but cannot be read stops the caller. */
export interface ReadOptions { strict?: boolean; }

export class LessonStore {
  private db: DatabaseSync;
  /** Deleted notes are copied here first so a mistaken delete can be undone by hand. */
  private readonly trash?: string;
  constructor(path: string, seeds: Lesson[] = []) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
      this.trash = join(dirname(path), "trash");
    }
    this.db = new DatabaseSync(path);
    this.pruneTrash();
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    migrate(this.db, "筆記", BASELINE, path);
    if (
      !this.db.prepare("SELECT value FROM metadata WHERE key = 'seeded'").get()
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const lesson of seeds) this.save(lesson);
        this.db
          .prepare("INSERT INTO metadata (key, value) VALUES ('seeded', '1')")
          .run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  /**
   * For display, one unreadable row is logged and skipped instead of taking the
   * whole library down. Sync and file deletion read strictly: there a skipped
   * row would look like a deleted note and be removed everywhere else.
   */
  private parse(id: unknown, json: unknown, strict = false): StoredLesson | undefined {
    try {
      const lesson = JSON.parse(json as string) as StoredLesson;
      // A note without `format` is the original format; format 3 has steps instead of sections.
      const parts = isLessonV3(lesson) ? lesson.steps : (lesson as Lesson).sections;
      if (typeof lesson?.id === "string" && typeof lesson.createdAt === "string" && Array.isArray(parts)) return lesson;
    } catch { /* reported below */ }
    logEvent("store.unreadable", { id: String(id), strict });
    if (strict) throw new AppError(500, "有一篇筆記的資料無法讀取，已暫停同步與檔案移除以免誤刪。請從 data/trash 或備份還原後再試。");
    return undefined;
  }
  listRaw(options: ReadOptions = {}): StoredLesson[] {
    const lessons = this.db
      .prepare("SELECT id, json FROM lessons ORDER BY rowid ASC")
      .all()
      .flatMap((row) => this.parse(row.id, row.json, options.strict) ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return lessons;
  }
  getRaw(id: string, options: ReadOptions = {}): StoredLesson | undefined {
    const row = this.db.prepare("SELECT id, json FROM lessons WHERE id=?").get(id);
    return row ? this.parse(row.id, row.json, options.strict) : undefined;
  }
  list(): StoredLesson[] {
    const lessons = this.listRaw();
    return lessons.map((lesson) => ({
      ...lesson,
      connections: lesson.connections.filter((connection) =>
        lessons.some(
          (target) =>
            target.id === connection.targetId &&
            lessonPartIds(target).includes(connection.sectionId),
        ),
      ),
    }));
  }
  /** Same connection filtering as list(), reading only the linked notes. */
  get(id: string): StoredLesson | undefined {
    const lesson = this.getRaw(id);
    if (!lesson) return undefined;
    return {
      ...lesson,
      connections: lesson.connections.filter((connection) => {
        const target = this.getRaw(connection.targetId);
        return !!target && lessonPartIds(target).includes(connection.sectionId);
      }),
    };
  }
  save(lesson: StoredLesson): void {
    this.db
      .prepare(
        "INSERT INTO lessons (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(lesson.id, JSON.stringify(lesson), lesson.updatedAt);
  }
  favorite(id: string, favorite: boolean): StoredLesson | undefined {
    const lesson = this.getRaw(id);
    if (!lesson) return undefined;
    lesson.favorite = favorite;
    lesson.updatedAt = new Date().toISOString();
    this.save(lesson);
    return lesson;
  }
  private pruneTrash(): void {
    if (!this.trash) return;
    try {
      const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
      for (const name of readdirSync(this.trash))
        if (name.endsWith(".json") && statSync(join(this.trash, name)).mtimeMs < cutoff) rmSync(join(this.trash, name), { force: true });
    } catch {
      // No trash yet, or it cannot be read; deletes still write new copies.
    }
  }
  delete(id: string): boolean {
    const row = this.db.prepare("SELECT json FROM lessons WHERE id = ?").get(id);
    if (!row) return false;
    if (this.trash) {
      mkdirSync(this.trash, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(this.trash, `${id.replace(/[^\w-]/g, "_")}-${stamp}.json`), row.json as string, { mode: 0o600, flag: "wx" });
    }
    return this.db.prepare("DELETE FROM lessons WHERE id = ?").run(id).changes > 0;
  }
  close(): void {
    this.db.close();
  }
}
