import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { logEvent } from "../log.js";

export interface Migration {
  version: number;
  /** Runs inside BEGIN IMMEDIATE; throw to roll the step back. */
  up?: (db: DatabaseSync) => void;
}

/** Version 1 records the schemas that existed before migrations were tracked. */
export const BASELINE: Migration[] = [{ version: 1 }];

/**
 * Brings a database to the newest version this build knows, one transaction per
 * step, and records it in PRAGMA user_version. A database written by a newer
 * BELL is refused instead of being read with older assumptions after a rollback.
 */
export function migrate(db: DatabaseSync, name: string, migrations: Migration[], path?: string): number {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest)
    throw new Error(`${name} 資料庫版本 ${current} 比這個 BELL 版本支援的 ${latest} 新。請改用較新的 BELL，或從備份還原資料。`);
  const pending = migrations.filter(step => step.version > current);
  if (!pending.length) return current;
  // Only real changes to existing data need a copy: recording the baseline changes
  // nothing, and a brand-new database (version 0 with steps to run) has nothing to save.
  if (path && path !== ":memory:" && current > 0 && pending.some(step => step.up)) {
    const backup = `${path}.before-v${pending[0].version}`;
    if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  }
  for (const step of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      step.up?.(db);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    logEvent("db.migrated", { database: name, version: step.version });
  }
  return latest;
}
