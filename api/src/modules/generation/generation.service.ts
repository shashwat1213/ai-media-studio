import { randomUUID } from 'node:crypto';
import { Prisma, type Asset, type GenerationJob, type JobKind, type JobStatus, type PrismaClient } from '@prisma/client';
import { conflict, HttpError, InsufficientCreditsError, notFound, serviceUnavailable, tooManyRequests } from '../../lib/errors.js';
import type { Storage } from '../../lib/storage.js';
import type { Metrics } from '../../observability/metrics.js';
import { applyDebit } from '../credits/credits.service.js';
import { ACTIVE_STATUSES, failAndRefund } from './job-lifecycle.js';
import { findModel } from './models.js';
import { MOTION_MODEL_ID, findPreset, motionCost } from './motion.js';
import type { JobQueue } from './queue.js';

export interface CreateJobInput {
  prompt: string;
  model: string;
  aspectRatio: string;
}

export interface CreateMotionInput {
  sourceAssetId: string;
  preset: string;
  durationS: number;
}

export interface GenerationServiceDeps {
  prisma: PrismaClient;
  queue: JobQueue;
  storage: Storage;
  metrics?: Metrics;
  maxActiveJobsPerUser: number;
}

/** What the API returns for an asset: never the storage key, always a fresh short-lived URL. */
export interface PublicAsset {
  id: string;
  jobId: string;
  url: string;
  downloadUrl: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  kind: 'image' | 'video';
  createdAt: Date;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
}

export interface PublicJob {
  id: string;
  kind: JobKind;
  prompt: string;
  model: string;
  aspectRatio: string;
  status: JobStatus;
  creditsCost: number;
  attempts: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  asset: PublicAsset | null;
  /** MOTION only. */
  motion: { preset: string; durationS: number; sourceAssetId: string | null } | null;
}

type JobWithAsset = GenerationJob & { asset: Asset | null };

