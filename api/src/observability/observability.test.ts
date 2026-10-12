import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { createApp } from '../app.js';
import { createMetrics } from './metrics.js';
import { createCreditService } from '../modules/credits/credits.service.js';
import { prisma, resetDb, testConfig } from '../../test/helpers.js';

/** App wired with a logger that writes JSON lines into an array we can inspect. */
function instrumentedApp(overrides: Partial<typeof testConfig> = {}) {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  const logger = pino({ level: 'info' }, sink);
  const metrics = createMetrics();
  const app = createApp({ prisma, config: { ...testConfig, ...overrides }, logger, metrics });
  return { app, metrics, lines };
}

const metricsText = (app: ReturnType<typeof instrumentedApp>['app'], auth?: string) => {
  const r = request(app).get('/metrics');
  return auth ? r.set('Authorization', auth) : r;
};

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('request ids', () => {
  it('generates an X-Request-Id and puts the same id in the access log', async () => {
    const { app, lines } = instrumentedApp();
    const res = await request(app).get('/auth/me'); // 401, still logged
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const entry = lines.find((l) => (l.req as { id?: string })?.id === id);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ res: { statusCode: 401 } });
    expect(typeof entry!.responseTime).toBe('number');
  });

  it('reuses a safe incoming id, replaces an unsafe one', async () => {
    const { app } = instrumentedApp();
    const ok = await request(app).get('/nope').set('X-Request-Id', 'alb-trace-123');
    expect(ok.headers['x-request-id']).toBe('alb-trace-123');
    const bad = await request(app).get('/nope').set('X-Request-Id', 'evil\nInjected: header'.replace('\n', ' '));
    expect(bad.headers['x-request-id']).not.toContain('evil');
  });

  it('never logs cookies or passwords', async () => {
    const { app, lines } = instrumentedApp();
    await request(app).post('/auth/register').send({ email: 'log@example.com', password: 'super-secret-pw' });
    const all = JSON.stringify(lines);
    expect(all).not.toContain('super-secret-pw');
    expect(all).not.toMatch(/token=ey/);
  });
});

describe('GET /metrics', () => {
  it('exposes latency histogram labelled by ROUTE PATTERN, plus default process metrics', async () => {
    const { app } = instrumentedApp();
    await request(app).get('/credits'); // 401
    await request(app).get('/random/abc123'); // unmatched
    await request(app).get('/random/xyz789'); // unmatched

    const res = await metricsText(app);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/http_request_duration_seconds_bucket\{.*route="\/credits".*status_code="401"/);
    expect(res.text).toContain('nodejs_eventloop_lag_seconds');
    // cardinality guard: raw URLs never become labels
    expect(res.text).not.toContain('abc123');
    expect(res.text).toMatch(/http_requests_total\{method="GET",route="unmatched",status_code="404"\} 2/);
  });

  it('counts business events: register, login success/failure, credits', async () => {
    const { app, metrics } = instrumentedApp();
    const creds = { email: 'm@example.com', password: 'password-123' };
    const reg = await request(app).post('/auth/register').send(creds).expect(201);
    await request(app).post('/auth/login').send(creds).expect(200);
    await request(app).post('/auth/login').send({ ...creds, password: 'wrong-pass-1' }).expect(401);

    const credits = createCreditService(prisma, metrics);
    await credits.debit(reg.body.user.id, 30, 'GENERATION');
    await expect(credits.debit(reg.body.user.id, 30, 'GENERATION')).rejects.toThrow();

    const text = (await metricsText(app)).text;
    expect(text).toContain('auth_events_total{event="register"} 1');
    expect(text).toContain('auth_events_total{event="login_success"} 1');
    expect(text).toContain('auth_events_total{event="login_failure"} 1');
    expect(text).toContain('credits_granted_total{reason="SIGNUP_BONUS"} 50');
    expect(text).toContain('credits_debited_total 30');
    expect(text).toContain('credit_debit_rejected_total 1');
  });

  it('requires the bearer token when METRICS_TOKEN is configured', async () => {
    const { app } = instrumentedApp({ metricsToken: 'metrics-token-1234567890' });
    await metricsText(app).expect(401);
    await metricsText(app, 'Bearer wrong-token-000000000000').expect(401);
    await metricsText(app, 'Bearer metrics-token-1234567890').expect(200);
  });
});

describe('500 errors', () => {
  it('returns a generic message with the requestId and logs the real error', async () => {
    const { app, lines } = instrumentedApp();
    // Simulate a DB outage on an authenticated route.
    const reg = await request(app).post('/auth/register').send({ email: 'e@example.com', password: 'password-123' });
    const cookie = (reg.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const original = prisma.user.findUnique;
    prisma.user.findUnique = (() => Promise.reject(new Error('db exploded'))) as never;
    try {
      const res = await request(app).get('/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error', requestId: res.headers['x-request-id'] });
      expect(JSON.stringify(res.body)).not.toContain('db exploded');
      expect(JSON.stringify(lines)).toContain('db exploded');
    } finally {
      prisma.user.findUnique = original;
    }
  });
});
