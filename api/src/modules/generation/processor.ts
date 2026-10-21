import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Storage } from '../../lib/storage.js';
import type { Metrics } from '../../observability/metrics.js';
import { failAndRefund } from './job-lifecycle.js';
import { findPreset } from './motion.js';
import type { MotionRenderer } from './motion-renderer.js';
import type { EditRenderer } from '../editor/edit-renderer.js';
import { parseStoredSpec, specUploadIds } from '../editor/edit-spec.js';
import { ProviderError, type ImageProvider } from './providers/types.js';

export interface ProcessorDeps {
  prisma: PrismaClient;
  provider: ImageProvider;
  /** Needed for MOTION jobs. A worker without it fails motion jobs (with a refund) instead of crashing. */
  motion?: MotionRenderer;
  /** Needed for EDIT jobs. Same rule: missing = fail + refund, never crash. */
  editor?: EditRenderer;
  storage: Storage;
  logger: Logger;
  metrics?: Metrics;
}

export interface AttemptInfo {
  /** 1-based number of this attempt. */
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

/**
 * What the BullMQ wrapper should do after an attempt:
 *  - 'done' / 'skipped' / 'failed': finished, don't retry.
 *  - 'retry': throw so BullMQ schedules another attempt with backoff.
 */
export type AttemptResult = 'done' | 'skipped' | 'failed' | 'retry';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
/** Edits can be 2 minutes of 1080p screen content. */
const MAX_EDIT_BYTES = 250 * 1024 * 1024;

/** The output of step 2, whatever the job kind. */
interface Output {
  data: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  costUsd?: number;
}

type Job = Awaited<ReturnType<PrismaClient['generationJob']['findUniqueOrThrow']>>;

const extOf = (mime: string) =>
  mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] ?? 'bin').replace('svg+xml', 'svg');

/**
 * One attempt at one job. Pure business logic, no BullMQ in here, so tests can call it
 * directly with a fake provider and check every branch.
 *
 * Crash safety: every step is either idempotent or guarded by a status condition.
 *  - The storage key is deterministic (users/<user>/<job>.<ext>), so a re-run overwrites the same object.
 *  - Asset create + DONE happen in one transaction, guarded by status = PROCESSING.
 *  - A late/duplicate delivery of a finished job is skipped at the first step.
 *
 * All kinds share this lifecycle; only step 2 ("make the output") differs:
 *  - IMAGE:  prompt -> AI provider -> image
 *  - MOTION: source image (from storage) -> renderer (ffmpeg) -> MP4
 *  - EDIT:   the user's uploads + captions (EditSpec) -> editor renderer (ffmpeg) -> MP4
 */
export async function processGenerationJob(jobId: string, info: AttemptInfo, deps: ProcessorDeps): Promise<AttemptResult> {
  const { prisma, storage, logger, metrics } = deps;
  const log = logger.child({ jobId, attempt: info.attempt });
  const endTimer = metrics?.jobDuration.startTimer();

  // 1. Claim: QUEUED -> PROCESSING (or re-claim PROCESSING on a retry). DONE/FAILED never match.
  const claimed = await prisma.generationJob.updateMany({
    where: { id: jobId, status: { in: ['QUEUED', 'PROCESSING'] } },
    data: { status: 'PROCESSING', attempts: info.attempt, startedAt: new Date(), error: null },
  });
  if (claimed.count === 0) {
    log.info('job already finished or missing, skipping');
    endTimer?.({ outcome: 'skipped' });
    return 'skipped';
  }
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });

  // 2. Make the output (the slow, flaky part).
  let output: Output;
  const source =
    job.kind === 'MOTION' ? (deps.motion?.name ?? 'none') : job.kind === 'EDIT' ? (deps.editor?.name ?? 'none') : deps.provider.name;
  const providerTimer = metrics?.providerDuration.startTimer({ provider: source });
  try {
    output =
      job.kind === 'MOTION'
        ? await renderMotion(job, info, deps)
        : job.kind === 'EDIT'
          ? await renderEdit(job, info, deps)
          : await generateImage(job, info, deps);
    const max = job.kind === 'MOTION' ? MAX_VIDEO_BYTES : job.kind === 'EDIT' ? MAX_EDIT_BYTES : MAX_IMAGE_BYTES;
    if (output.data.length === 0 || output.data.length > max) {
      throw new ProviderError(`bad output size: ${output.data.length} bytes`, {
        retryable: true,
        userMessage: job.kind === 'IMAGE' ? 'The AI provider returned an invalid image.' : 'Rendering produced an invalid video.',
      });
    }
    providerTimer?.({ outcome: 'ok' });
  } catch (err) {
    providerTimer?.({ outcome: 'error' });
    const pe =
      err instanceof ProviderError
        ? err
        : new ProviderError((err as Error).message, { retryable: true, userMessage: 'Something went wrong while generating.' });

    const lastAttempt = info.attempt >= info.maxAttempts;
    if (pe.retryable && !lastAttempt) {
      log.warn({ err: pe.message }, 'generation failed, will retry');
      metrics?.jobOutcomes.inc({ outcome: 'retried', model: job.model });
      endTimer?.({ outcome: 'retried' });
      return 'retry';
    }

    log.warn({ err: pe.message, retryable: pe.retryable }, 'generation failed for good, refunding');
    if (await failAndRefund(prisma, jobId, pe.userMessage)) {
      metrics?.creditsRefunded.inc(job.creditsCost);
    }
    metrics?.jobOutcomes.inc({ outcome: 'failed', model: job.model });
    endTimer?.({ outcome: 'failed' });
    return 'failed';
  }
  if (output.costUsd) metrics?.providerCostUsd.inc(output.costUsd);

  // 3. Upload. Deterministic key: a retry after a crash overwrites instead of leaking a second object.
  const storageKey = `users/${job.userId}/${job.id}.${extOf(output.mimeType)}`;
  await storage.put(storageKey, output.data, output.mimeType); // throws -> BullMQ retries (transient by nature)

  // 4. Record the asset and finish, atomically. If the sweeper failed+refunded this job while we
  //    were working, the guarded update matches 0 rows: we must NOT also deliver it for free.
  const finished = await prisma.$transaction(async (tx) => {
    const { count } = await tx.generationJob.updateMany({
      where: { id: jobId, status: 'PROCESSING' },
      data: { status: 'DONE', finishedAt: new Date(), error: null },
    });
    if (count === 0) return false;
    await tx.asset.create({
      data: {
        userId: job.userId,
        jobId: job.id,
        storageKey,
        mimeType: output.mimeType,
        bytes: output.data.length,
        width: output.width,
        height: output.height,
        durationMs: output.durationMs,
      },
    });
    return true;
  });

  if (!finished) {
    log.warn('job was failed by the sweeper meanwhile; discarding the result');
    await storage.remove(storageKey).catch(() => undefined);
    endTimer?.({ outcome: 'skipped' });
    return 'skipped';
  }

  log.info({ kind: job.kind, bytes: output.data.length, storageKey }, 'job done');
  metrics?.jobOutcomes.inc({ outcome: 'done', model: job.model });
  endTimer?.({ outcome: 'done' });
  return 'done';
}

