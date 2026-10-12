import { loadEnv } from './config/env.js';
import { toAppConfig } from './config/app-config.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';
import { createLogger } from './observability/logger.js';

const env = loadEnv();
const logger = createLogger(env.NODE_ENV, env.LOG_LEVEL);
const app = createApp({ prisma, config: toAppConfig(env), logger });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

/**
 * Graceful shutdown: Docker/ECS send SIGTERM before killing a container.
 * Stop accepting new requests, let in-flight ones finish, close the DB pool, exit.
 * This is what makes rolling deployments zero-downtime.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
