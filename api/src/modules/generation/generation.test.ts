import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cookieOf,
  fakeQueue,
  makeGenApp,
  makeTestStorage,
  prisma,
  resetDb,
} from '../../../test/helpers.js';

const storage = makeTestStorage();
const queue = fakeQueue();
const app = makeGenApp({ queue, storage });

async function register(email = 'gen@example.com') {
  const res = await request(app).post('/auth/register').send({ email, password: 'password-123' }).expect(201);
  return { id: res.body.user.id as string, cookie: cookieOf(res) };
}

const body = (over: Record<string, unknown> = {}) => ({
  prompt: 'a red panda astronaut, studio lighting',
  model: 'bytedance-seed/seedream-5-0-flash', // 5 credits
  aspectRatio: '1:1',
  ...over,
});

const balance = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).credits;
const ledgerSum = async (userId: string) =>
  (await prisma.creditTransaction.aggregate({ where: { userId }, _sum: { delta: true } }))._sum.delta ?? 0;

beforeAll(() => storage.ensureBucket());
beforeEach(async () => {
  await resetDb();
  queue.ids.length = 0;
});
afterAll(async () => {
  storage.destroy();
  await prisma.$disconnect();
});

describe('GET /generate/models', () => {
  it('lists the catalog, aspect ratios and the provider mode (public)', async () => {
    const res = await request(app).get('/generate/models').expect(200);
    expect(res.body.mode).toBe('stub');
    expect(res.body.models.map((m: { id: string }) => m.id)).toContain('recraft/recraft-v4.1-flash');
    expect(res.body.models[0]).not.toHaveProperty('usdPerImage'); // our cost is internal
    expect(res.body.aspectRatios).toContain('16:9');
  });
});

