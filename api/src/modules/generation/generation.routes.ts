import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { requireAuth } from '../auth/require-auth.js';
import type { GenerationService } from './generation.service.js';
import { ASPECT_RATIOS, catalogFor, type ProviderMode } from './models.js';
import { MOTION_DURATIONS, MOTION_PRESETS, motionCost } from './motion.js';
import { EDIT_FORMATS, EDIT_LIMITS, EDIT_SECONDS_PER_CREDIT, EditRequestSchema, IMAGE_MOTIONS, TRANSITIONS } from '../editor/edit-spec.js';
import { TEMPLATES, buildFromTemplate, findTemplate } from '../editor/templates.js';
import { UPLOAD_LIMITS, UPLOAD_TYPES, type UploadMime } from '../editor/probe.js';
import type { UploadService } from '../editor/uploads.service.js';

/** The request schema depends on the active provider: only ITS models (and their ratios) are valid. */
function generateSchema(mode: ProviderMode) {
  const catalog = catalogFor(mode);
  return z
    .object({
      prompt: z
        .string()
        .trim()
        .min(3, 'Prompt must be at least 3 characters')
        .max(1000, 'Prompt must be at most 1000 characters'),
      model: z.enum(catalog.map((m) => m.id) as [string, ...string[]]),
      aspectRatio: z.enum(ASPECT_RATIOS).default('1:1'),
    })
    .refine((v) => catalog.find((m) => m.id === v.model)!.aspectRatios.includes(v.aspectRatio), {
      message: 'This model does not support that aspect ratio',
      path: ['aspectRatio'],
    });
}

const MotionSchema = z.object({
  sourceAssetId: z.string().uuid('sourceAssetId must be an image id'),
  preset: z.enum(MOTION_PRESETS.map((p) => p.id) as [string, ...string[]]),
  durationS: z
    .number()
    .int()
    .refine((d) => (MOTION_DURATIONS as readonly number[]).includes(d), `Duration must be one of ${MOTION_DURATIONS.join(', ')} seconds`)
    .default(5),
});

