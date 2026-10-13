import { createServer, type Server } from 'node:http';
import { UnrecoverableError, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Storage } from '../../lib/storage.js';
import { pingRedis } from '../../lib/redis.js';
import type { Metrics } from '../../observability/metrics.js';
import { processGenerationJob, sweepStuckJobs } from './processor.js';
import type { ImageProvider } from './providers/types.js';
import type { MotionRenderer } from './motion-renderer.js';
import { GENERATION_QUEUE, type GenerationJobData } from './queue.js';

export interface GenerationWorkerDeps {
  prisma: PrismaClient;
  connection: Redis;
  provider: ImageProvider;
  motion?: MotionRenderer;
  storage: Storage;
  logger: Logger;
  metrics?: Metrics;
  concurrency: number;
  maxAttempts: number;
  jobTimeoutMinutes: number;
  sweepIntervalMs?: number;
}

/**
 * BullMQ wiring around processGenerationJob.
 * The worker is a SEPARATE process from the API (one process per container): a slow AI call
 * or a CPU-heavy image step can never make the API slow, and each scales on its own.
 */
export function startGenerationWorker(deps: GenerationWorkerDeps) {
  const { prisma, connection, provider, motion, storage, logger, metrics } = deps;

  const worker = new Worker<GenerationJobData>(
    GENERATION_QUEUE,
    async (job, _token, signal) => {
      const result = await processGenerationJob(
        job.data.jobId,
        // attemptsMade = finished attempts before this one.
        { attempt: job.attemptsMade + 1, maxAttempts: deps.maxAttempts, signal },
        { prisma, provider, motion, storage, logger, metrics },
      );
      if (result === 'retry') throw new Error('transient provider failure, retrying');
      return result;
    },
    {
      connection,
      concurrency: deps.concurrency,
      // If a worker dies mid-job, its lock expires and another worker picks the job up again.
      lockDuration: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    // Out of attempts but the processor never got to refund (e.g. S3 kept failing):
    // the sweeper will refund it after the timeout. Log it loudly so it's visible.
    if (job.attemptsMade >= deps.maxAttempts && !(err instanceof UnrecoverableError)) {
      logger.error({ jobId: job.data.jobId, err: err.message }, 'job exhausted retries');
    }
  });
  worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'));

  const sweep = async () => {
    try {
      const n = await sweepStuckJobs(prisma, deps.jobTimeoutMinutes, metrics);
      if (n > 0) logger.warn({ refunded: n }, 'swept stuck jobs');
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'sweeper failed');
    }
  };
  const sweeper = setInterval(sweep, deps.sweepIntervalMs ?? 60_000);
  sweeper.unref();
  void sweep();

  return {
    worker,
    async close() {
      clearInterval(sweeper);
      // Waits for in-flight jobs to finish (graceful), so a deploy doesn't kill a half-done job.
      await worker.close();
    },
  };
}

/** Tiny HTTP server for the worker: /health (container healthcheck) and /metrics (Prometheus). */
export function startWorkerHttp(
  port: number,
  deps: { prisma: PrismaClient; connection: Redis; metrics: Metrics; metricsToken?: string },
): Server {
  const server = createServer(async (req, res) => {
    if (req.url === '/health') {
      const [db, redis] = await Promise.all([
        deps.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        pingRedis(deps.connection),
      ]);
      const ok = db && redis;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', db: db ? 'up' : 'down', redis: redis ? 'up' : 'down' }));
      return;
    }
    if (req.url === '/metrics') {
      if (deps.metricsToken && req.headers.authorization !== `Bearer ${deps.metricsToken}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': deps.metrics.registry.contentType });
      res.end(await deps.metrics.registry.metrics());
      return;
    }
    res.writeHead(404).end();
  });
  return server.listen(port);
}
