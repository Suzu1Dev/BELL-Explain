import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defaultPonytailMode, ponytailModes } from '../shared/efficiency.js';
import type { ProviderSettings } from '../shared/settings.js';
import { AppError } from './errors.js';
import { BASELINE, migrate } from './db/migrate.js';

export const providerSettingsSchema = z.object({
  provider:z.enum(['codex','claude','antigravity','api']), model:z.string().trim().max(160),
  effort:z.string().trim().min(1).max(40), speed:z.enum(['default','fast','ultrafast']),
  ponytailMode:z.enum(ponytailModes).default(defaultPonytailMode),
}).strict();
export const providerSettingsPatchSchema = z.object({
  provider:z.enum(['codex','claude','antigravity','api']).optional(), model:z.string().trim().max(160).optional(),
  effort:z.string().trim().min(1).max(40).optional(), speed:z.enum(['default','fast','ultrafast']).optional(),
  ponytailMode:z.enum(ponytailModes).optional(),
}).strict();
export class ProviderSettingsStore {
  private readonly db:DatabaseSync;
  private readonly defaults:ProviderSettings;
  constructor(path:string, defaults:Partial<ProviderSettings> = {}) {
    this.defaults = providerSettingsSchema.parse({provider:'codex', model:'', effort:'default', speed:'default', ...defaults});
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS provider_settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)');
    migrate(this.db, '模型設定', BASELINE, path);
  }
  get():ProviderSettings {
    const row=this.db.prepare('SELECT json FROM provider_settings WHERE id=1').get();
    if (!row) return {...this.defaults};
    try { return providerSettingsSchema.parse(JSON.parse(row.json as string)); }
    catch { throw new AppError(500, '模型設定資料損毀，請從備份還原設定資料庫。'); }
  }
  save(settings:ProviderSettings):ProviderSettings {
    const parsed=providerSettingsSchema.parse(settings);
    this.db.prepare('INSERT INTO provider_settings (id,json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(parsed));
    return parsed;
  }
  close():void { this.db.close(); }
}
