import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError } from './errors.js';
import { SyncService, testSyncConnection } from './sync.js';

const connection = z.object({remoteUrl:z.string().min(1).max(2000),token:z.string().min(32).max(4096)}).strict();
export function createSyncRouter(sync:SyncService) {
  const router = Router();
  router.get('/guide', (_req,res) => res.type('text/plain').sendFile(fileURLToPath(new URL('../deployment/README.md',import.meta.url))));
  router.get('/status', (_req,res) => res.json(sync.status()));
  router.get('/conflicts', (_req,res) => res.json(sync.conflicts()));
  router.post('/test', async (req,res) => {
    const parsed = connection.safeParse(req.body);if (!parsed.success) throw new AppError(400,'請提供同步網址與至少 32 個字元的憑證。');
    res.json({ok:true,...await testSyncConnection(parsed.data)});
  });
  router.post('/connect', async (req,res) => {
    const parsed = connection.extend({uploadExisting:z.literal(true)}).safeParse(req.body);if (!parsed.success) throw new AppError(400,'請提供有效的同步設定，並確認同步現有筆記。');
    res.json(await sync.configure(parsed.data));
  });
  router.post('/run', async (_req,res) => res.json(await sync.sync()));
  router.delete('/connection', async (_req,res) => res.json(await sync.disconnect()));
  router.post('/conflicts/:id/resolve', async (req,res) => {
    const parsed = z.object({strategy:z.enum(['local','remote','both'])}).strict().safeParse(req.body);if (!parsed.success) throw new AppError(400,'請選擇保留本機、雲端或兩個版本。');
    res.json(await sync.resolveConflict(req.params.id,parsed.data.strategy));
  });
  return router;
}
