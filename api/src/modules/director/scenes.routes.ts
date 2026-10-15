import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { HttpError, notFound, tooManyRequests } from '../../lib/errors.js';
import { applyDebit, applyGrant } from '../credits/credits.service.js';
import { requireAuth } from '../auth/require-auth.js';
import type { Voice } from '../audio/speech.js';
import type { Storage } from '../../lib/storage.js';
import { DIRECTOR_LIMITS, detectLanguage, SCENE_LANGUAGE_CHOICES, spokenLanguage } from './director.js';
import { DEFAULT_NARRATOR, voiceLanguage } from './local-ai.js';

/**
 * Scene Director API. A scene costs a flat fee when it's created (pictures + voice + an LLM run on
 * the local machine; the fee just keeps the free tier fair) and is refunded once if it fails for good.
 */
export const SCENE_COST = 5;
/** Extra for HD pictures: ~31 s of GPU per shot for the x4 upscale (vs ~12 s for the picture). */
export const SCENE_HD_EXTRA = 3;
export const sceneCost = (hd: boolean) => SCENE_COST + (hd ? SCENE_HD_EXTRA : 0);

const CreateScene = z.object({
  prompt: z.string().trim().min(3, 'Describe the scene').max(DIRECTOR_LIMITS.prompt),
  /** 'auto' (default) = the language the brief asks for ("English voice-over"), else the one it's written in. */
  language: z.enum(SCENE_LANGUAGE_CHOICES).default('auto'),
  format: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  targetS: z.number().int().min(6).max(DIRECTOR_LIMITS.maxTotalS).default(20),
  /** A VOICE library handle, or a raw voice id from GET /scenes/config. Omit = default narrator for the language. */
  voice: z.string().min(2).max(60).optional(),
  /** HD pictures (GPU x4 upscale). Needs the upscaler installed in the local AI. */
  hd: z.boolean().default(false),
});
const IdParam = z.object({ id: z.string().uuid() });
const parseId = (p: unknown) => {
  const r = IdParam.safeParse(p);
  if (!r.success) throw new HttpError(404, 'Not found');
  return r.data.id;
};

const publicScene = (s: { id: string; prompt: string; language: string; format: string; targetS: number; voice: string; hd: boolean; status: string; title: string | null; script: unknown; draft: unknown; progress: string | null; error: string | null; createdAt: Date; updatedAt: Date }) => s;

