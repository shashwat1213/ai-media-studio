import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { ensureDemoAccount } from '../modules/auth/demo-account.js';

/**
 * Internal cron endpoint (Vercel Cron hits it on a schedule). Tops the public demo account's
 * credits back up to the daily cap so a recruiter always has some to spend. Idempotent per day.
 *
 * Protected by a bearer token (CRON_SECRET). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
 * automatically when the env var is set. No token configured = the route is disabled (404).
 */
export interface CronConfig {
  secret?: string;
  bcryptCost: number;
  demo?: { email: string; password: string; dailyCredits: number };
}

export function cronRouter(prisma: PrismaClient, cfg: CronConfig): Router {
  const router = Router();
  router.all('/internal/cron/demo-topup', async (req, res) => {
    if (!cfg.secret || req.get('authorization') !== `Bearer ${cfg.secret}`) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!cfg.demo) {
      res.json({ ok: true, skipped: 'no demo account configured' });
      return;
    }
    const r = await ensureDemoAccount(prisma, { ...cfg.demo, bcryptCost: cfg.bcryptCost });
    res.json({ ok: true, credits: r.credits, changed: r.changed });
  });
  return router;
}