export function createGenerationService({ prisma, queue, storage, metrics, maxActiveJobsPerUser }: GenerationServiceDeps) {
  const extOf = (mime: string) => (mime.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg');

  async function toPublicAsset(a: Asset, job?: Pick<GenerationJob, 'prompt' | 'model' | 'aspectRatio'>): Promise<PublicAsset> {
    const [url, downloadUrl] = await Promise.all([
      storage.signedUrl(a.storageKey),
      storage.signedUrl(a.storageKey, `ai-media-${a.id.slice(0, 8)}.${extOf(a.mimeType)}`),
    ]);
    return {
      id: a.id,
      jobId: a.jobId,
      url,
      downloadUrl,
      mimeType: a.mimeType,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      kind: a.mimeType.startsWith('video/') ? 'video' : 'image',
      createdAt: a.createdAt,
      ...(job ? { prompt: job.prompt, model: job.model, aspectRatio: job.aspectRatio } : {}),
    };
  }

  async function toPublicJob(j: JobWithAsset): Promise<PublicJob> {
    return {
      id: j.id,
      kind: j.kind,
      prompt: j.prompt,
      model: j.model,
      aspectRatio: j.aspectRatio,
      status: j.status,
      creditsCost: j.creditsCost,
      attempts: j.attempts,
      error: j.error,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      asset: j.asset ? await toPublicAsset(j.asset) : null,
      motion:
        j.kind === 'MOTION' && j.motionPreset && j.durationS
          ? { preset: j.motionPreset, durationS: j.durationS, sourceAssetId: j.sourceAssetId }
          : null,
    };
  }

  const sameRequest = (j: GenerationJob, input: CreateJobInput) =>
    j.prompt === input.prompt && j.model === input.model && j.aspectRatio === input.aspectRatio;

  async function replay(userId: string, key: string, input: CreateJobInput) {
    const existing = await prisma.generationJob.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      include: { asset: true },
    });
    if (!existing) return null;
    if (!sameRequest(existing, input)) throw conflict('Idempotency-Key was already used with a different request');
    return existing;
  }

  /**
   * The money path shared by every job kind. Reserve credits + create the job in ONE
   * transaction, then enqueue.
   *
   * Order inside the transaction matters:
   *  1. applyDebit locks the user's row (atomic conditional UPDATE). Every other generate
   *     request for this user now waits here until we commit.
   *  2. Only THEN do we count active jobs. Because of the lock, two parallel requests can't
   *     both see "2 active" and both start a 3rd. (Count first = check-then-act race.)
   *  3. Create the job. Any throw rolls back the debit too: no credits lost, no orphan job.
   */
  async function reserveAndEnqueue(
    userId: string,
    credits: number,
    idempotencyKey: string | undefined,
    fingerprint: CreateJobInput,
    createJob: (tx: Prisma.TransactionClient, id: string) => Promise<JobWithAsset>,
    sameExtra: (j: GenerationJob) => boolean = () => true,
  ): Promise<JobWithAsset | { job: PublicJob; replayed: true }> {
    const replayIfAny = async () => {
      if (!idempotencyKey) return null;
      const existing = await replay(userId, idempotencyKey, fingerprint);
      if (!existing) return null;
      if (!sameExtra(existing)) throw conflict('Idempotency-Key was already used with a different request');
      return { job: await toPublicJob(existing), replayed: true as const };
    };
    const early = await replayIfAny();
    if (early) return early;

    const jobId = randomUUID();
    let job: JobWithAsset;
    try {
      job = await prisma.$transaction(async (tx) => {
        await applyDebit(tx, userId, credits, 'GENERATION', jobId);
        const active = await tx.generationJob.count({ where: { userId, status: { in: ACTIVE_STATUSES } } });
        if (active >= maxActiveJobsPerUser) {
          throw tooManyRequests(`You already have ${active} generations running. Wait for one to finish.`);
        }
        return createJob(tx, jobId);
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) metrics?.debitRejected.inc();
      // Two requests with the same Idempotency-Key raced: the unique index let only one in.
      if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const late = await replayIfAny();
        if (late) return late;
      }
      throw err;
    }
    metrics?.creditsDebited.inc(credits);

    // The job is committed. If Redis is down we can't run it, so undo the charge right away
    // instead of leaving credits locked until the sweeper notices.
    try {
      await queue.enqueue(job.id);
    } catch {
      if (await failAndRefund(prisma, job.id, 'Could not queue the job. Your credits were refunded.')) {
        metrics?.creditsRefunded.inc(credits);
      }
      throw serviceUnavailable('Generation queue is unavailable. Your credits were refunded, please try again.');
    }
    metrics?.jobsCreated.inc({ model: job.model });
    return job;
  }

  return {
    /** Text -> image. See reserveAndEnqueue for how credits + queue stay consistent. */
    async create(userId: string, input: CreateJobInput, idempotencyKey?: string) {
      const model = findModel(input.model);
      if (!model) throw new HttpError(400, 'Unknown model');

      const job = await reserveAndEnqueue(userId, model.credits, idempotencyKey, input, (tx, id) =>
        tx.generationJob.create({
          data: { id, userId, prompt: input.prompt, model: model.id, aspectRatio: input.aspectRatio, creditsCost: model.credits, idempotencyKey },
          include: { asset: true },
        }),
      );
      if ('replayed' in job) return job;
      return { job: await toPublicJob(job), replayed: false };
    },

    /**
     * Animate one of the user's own images. Same money/queue path as create(): credits reserved
     * in the same transaction as the job, refunded once if anything fails.
     */
    async createMotion(userId: string, input: CreateMotionInput, idempotencyKey?: string) {
      const preset = findPreset(input.preset);
      if (!preset) throw new HttpError(400, 'Unknown motion preset');
      // Ownership check: someone else's image looks exactly like a missing one (404).
      const src = await prisma.asset.findFirst({
        where: { id: input.sourceAssetId, userId },
        include: { job: { select: { prompt: true, aspectRatio: true } } },
      });
      if (!src) throw notFound('Source image not found');
      if (!src.mimeType.startsWith('image/')) throw new HttpError(400, 'Only images can be animated');

      const credits = motionCost(input.durationS);
      const prompt = src.job.prompt;
      const fingerprint = { prompt, model: MOTION_MODEL_ID, aspectRatio: src.job.aspectRatio };
      const job = await reserveAndEnqueue(userId, credits, idempotencyKey, fingerprint, (tx, id) =>
        tx.generationJob.create({
          data: {
            id,
            userId,
            kind: 'MOTION',
            prompt,
            model: MOTION_MODEL_ID,
            aspectRatio: src.job.aspectRatio,
            creditsCost: credits,
            idempotencyKey,
            sourceAssetId: src.id,
            motionPreset: preset.id,
            durationS: input.durationS,
          },
          include: { asset: true },
        }),
        (j) => j.sourceAssetId === src.id && j.motionPreset === preset.id && j.durationS === input.durationS,
      );
      if ('replayed' in job) return job;
      return { job: await toPublicJob(job), replayed: false };
    },

    async getJob(userId: string, id: string) {
      // userId in the WHERE: someone else's job looks exactly like a missing one (404, not 403),
      // so ids can't be probed to learn what exists.
      const job = await prisma.generationJob.findFirst({ where: { id, userId }, include: { asset: true } });
      if (!job) throw notFound('Job not found');
      return toPublicJob(job);
    },

    /** Cursor pagination: stable under inserts (offset pagination would skip/duplicate rows). */
    async listJobs(userId: string, opts: { limit: number; cursor?: string; status?: JobStatus; kind?: JobKind }) {
      const rows = await prisma.generationJob.findMany({
        where: { userId, ...(opts.status ? { status: opts.status } : {}), ...(opts.kind ? { kind: opts.kind } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        include: { asset: true },
      });
      const page = rows.slice(0, opts.limit);
      return {
        items: await Promise.all(page.map(toPublicJob)),
        nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
      };
    },

    async listAssets(userId: string, opts: { limit: number; cursor?: string; type?: 'image' | 'video' }) {
      const rows = await prisma.asset.findMany({
        where: { userId, ...(opts.type ? { mimeType: { startsWith: `${opts.type}/` } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        include: { job: { select: { prompt: true, model: true, aspectRatio: true } } },
      });
      const page = rows.slice(0, opts.limit);
      return {
        items: await Promise.all(page.map((a) => toPublicAsset(a, a.job))),
        nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
      };
    },

    async getAsset(userId: string, id: string) {
      const a = await prisma.asset.findFirst({
        where: { id, userId },
        include: { job: { select: { prompt: true, model: true, aspectRatio: true } } },
      });
      if (!a) throw notFound('Asset not found');
      return toPublicAsset(a, a.job);
    },

    /**
     * Delete the DB row first, then the object. If the object delete fails we're left with an
     * orphan file nobody can reach (harmless, cleanable later), never a row pointing at nothing.
     * No refund: the generation work was done and paid for.
     */
    async deleteAsset(userId: string, id: string, onOrphan?: (key: string, err: unknown) => void) {
      const a = await prisma.asset.findFirst({ where: { id, userId }, select: { id: true, storageKey: true } });
      if (!a) throw notFound('Asset not found');
      await prisma.asset.delete({ where: { id: a.id } });
      try {
        await storage.remove(a.storageKey);
      } catch (err) {
        onOrphan?.(a.storageKey, err);
      }
    },
  };
}

export type GenerationService = ReturnType<typeof createGenerationService>;
