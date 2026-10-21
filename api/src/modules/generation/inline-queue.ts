import type { Logger } from 'pino';
import type { JobQueue, GenerationJobData } from './queue.js';
import type { QueueJob } from './worker.js';

/**
 * The job queue for a SERVERLESS deployment (no Redis, no long-running worker).
 *
 * enqueue() starts the job in the background of the SAME function invocation (`runInBackground`,
 * Vercel's waitUntil) and returns immediately, so the API still answers 202 at once. Retries
 * use the same exponential backoff as BullMQ. The DB row stays the source of truth: if the
 * function is killed mid-job, the sweeper refunds it after JOB_TIMEOUT_MINUTES (same as a
 * crashed BullMQ worker).
 *
 * Duplicate enqueues are ignored per instance (BullMQ's "same jobId = no-op" guarantee).
 */
export interface InlineQueueOptions {
  handle: (job: QueueJob, signal?: AbortSignal) => Promise<string>;
  /** Keeps the work alive after the response is sent (Vercel: waitUntil). */
  runInBackground: (p: Promise<unknown>) => void;
  logger: Logger;
  maxAttempts: number;
  backoffMs: number;
  /** Hard cap per job (the function's max duration minus a margin). */
  jobTimeoutMs: number;
  /** Optional housekeeping, run at most once per `sweepEveryMs` after a job. */
  sweep?: () => Promise<void>;
  sweepEveryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createInlineQueue(o: InlineQueueOptions): JobQueue & { idle(): Promise<void> } {
  const running = new Map<string, Promise<void>>();
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastSweep = 0;

  async function run(id: string, name: string, data: GenerationJobData, attempts: number) {
    const signal = AbortSignal.timeout(o.jobTimeoutMs);
    for (let attemptsMade = 0; attemptsMade < attempts; attemptsMade++) {
      try {
        const r = await o.handle({ name, data, attemptsMade, attempts }, signal);
        o.logger.info({ queueJob: id, result: r, attempt: attemptsMade + 1 }, 'inline job finished');
        break;
      } catch (err) {
        o.logger.warn({ queueJob: id, attempt: attemptsMade + 1, err: (err as Error).message }, 'inline job failed');
        if (signal.aborted || attemptsMade + 1 >= attempts) break; // the sweeper refunds anything left hanging
        await sleep(o.backoffMs * 2 ** attemptsMade);
      }
    }
    if (o.sweep && Date.now() - lastSweep > (o.sweepEveryMs ?? 60_000)) {
      lastSweep = Date.now();
      await o.sweep();
    }
  }

  function start(id: string, name: string, data: GenerationJobData, attempts: number) {
    if (running.has(id)) return;
    const p = run(id, name, data, attempts)
      .catch((err: unknown) => o.logger.error({ queueJob: id, err: (err as Error).message }, 'inline job crashed'))
      .finally(() => running.delete(id));
    running.set(id, p);
    o.runInBackground(p);
  }

  return {
    async enqueue(jobId: string) {
      start(jobId, 'generate', { jobId }, o.maxAttempts);
    },
    async enqueueTranscription(uploadId: string, ref: string) {
      start(`stt:${uploadId}:${ref}`, 'transcribe', { uploadId }, o.maxAttempts);
    },
    async enqueueScene(sceneId: string, attempt: string) {
      start(`scene:${sceneId}:${attempt}`, 'scene', { sceneId }, 2);
    },
    async close() {
      await Promise.allSettled([...running.values()]);
    },
    /** Tests: wait until every started job has finished. */
    async idle() {
      while (running.size) await Promise.allSettled([...running.values()]);
    },
  };
}
