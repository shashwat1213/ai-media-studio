import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { cronRouter } from './cron.js';

vi.mock('../modules/auth/demo-account.js', () => ({
  ensureDemoAccount: vi.fn(async () => ({ userId: 'u1', credits: 100, changed: 40 })),
}));

const app = (cfg: Parameters<typeof cronRouter>[1]) => express().use(express.json()).use(cronRouter({} as never, cfg));
const demo = { email: 'r@demo.dev', password: 'pw-1234567', dailyCredits: 100 };

describe('cron: demo top-up', () => {
  it('tops up with the right bearer token', async () => {
    const res = await request(app({ secret: 'sekret-123456', bcryptCost: 4, demo })).get('/internal/cron/demo-topup').set('Authorization', 'Bearer sekret-123456');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, credits: 100, changed: 40 });
  });

  it('404 without the token, with a wrong token, or when no secret is configured', async () => {
    expect((await request(app({ secret: 'sekret-123456', bcryptCost: 4, demo })).get('/internal/cron/demo-topup')).status).toBe(404);
    expect((await request(app({ secret: 'sekret-123456', bcryptCost: 4, demo })).get('/internal/cron/demo-topup').set('Authorization', 'Bearer nope')).status).toBe(404);
    expect((await request(app({ bcryptCost: 4, demo })).get('/internal/cron/demo-topup').set('Authorization', 'Bearer x')).status).toBe(404);
  });

  it('with a valid token but no demo account: a no-op success, never a crash', async () => {
    const res = await request(app({ secret: 'sekret-123456', bcryptCost: 4 })).get('/internal/cron/demo-topup').set('Authorization', 'Bearer sekret-123456');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