describe('POST /generate', () => {
  it('401 without a session', async () => {
    await request(app).post('/generate').send(body()).expect(401);
  });

  it('202: reserves credits + creates a QUEUED job + enqueues it, in that order', async () => {
    const u = await register();
    const res = await request(app).post('/generate').set('Cookie', u.cookie).send(body()).expect(202);

    expect(res.headers.location).toBe(`/jobs/${res.body.job.id}`);
    expect(res.body.job).toMatchObject({ status: 'QUEUED', creditsCost: 5, asset: null, model: body().model });
    expect(queue.ids).toEqual([res.body.job.id]);

    expect(await balance(u.id)).toBe(45);
    const debit = await prisma.creditTransaction.findFirstOrThrow({ where: { userId: u.id, reason: 'GENERATION' } });
    expect(debit).toMatchObject({ delta: -5, refId: res.body.job.id, balanceAfter: 45 });
    expect(await ledgerSum(u.id)).toBe(45);
  });

  it('prices by model (asymmetric pricing)', async () => {
    const u = await register();
    await request(app).post('/generate').set('Cookie', u.cookie).send(body({ model: 'recraft/recraft-v4.1-flash' })).expect(202);
    await request(app).post('/generate').set('Cookie', u.cookie).send(body({ model: 'qwen/qwen-image-3' })).expect(202);
    expect(await balance(u.id)).toBe(50 - 2 - 8);
  });

  it('validates input: prompt length, unknown model, bad aspect ratio, trims whitespace', async () => {
    const u = await register();
    const post = (b: object) => request(app).post('/generate').set('Cookie', u.cookie).send(b);
    expect((await post(body({ prompt: 'hi' }))).status).toBe(400);
    expect((await post(body({ prompt: 'x'.repeat(1001) }))).status).toBe(400);
    expect((await post(body({ prompt: '      ' }))).status).toBe(400);
    expect((await post(body({ model: 'openai/gpt-5-image' }))).status).toBe(400); // real model, not in our catalog
    expect((await post(body({ aspectRatio: '7:3' }))).status).toBe(400);
    const ok = await post(body({ prompt: '   a cat   ', aspectRatio: undefined })).expect(202);
    expect(ok.body.job).toMatchObject({ prompt: 'a cat', aspectRatio: '1:1' });
    expect(await balance(u.id)).toBe(45); // only the valid one charged
  });

  it('402 when the balance is too low; nothing is charged or created', async () => {
    const u = await register();
    await prisma.user.update({ where: { id: u.id }, data: { credits: 4 } });
    const res = await request(app).post('/generate').set('Cookie', u.cookie).send(body()).expect(402);
    expect(res.body.error).toBe('Insufficient credits');
    expect(await prisma.generationJob.count()).toBe(0);
    expect(queue.ids).toHaveLength(0);
  });

  it('429 over the active-job cap, and the rejected request is NOT charged', async () => {
    const u = await register();
    for (let i = 0; i < 3; i++) {
      await request(app).post('/generate').set('Cookie', u.cookie).send(body()).expect(202);
    }
    const res = await request(app).post('/generate').set('Cookie', u.cookie).send(body()).expect(429);
    expect(res.body.error).toMatch(/already have 3/);
    expect(await balance(u.id)).toBe(35); // 3 x 5, the 4th rolled back
    expect(await ledgerSum(u.id)).toBe(35);
  });

  it('finished jobs do not count toward the cap', async () => {
    const u = await register();
    for (let i = 0; i < 3; i++) await request(app).post('/generate').set('Cookie', u.cookie).send(body()).expect(202);
    await prisma.generationJob.updateMany({ data: { status: 'DONE' } });
    await request(app).post('/generate').set('Cookie', u.cookie).send(body()).expect(202);
  });

  it('CONCURRENCY: 10 parallel requests on 50 credits with a 10-credit cap -> never overspends, ledger == balance', async () => {
    const u = await register();
    // cap 20 so only credits limit it: 10 requests x 8 credits on 50 -> at most 6 can be paid for
    const capApp = makeGenApp({ queue, storage, overrides: { maxActiveJobsPerUser: 20 } });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(capApp).post('/generate').set('Cookie', u.cookie).send(body({ model: 'qwen/qwen-image-3' })),
      ),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 202)).toHaveLength(6);
    expect(codes.filter((c) => c === 402)).toHaveLength(4);
    expect(await balance(u.id)).toBe(2);
    expect(await ledgerSum(u.id)).toBe(2);
    expect(await prisma.generationJob.count({ where: { userId: u.id } })).toBe(6);
  });

  it('CONCURRENCY: the active-job cap holds under parallel requests (no check-then-act race)', async () => {
    const u = await register();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post('/generate').set('Cookie', u.cookie).send(body({ model: 'recraft/recraft-v4.1-flash' })),
      ),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(await balance(u.id)).toBe(50 - 3 * 2);
  });

  it('503 + automatic refund when the queue is down', async () => {
    const downApp = makeGenApp({ queue: fakeQueue({ fail: true }), storage });
    const res0 = await request(downApp).post('/auth/register').send({ email: 'q@example.com', password: 'password-123' });
    const cookie = cookieOf(res0);
    const id = res0.body.user.id as string;

    const res = await request(downApp).post('/generate').set('Cookie', cookie).send(body()).expect(503);
    expect(res.body.error).toMatch(/refunded/);
    expect(await balance(id)).toBe(50);
    const job = await prisma.generationJob.findFirstOrThrow({ where: { userId: id } });
    expect(job.status).toBe('FAILED');
    const refunds = await prisma.creditTransaction.findMany({ where: { userId: id, reason: 'REFUND' } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ delta: 5, refId: job.id });
  });

  describe('Idempotency-Key', () => {
    it('same key + same body -> same job, charged once (200 on replay)', async () => {
      const u = await register();
      const first = await request(app).post('/generate').set('Cookie', u.cookie).set('Idempotency-Key', 'key-12345678').send(body()).expect(202);
      const again = await request(app).post('/generate').set('Cookie', u.cookie).set('Idempotency-Key', 'key-12345678').send(body()).expect(200);
      expect(again.body.job.id).toBe(first.body.job.id);
      expect(await balance(u.id)).toBe(45);
      expect(queue.ids).toHaveLength(1);
    });

    it('same key + different body -> 409', async () => {
      const u = await register();
      await request(app).post('/generate').set('Cookie', u.cookie).set('Idempotency-Key', 'key-abcdefgh').send(body()).expect(202);
      await request(app)
        .post('/generate')
        .set('Cookie', u.cookie)
        .set('Idempotency-Key', 'key-abcdefgh')
        .send(body({ prompt: 'something else entirely' }))
        .expect(409);
    });

    it('parallel duplicates with one key -> exactly one job and one charge', async () => {
      const u = await register();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post('/generate').set('Cookie', u.cookie).set('Idempotency-Key', 'race-key-0001').send(body()),
        ),
      );
      const ids = new Set(results.map((r) => r.body.job?.id));
      expect(ids.size).toBe(1);
      expect(results.every((r) => r.status === 200 || r.status === 202)).toBe(true);
      expect(await prisma.generationJob.count({ where: { userId: u.id } })).toBe(1);
      expect(await balance(u.id)).toBe(45);
    });

    it('keys are per-user: two users can use the same key', async () => {
      const a = await register('a@example.com');
      const b = await register('b@example.com');
      await request(app).post('/generate').set('Cookie', a.cookie).set('Idempotency-Key', 'shared-key-1').send(body()).expect(202);
      await request(app).post('/generate').set('Cookie', b.cookie).set('Idempotency-Key', 'shared-key-1').send(body()).expect(202);
    });

    it('rejects malformed keys', async () => {
      const u = await register();
      await request(app).post('/generate').set('Cookie', u.cookie).set('Idempotency-Key', 'short').send(body()).expect(400);
      await request(app).post('/generate').set('Cookie', u.cookie).set('Idempotency-Key', 'has spaces in it').send(body()).expect(400);
    });
  });
});

