import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncFormatOf, type StoredLesson } from '../shared/lesson-v3.js';
import type { SyncConflict, SyncDocument, SyncOperation, SyncResolution, SyncSettingsInput, SyncStatus } from '../shared/sync.js';
import { AppError } from './errors.js';
import { lessonHash, syncCapabilitiesSchema, syncInfoSchema, syncLessonSchema, syncPullSchema, syncPushResultSchema, validateSyncDocument } from './sync-protocol.js';
import { BASELINE, migrate } from './db/migrate.js';

interface LocalNotes { list(): StoredLesson[]; get(id:string): StoredLesson | undefined; save(lesson:StoredLesson): void; delete(id:string): unknown; }
interface Settings { remoteUrl:string; token:string; workspaceId:string; cursor:number; }
interface RecordRow { revision:number; hash:string; }
interface QueueRow { operation:SyncOperation; hash:string; }
export interface SyncServiceOptions { path:string; lessons:LocalNotes; intervalMs?:number; onRemoteChange?:(lesson:StoredLesson | null,id:string) => void; }

export function normalizeSyncUrl(value:string): string {
  let url:URL; try {url = new URL(value);} catch {throw new AppError(400,'請輸入有效的同步伺服器網址。');}
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new AppError(400,'同步伺服器須使用 HTTPS；本機測試可使用 http://127.0.0.1。');
  return url.toString().replace(/\/+$/,'');
}

/** Shown while format-3 notes wait for a sync server that can store them. */
export const FORMAT_HELD_MESSAGE = '同步伺服器需要更新，才能同步新格式筆記和標示「整理失敗」的筆記；這些筆記保留在本機，其他筆記照常同步。';

