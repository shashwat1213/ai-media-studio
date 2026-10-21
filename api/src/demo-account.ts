import { z } from 'zod';
import { prisma } from './lib/prisma.js';
import { ensureDemoAccount } from './modules/auth/demo-account.js';

/** One-shot: create / refresh the public demo account, then exit. See modules/auth/demo-account.ts. */
const env = z
  .object({
    DEMO_EMAIL: z.string().email(),
    DEMO_PASSWORD: z.string().min(8),
    DEMO_DAILY_CREDITS: z.coerce.number().int().min(0).max(1000).default(100),
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  })
  .parse(process.env);

try {
  const r = await ensureDemoAccount(prisma, { email: env.DEMO_EMAIL, password: env.DEMO_PASSWORD, dailyCredits: env.DEMO_DAILY_CREDITS, bcryptCost: env.BCRYPT_COST });
  console.log(`demo account ${env.DEMO_EMAIL}: ${r.credits} credits (changed ${r.changed >= 0 ? '+' : ''}${r.changed})`);
} finally {
  await prisma.$disconnect();
}