describe('GET /jobs, /jobs/:id', () => {
  it('returns own jobs newest first with cursor pagination and status filter', async () => {
    const u = await register();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/generate').set('Cookie', u.cookie).send(body({ prompt: `prompt number ${i}` }));
      ids.push(r.body.job.id);
    }
    const p1 = await request(app).get('/jobs?limit=2').set('Cookie', u.cookie).expect(200);
    expect(p1.body.items.map((j: { id: string }) => j.id)).toEqual([ids[2], ids[1]]);
    expect(p1.body.nextCursor).toBe(ids[1]);
    const p2 = await request(app).get(`/jobs?limit=2&cursor=${p1.body.nextCursor}`).set('Cookie', u.cookie).expect(200);
    expect(p2.body.items.map((j: { id: string }) => j.id)).toEqual([ids[0]]);
    expect(p2.body.nextCursor).toBeNull();

    await prisma.generationJob.update({ where: { id: ids[0] }, data: { status: 'FAILED' } });
    const failed = await request(app).get('/jobs?status=FAILED').set('Cookie', u.cookie).expect(200);
    expect(failed.body.items).toHaveLength(1);
    await request(app).get('/jobs?status=NOPE').set('Cookie', u.cookie).expect(400);
  });

  it('GET /jobs/:id: own job 200 with no-store; others / malformed / unknown -> 404', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const job = (await request(app).post('/generate').set('Cookie', a.cookie).send(body())).body.job;

    const own = await request(app).get(`/jobs/${job.id}`).set('Cookie', a.cookie).expect(200);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(own.body.job.id).toBe(job.id);

    await request(app).get(`/jobs/${job.id}`).set('Cookie', b.cookie).expect(404); // not 403: don't confirm it exists
    await request(app).get('/jobs/not-a-uuid').set('Cookie', a.cookie).expect(404);
    await request(app).get('/jobs/00000000-0000-4000-8000-000000000000').set('Cookie', a.cookie).expect(404);
    const bList = await request(app).get('/jobs').set('Cookie', b.cookie).expect(200);
    expect(bList.body.items).toHaveLength(0);
  });
});

describe('assets', () => {
  /** Simulates what the worker does, so asset endpoints can be tested without one. */
  async function seedAsset(userId: string) {
    const job = await prisma.generationJob.create({
      data: { userId, prompt: 'seeded image', model: 'qwen/qwen-image-3', aspectRatio: '16:9', creditsCost: 8, status: 'DONE' },
    });
    const key = `users/${userId}/${job.id}.png`;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await storage.put(key, png, 'image/png');
    return prisma.asset.create({ data: { userId, jobId: job.id, storageKey: key, mimeType: 'image/png', bytes: png.length } });
  }

  it('lists own assets with prompt info and working signed URLs; never exposes the storage key', async () => {
    const u = await register();
    const asset = await seedAsset(u.id);
    const res = await request(app).get('/assets').set('Cookie', u.cookie).expect(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item).toMatchObject({ id: asset.id, prompt: 'seeded image', aspectRatio: '16:9', mimeType: 'image/png' });
    expect(item).not.toHaveProperty('storageKey');
    expect(item.url).toMatch(/X-Amz-Signature=/);

    // The signed URL really works against S3/MinIO, and the download variant forces "attachment".
    const got = await fetch(item.url);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).toString('hex')).toBe('89504e470d0a1a0a');
    const dl = await fetch(item.downloadUrl);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('a tampered signed URL is rejected by storage', async () => {
    const u = await register();
    await seedAsset(u.id);
    const { body: b } = await request(app).get('/assets').set('Cookie', u.cookie);
    const bad = (b.items[0].url as string).replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64));
    expect((await fetch(bad)).status).toBe(403);
  });

  it('GET/DELETE /assets/:id are owner-only; delete removes row + object and does NOT refund', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const asset = await seedAsset(a.id);
    const before = await balance(a.id);

    await request(app).get(`/assets/${asset.id}`).set('Cookie', b.cookie).expect(404);
    await request(app).delete(`/assets/${asset.id}`).set('Cookie', b.cookie).expect(404);
    const own = await request(app).get(`/assets/${asset.id}`).set('Cookie', a.cookie).expect(200);
    const url = own.body.asset.url as string;

    await request(app).delete(`/assets/${asset.id}`).set('Cookie', a.cookie).expect(204);
    expect(await prisma.asset.count()).toBe(0);
    expect((await fetch(url)).status).toBe(404); // object is gone from the bucket
    expect(await balance(a.id)).toBe(before);
    await request(app).delete(`/assets/${asset.id}`).set('Cookie', a.cookie).expect(404);
  });

  it('paginates assets', async () => {
    const u = await register();
    for (let i = 0; i < 3; i++) await seedAsset(u.id);
    const p1 = await request(app).get('/assets?limit=2').set('Cookie', u.cookie).expect(200);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await request(app).get(`/assets?limit=2&cursor=${p1.body.nextCursor}`).set('Cookie', u.cookie).expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
  });
});
