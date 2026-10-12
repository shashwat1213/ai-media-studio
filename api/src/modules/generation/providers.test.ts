import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cookieOf, makeGenApp, makeTestStorage, prisma, resetDb } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { testConfig } from '../../../test/helpers.js';
import { loadEnv, loadWorkerEnv } from '../../config/env.js';
import { toAppConfig } from '../../config/app-config.js';
import { createRedis } from '../../lib/redis.js';
import { classify, createOpenRouterProvider } from './providers/openrouter.js';
import { providerFromEnv, providerMode } from './providers/index.js';
import { createJobQueue } from './queue.js';

const storage = makeTestStorage();
afterAll(async () => {
  storage.destroy();
  await prisma.$disconnect();
});

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('OpenRouter provider (no network, no money: fetch is faked)', () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex');

  it('sends the documented Image API request and decodes the base64 image', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const p = createOpenRouterProvider({
      apiKey: 'sk-test',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(200, { data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.007 } }, (url, init) => {
        sent = { url, init };
      }),
    });
    const img = await p.generate({ prompt: 'a cat', model: 'recraft/recraft-v4.1-flash', aspectRatio: '16:9' });

    expect(sent!.url).toBe('https://openrouter.ai/api/v1/images');
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(sent!.init.body as string)).toEqual({ model: 'recraft/recraft-v4.1-flash', prompt: 'a cat', aspect_ratio: '16:9', n: 1 });
    expect(img).toMatchObject({ mimeType: 'image/png', costUsd: 0.007 });
    expect(img.data.equals(png)).toBe(true);
  });

  it('defaults the mime type and handles an empty data array', async () => {
    const ok = createOpenRouterProvider({ apiKey: 'k', timeoutMs: 5000, fetchImpl: fakeFetch(200, { data: [{ b64_json: png.toString('base64') }] }) });
    expect((await ok.generate({ prompt: 'x', model: 'm', aspectRatio: '1:1' })).mimeType).toBe('image/png');
    const empty = createOpenRouterProvider({ apiKey: 'k', timeoutMs: 5000, fetchImpl: fakeFetch(200, { data: [] }) });
    await expect(empty.generate({ prompt: 'x', model: 'm', aspectRatio: '1:1' })).rejects.toMatchObject({ retryable: true });
  });

  it('maps HTTP errors to retry decisions and user-safe messages', async () => {
    const cases: [number, boolean][] = [
      [429, true],
      [500, true],
      [502, true],
      [400, false],
      [401, false],
      [402, false],
      [403, false],
    ];
    for (const [status, retryable] of cases) {
      const p = createOpenRouterProvider({ apiKey: 'k', timeoutMs: 5000, fetchImpl: fakeFetch(status, { error: { message: 'secret internal detail' } }) });
      const err = await p.generate({ prompt: 'x', model: 'm', aspectRatio: '1:1' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ retryable, status });
      expect((err as { userMessage: string }).userMessage).not.toMatch(/secret/);
    }
    expect(classify(418).userMessage).toBe('The model rejected this prompt.');
  });

  it('network failures and timeouts are retryable', async () => {
    const down = createOpenRouterProvider({
      apiKey: 'k',
      timeoutMs: 5000,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(down.generate({ prompt: 'x', model: 'm', aspectRatio: '1:1' })).rejects.toMatchObject({ retryable: true });

    const slow = createOpenRouterProvider({
      apiKey: 'k',
      timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch,
    });
    await expect(slow.generate({ prompt: 'x', model: 'm', aspectRatio: '1:1' })).rejects.toMatchObject({ retryable: true });
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'x'.repeat(32),
  };

  it('never uses the paid provider without a key', () => {
    expect(providerMode({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: undefined })).toBe('stub');
    expect(providerMode({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk' })).toBe('openrouter');
    expect(providerMode({ AI_PROVIDER: 'stub', OPENROUTER_API_KEY: 'sk' })).toBe('stub');
  });

  it('loads API + worker env with Phase 2 defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ REDIS_URL: 'redis://localhost:6379', AI_PROVIDER: 'stub', MAX_ACTIVE_JOBS_PER_USER: 3, S3_FORCE_PATH_STYLE: false });
    expect(toAppConfig(env)).toMatchObject({ providerMode: 'stub', maxActiveJobsPerUser: 3 });
    const w = loadWorkerEnv({ ...base, S3_FORCE_PATH_STYLE: 'true', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-x' });
    expect(w).toMatchObject({ WORKER_PORT: 4001, WORKER_CONCURRENCY: 4, S3_FORCE_PATH_STYLE: true });
    expect(providerFromEnv(w).name).toBe('openrouter');
    expect(providerFromEnv(loadWorkerEnv(base)).name).toBe('stub');
  });

  it('refuses to boot with AI_PROVIDER=openrouter and no key, or in production without METRICS_TOKEN', () => {
    const exits: unknown[] = [];
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = ((code: number) => {
      exits.push(code);
      throw new Error('exit');
    }) as typeof process.exit;
    console.error = () => {};
    try {
      expect(() => loadWorkerEnv({ ...base, AI_PROVIDER: 'openrouter' })).toThrow('exit');
      expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow('exit');
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    expect(exits).toEqual([1, 1]);
  });
});

describe('Redis really down', () => {
  it('POST /generate answers 503 within the timeout and refunds, using a REAL queue on a dead port', async () => {
    await resetDb();
    const dead = createRedis('redis://localhost:6390', 'producer'); // nothing listens here
    dead.on('error', () => {});
    const queue = createJobQueue(dead, { maxAttempts: 3, backoffMs: 50, enqueueTimeoutMs: 1500 });
    const app = makeGenApp({ queue, storage });

    const reg = await request(app).post('/auth/register').send({ email: 'down@example.com', password: 'password-123' });
    const started = Date.now();
    const res = await request(app)
      .post('/generate')
      .set('Cookie', cookieOf(reg))
      .send({ prompt: 'will not run', model: 'recraft/recraft-v4.1-flash' });
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: reg.body.user.id } })).credits).toBe(50);
    dead.disconnect();
  });

  it('/health reports redis down as degraded but keeps 200 while the DB is up', async () => {
    const app = createApp({ prisma, config: testConfig, redisPing: async () => false });
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'degraded', db: 'up', redis: 'down' });
    const ok = createApp({ prisma, config: testConfig, redisPing: async () => true });
    expect((await request(ok).get('/health')).body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
  });
});
