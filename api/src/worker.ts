import { loadWorkerEnv } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { createRedis } from './lib/redis.js';
import { storageFromEnv } from './lib/storage.js';
import { startGenerationWorker, startWorkerHttp } from './modules/generation/worker.js';
import { providerFromEnv } from './modules/generation/providers/index.js';
import { createFfmpegRenderer } from './modules/generation/motion-renderer.js';
import { createEditRenderer } from './modules/editor/edit-renderer.js';
import { speechFromEnv } from './modules/audio/index.js';
import { directorFromEnv, picturesFromEnv, scribeFromEnv } from './modules/director/index.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';

/**
 * Worker entrypoint: `node dist/worker.js`. Same codebase + Docker image as the API,
 * different start command (decided in 00_PROJECT_BASE §7a; explained in 04 learnings).
 */
const env = loadWorkerEnv();
const logger = createLogger(env.NODE_ENV, env.LOG_LEVEL).child({ proc: 'worker' });
const metrics = createMetrics();
const connection = createRedis(env.REDIS_URL, 'worker');
const storage = await storageFromEnv(env);
const provider = providerFromEnv(env);
const motion = createFfmpegRenderer({ ffmpegPath: env.FFMPEG_PATH, timeoutMs: 120_000 });
const editor = createEditRenderer({ ffmpegPath: env.FFMPEG_PATH, timeoutMs: 300_000 });
const speech = speechFromEnv(env);

if (env.NODE_ENV !== 'production') await storage.ensureBucket();

const running = startGenerationWorker({
  prisma,
  connection,
  provider,
  motion,
  editor,
  speech,
  director: directorFromEnv(env),
  scribe: scribeFromEnv(env),
  pictures: picturesFromEnv(env),
  ffmpegPath: env.FFMPEG_PATH,
  storage,
  logger,
  metrics,
  concurrency: env.WORKER_CONCURRENCY,
  maxAttempts: env.JOB_MAX_ATTEMPTS,
  jobTimeoutMinutes: env.JOB_TIMEOUT_MINUTES,
});
const http = startWorkerHttp(env.WORKER_PORT, { prisma, connection, metrics, metricsToken: env.METRICS_TOKEN });

logger.info(
  { provider: provider.name, motion: motion.name, editor: editor.name, speech: speech.name, concurrency: env.WORKER_CONCURRENCY, port: env.WORKER_PORT },
  'worker started',
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down (finishing in-flight jobs)');
  setTimeout(() => process.exit(1), 30_000).unref();
  http.close();
  await running.close();
  // worker.close() already closes the shared connection it was given; quit() would throw
  // "Connection is closed". Guard it so shutdown stays clean.
  await connection.quit().catch(() => undefined);
  storage.destroy();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
