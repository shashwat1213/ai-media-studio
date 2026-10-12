import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { withTimeout } from '../../lib/redis.js';

export const GENERATION_QUEUE = 'generation';

/** What travels through Redis: just the id. The DB row is the source of truth for everything else. */
export interface GenerationJobData {
  jobId: string;
}

export interface JobQueueOptions {
  maxAttempts: number;
  /** First retry delay; doubles each attempt (exponential backoff). */
  backoffMs: number;
  enqueueTimeoutMs?: number;
}

/**
 * The producer side of the queue (used by the API).
 *
 * Why only the id goes into Redis: if the payload held the prompt/model too, there would be
 * two copies of the truth that could disagree. The worker re-reads the row from Postgres.
 */
export function createJobQueue(connection: Redis, opts: JobQueueOptions) {
  const queue = new Queue<GenerationJobData>(GENERATION_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: opts.maxAttempts,
      backoff: { type: 'exponential', delay: opts.backoffMs },
      // Don't let Redis grow forever: keep finished job records for a day / a week.
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  return {
    queue,
    /**
     * BullMQ jobId = our DB job id. Adding the same id twice is a no-op in BullMQ,
     * so a retried enqueue can never create a duplicate run.
     */
    async enqueue(jobId: string) {
      // Hard cap: if Redis is unreachable, give up in 3 s and let the caller refund + 503.
      await withTimeout(queue.add('generate', { jobId }, { jobId }), opts.enqueueTimeoutMs ?? 3_000, 'enqueue timed out');
    },
    async counts() {
      return queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    },
    close: () => queue.close(),
  };
}

export type JobQueue = Pick<ReturnType<typeof createJobQueue>, 'enqueue' | 'close'>;