// Ids are uuids. Validating the shape avoids a DB round-trip for garbage input.
const IdParam = z.object({ id: z.string().uuid() });
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});
const JobsQuery = PageQuery.extend({
  status: z.enum(['QUEUED', 'PROCESSING', 'DONE', 'FAILED']).optional(),
  kind: z.enum(['IMAGE', 'MOTION', 'EDIT']).optional(),
});
const AssetsQuery = PageQuery.extend({ type: z.enum(['image', 'video']).optional() });
const UploadsQuery = PageQuery.extend({ type: z.enum(['image', 'video', 'audio']).optional() });
const BuildSchema = z.object({
  templateId: z.string().max(50),
  uploadIds: z.array(z.string().uuid()).min(1, 'Pick at least one file').max(EDIT_LIMITS.clips - 2),
  title: z.string().trim().max(80).optional(),
  subtitle: z.string().trim().max(120).optional(),
  targetS: z.number().min(5).max(EDIT_LIMITS.maxTotalS).optional(),
  /** Optional caption per upload id. */
  captions: z.record(z.string().uuid(), z.string().max(EDIT_LIMITS.textChars)).optional(),
});
const CreateUploadSchema = z.object({
  // Display only (never used as a path): strip anything path-like, keep it short.
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((n) => n.split(/[\\/]/).pop()!.replace(/[^\w .()-]/g, '_').slice(0, 120) || 'file'),
  mimeType: z.enum(Object.keys(UPLOAD_TYPES) as [UploadMime, ...UploadMime[]], {
    errorMap: () => ({ message: 'Supported: PNG/JPEG/WebP images, MP4/WebM/MOV videos, MP3/WAV/M4A/OGG audio' }),
  }),
  bytes: z.number().int().positive(),
  source: z.enum(['UPLOAD', 'RECORDING']).default('UPLOAD'),
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
  opts: {
    jwtSecret: string;
    providerMode: ProviderMode;
    generateRateLimit: number;
    onOrphan?: (key: string, err: unknown) => void;
    uploads?: UploadService;
  },
): Router {
  const router = Router();
  const auth = requireAuth(opts.jwtSecret);
  const catalog = catalogFor(opts.providerMode);
  const GenerateSchema = generateSchema(opts.providerMode);

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
      // usdPerImage and provider params are internal: never sent to the browser.
      models: catalog.map(({ id, name, description, credits, aspectRatios }) => ({ id, name, description, credits, aspectRatios })),
      aspectRatios: ASPECT_RATIOS,
    });
  });

  router.get('/motion/presets', (_req, res) => {
    res.json({
      // Honest label for the UI: this is a camera move, not AI video.
      engine: 'camera',
      presets: MOTION_PRESETS.map(({ id, name, description }) => ({ id, name, description })),
      durations: MOTION_DURATIONS.map((s) => ({ seconds: s, credits: motionCost(s) })),
    });
  });

  router.post('/motion', auth, generateLimiter, async (req, res) => {
    const input = MotionSchema.parse(req.body);
    const rawKey = req.get('Idempotency-Key');
    const key = rawKey === undefined ? undefined : IdempotencyKey.parse(rawKey);
    const { job, replayed } = await service.createMotion(req.userId!, input, key);
    res.status(replayed ? 200 : 202).location(`/jobs/${job.id}`).json({ job });
  });

  // ---- Editor: uploads + render ----
  router.get('/editor/config', (_req, res) => {
    res.json({
      formats: Object.entries(EDIT_FORMATS).map(([id, size]) => ({ id, ...size })),
      limits: { ...EDIT_LIMITS, imageBytes: UPLOAD_LIMITS.imageBytes, videoBytes: UPLOAD_LIMITS.videoBytes, audioBytes: UPLOAD_LIMITS.audioBytes, maxVideoS: UPLOAD_LIMITS.maxVideoS },
      uploadTypes: Object.keys(UPLOAD_TYPES),
      secondsPerCredit: EDIT_SECONDS_PER_CREDIT,
      transitions: TRANSITIONS,
      motions: IMAGE_MOTIONS,
      templates: TEMPLATES,
    });
  });

  /**
   * Template + the user's files -> a complete timeline (not rendered, not charged). The browser
   * loads it into the editor, where the user can change anything before rendering.
   */
  router.post('/edits/build', auth, async (req, res) => {
    const input = BuildSchema.parse(req.body);
    const t = findTemplate(input.templateId);
    if (!t) throw new HttpError(400, 'Unknown template');
    const items = await service.uploadInfo(req.userId!, input.uploadIds);
    const draft = buildFromTemplate(
      t,
      items.map((u) => ({ ...u, caption: input.captions?.[u.uploadId] })),
      { title: input.title, subtitle: input.subtitle, targetS: input.targetS },
    );
    // Prove it's renderable right now (same normalisation the render uses): fail here, not later.
    const spec = await service.previewEdit(req.userId!, EditRequestSchema.parse(draft));
    res.json({ draft, totalS: spec.totalS });
  });

  router.post('/edits', auth, generateLimiter, async (req, res) => {
    const input = EditRequestSchema.parse(req.body);
    const rawKey = req.get('Idempotency-Key');
    const key = rawKey === undefined ? undefined : IdempotencyKey.parse(rawKey);
    const { job, replayed } = await service.createEdit(req.userId!, input, key);
    res.status(replayed ? 200 : 202).location(`/jobs/${job.id}`).json({ job });
  });

  const uploads = opts.uploads;
  if (uploads) {
    router.post('/uploads', auth, generateLimiter, async (req, res) => {
      const result = await uploads.create(req.userId!, CreateUploadSchema.parse(req.body));
      res.status(201).json(result);
    });
    router.post('/uploads/:id/complete', auth, async (req, res) => {
      res.json({ upload: await uploads.complete(req.userId!, parseId(req.params)) });
    });
    router.get('/uploads/:id', auth, async (req, res) => {
      res.set('Cache-Control', 'no-store'); // polled while a transcription runs
      res.json({ upload: await uploads.get(req.userId!, parseId(req.params)) });
    });
    router.get('/uploads', auth, async (req, res) => {
      res.json(await uploads.list(req.userId!, UploadsQuery.parse(req.query)));
    });
    router.delete('/uploads/:id', auth, async (req, res) => {
      await uploads.remove(req.userId!, parseId(req.params), opts.onOrphan);
      res.status(204).end();
    });
  }

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
    res.json(await service.listAssets(req.userId!, AssetsQuery.parse(req.query)));
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