async function remoteRequest(settings:Pick<Settings,'remoteUrl'|'token'>, path:string, signal:AbortSignal, body?:unknown, options:{optional?:boolean} = {}):Promise<unknown> {
  const response = await fetch(`${settings.remoteUrl}${path}`, {
    method:body === undefined ? 'GET' : 'POST', redirect:'error',
    headers:{authorization:`Bearer ${settings.token}`, 'content-type':'application/json',accept:'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),
  });
  // An optional endpoint an older server does not have.
  if (response.status === 404 && options.optional) {await response.body?.cancel();return undefined;}
  if (!response.ok) {await response.body?.cancel();throw new AppError(response.status === 401 ? 401 : 502, response.status === 401 ? '同步憑證無效，請重新連線。' : '同步伺服器暫時無法處理請求，變更已保留在本機。');}
  const reader = response.body?.getReader(); if (!reader) throw new AppError(502,'同步伺服器沒有回傳資料。');
  const chunks:Uint8Array[] = [];let length = 0;
  try {
    for (;;) {const {done,value} = await reader.read();if (done) break;length += value.byteLength;if (length > 8_000_000) throw new AppError(502,'同步回應超過大小限制。');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {await reader.cancel().catch(() => {});reader.releaseLock();}
}

export async function testSyncConnection(input:{remoteUrl:string;token:string}) {
  if (input.token.length < 32 || input.token.length > 4096 || /\s/.test(input.token)) throw new AppError(400,'同步憑證須至少 32 個字元且不能含空白。');
  const settings = {remoteUrl:normalizeSyncUrl(input.remoteUrl), token:input.token};
  try {const info = syncInfoSchema.parse(await remoteRequest(settings,'/v1/info',new AbortController().signal));return {remoteUrl:settings.remoteUrl,workspaceId:info.workspaceId};}
  catch (error) {if (error instanceof AppError) throw error;throw new AppError(502,'無法連線或同步協定不相容；請確認伺服器網址與 HTTPS 憑證。');}
}

export class SyncService {
  private db:DatabaseSync;
  private settings:Settings | null;
  private active:Promise<SyncStatus> | null = null;
  private controller = new AbortController();
  private timer:ReturnType<typeof setInterval>;
  private closed = false;
  private configuring = false;
  constructor(private options:SyncServiceOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(options.path);
    if (options.path !== ':memory:') chmodSync(options.path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,json TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,local_json TEXT NOT NULL,remote_json TEXT NOT NULL);`);
    migrate(this.db,'同步',BASELINE,options.path);
    const saved = this.value('settings'); this.settings = saved ? JSON.parse(saved) as Settings : null;
    this.timer = setInterval(() => this.schedule(),options.intervalMs ?? 30_000);this.timer.unref();
    if (this.settings) queueMicrotask(() => this.schedule());
  }
  private value(key:string):string | null {return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string) ?? null;}
  private setValue(key:string,value:string) {this.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  private record(id:string):RecordRow | undefined {const row = this.db.prepare('SELECT revision,hash FROM records WHERE id=?').get(id);return row ? {revision:Number(row.revision),hash:row.hash as string} : undefined;}
  private setRecord(document:SyncDocument) {this.db.prepare('INSERT INTO records(id,revision,hash) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash').run(document.id,document.revision,document.hash);}
  private queued(id:string):QueueRow | undefined {const row = this.db.prepare('SELECT json,hash FROM queue WHERE id=?').get(id);return row ? {operation:JSON.parse(row.json as string),hash:row.hash as string} : undefined;}
  private hasConflict(id:string) {return Boolean(this.db.prepare('SELECT id FROM conflicts WHERE id=?').get(id));}
  private enqueue(id:string,lesson:StoredLesson | null,baseRevision = this.record(id)?.revision || 0) {
    const hash = lessonHash(lesson);const previous = this.queued(id);
    if (previous?.hash === hash && previous.operation.baseRevision === baseRevision) return;
    const operation:SyncOperation = {operationId:randomUUID(),id,baseRevision,lesson};
    this.db.prepare('INSERT INTO queue(id,json,hash) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,hash=excluded.hash').run(id,JSON.stringify(operation),hash);
  }
  private schedule() {if (this.settings && !this.closed && !this.configuring) void this.sync().catch(() => {});}
  private changed(id:string,lesson:StoredLesson | null) {
    if (!this.settings || this.closed) return;
    if (this.hasConflict(id)) {this.db.prepare('UPDATE conflicts SET local_json=? WHERE id=?').run(JSON.stringify(lesson),id);return;}
    const record = this.record(id);
    if (record?.hash === lessonHash(lesson)) this.db.prepare('DELETE FROM queue WHERE id=?').run(id);
    else this.enqueue(id,lesson);
  }
  updatedLesson(lesson:StoredLesson) {this.changed(lesson.id,lesson);this.schedule();}
  deletedLesson(id:string) {this.changed(id,null);this.schedule();}
  status():SyncStatus {
    return {configured:Boolean(this.settings),remoteUrl:this.settings?.remoteUrl || null,syncing:Boolean(this.active),pending:Number(this.db.prepare('SELECT COUNT(*) AS n FROM queue').get()!.n),conflicts:Number(this.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get()!.n),lastSyncedAt:this.value('lastSyncedAt'),lastError:this.value('lastError') || null};
  }
  async configure(input:SyncSettingsInput):Promise<SyncStatus> {
    if (input.uploadExisting !== true) throw new AppError(400,'連線前請確認將現有筆記同步至此伺服器。');
    if (this.configuring) throw new AppError(409,'同步設定正在更新。');
    this.configuring = true;
    try {
      const verified = await testSyncConnection(input);
      this.controller.abort();await this.active?.catch(() => {});this.controller = new AbortController();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // A new connection is a deliberate fresh reconciliation. Divergent notes become conflicts.
        this.db.exec('DELETE FROM records;DELETE FROM queue;DELETE FROM conflicts;DELETE FROM metadata;');
        this.settings = {...verified,token:input.token,cursor:0};this.setValue('settings',JSON.stringify(this.settings));
        for (const lesson of this.options.lessons.list()) this.enqueue(lesson.id,lesson,0);
        this.db.exec('COMMIT');
      } catch (error) {this.db.exec('ROLLBACK');throw error;}
    } finally {this.configuring = false;}
    return this.sync();
  }
  async disconnect():Promise<SyncStatus> {
    if (this.configuring) throw new AppError(409,'同步設定正在更新。');
    this.configuring = true;
    try {
      this.controller.abort();await this.active?.catch(() => {});this.controller = new AbortController();this.settings = null;
      this.db.exec('DELETE FROM records;DELETE FROM queue;DELETE FROM conflicts;DELETE FROM metadata;PRAGMA wal_checkpoint(TRUNCATE);');
      return this.status();
    } finally {this.configuring = false;}
  }
  conflicts():SyncConflict[] {
    return this.db.prepare('SELECT id,local_json,remote_json FROM conflicts ORDER BY id').all().map(row => {
      const remote = JSON.parse(row.remote_json as string) as SyncDocument;
      return {id:row.id as string,local:JSON.parse(row.local_json as string),remote:remote.lesson,remoteRevision:remote.revision};
    });
  }
  private apply(lesson:StoredLesson | null,id:string) {
    if (lesson) this.options.lessons.save(lesson); else this.options.lessons.delete(id);
    this.options.onRemoteChange?.(lesson,id);
  }
  async resolveConflict(id:string,strategy:SyncResolution):Promise<SyncStatus> {
    if (this.active) await this.active.catch(() => {});
    const row = this.db.prepare('SELECT local_json,remote_json FROM conflicts WHERE id=?').get(id);
    if (!row) throw new AppError(404,'找不到此同步衝突。');
    const local = JSON.parse(row.local_json as string) as StoredLesson | null;
    const remote = validateSyncDocument(JSON.parse(row.remote_json as string));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setRecord(remote);
      if (strategy === 'local') {this.apply(local,id);this.enqueue(id,local,remote.revision);}
      else {
        if (strategy === 'both' && local && lessonHash(local) !== remote.hash) {
          const copy = {...local,id:randomUUID(),title:`${local.title.slice(0,220)}（本機衝突副本）`,updatedAt:new Date().toISOString()};
          // Persist the preserved local version before replacing the original note.
          this.apply(copy,copy.id);this.enqueue(copy.id,copy,0);
        }
        this.apply(remote.lesson,id);
      }
      this.db.prepare('DELETE FROM conflicts WHERE id=?').run(id);this.db.exec('COMMIT');
    } catch (error) {this.db.exec('ROLLBACK');throw error;}
    return this.sync();
  }
  private reconcile() {
    const current = this.options.lessons.list();const ids = new Set(current.map(note => note.id));
    for (const lesson of current) this.changed(lesson.id,lesson);
    for (const row of this.db.prepare('SELECT id FROM records UNION SELECT id FROM queue UNION SELECT id FROM conflicts').all()) if (!ids.has(row.id as string)) this.changed(row.id as string,null);
  }
  private receive(document:SyncDocument) {
    const record = this.record(document.id);
    if (record && record.revision >= document.revision) return;
    const queue = this.queued(document.id);
    if (this.hasConflict(document.id)) {
      if (lessonHash(this.options.lessons.get(document.id) || null) === document.hash) {
        this.setRecord(document);this.db.prepare('DELETE FROM conflicts WHERE id=?').run(document.id);
      } else this.db.prepare('UPDATE conflicts SET remote_json=? WHERE id=?').run(JSON.stringify(document),document.id);
      return;
    }
    if (queue) {
      if (queue.hash === document.hash) {this.setRecord(document);this.db.prepare('DELETE FROM queue WHERE id=?').run(document.id);return;}
      if (queue.operation.baseRevision === document.revision) {this.setRecord(document);return;}
      this.db.prepare('INSERT INTO conflicts(id,local_json,remote_json) VALUES (?,?,?)').run(document.id,JSON.stringify(this.options.lessons.get(document.id) || null),JSON.stringify(document));
      this.db.prepare('DELETE FROM queue WHERE id=?').run(document.id);return;
    }
    this.apply(document.lesson,document.id);this.setRecord(document);
  }
  private async run():Promise<void> {
    const settings = this.settings;if (!settings) return;
    const signal = this.controller.signal;
    const info = syncInfoSchema.parse(await remoteRequest(settings,'/v1/info',signal));
    if (info.workspaceId !== settings.workspaceId) throw new AppError(409,'同步伺服器的資料庫已更換；請重新連線以重新比對筆記。');
    this.reconcile();
    let pages = 0;
    for (;;) {
      const pulled = syncPullSchema.parse(await remoteRequest(settings,`/v1/pull?cursor=${settings.cursor}`,signal));
      signal.throwIfAborted();
      let previous = settings.cursor;
      for (const change of pulled.changes) {
        if (change.sequence <= previous) throw new AppError(502,'同步伺服器回傳無效的變更順序。');
        const document = validateSyncDocument(change.document);previous = change.sequence;this.receive(document);
      }
      if (pulled.cursor !== previous || (pulled.hasMore && !pulled.changes.length)) throw new AppError(502,'同步伺服器回傳無效的游標。');
      settings.cursor = pulled.cursor;this.setValue('settings',JSON.stringify(settings));
      if (!pulled.hasMore) break;
      if (++pages > 1000) throw new AppError(502,'變更記錄過多，稍後將從目前進度繼續。');
    }
    // Read the queue each time: edits made while a request is in flight remain queued.
    // A format the server does not store stays queued, unsent, and the rest go on. So does a
    // note marked 「整理失敗」: a server that predates format 3 would drop the mark.
    let pushes = 0;let formats:number[] | undefined;const held:string[] = [];
    for (;;) {
      signal.throwIfAborted();
      const row = this.db.prepare('SELECT id,json FROM queue WHERE id NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT 1').get(JSON.stringify(held));if (!row) break;
      const operation = JSON.parse(row.json as string) as SyncOperation;
      if (operation.lesson) syncLessonSchema.parse(operation.lesson);
      const format = operation.lesson ? syncFormatOf(operation.lesson) : undefined;
      if (format !== undefined) {
        formats ??= await this.lessonFormats(settings,signal);
        if (!formats.includes(format)) {held.push(operation.id);continue;}
      }
      const result = syncPushResultSchema.parse(await remoteRequest(settings,'/v1/push',signal,operation));
      signal.throwIfAborted();const document = validateSyncDocument(result.document);
      if (document.id !== operation.id) throw new AppError(502,'同步伺服器回傳不同的筆記 ID。');
      if (result.accepted) {
        if (document.revision !== operation.baseRevision + 1 || document.hash !== lessonHash(operation.lesson)) throw new AppError(502,'同步伺服器回傳不一致的版本。');
        this.setRecord(document);
        if (this.queued(operation.id)?.operation.operationId === operation.operationId) this.db.prepare('DELETE FROM queue WHERE id=?').run(operation.id);
        // A user may edit or undo while this operation is travelling to the cloud.
        const local = this.options.lessons.get(operation.id) || null;
        if (lessonHash(local) !== document.hash) this.enqueue(operation.id,local,document.revision);
      } else {
        this.receive(document);
        // If the server returned a known revision, retry with its revision once reconciled.
        const remaining = this.queued(operation.id);
        if (remaining && remaining.operation.operationId === operation.operationId) this.enqueue(operation.id,remaining.operation.lesson,document.revision);
      }
      if (++pushes >= 500) break;
    }
    this.setValue('lastSyncedAt',new Date().toISOString());this.setValue('lastError',held.length ? FORMAT_HELD_MESSAGE : '');
  }
  /** Lesson formats the server stores besides the original; a server without the endpoint stores none. */
  private async lessonFormats(settings:Settings,signal:AbortSignal):Promise<number[]> {
    const reply = await remoteRequest(settings,'/v1/capabilities',signal,undefined,{optional:true});
    return reply === undefined ? [] : syncCapabilitiesSchema.parse(reply).lessonFormats;
  }
  sync():Promise<SyncStatus> {
    if (this.active) return this.active.then(() => this.status());
    if (!this.settings || this.closed || this.configuring) return Promise.resolve(this.status());
    this.active = this.run().then(() => this.status()).catch(error => {
      const message = error instanceof AppError ? error.message : '同步暫時離線或資料格式不相容；本機變更已保留，恢復連線後會自動重試。';
      this.setValue('lastError',message);throw new AppError(error instanceof AppError ? error.status : 503,message);
    }).finally(() => {this.active = null;});
    return this.active.then(() => this.status());
  }
  async close():Promise<void> {this.closed = true;clearInterval(this.timer);this.controller.abort();await this.active?.catch(() => {});this.db.close();}
}
export function createSyncService(options:SyncServiceOptions) {return new SyncService(options);}
