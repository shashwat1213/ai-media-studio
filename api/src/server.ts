import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';

const app = createApp({ db: prisma, corsOrigin: env.CORS_ORIGIN });

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});

/**
 * Graceful shutdown: Docker/ECS send SIGTERM before killing a container.
 * We stop accepting new requests, let in-flight ones finish, close the DB pool,
 * then exit. This is what makes rolling deployments zero-downtime.
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
