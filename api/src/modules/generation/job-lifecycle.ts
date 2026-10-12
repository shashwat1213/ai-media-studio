import type { JobStatus, Prisma, PrismaClient } from '@prisma/client';
import { applyGrant } from '../credits/credits.service.js';

/**
 * Job state transitions shared by the API (enqueue failed), the worker (provider failed)
 * and the sweeper (job stuck). They all go through ONE function so the refund rule
 * lives in exactly one place.
 */

/** Jobs in these states still hold reserved credits and may still finish. */
export const ACTIVE_STATUSES: JobStatus[] = ['QUEUED', 'PROCESSING'];

/**
 * Mark a job FAILED and refund its credits, atomically and AT MOST ONCE.
 *
 * Exactly-once refund comes from two independent guards:
 *  1. The conditional UPDATE only matches while the job is still active. Whoever flips it
 *     to FAILED first wins; everyone else gets count = 0 and refunds nothing.
 *  2. A partial unique index (one REFUND row per refId) in the database. Even a buggy future
 *     code path can't write a second refund for the same job.
 *
 * Returns true if THIS call failed + refunded the job.
 */
export async function failAndRefund(
  prisma: PrismaClient,
  jobId: string,
  userMessage: string,
  extraWhere: Prisma.GenerationJobWhereInput = {},
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.generationJob.updateMany({
      where: { id: jobId, status: { in: ACTIVE_STATUSES }, ...extraWhere },
      data: { status: 'FAILED', error: userMessage, finishedAt: new Date() },
    });
    if (count === 0) return false;

    const job = await tx.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { userId: true, creditsCost: true },
    });
    await applyGrant(tx, job.userId, job.creditsCost, 'REFUND', jobId);
    return true;
  });
}
