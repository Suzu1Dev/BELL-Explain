import { Router } from 'express';
import { z } from 'zod';
import type { KnowledgeService } from './knowledge.js';
import { AppError } from './errors.js';

export function createKnowledgeRouter(service: KnowledgeService) {
  const router = Router();
  router.get('/status', (_req, res) => res.json(service.status()));
  router.post('/embeddings/enable', (req, res) => {
    const parsed = z.object({provider:z.enum(['local','api']).optional()}).strict().safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400,'向量設定格式不正確。');
    service.enableEmbeddings(parsed.data.provider ?? 'local');
    res.status(202).json(service.status());
  });
  router.post('/embeddings/rebuild', (_req, res) => { service.rebuildEmbeddings(); res.status(202).json(service.status()); });
  router.get('/repositories', (_req, res) => res.json(service.repositories()));
  router.post('/repositories', (req, res) => {
    const parsed = z.discriminatedUnion('source', [
      z.object({source:z.literal('github'),url:z.string().min(1).max(500)}).strict(),
      z.object({source:z.literal('local'),path:z.string().min(1).max(2000)}).strict(),
    ]).safeParse(req.body);
    if (!parsed.success) throw new AppError(400,'請指定公開 GitHub 根網址，或明確輸入本機 repository 的絕對路徑。');
    res.status(202).json(service.createRepository(parsed.data));
  });
  router.get('/jobs', (_req, res) => res.json(service.jobs()));
  router.post('/jobs/:id/cancel', (req, res) => res.json(service.cancelJob(req.params.id)));
  router.post('/jobs/:id/retry', (req, res) => res.status(202).json(service.retryJob(req.params.id)));
  router.delete('/repositories/:id', async (req, res) => { await service.deleteRepository(req.params.id); res.status(204).end(); });
  router.get('/repositories/:id/files', (req, res) => {
    const parsed = z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(1000).default(200),q:z.string().max(300).optional()}).safeParse(req.query);
    if (!parsed.success) throw new AppError(400,'分頁範圍不正確。');
    res.json(service.repositoryFiles(req.params.id, parsed.data));
  });
  router.get('/repositories/:id/file', (req, res) => {
    if (typeof req.query.path !== 'string') throw new AppError(400,'請指定檔案路徑。');
    res.json(service.repositoryFile(req.params.id, req.query.path));
  });
  router.get('/search', async (req, res) => {
    const parsed = z.object({q:z.string().min(1).max(2000),kind:z.enum(['lesson','repo']).optional(),repositoryId:z.string().max(100).optional(),excludeLessonId:z.string().max(100).optional(),limit:z.coerce.number().int().min(1).max(30).default(12)}).safeParse(req.query);
    if (!parsed.success) throw new AppError(400,'搜尋內容或篩選條件不正確。');
    const {q, ...options} = parsed.data;
    res.json(await service.search(q, options));
  });
  return router;
}
