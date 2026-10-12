import { loadEnv } from './config/env.js';
import { toAppConfig } from './config/app-config.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';

const env = loadEnv();
const app = createApp({ prisma, config: toAppConfig(env) });

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});

/**
 * Graceful shutdown: Docker/ECS send SIGTERM before killing a container.
 * Stop accepting new requests, let in-flight ones finish, close the DB pool, exit.
 * This is what makes rolling deployments zero-downtime.
 */
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
