import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from 'bullmq';
import {
  cookieOf,
  makeGenApp,
  makeRealQueue,
  makeTestStorage,
  prisma,
  resetDb,
  silentLogger,
  TEST_REDIS_URL,
} from '../../../test/helpers.js';
import { createRedis } from '../../lib/redis.js';
import { createMetrics } from '../../observability/metrics.js';
import { failAndRefund } from './job-lifecycle.js';
import { processGenerationJob, sweepStuckJobs } from './processor.js';
import { createStubProvider, dimensions } from './providers/stub.js';
import { ProviderError, type ImageProvider } from './providers/types.js';
import { startGenerationWorker, startWorkerHttp } from './worker.js';

const storage = makeTestStorage();
const stub = createStubProvider(0);

async function makeUserAndJob(over: { prompt?: string; status?: 'QUEUED' | 'PROCESSING' | 'DONE' | 'FAILED' } = {}) {
  const user = await prisma.user.create({ data: { email: `u${Math.random()}@example.com`, passwordHash: 'x', credits: 45 } });
  const job = await prisma.generationJob.create({
    data: {
      userId: user.id,
      prompt: over.prompt ?? 'a lighthouse at dusk',
      model: 'bytedance-seed/seedream-5-0-flash',
      aspectRatio: '16:9',
      creditsCost: 5,
      status: over.status ?? 'QUEUED',
    },
  });
  // Mirror the API's reservation so ledger checks are meaningful.
  await prisma.creditTransaction.create({ data: { userId: user.id, delta: 50, reason: 'SIGNUP_BONUS', balanceAfter: 50 } });
  await prisma.creditTransaction.create({ data: { userId: user.id, delta: -5, reason: 'GENERATION', refId: job.id, balanceAfter: 45 } });
  return { user, job };
}

const deps = (provider: ImageProvider = stub, metrics = createMetrics()) => ({ prisma, provider, storage, logger: silentLogger, metrics });
const credits = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).credits;
const refunds = (refId: string) => prisma.creditTransaction.count({ where: { refId, reason: 'REFUND' } });

function failing(err: Error): ImageProvider {
  return { name: 'stub', generate: async () => Promise.reject(err) };
}

beforeAll(() => storage.ensureBucket());
beforeEach(resetDb);
afterAll(async () => {
  storage.destroy();
  await prisma.$disconnect();
});

