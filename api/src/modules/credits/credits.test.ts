import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, prisma, resetDb } from '../../../test/helpers.js';
import { createCreditService } from './credits.service.js';
import { InsufficientCreditsError } from '../../lib/errors.js';

const app = makeApp();
const credits = createCreditService(prisma);

async function registerUser(email = 'bob@example.com') {
  const res = await request(app).post('/auth/register').send({ email, password: 'password-123' }).expect(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return { id: res.body.user.id as string, cookie };
}

async function ledgerSum(userId: string) {
  const agg = await prisma.creditTransaction.aggregate({ where: { userId }, _sum: { delta: true } });
  return agg._sum.delta ?? 0;
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('credit service', () => {
  it('grant adds credits and writes a ledger row with balanceAfter', async () => {
    const { id } = await registerUser();
    const tx = await credits.grant(id, 100, 'PURCHASE', 'pay_123');
    expect(tx).toMatchObject({ delta: 100, reason: 'PURCHASE', balanceAfter: 150, refId: 'pay_123' });
  });

  it('debit subtracts credits and writes a negative ledger row', async () => {
    const { id } = await registerUser();
    const tx = await credits.debit(id, 20, 'GENERATION', 'job_1');
    expect(tx).toMatchObject({ delta: -20, balanceAfter: 30 });
  });

  it('debit refuses to overdraw and changes nothing', async () => {
    const { id } = await registerUser();
    await expect(credits.debit(id, 51, 'GENERATION')).rejects.toBeInstanceOf(InsufficientCreditsError);
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.credits).toBe(50);
    expect(await prisma.creditTransaction.count({ where: { userId: id } })).toBe(1); // only the bonus
  });

  it('rejects zero / negative / fractional amounts', async () => {
    const { id } = await registerUser();
    await expect(credits.debit(id, 0, 'GENERATION')).rejects.toThrow();
    await expect(credits.grant(id, -5, 'PURCHASE')).rejects.toThrow();
    await expect(credits.grant(id, 1.5, 'PURCHASE')).rejects.toThrow();
  });

  it('CONCURRENCY: 10 parallel debits of 10 on a balance of 50 -> exactly 5 succeed, never negative', async () => {
    const { id } = await registerUser();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => credits.debit(id, 10, 'GENERATION', `job_${i}`)),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(5);
    for (const f of failed) expect((f as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.credits).toBe(0);
    // Ledger and cached balance agree: the audit trail explains every credit.
    expect(await ledgerSum(id)).toBe(user.credits);
  });

  it('the database itself rejects a negative balance (CHECK constraint)', async () => {
    const { id } = await registerUser();
    await expect(
      prisma.$executeRaw`UPDATE "User" SET credits = -1 WHERE id = ${id}`,
    ).rejects.toThrow(/User_credits_non_negative/);
  });
});

describe('GET /credits', () => {
  it('401 without a session', async () => {
    await request(app).get('/credits').expect(401);
  });

  it('returns balance + newest-first transactions, scoped to the caller', async () => {
    const bob = await registerUser('bob@example.com');
    const eve = await registerUser('eve@example.com');
    await credits.debit(bob.id, 5, 'GENERATION', 'job_a');
    await credits.grant(eve.id, 999, 'PURCHASE'); // another user's activity must not leak

    const res = await request(app).get('/credits').set('Cookie', bob.cookie);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(45);
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.transactions[0]).toMatchObject({ delta: -5, reason: 'GENERATION', balanceAfter: 45 });
    expect(res.body.transactions[1]).toMatchObject({ delta: 50, reason: 'SIGNUP_BONUS' });
    expect(res.body.transactions[0]).not.toHaveProperty('userId');
  });

  it('validates the limit query param', async () => {
    const { cookie } = await registerUser();
    await request(app).get('/credits?limit=0').set('Cookie', cookie).expect(400);
    await request(app).get('/credits?limit=500').set('Cookie', cookie).expect(400);
    const res = await request(app).get('/credits?limit=1').set('Cookie', cookie).expect(200);
    expect(res.body.transactions).toHaveLength(1);
  });
});