function generateImage(job: Job, info: AttemptInfo, deps: ProcessorDeps): Promise<Output> {
  return deps.provider.generate({ prompt: job.prompt, model: job.model, aspectRatio: job.aspectRatio, signal: info.signal });
}

async function renderMotion(job: Job, info: AttemptInfo, deps: ProcessorDeps): Promise<Output> {
  if (!deps.motion) {
    throw new ProviderError('no motion renderer configured', { retryable: false, userMessage: 'Video rendering is unavailable right now.' });
  }
  const preset = job.motionPreset ? findPreset(job.motionPreset) : undefined;
  if (!preset || !job.durationS) {
    throw new ProviderError(`bad motion job: preset=${job.motionPreset} duration=${job.durationS}`, {
      retryable: false,
      userMessage: 'This motion preset is no longer available.',
    });
  }
  // The source must still exist AND still belong to the job's owner (defence in depth: the API
  // already checked ownership at create time, but the image could be deleted while queued).
  const src = job.sourceAssetId
    ? await deps.prisma.asset.findFirst({ where: { id: job.sourceAssetId, userId: job.userId } })
    : null;
  if (!src || !src.mimeType.startsWith('image/')) {
    throw new ProviderError('source image missing', {
      retryable: false,
      userMessage: 'The source image was deleted before the video could be made.',
    });
  }
  const image = await deps.storage.get(src.storageKey); // throws -> transient -> retry
  return deps.motion.render({ image, width: src.width, height: src.height, preset, durationS: job.durationS, signal: info.signal });
}

async function renderEdit(job: Job, info: AttemptInfo, deps: ProcessorDeps): Promise<Output> {
  if (!deps.editor) {
    throw new ProviderError('no edit renderer configured', { retryable: false, userMessage: 'Video rendering is unavailable right now.' });
  }
  const spec = parseStoredSpec(job.editSpec);
  if (!spec) throw new ProviderError('bad edit spec', { retryable: false, userMessage: 'This edit could not be read. Please try again.' });

  // Every source must still exist, be READY and belong to the job's owner (the user may have
  // deleted a file while the job was queued; ids in the JSON are never trusted on their own).
  const ids = specUploadIds(spec);
  const uploads = ids.length ? await deps.prisma.upload.findMany({ where: { id: { in: ids }, userId: job.userId, status: 'READY' } }) : [];
  const byId = new Map(uploads.map((u) => [u.id, u]));
  if (byId.size !== ids.length) {
    throw new ProviderError('edit source missing', {
      retryable: false,
      userMessage: 'One of the files in this edit was deleted before the video could be made.',
    });
  }
  return deps.editor.render({
    spec,
    // Storage errors are transient -> the generic catch marks them retryable.
    fetchClip: (i, filePath) => {
      const c = spec.clips[i]!;
      if (c.kind === 'card') return Promise.resolve();
      return deps.storage.download(byId.get(c.uploadId)!.storageKey, filePath);
    },
    fetchAudio: (i, filePath) => deps.storage.download(byId.get(spec.audio[i]!.uploadId)!.storageKey, filePath),
    signal: info.signal,
  });
}

/**
 * Safety net for jobs that will never finish on their own: the worker crashed mid-job and the
 * queue entry was lost, Redis was wiped, etc. Their credits would stay reserved forever.
 * Anything active and untouched for longer than the timeout is failed + refunded (exactly once).
 */
export async function sweepStuckJobs(
  prisma: PrismaClient,
  timeoutMinutes: number,
  metrics?: Metrics,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000);
  const stuck = await prisma.generationJob.findMany({
    where: { status: { in: ['QUEUED', 'PROCESSING'] }, updatedAt: { lt: cutoff } },
    select: { id: true, model: true, creditsCost: true },
    take: 100,
  });
  let refunded = 0;
  for (const j of stuck) {
    // Re-check the cutoff inside the update: the job may have progressed since we listed it.
    if (await failAndRefund(prisma, j.id, 'Generation timed out. Your credits were refunded.', { updatedAt: { lt: cutoff } })) {
      refunded++;
      metrics?.creditsRefunded.inc(j.creditsCost);
      metrics?.jobOutcomes.inc({ outcome: 'swept', model: j.model });
    }
  }
  return refunded;
}
