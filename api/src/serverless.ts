import type { Express } from 'express';
import { loadEnv } from './config/env.js';
import { toAppConfig } from './config/app-config.js';
import { prisma } from './lib/prisma.js';
import { storageFromEnv } from './lib/storage.js';
import { createApp } from './app.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { speechFromEnv } from './modules/audio/index.js';
import { directorFromEnv, localAiStatus, picturesFromEnv, scribeFromEnv } from './modules/director/index.js';
import { providerFromEnv } from './modules/generation/providers/index.js';
import { createFfmpegRenderer } from './modules/generation/motion-renderer.js';
import { createEditRenderer } from './modules/editor/edit-renderer.js';
import { createJobHandler, createSweeper } from './modules/generation/worker.js';
import { createInlineQueue } from './modules/generation/inline-queue.js';

/**
 * The whole backend as ONE serverless function (Vercel): the Express API plus the job processing
 * that normally runs in the worker container. Jobs run in the background of the request that
 * created them (waitUntil), so no Redis and no always-on worker are needed.
 *
 *   STORAGE_DRIVER=vercel-blob  QUEUE_DRIVER=inline  DIRECTOR_PROVIDER=cloudflare  AI_PROVIDER=cloudflare
 */
export async function createServerlessApp(runInBackground: (p: Promise<unknown>) => void, opts: { jobTimeoutMs: number }): Promise<Express> {
  const env = loadEnv();
  const logger = createLogger(env.NODE_ENV, env.LOG_LEVEL);
  const metrics = createMetrics();
  const storage = await storageFromEnv(env);
  const speech = speechFromEnv(env);
  const deps = {
    prisma,
    provider: providerFromEnv(env),
    motion: createFfmpegRenderer({ ffmpegPath: env.FFMPEG_PATH, timeoutMs: 120_000 }),
    editor: createEditRenderer({ ffmpegPath: env.FFMPEG_PATH, timeoutMs: 240_000 }),
    speech,
    director: directorFromEnv(env),
    scribe: scribeFromEnv(env),
    pictures: picturesFromEnv(env),
    ffmpegPath: env.FFMPEG_PATH,
    storage,
    logger,
    metrics,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    jobTimeoutMinutes: env.JOB_TIMEOUT_MINUTES,
  };
  const queue = createInlineQueue({
    handle: createJobHandler(deps),
    runInBackground,
    logger,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    backoffMs: 2_000,
    jobTimeoutMs: opts.jobTimeoutMs,
    sweep: createSweeper(deps),
  });
  logger.info({ storage: env.STORAGE_DRIVER, queue: 'inline', provider: deps.provider.name, director: deps.director.name, speech: speech.name }, 'serverless app ready');
  return createApp({ prisma, config: toAppConfig(env), logger, metrics, queue, storage, speech, ffmpegPath: env.FFMPEG_PATH, localAi: () => localAiStatus(env) });
}
