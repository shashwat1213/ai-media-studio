import { loadWorkerEnv } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { createRedis } from './lib/redis.js';
import { createStorage, storageConfigFromEnv } from './lib/storage.js';
import { startGenerationWorker, startWorkerHttp } from './modules/generation/worker.js';
import { providerFromEnv } from './modules/generation/providers/index.js';
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
const storage = createStorage(storageConfigFromEnv(env));
const provider = providerFromEnv(env);

if (env.NODE_ENV !== 'production') await storage.ensureBucket();

const running = startGenerationWorker({
  prisma,
  connection,
  provider,
  storage,
  logger,
  metrics,
  concurrency: env.WORKER_CONCURRENCY,
  maxAttempts: env.JOB_MAX_ATTEMPTS,
  jobTimeoutMinutes: env.JOB_TIMEOUT_MINUTES,
});
const http = startWorkerHttp(env.WORKER_PORT, { prisma, connection, metrics, metricsToken: env.METRICS_TOKEN });

logger.info(
  { provider: provider.name, concurrency: env.WORKER_CONCURRENCY, port: env.WORKER_PORT },
  'worker started',
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down (finishing in-flight jobs)');
  setTimeout(() => process.exit(1), 30_000).unref();
  http.close();
  await running.close();
  await connection.quit();
  storage.destroy();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
