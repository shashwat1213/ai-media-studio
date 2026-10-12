import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { makeApp, prisma, resetDb, testConfig } from '../../../test/helpers.js';

const app = makeApp();
const creds = { email: 'Alice@Example.com', password: 'correct-horse-battery' };

function cookieFrom(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = set?.find((s) => s.startsWith('token='));
  if (!c) throw new Error('no token cookie set');
  return c.split(';')[0]!;
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('POST /auth/register', () => {
  it('creates the user, sets an httpOnly cookie, grants the signup bonus with a ledger row', async () => {
    const res = await request(app).post('/auth/register').send(creds);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', credits: 50 });
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const ledger = await prisma.creditTransaction.findMany({ where: { userId: res.body.user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 50, reason: 'SIGNUP_BONUS', balanceAfter: 50 });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(stored.passwordHash).not.toBe(creds.password);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt format
  });

  it('rejects a duplicate email case-insensitively with 409', async () => {
    await request(app).post('/auth/register').send(creds).expect(201);
    const res = await request(app).post('/auth/register').send({ ...creds, email: 'ALICE@example.COM' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email already registered' });
  });

  it('validates input with 400 + field details', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty('email');
    expect(res.body.details).toHaveProperty('password');
  });

  it('rejects passwords over bcrypt\'s 72-char limit', async () => {
    const res = await request(app).post('/auth/register').send({ ...creds, password: 'x'.repeat(73) });
    expect(res.status).toBe(400);
  });

  it('rejects non-JSON bodies with 415 (CSRF hardening)', async () => {
    const res = await request(app)
      .post('/auth/register')
      .type('form')
      .send('email=a@b.com&password=12345678');
    expect(res.status).toBe(415);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/auth/register').send(creds).expect(201);
  });

  it('logs in with correct credentials (email case-insensitive)', async () => {
    const res = await request(app).post('/auth/login').send({ ...creds, email: 'alice@EXAMPLE.com' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(cookieFrom(res)).toMatch(/^token=/);
  });

  it('returns the SAME 401 for wrong password and unknown email (no account enumeration)', async () => {
    const wrongPw = await request(app).post('/auth/login').send({ ...creds, password: 'wrong-password-1' });
    const noUser = await request(app).post('/auth/login').send({ email: 'ghost@example.com', password: 'whatever-123' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body).toEqual(noUser.body);
    expect(wrongPw.headers['set-cookie']).toBeUndefined();
  });
});

describe('session: /auth/me and /auth/logout', () => {
  it('401 without a cookie', async () => {
    await request(app).get('/auth/me').expect(401);
  });

  it('returns the current user with a valid cookie', async () => {
    const reg = await request(app).post('/auth/register').send(creds);
    const res = await request(app).get('/auth/me').set('Cookie', cookieFrom(reg));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', credits: 50 });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a token signed with a different secret (tampered)', async () => {
    const reg = await request(app).post('/auth/register').send(creds);
    const forged = jwt.sign({}, 'attacker-secret-attacker-secret-attacker', { subject: reg.body.user.id });
    await request(app).get('/auth/me').set('Cookie', `token=${forged}`).expect(401);
  });

  it('rejects an expired token', async () => {
    const reg = await request(app).post('/auth/register').send(creds);
    const expired = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 60 }, testConfig.jwtSecret, {
      subject: reg.body.user.id,
    });
    await request(app).get('/auth/me').set('Cookie', `token=${expired}`).expect(401);
  });

  it('rejects an alg=none token', async () => {
    const reg = await request(app).post('/auth/register').send(creds);
    const none = jwt.sign({ sub: reg.body.user.id }, '', { algorithm: 'none' });
    await request(app).get('/auth/me').set('Cookie', `token=${none}`).expect(401);
  });

  it('401 when the token is valid but the user was deleted', async () => {
    const reg = await request(app).post('/auth/register').send(creds);
    await prisma.user.delete({ where: { id: reg.body.user.id } });
    await request(app).get('/auth/me').set('Cookie', cookieFrom(reg)).expect(401);
  });

  it('logout clears the cookie', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(204);
    const set = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(set).toMatch(/^token=;/);
    expect(set).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});

describe('rate limiting', () => {
  it('returns 429 after the limit is hit', async () => {
    const limited = makeApp({ authRateLimit: 3 });
    for (let i = 0; i < 3; i++) {
      await request(limited).post('/auth/login').send({ email: 'x@y.com', password: 'whatever-123' }).expect(401);
    }
    const res = await request(limited).post('/auth/login').send({ email: 'x@y.com', password: 'whatever-123' });
    expect(res.status).toBe(429);
  });
});
