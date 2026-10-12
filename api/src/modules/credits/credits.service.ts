import type { CreditReason, PrismaClient } from '@prisma/client';
import { InsufficientCreditsError } from '../../lib/errors.js';
import type { Metrics } from '../../observability/metrics.js';

/**
 * The ONLY code allowed to change a user's credit balance.
 * Every change = balance update + ledger row, in one DB transaction.
 */
export function createCreditService(prisma: PrismaClient, metrics?: Metrics) {
  return {
    async grant(userId: string, amount: number, reason: CreditReason, refId?: string) {
      assertPositive(amount);
      const row = await prisma.$transaction(async (tx) => {
        const { credits } = await tx.user.update({
          where: { id: userId },
          data: { credits: { increment: amount } },
          select: { credits: true },
        });
        return tx.creditTransaction.create({
          data: { userId, delta: amount, reason, refId, balanceAfter: credits },
        });
      });
      metrics?.creditsGranted.inc({ reason }, amount); // count only after commit
      return row;
    },

    /**
     * Atomic "check and subtract": the WHERE clause only matches if the balance
     * is high enough, and Postgres locks the row while updating it.
     * Two concurrent debits can't both pass a stale check (no check-then-act race).
     */
    async debit(userId: string, amount: number, reason: CreditReason, refId?: string) {
      assertPositive(amount);
      const row = await prisma.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: userId, credits: { gte: amount } },
          data: { credits: { decrement: amount } },
        });
        if (count === 0) {
          metrics?.debitRejected.inc();
          throw new InsufficientCreditsError();
        }

        // We hold the row lock until commit, so this read sees our own update.
        const { credits } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true } });
        return tx.creditTransaction.create({
          data: { userId, delta: -amount, reason, refId, balanceAfter: credits },
        });
      });
      metrics?.creditsDebited.inc(amount);
      return row;
    },

    async getSummary(userId: string, limit: number) {
      const [user, transactions] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true } }),
        prisma.creditTransaction.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, delta: true, reason: true, balanceAfter: true, refId: true, createdAt: true },
        }),
      ]);
      return { balance: user.credits, transactions };
    },
  };
}

function assertPositive(amount: number) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Credit amount must be a positive integer, got ${amount}`);
}

export type CreditService = ReturnType<typeof createCreditService>;
