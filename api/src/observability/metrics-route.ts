import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Metrics } from './metrics.js';

/**
 * GET /metrics in Prometheus text format.
 * If a token is configured, require `Authorization: Bearer <token>`: metrics
 * reveal traffic patterns and internals, so they shouldn't be public.
 */
export function metricsRouter(metrics: Metrics, token?: string): Router {
  const router = Router();
  router.get('/metrics', async (req, res) => {
    if (token && !safeEqual(req.headers.authorization ?? '', `Bearer ${token}`)) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });
  return router;
}

// Constant-time compare: a normal `===` returns faster on the first wrong
// character, which can leak the token one character at a time.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
