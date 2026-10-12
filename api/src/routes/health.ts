import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';

/**
 * Health check used by Docker healthchecks, the ECS load balancer, and humans.
 * It pings the DB (and Redis, when wired) so "healthy" means "can actually serve requests".
 * Dependencies are injected so tests can pass fakes.
 */
export function healthRouter(db: Pick<PrismaClient, '$queryRaw'>, redisPing?: () => Promise<boolean>): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const [dbUp, redisUp] = await Promise.all([
      db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redisPing ? redisPing() : Promise.resolve(undefined),
    ]);
    const body: Record<string, string> = { status: 'ok', db: dbUp ? 'up' : 'down' };
    if (redisUp !== undefined) body.redis = redisUp ? 'up' : 'down';
    // Redis down = can't queue new jobs, but reads still work: report it, only the DB decides 503.
    if (!dbUp) {
      body.status = 'degraded';
      res.status(503).json(body);
      return;
    }
    if (redisUp === false) body.status = 'degraded';
    res.json(body);
  });

  return router;
}
