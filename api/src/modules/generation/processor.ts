import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Storage } from '../../lib/storage.js';
import type { Metrics } from '../../observability/metrics.js';
import { failAndRefund } from './job-lifecycle.js';
import { ProviderError, type ImageProvider } from './providers/types.js';

export interface ProcessorDeps {
  prisma: PrismaClient;
  provider: ImageProvider;
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

/**
 * One attempt at one job. Pure business logic, no BullMQ in here, so tests can call it
 * directly with a fake provider and check every branch.
 *
 * Crash safety: every step is either idempotent or guarded by a status condition.
 *  - The storage key is deterministic (users/<user>/<job>.<ext>), so a re-run overwrites the same object.
 *  - Asset create + DONE happen in one transaction, guarded by status = PROCESSING.
 *  - A late/duplicate delivery of a finished job is skipped at the first step.
 */
export async function processGenerationJob(jobId: string, info: AttemptInfo, deps: ProcessorDeps): Promise<AttemptResult> {
  const { prisma, provider, storage, logger, metrics } = deps;
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

  // 2. Call the AI provider (the slow, flaky, paid part).
  let image;
  const providerTimer = metrics?.providerDuration.startTimer({ provider: provider.name });
  try {
    image = await provider.generate({ prompt: job.prompt, model: job.model, aspectRatio: job.aspectRatio, signal: info.signal });
    if (image.data.length === 0 || image.data.length > MAX_IMAGE_BYTES) {
      throw new ProviderError(`bad image size: ${image.data.length} bytes`, {
        retryable: true,
        userMessage: 'The AI provider returned an invalid image.',
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
      log.warn({ err: pe.message }, 'provider failed, will retry');
      metrics?.jobOutcomes.inc({ outcome: 'retried', model: job.model });
      endTimer?.({ outcome: 'retried' });
      return 'retry';
    }

    log.warn({ err: pe.message, retryable: pe.retryable }, 'provider failed for good, refunding');
    if (await failAndRefund(prisma, jobId, pe.userMessage)) {
      metrics?.creditsRefunded.inc(job.creditsCost);
    }
    metrics?.jobOutcomes.inc({ outcome: 'failed', model: job.model });
    endTimer?.({ outcome: 'failed' });
    return 'failed';
  }
  if (image.costUsd) metrics?.providerCostUsd.inc(image.costUsd);

  // 3. Upload. Deterministic key: a retry after a crash overwrites instead of leaking a second object.
  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : (image.mimeType.split('/')[1] ?? 'bin').replace('svg+xml', 'svg');
  const storageKey = `users/${job.userId}/${job.id}.${ext}`;
  await storage.put(storageKey, image.data, image.mimeType); // throws -> BullMQ retries (transient by nature)

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
        mimeType: image.mimeType,
        bytes: image.data.length,
        width: image.width,
        height: image.height,
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

  log.info({ bytes: image.data.length, storageKey }, 'job done');
  metrics?.jobOutcomes.inc({ outcome: 'done', model: job.model });
  endTimer?.({ outcome: 'done' });
  return 'done';
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
