import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SyncDocument, SyncOperation, SyncPushResult } from '../shared/sync.js';
import { LESSON_FORMATS, canonical, lessonHash, syncOperationSchema } from '../server/sync-protocol.js';

export class CloudSyncStore {
  private db: DatabaseSync;
  readonly workspaceId: string;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('workspaceId', randomUUID());
    this.workspaceId = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('workspaceId')!.value as string;
  }
  push(operation: SyncOperation): SyncPushResult {
    const requestHash = createHash('sha256').update(canonical(operation)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.db.prepare('SELECT request_hash,result FROM operations WHERE id=?').get(operation.operationId);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new Error('Operation ID reused');
        this.db.exec('COMMIT'); return JSON.parse(replay.result as string) as SyncPushResult;
      }
      const row = this.db.prepare('SELECT json FROM documents WHERE id=?').get(operation.id);
      const current = row ? JSON.parse(row.json as string) as SyncDocument : null;
      // Tombstones participate in revision checks: an offline edit cannot restore a deleted note.
      const accepted = operation.baseRevision === (current?.revision || 0);
      let document: SyncDocument;
      if (!accepted) {
        if (!current) throw new Error('Unknown base revision');
        document = current;
      } else {
        document = {id:operation.id, revision:(current?.revision || 0) + 1, hash:lessonHash(operation.lesson), lesson:operation.lesson};
        const json = JSON.stringify(document);
        this.db.prepare('INSERT INTO documents(id,revision,json) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(document.id, document.revision, json);
        this.db.prepare('INSERT INTO changes(json) VALUES (?)').run(json);
      }
      const result = {accepted, document};
      this.db.prepare('INSERT INTO operations(id,request_hash,result) VALUES (?,?,?)').run(operation.operationId, requestHash, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pull(cursor: number) {
    const changes:Array<{sequence:number;document:SyncDocument}> = [];let bytes = 0;let hasMore = false;
    for (const row of this.db.prepare('SELECT sequence,json FROM changes WHERE sequence>? ORDER BY sequence LIMIT 101').iterate(cursor)) {
      const json = row.json as string;const size = Buffer.byteLength(json);
      if (changes.length >= 100 || (changes.length > 0 && bytes + size > 6_000_000)) {hasMore = true;break;}
      changes.push({sequence:Number(row.sequence),document:JSON.parse(json) as SyncDocument});bytes += size;
    }
    return {cursor:changes.at(-1)?.sequence ?? cursor, hasMore, changes};
  }
  close() { this.db.close(); }
}

export function createCloudApp({store, token}: {store:CloudSyncStore; token:string}) {
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) throw new Error('BELL_SYNC_TOKEN must be at least 32 characters without whitespace. Generate it with openssl rand -hex 32.');
  const expected = createHash('sha256').update(token).digest();
  const app = express(); app.disable('x-powered-by');
  app.use((_req,res,next) => {res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
  app.get('/health', (_req,res) => res.json({ok:true}));
  app.use((req,res,next) => {
    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (supplied.length > 4096 || !timingSafeEqual(createHash('sha256').update(supplied).digest(), expected)) {res.status(401).json({error:'同步憑證無效。'});return;}
    next();
  });
  app.use(express.json({limit:'2mb'}));
  app.get('/v1/info', (_req,res) => res.json({protocol:1, workspaceId:store.workspaceId}));
  // Lesson formats this server stores besides the original. Clients read it before pushing one;
  // a server without this endpoint answers 404 and gets original-format notes only.
  app.get('/v1/capabilities', (_req,res) => res.json({lessonFormats:[...LESSON_FORMATS]}));
  app.get('/v1/pull', (req,res) => {
    const cursor = typeof req.query.cursor === 'string' && /^\d{1,15}$/.test(req.query.cursor) ? Number(req.query.cursor) : NaN;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {res.status(400).json({error:'同步游標格式不正確。'});return;}
    res.json(store.pull(cursor));
  });
  app.post('/v1/push', (req,res) => {
    const parsed = syncOperationSchema.safeParse(req.body);
    if (!parsed.success) {res.status(400).json({error:'同步筆記格式不正確。'});return;}
    try {res.json(store.push(parsed.data));} catch {res.status(409).json({error:'同步操作識別碼或版本不正確。'});}
  });
  app.use((_req,res) => res.status(404).json({error:'找不到此同步 API。'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction) => {
    const type = (error as {type?:string}).type;
    res.status(type === 'entity.too.large' ? 413 : type === 'entity.parse.failed' ? 400 : 500).json({error:'無法處理同步請求。'});
  });
  return app;
}
