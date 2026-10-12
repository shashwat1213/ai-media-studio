import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';

/**
 * Health check used by Docker healthchecks, the ECS load balancer, and humans.
 * It also pings the DB so "healthy" means "can actually serve requests".
 * The prisma client is injected so tests can pass a fake one.
 */
export function healthRouter(db: Pick<PrismaClient, '$queryRaw'>): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  return router;
}