describe('stub provider', () => {
  it('produces a valid PNG of the requested aspect ratio, deterministic per prompt', async () => {
    const a = await stub.generate({ prompt: 'same', model: 'm', aspectRatio: '16:9' });
    const b = await stub.generate({ prompt: 'same', model: 'm', aspectRatio: '16:9' });
    const c = await stub.generate({ prompt: 'different', model: 'm', aspectRatio: '16:9' });
    expect(a.data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(a.data.readUInt32BE(16)).toBe(512); // IHDR width
    expect(a.data.readUInt32BE(20)).toBe(288); // IHDR height
    expect(a.data.equals(b.data)).toBe(true);
    expect(a.data.equals(c.data)).toBe(false);
    expect(dimensions('9:16', 512)).toEqual({ width: 288, height: 512 });
  });

  it('[fail] and [flaky] demo hooks', async () => {
    await expect(stub.generate({ prompt: 'x [fail]', model: 'm', aspectRatio: '1:1' })).rejects.toMatchObject({ retryable: false });
    await expect(stub.generate({ prompt: 'x [flaky]', model: 'm', aspectRatio: '1:1' })).rejects.toMatchObject({ retryable: true });
  });
});

describe('processGenerationJob', () => {
  it('happy path: QUEUED -> DONE, object uploaded, asset recorded, credits kept', async () => {
    const { user, job } = await makeUserAndJob();
    const metrics = createMetrics();
    expect(await processGenerationJob(job.id, { attempt: 1, maxAttempts: 3 }, deps(stub, metrics))).toBe('done');

    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id }, include: { asset: true } });
    expect(done).toMatchObject({ status: 'DONE', attempts: 1, error: null });
    expect(done.finishedAt).not.toBeNull();
    expect(done.asset).toMatchObject({ storageKey: `users/${user.id}/${job.id}.png`, mimeType: 'image/png', width: 512, height: 288 });

    const res = await fetch(await storage.signedUrl(done.asset!.storageKey));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Number(res.headers.get('content-length'))).toBe(done.asset!.bytes);
    expect(await credits(user.id)).toBe(45);
    expect(await metrics.registry.getSingleMetricAsString('generation_job_outcomes_total')).toMatch(/outcome="done".* 1/);
  });

  it('a finished job delivered again is skipped (no double work, no state regression)', async () => {
    const { job } = await makeUserAndJob({ status: 'DONE' });
    expect(await processGenerationJob(job.id, { attempt: 1, maxAttempts: 3 }, deps())).toBe('skipped');
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('DONE');
    expect(await processGenerationJob('00000000-0000-4000-8000-000000000000', { attempt: 1, maxAttempts: 3 }, deps())).toBe('skipped');
  });

  it('transient error before the last attempt -> retry, job stays PROCESSING, nothing refunded', async () => {
    const { user, job } = await makeUserAndJob();
    const flaky = failing(new ProviderError('503', { retryable: true, userMessage: 'busy' }));
    expect(await processGenerationJob(job.id, { attempt: 1, maxAttempts: 3 }, deps(flaky))).toBe('retry');
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PROCESSING');
    expect(await credits(user.id)).toBe(45);
  });

  it('transient error on the LAST attempt -> FAILED + exactly one refund', async () => {
    const { user, job } = await makeUserAndJob();
    const flaky = failing(new ProviderError('503', { retryable: true, userMessage: 'The AI provider is temporarily unavailable.' }));
    expect(await processGenerationJob(job.id, { attempt: 3, maxAttempts: 3 }, deps(flaky))).toBe('failed');
    const failed = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed).toMatchObject({ status: 'FAILED', error: 'The AI provider is temporarily unavailable.' });
    expect(await credits(user.id)).toBe(50);
    expect(await refunds(job.id)).toBe(1);
  });

  it('permanent error -> FAILED on the first attempt (no pointless retries)', async () => {
    const { user, job } = await makeUserAndJob();
    const bad = failing(new ProviderError('400', { retryable: false, userMessage: 'The model rejected this prompt.' }));
    expect(await processGenerationJob(job.id, { attempt: 1, maxAttempts: 3 }, deps(bad))).toBe('failed');
    expect(await credits(user.id)).toBe(50);
  });

  it('unknown errors are treated as transient, and never leak internals to the user', async () => {
    const { job } = await makeUserAndJob();
    const boom = failing(new Error('ECONNRESET at internal-host:1234'));
    expect(await processGenerationJob(job.id, { attempt: 3, maxAttempts: 3 }, deps(boom))).toBe('failed');
    const failed = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed.error).toBe('Something went wrong while generating.');
  });

  it('rejects an empty image from the provider', async () => {
    const { job } = await makeUserAndJob();
    const empty: ImageProvider = { name: 'stub', generate: async () => ({ data: Buffer.alloc(0), mimeType: 'image/png' }) };
    expect(await processGenerationJob(job.id, { attempt: 3, maxAttempts: 3 }, deps(empty))).toBe('failed');
  });

  it('if the sweeper failed+refunded the job mid-flight, the result is discarded (user is not given it for free)', async () => {
    const { user, job } = await makeUserAndJob();
    const racing: ImageProvider = {
      name: 'stub',
      async generate(req) {
        await failAndRefund(prisma, job.id, 'Generation timed out.'); // the sweeper wins the race
        return stub.generate(req);
      },
    };
    expect(await processGenerationJob(job.id, { attempt: 1, maxAttempts: 3 }, deps(racing))).toBe('skipped');
    expect(await prisma.asset.count()).toBe(0);
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    expect(await credits(user.id)).toBe(50);
    expect(await refunds(job.id)).toBe(1);
  });
});

describe('refund exactly once', () => {
  it('10 concurrent failAndRefund calls on one job -> one winner, one refund row', async () => {
    const { user, job } = await makeUserAndJob();
    const results = await Promise.all(Array.from({ length: 10 }, () => failAndRefund(prisma, job.id, 'x')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await refunds(job.id)).toBe(1);
    expect(await credits(user.id)).toBe(50);
  });

  it('the DATABASE rejects a second refund row for the same job (partial unique index)', async () => {
    const { user, job } = await makeUserAndJob();
    await failAndRefund(prisma, job.id, 'x');
    await expect(
      prisma.creditTransaction.create({ data: { userId: user.id, delta: 5, reason: 'REFUND', refId: job.id, balanceAfter: 55 } }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('a DONE job can never be refunded', async () => {
    const { user, job } = await makeUserAndJob({ status: 'DONE' });
    expect(await failAndRefund(prisma, job.id, 'x')).toBe(false);
    expect(await credits(user.id)).toBe(45);
  });
});

describe('sweepStuckJobs', () => {
  it('fails + refunds only jobs stuck longer than the timeout, once', async () => {
    const stuck = await makeUserAndJob({ status: 'PROCESSING' });
    const fresh = await makeUserAndJob({ status: 'QUEUED' });
    const done = await makeUserAndJob({ status: 'DONE' });
    const old = new Date(Date.now() - 20 * 60_000);
    // updatedAt is managed by Prisma, so backdate it with raw SQL.
    await prisma.$executeRaw`UPDATE "GenerationJob" SET "updatedAt" = ${old} WHERE id IN (${stuck.job.id}, ${done.job.id})`;

    expect(await sweepStuckJobs(prisma, 10)).toBe(1);
    expect(await sweepStuckJobs(prisma, 10)).toBe(0); // idempotent
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: stuck.job.id } })).status).toBe('FAILED');
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: fresh.job.id } })).status).toBe('QUEUED');
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: done.job.id } })).status).toBe('DONE');
    expect(await credits(stuck.user.id)).toBe(50);
  });
});

