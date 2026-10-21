import bcrypt from 'bcrypt';
import type { PrismaClient } from '@prisma/client';
import { applyDebit, applyGrant } from '../credits/credits.service.js';

/**
 * Public demo account (for recruiters on the live site). The password is published, so:
 *  - credits are topped up to a SMALL daily cap, never above it (ledger rows, like any other grant)
 *  - the top-up is idempotent per day (refId demo-topup:YYYY-MM-DD; running it twice changes nothing)
 *  - the password is reset to the published one each run (in case someone found a way to change it)
 * Run daily from cron: `docker compose run --rm api node dist/demo-account.js`.
 */
export interface DemoAccountOptions {
  email: string;
  password: string;
  dailyCredits: number;
  bcryptCost: number;
  today?: Date;
}

export async function ensureDemoAccount(prisma: PrismaClient, o: DemoAccountOptions) {
  const email = o.email.trim().toLowerCase();
  const day = (o.today ?? new Date()).toISOString().slice(0, 10);
  const passwordHash = await bcrypt.hash(o.password, o.bcryptCost);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({ where: { email }, update: { passwordHash }, create: { email, passwordHash, credits: 0 } });
    const refId = `demo-topup:${day}`;
    const done = await tx.creditTransaction.findFirst({ where: { userId: user.id, refId } });
    if (done) return { userId: user.id, credits: user.credits, changed: 0 };
    const delta = o.dailyCredits - user.credits;
    if (delta > 0) await applyGrant(tx, user.id, delta, 'PURCHASE', refId);
    // Above the cap (e.g. the cap was lowered): bring it back down, also through the ledger.
    if (delta < 0) await applyDebit(tx, user.id, -delta, 'GENERATION', refId);
    return { userId: user.id, credits: o.dailyCredits, changed: delta };
  });
}
