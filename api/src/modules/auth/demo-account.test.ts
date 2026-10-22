import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, prisma, resetDb } from '../../../test/helpers.js';
import { ensureDemoAccount } from './demo-account.js';

const app = makeApp();
const base = { email: ' Recruiter@Demo.dev ', password: 'demo-pass-123', dailyCredits: 100, bcryptCost: 4 };
const ledgerSum = async (userId: string) => (await prisma.creditTransaction.aggregate({ where: { userId }, _sum: { delta: true } }))._sum.delta ?? 0;

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('demo account', () => {
  it('creates the account (lower-cased email) with the daily credits; login works with the published password', async () => {
    const r = await ensureDemoAccount(prisma, { ...base, today: new Date('2026-10-21T05:00:00Z') });
    expect(r).toMatchObject({ credits: 100, changed: 100 });
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'recruiter@demo.dev' } });
    expect(u.credits).toBe(100);
    expect(await ledgerSum(u.id)).toBe(100);
    await request(app).post('/auth/login').send({ email: 'recruiter@demo.dev', password: 'demo-pass-123' }).expect(200);
  });

  it('is idempotent per day, tops up (never above the cap) the next day, and resets the password', async () => {
    const d1 = new Date('2026-10-21T05:00:00Z');
    const { userId } = await ensureDemoAccount(prisma, { ...base, today: d1 });
    await prisma.user.update({ where: { id: userId }, data: { credits: 30 } });
    await prisma.creditTransaction.create({ data: { userId, delta: -70, reason: 'GENERATION', balanceAfter: 30, refId: 'job' } });
    expect((await ensureDemoAccount(prisma, { ...base, today: d1 })).changed).toBe(0); // same day: nothing
    const r = await ensureDemoAccount(prisma, { ...base, password: 'new-pass-456', today: new Date('2026-10-22T05:00:00Z') });
    expect(r).toMatchObject({ credits: 100, changed: 70 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(100);
    expect(await ledgerSum(userId)).toBe(100);
    await request(app).post('/auth/login').send({ email: 'recruiter@demo.dev', password: 'new-pass-456' }).expect(200);
  });

  it('a lowered cap brings the balance down through the ledger', async () => {
    const { userId } = await ensureDemoAccount(prisma, { ...base, today: new Date('2026-10-21T05:00:00Z') });
    const r = await ensureDemoAccount(prisma, { ...base, dailyCredits: 40, today: new Date('2026-10-22T05:00:00Z') });
    expect(r).toMatchObject({ credits: 40, changed: -60 });
    expect(await ledgerSum(userId)).toBe(40);
  });
});

describe('one-click demo login (/auth/demo)', () => {
  const demo = { email: 'recruiter@demo.dev', password: 'demo-pass-123', dailyCredits: 100 };

  it('is disabled (404) when no demo account is configured', async () => {
    expect((await request(app).get('/auth/demo').expect(200)).body).toEqual({ enabled: false });
    await request(app).post('/auth/demo').set('content-type', 'application/json').send({}).expect(404);
  });

  it('logs into the demo account without the client knowing the password', async () => {
    await ensureDemoAccount(prisma, { ...base });
    const demoApp = makeApp({ demo });
    expect((await request(demoApp).get('/auth/demo').expect(200)).body).toEqual({ enabled: true });
    const res = await request(demoApp).post('/auth/demo').set('content-type', 'application/json').send({}).expect(200);
    expect(res.body.user).toMatchObject({ email: 'recruiter@demo.dev', credits: 100 });
    expect(JSON.stringify(res.body)).not.toContain('demo-pass-123');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const me = await request(demoApp).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.email).toBe('recruiter@demo.dev');
  });

  it('401 when configured but the account was never created', async () => {
    await request(makeApp({ demo })).post('/auth/demo').set('content-type', 'application/json').send({}).expect(401);
  });
});