export function scenesRouter(opts: {
  prisma: PrismaClient;
  storage: Storage;
  jwtSecret: string;
  voices: () => Voice[];
  enqueueScene?: (sceneId: string, attempt: string) => Promise<void>;
  localAi: () => Promise<{ llm: boolean; image: boolean; upscale: boolean; faceRef: boolean }>;
  rateLimit: number;
}): Router {
  const { prisma } = opts;
  const router = Router();

  /** Scene + signed URLs for its shots' pictures (only this user's uploads). */
  async function withImages<T extends { userId: string; script: unknown }>(s: T) {
    const shots = ((s.script as { shots?: { imageUploadId?: string }[] } | null)?.shots ?? []);
    const ids = shots.map((x) => x.imageUploadId).filter((x): x is string => Boolean(x));
    const rows = ids.length ? await prisma.upload.findMany({ where: { id: { in: ids }, userId: s.userId, status: 'READY' }, select: { id: true, storageKey: true } }) : [];
    const images: Record<string, string> = {};
    await Promise.all(rows.map(async (r) => (images[r.id] = await opts.storage.signedUrl(r.storageKey))));
    const { userId: _omit, ...rest } = s;
    void _omit;
    return { ...publicScene(rest as never), images };
  }
  const auth = requireAuth(opts.jwtSecret);
  const limiter = rateLimit({ windowMs: 60_000, limit: opts.rateLimit, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (req) => req.userId!, message: { error: 'Too many requests, slow down' } });

  router.get('/scenes/config', auth, async (_req, res) => {
    res.json({ cost: SCENE_COST, hdCost: sceneCost(true), limits: DIRECTOR_LIMITS, voices: opts.voices(), localAi: await opts.localAi() });
  });

  router.get('/scenes', auth, async (req, res) => {
    const items = await prisma.scene.findMany({ where: { userId: req.userId! }, orderBy: { createdAt: 'desc' }, take: 30 });
    res.json({ items: await Promise.all(items.map(withImages)) });
  });

  router.get('/scenes/:id', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store'); // polled while producing
    const s = await prisma.scene.findFirst({ where: { id: parseId(req.params), userId: req.userId! } });
    if (!s) throw notFound('Scene not found');
    res.json({ scene: await withImages(s) });
  });

  async function start(userId: string, sceneId: string, attempt: string) {
    if (!opts.enqueueScene) throw new HttpError(503, 'The scene queue is unavailable');
    try {
      await opts.enqueueScene(sceneId, attempt);
    } catch {
      await failAndRefund(prisma, sceneId, 'Could not queue the scene. Your credits were refunded.');
      throw new HttpError(503, 'Scene queue is unavailable. Your credits were refunded, please try again.');
    }
    void userId;
  }

  router.post('/scenes', auth, limiter, async (req, res) => {
    const input = CreateScene.parse(req.body);
    const userId = req.userId!;
    const language = input.language === 'auto' ? detectLanguage(input.prompt).language : input.language;
    const spoken = spokenLanguage(language);
    // The voice must exist (a VOICE item of this user, or a known voice id) AND speak the scene's
    // language: a Hindi narrator reading English (or the reverse) is exactly the bug we never want.
    let voice = input.voice;
    const item = voice ? await prisma.libraryItem.findFirst({ where: { userId, kind: 'VOICE', handle: voice.toLowerCase() } }) : null;
    if (voice && !item && !opts.voices().some((v) => v.id === voice)) throw new HttpError(400, 'Unknown voice');
    // A library VOICE item wraps a voice id in settings.voice; the id says what language it speaks.
    const voiceLang = item ? voiceLanguage(String((item.settings as { voice?: string } | null)?.voice ?? '')) : voice ? voiceLanguage(voice) : null;
    if (!voice || voiceLang !== spoken) {
      const fallback = DEFAULT_NARRATOR[spoken];
      voice = opts.voices().some((v) => v.id === fallback) ? fallback : opts.voices().find((v) => voiceLanguage(v.id) === spoken)?.id;
      if (!voice) throw new HttpError(400, spoken === 'hi' ? 'No Hindi voice is available. Start the local AI.' : 'No English voice is available.');
    }
    if ((await prisma.scene.count({ where: { userId, status: { in: ['PLANNING', 'PRODUCING'] } } })) >= 2) {
      throw tooManyRequests('Two scenes are already being made. Wait for one to finish.');
    }
    // Don't charge for HD the machine can't make (checked again by the worker; a failure refunds).
    if (input.hd && !(await opts.localAi()).upscale) throw new HttpError(409, 'HD pictures need the upscaler. Run scripts/local-ai/install.sh and start the local AI.');
    const scene = await prisma.$transaction(async (tx) => {
      const s = await tx.scene.create({ data: { userId, prompt: input.prompt, language, format: input.format, targetS: input.targetS, hd: input.hd, voice: item && voice === input.voice ? item.handle : voice! } });
      await applyDebit(tx, userId, sceneCost(s.hd), 'GENERATION', `scene:${s.id}`);
      return s;
    });
    await start(userId, scene.id, '1');
    res.status(202).json({ scene: publicScene(scene) });
  });

  /** Retry a FAILED scene: keeps the script and pictures already made, charges again. */
  router.post('/scenes/:id/retry', auth, limiter, async (req, res) => {
    const id = parseId(req.params);
    const userId = req.userId!;
    const attempt = String(Date.now());
    const ok = await prisma.$transaction(async (tx) => {
      const { count } = await tx.scene.updateMany({ where: { id, userId, status: 'FAILED' }, data: { status: 'PLANNING', error: null, progress: 'Queued…' } });
      if (count === 0) return false;
      const { hd } = await tx.scene.findUniqueOrThrow({ where: { id }, select: { hd: true } });
      await applyDebit(tx, userId, sceneCost(hd), 'GENERATION', `scene:${id}:${attempt}`);
      return true;
    });
    if (!ok) throw new HttpError(409, 'Only a failed scene can be retried');
    await start(userId, id, attempt);
    res.status(202).json({ scene: publicScene(await prisma.scene.findUniqueOrThrow({ where: { id } })) });
  });

  router.delete('/scenes/:id', auth, async (req, res) => {
    const { count } = await prisma.scene.deleteMany({ where: { id: parseId(req.params), userId: req.userId!, status: { in: ['READY', 'FAILED'] } } });
    if (count === 0) throw new HttpError(409, 'Scene not found or still being made');
    res.status(204).end();
  });

  return router;
}

/**
 * FAILED + refund the LAST charge for this scene, at most once: the refund's refId is the debit's
 * refId, and the ledger allows one REFUND per refId (partial unique index).
 */
export async function failAndRefund(prisma: PrismaClient, sceneId: string, message: string) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.scene.findUnique({ where: { id: sceneId } });
    if (!s) return false;
    await tx.scene.update({ where: { id: sceneId }, data: { status: 'FAILED', error: message, progress: null } });
    const debit = await tx.creditTransaction.findFirst({
      where: { userId: s.userId, reason: 'GENERATION', refId: { startsWith: `scene:${sceneId}` } },
      orderBy: { createdAt: 'desc' },
    });
    if (!debit?.refId) return false;
    const already = await tx.creditTransaction.findFirst({ where: { reason: 'REFUND', refId: debit.refId } });
    if (already) return false;
    await applyGrant(tx, s.userId, -debit.delta, 'REFUND', debit.refId);
    return true;
  }) as Promise<boolean>;
}

export type SceneUpdate = Prisma.SceneUpdateInput;
