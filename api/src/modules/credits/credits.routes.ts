import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/require-auth.js';
import type { CreditService } from './credits.service.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function creditsRouter(credits: CreditService, jwtSecret: string): Router {
  const router = Router();

  router.get('/credits', requireAuth(jwtSecret), async (req, res) => {
    const { limit } = QuerySchema.parse(req.query);
    res.json(await credits.getSummary(req.userId!, limit));
  });

  return router;
}
