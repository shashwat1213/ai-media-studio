import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { requireAuth } from '../auth/require-auth.js';
import type { GenerationService } from './generation.service.js';
import { ASPECT_RATIOS, MODEL_IDS, MODELS } from './models.js';

const GenerateSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, 'Prompt must be at least 3 characters')
    .max(1000, 'Prompt must be at most 1000 characters'),
  model: z.enum(MODEL_IDS),
  aspectRatio: z.enum(ASPECT_RATIOS).default('1:1'),
});

// Ids are uuids. Validating the shape avoids a DB round-trip for garbage input.
const IdParam = z.object({ id: z.string().uuid() });
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});
const JobsQuery = PageQuery.extend({
  status: z.enum(['QUEUED', 'PROCESSING', 'DONE', 'FAILED']).optional(),
});
// Same character rules as request ids: it ends up in the DB and in logs.
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, 'Idempotency-Key must be 8-100 safe characters');

function parseId(params: unknown) {
  const parsed = IdParam.safeParse(params);
  if (!parsed.success) throw new HttpError(404, 'Not found'); // a malformed id can't exist
  return parsed.data.id;
}

export function generationRouter(
  service: GenerationService,
  opts: { jwtSecret: string; providerMode: 'stub' | 'openrouter'; generateRateLimit: number; onOrphan?: (key: string, err: unknown) => void },
): Router {
  const router = Router();
  const auth = requireAuth(opts.jwtSecret);

  // Per-USER limit (not per IP): behind a NAT, one office shares an IP.
  const generateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: opts.generateRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.userId!,
    message: { error: 'Too many generation requests, slow down' },
  });

  router.get('/generate/models', (_req, res) => {
    res.json({
      mode: opts.providerMode,
      models: MODELS.map(({ id, name, description, credits }) => ({ id, name, description, credits })),
      aspectRatios: ASPECT_RATIOS,
    });
  });

  router.post('/generate', auth, generateLimiter, async (req, res) => {
    const input = GenerateSchema.parse(req.body);
    const rawKey = req.get('Idempotency-Key');
    const key = rawKey === undefined ? undefined : IdempotencyKey.parse(rawKey);
    const { job, replayed } = await service.create(req.userId!, input, key);
    // 202 Accepted = "got it, working on it". Location tells the client where to poll.
    res.status(replayed ? 200 : 202).location(`/jobs/${job.id}`).json({ job });
  });

  router.get('/jobs', auth, async (req, res) => {
    res.json(await service.listJobs(req.userId!, JobsQuery.parse(req.query)));
  });

  router.get('/jobs/:id', auth, async (req, res) => {
    // Polled every ~1.5s: tell caches/proxies not to keep a stale status.
    res.set('Cache-Control', 'no-store');
    res.json({ job: await service.getJob(req.userId!, parseId(req.params)) });
  });

  router.get('/assets', auth, async (req, res) => {
    res.json(await service.listAssets(req.userId!, PageQuery.parse(req.query)));
  });

  router.get('/assets/:id', auth, async (req, res) => {
    res.json({ asset: await service.getAsset(req.userId!, parseId(req.params)) });
  });

  router.delete('/assets/:id', auth, async (req, res) => {
    await service.deleteAsset(req.userId!, parseId(req.params), opts.onOrphan);
    res.status(204).end();
  });

  return router;
}
