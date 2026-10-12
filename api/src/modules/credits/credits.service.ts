import type { CreditReason, Prisma, PrismaClient } from '@prisma/client';
import { InsufficientCreditsError } from '../../lib/errors.js';
import type { Metrics } from '../../observability/metrics.js';

/** A Prisma client OR an open transaction: both expose the same model API. */
type Db = Prisma.TransactionClient;

/**
 * The ONLY code allowed to change a user's credit balance.
 * Every change = balance update + ledger row, in one DB transaction.
 *
 * `applyGrant` / `applyDebit` run INSIDE a transaction the caller already opened.
 * The generation service needs that: "reserve credits" and "create the job" must
 * commit together or not at all. The service methods below wrap them in their own transaction.
 */
export async function applyGrant(tx: Db, userId: string, amount: number, reason: CreditReason, refId?: string) {
  assertPositive(amount);
  const { credits } = await tx.user.update({
    where: { id: userId },
    data: { credits: { increment: amount } },
    select: { credits: true },
  });
  return tx.creditTransaction.create({
    data: { userId, delta: amount, reason, refId, balanceAfter: credits },
  });
}

/**
 * Atomic "check and subtract": the WHERE clause only matches if the balance
 * is high enough, and Postgres locks the row while updating it.
 * Two concurrent debits can't both pass a stale check (no check-then-act race).
 * The row lock is held until the surrounding transaction commits, so it also
 * serialises anything else the caller does for this user in the same transaction.
 */
export async function applyDebit(tx: Db, userId: string, amount: number, reason: CreditReason, refId?: string) {
  assertPositive(amount);
  const { count } = await tx.user.updateMany({
    where: { id: userId, credits: { gte: amount } },
    data: { credits: { decrement: amount } },
  });
  if (count === 0) throw new InsufficientCreditsError();

  // We hold the row lock until commit, so this read sees our own update.
  const { credits } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true } });
  return tx.creditTransaction.create({
    data: { userId, delta: -amount, reason, refId, balanceAfter: credits },
  });
}

export function createCreditService(prisma: PrismaClient, metrics?: Metrics) {
  return {
    async grant(userId: string, amount: number, reason: CreditReason, refId?: string) {
      const row = await prisma.$transaction((tx) => applyGrant(tx, userId, amount, reason, refId));
      metrics?.creditsGranted.inc({ reason }, amount); // count only after commit
      return row;
    },

    async debit(userId: string, amount: number, reason: CreditReason, refId?: string) {
      try {
        const row = await prisma.$transaction((tx) => applyDebit(tx, userId, amount, reason, refId));
        metrics?.creditsDebited.inc(amount);
        return row;
      } catch (err) {
        if (err instanceof InsufficientCreditsError) metrics?.debitRejected.inc();
        throw err;
      }
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