describe('END-TO-END: API -> real Redis/BullMQ -> worker -> S3 -> API', () => {
  const queue = makeRealQueue();
  const workerConn = createRedis(TEST_REDIS_URL, 'worker');
  const metrics = createMetrics();
  let running: ReturnType<typeof startGenerationWorker>;

  beforeAll(async () => {
    await queue.queue.obliterate({ force: true }); // clean slate in the test Redis db
    running = startGenerationWorker({
      prisma,
      connection: workerConn,
      provider: createStubProvider(50),
      storage,
      logger: silentLogger,
      metrics,
      concurrency: 4,
      maxAttempts: 3,
      jobTimeoutMinutes: 10,
    });
  });
  afterAll(async () => {
    await running.close();
    await queue.close();
    workerConn.disconnect();
  });

  const app = makeGenApp({ queue, storage });

  async function waitFor(cookie: string, id: string, timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await request(app).get(`/jobs/${id}`).set('Cookie', cookie);
      if (body.job.status === 'DONE' || body.job.status === 'FAILED') return body.job;
      if (Date.now() > end) throw new Error(`job ${id} still ${body.job.status}`);
      await sleep(50);
    }
  }

  it('a generated image ends up DONE with a downloadable PNG', async () => {
    const reg = await request(app).post('/auth/register').send({ email: 'e2e@example.com', password: 'password-123' });
    const cookie = cookieOf(reg);
    const { body } = await request(app)
      .post('/generate')
      .set('Cookie', cookie)
      .send({ prompt: 'a cozy cabin in snow', model: 'recraft/recraft-v4.1-flash', aspectRatio: '1:1' })
      .expect(202);

    const job = await waitFor(cookie, body.job.id);
    expect(job.status).toBe('DONE');
    const png = Buffer.from(await (await fetch(job.asset.url)).arrayBuffer());
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const gallery = await request(app).get('/assets').set('Cookie', cookie);
    expect(gallery.body.items[0].prompt).toBe('a cozy cabin in snow');
    expect((await request(app).get('/credits').set('Cookie', cookie)).body.balance).toBe(48);
  });

  it('a [flaky] job is retried by BullMQ 3 times, then FAILED and refunded once', async () => {
    const reg = await request(app).post('/auth/register').send({ email: 'flaky@example.com', password: 'password-123' });
    const cookie = cookieOf(reg);
    const { body } = await request(app)
      .post('/generate')
      .set('Cookie', cookie)
      .send({ prompt: 'unlucky [flaky]', model: 'recraft/recraft-v4.1-flash' })
      .expect(202);

    const job = await waitFor(cookie, body.job.id);
    expect(job).toMatchObject({ status: 'FAILED', attempts: 3, error: 'The AI provider is temporarily unavailable.' });
    const bull = (await queue.queue.getJob(body.job.id)) as Job;
    expect(bull.attemptsMade).toBe(3);
    const summary = (await request(app).get('/credits').set('Cookie', cookie)).body;
    expect(summary.balance).toBe(50);
    expect(summary.transactions.map((t: { reason: string }) => t.reason)).toEqual(['REFUND', 'GENERATION', 'SIGNUP_BONUS']);
  });

  it('many jobs from many users in parallel all complete, no drift anywhere', async () => {
    const users = await Promise.all(
      Array.from({ length: 4 }, async (_, i) =>
        cookieOf(await request(app).post('/auth/register').send({ email: `p${i}@example.com`, password: 'password-123' })),
      ),
    );
    const jobs = await Promise.all(
      users.flatMap((cookie) =>
        Array.from({ length: 3 }, (_, k) =>
          request(app)
            .post('/generate')
            .set('Cookie', cookie)
            .send({ prompt: `parallel ${k}`, model: 'recraft/recraft-v4.1-flash' })
            .then((r) => ({ cookie, id: r.body.job.id as string })),
        ),
      ),
    );
    const finished = await Promise.all(jobs.map((j) => waitFor(j.cookie, j.id, 20_000)));
    expect(finished.every((j) => j.status === 'DONE')).toBe(true);
    const drift = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "User" u
      WHERE u.credits <> (SELECT COALESCE(SUM(delta), 0) FROM "CreditTransaction" t WHERE t."userId" = u.id)`;
    expect(Number(drift[0]!.n)).toBe(0);
  });

  it('worker /health and /metrics', async () => {
    const http = startWorkerHttp(0, { prisma, connection: workerConn, metrics, metricsToken: 'worker-metrics-token-123' });
    await new Promise((r) => http.once('listening', r));
    const port = (http.address() as { port: number }).port;
    try {
      const h = await fetch(`http://localhost:${port}/health`);
      expect(await h.json()).toEqual({ status: 'ok', db: 'up', redis: 'up' });
      expect((await fetch(`http://localhost:${port}/metrics`)).status).toBe(401);
      const m = await fetch(`http://localhost:${port}/metrics`, { headers: { authorization: 'Bearer worker-metrics-token-123' } });
      expect(await m.text()).toMatch(/generation_job_outcomes_total\{outcome="done"/);
      expect((await fetch(`http://localhost:${port}/nope`)).status).toBe(404);
    } finally {
      http.close();
    }
  });
});
