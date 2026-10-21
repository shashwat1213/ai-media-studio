import { loadEnv } from './config/env.js';
import { toAppConfig } from './config/app-config.js';
import { prisma } from './lib/prisma.js';
import { createRedis, pingRedis } from './lib/redis.js';
import { storageFromEnv } from './lib/storage.js';
import { createApp } from './app.js';
import { createJobQueue } from './modules/generation/queue.js';
import { createLogger } from './observability/logger.js';
import { speechFromEnv } from './modules/audio/index.js';
import { localAiStatus } from './modules/director/index.js';

const env = loadEnv();
const logger = createLogger(env.NODE_ENV, env.LOG_LEVEL);
const redis = createRedis(env.REDIS_URL, 'producer');
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
const queue = createJobQueue(redis, { maxAttempts: env.JOB_MAX_ATTEMPTS, backoffMs: 2_000 });
const storage = await storageFromEnv(env);
const config = toAppConfig(env);

const speech = speechFromEnv(env);
const app = createApp({ prisma, config, logger, queue, storage, redisPing: () => pingRedis(redis), speech, ffmpegPath: env.FFMPEG_PATH, localAi: () => localAiStatus(env) });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, aiProvider: config.providerMode, speech: speech.name }, 'API listening');
});

/**
 * Graceful shutdown: Docker/ECS send SIGTERM before killing a container.
 * Stop accepting new requests, let in-flight ones finish, close connections, exit.
 * This is what makes rolling deployments zero-downtime.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await queue.close();
    redis.disconnect();
    storage.destroy();
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
