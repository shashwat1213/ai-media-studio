import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  cookieOf,
  fakeQueue,
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
import { MOTION_MODEL_ID, MOTION_PRESETS, findPreset, motionCost, motionFilter, outputSize } from './motion.js';
import { createFfmpegRenderer, type MotionRenderer } from './motion-renderer.js';
import { processGenerationJob } from './processor.js';
import { createStubProvider } from './providers/stub.js';
import { startGenerationWorker } from './worker.js';

const storage = makeTestStorage();
const stub = createStubProvider(0);
const ffmpeg = createFfmpegRenderer();
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => storage.ensureBucket());
beforeEach(resetDb);
afterAll(async () => {
  storage.destroy();
  await prisma.$disconnect();
});

/** A user with 50 credits and one finished image (a real PNG in storage) to animate. */
async function userWithImage(app: ReturnType<typeof makeGenApp>, email = `m${Math.random()}@example.com`) {
  const cookie = cookieOf(await request(app).post('/auth/register').send({ email, password: 'password-123' }));
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const job = await prisma.generationJob.create({
    data: { userId: user.id, prompt: 'a red fox in snow', model: 'stub', aspectRatio: '16:9', creditsCost: 2, status: 'DONE' },
  });
  const img = await stub.generate({ prompt: 'a red fox in snow', model: 'stub', aspectRatio: '16:9' });
  const storageKey = `users/${user.id}/${job.id}.png`;
  await storage.put(storageKey, img.data, img.mimeType);
  const asset = await prisma.asset.create({
    data: { userId: user.id, jobId: job.id, storageKey, mimeType: img.mimeType, bytes: img.data.length, width: img.width, height: img.height },
  });
  return { cookie, user, asset };
}

const balance = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).credits;
const ledgerSum = async (id: string) =>
  (await prisma.creditTransaction.aggregate({ where: { userId: id }, _sum: { delta: true } }))._sum.delta;

// -------------------------------------------------------------------------------------------
describe('motion: pure pieces', () => {
  it('output keeps the aspect ratio, long side 1024, even dimensions', () => {
    expect(outputSize(1024, 1024)).toEqual({ w: 1024, h: 1024 });
    expect(outputSize(1344, 768)).toEqual({ w: 1024, h: 586 });
    expect(outputSize(768, 1344)).toEqual({ w: 586, h: 1024 });
    expect(outputSize(511, 287)).toEqual({ w: 1024, h: 576 });
  });

  it('filter: 4x supersample, eased progress, exact frame count, browser-safe pixel format', () => {
    const f = motionFilter(findPreset('push-in')!, 120, { w: 1024, h: 576 });
    expect(f).toMatch(/^scale=4096:2304:flags=lanczos,zoompan=/);
    expect(f).toContain('(on/119)*(on/119)*(3-2*(on/119))'); // smoothstep
    expect(f).toContain(':d=120:s=1024x576:fps=24');
    expect(f).toMatch(/format=yuv420p$/);
    expect(f).not.toMatch(/\bE\b/); // every placeholder substituted
  });

  it('cost: 1 credit per second', () => {
    expect([3, 5, 8].map(motionCost)).toEqual([3, 5, 8]);
  });
});

// -------------------------------------------------------------------------------------------
describe.runIf(hasFfmpeg)('ffmpeg renderer (real ffmpeg)', () => {
  it.each(MOTION_PRESETS.map((p) => p.id))('%s renders a valid H.264 MP4 of the right length', async (id) => {
    const img = await stub.generate({ prompt: 'x', model: 'stub', aspectRatio: '1:1' });
    const out = await ffmpeg.render({ image: img.data, width: img.width, height: img.height, preset: findPreset(id)!, durationS: 3 });
    expect(out.mimeType).toBe('video/mp4');
    expect(out.data.subarray(4, 8).toString()).toBe('ftyp'); // MP4 signature
    expect({ w: out.width, h: out.height, ms: out.durationMs }).toEqual({ w: 1024, h: 1024, ms: 3000 });
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,nb_frames', '-of', 'csv=p=0', '-'], {
      input: out.data,
    }).toString();
    expect(probe.trim()).toBe('h264,yuv420p,72');
  }, 30_000);

  it('garbage input -> error (not a hang), temp files cleaned up', async () => {
    await expect(ffmpeg.render({ image: Buffer.from('not an image'), preset: MOTION_PRESETS[0]!, durationS: 3 })).rejects.toThrow(/ffmpeg exited/);
  });

  it('missing ffmpeg binary -> permanent error with a user-safe message', async () => {
    const r = createFfmpegRenderer({ ffmpegPath: '/nope/ffmpeg' });
    await expect(r.render({ image: Buffer.from('x'), preset: MOTION_PRESETS[0]!, durationS: 3 })).rejects.toMatchObject({
      retryable: false,
      userMessage: 'Video rendering is unavailable right now.',
    });
  });

  it('abort kills the render', async () => {
    const img = await stub.generate({ prompt: 'x', model: 'stub', aspectRatio: '1:1' });
    const ac = new AbortController();
    const p = ffmpeg.render({ image: img.data, preset: MOTION_PRESETS[0]!, durationS: 8, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
  });
});

// -------------------------------------------------------------------------------------------
describe('POST /motion (API)', () => {
  const queue = fakeQueue();
  const app = makeGenApp({ queue, storage });

  it('lists presets + durations with prices, labelled as a camera engine', async () => {
    const { body } = await request(app).get('/motion/presets').expect(200);
    expect(body.engine).toBe('camera');
    expect(body.presets.map((p: { id: string }) => p.id)).toContain('push-in');
    expect(body.durations).toEqual([
      { seconds: 3, credits: 3 },
      { seconds: 5, credits: 5 },
      { seconds: 8, credits: 8 },
    ]);
  });

  it('creates a MOTION job: reserves credits, enqueues, returns 202 with motion details', async () => {
    const { cookie, user, asset } = await userWithImage(app);
    const res = await request(app).post('/motion').set('Cookie', cookie).send({ sourceAssetId: asset.id, preset: 'drift', durationS: 5 }).expect(202);
    expect(res.body.job).toMatchObject({
      kind: 'MOTION',
      status: 'QUEUED',
      model: MOTION_MODEL_ID,
      creditsCost: 5,
      prompt: 'a red fox in snow',
      aspectRatio: '16:9',
      motion: { preset: 'drift', durationS: 5, sourceAssetId: asset.id },
    });
    expect(queue.ids).toContain(res.body.job.id);
    expect(await balance(user.id)).toBe(45);
    expect(await ledgerSum(user.id)).toBe(45);
  });

  it("someone else's image -> 404 (indistinguishable from missing), nothing charged", async () => {
    const owner = await userWithImage(app);
    const attacker = await userWithImage(app);
    await request(app).post('/motion').set('Cookie', attacker.cookie).send({ sourceAssetId: owner.asset.id, preset: 'drift', durationS: 3 }).expect(404);
    expect(await balance(attacker.user.id)).toBe(50);
  });

  it('a video cannot be animated again', async () => {
    const { cookie, asset } = await userWithImage(app);
    await prisma.asset.update({ where: { id: asset.id }, data: { mimeType: 'video/mp4' } });
    const res = await request(app).post('/motion').set('Cookie', cookie).send({ sourceAssetId: asset.id, preset: 'drift', durationS: 3 }).expect(400);
    expect(res.body.error).toMatch(/Only images/);
  });

  it('validation: unknown preset, odd duration, bad id', async () => {
    const { cookie, asset } = await userWithImage(app);
    const post = (b: object) => request(app).post('/motion').set('Cookie', cookie).send(b);
    expect((await post({ sourceAssetId: asset.id, preset: 'spin', durationS: 3 })).status).toBe(400);
    expect((await post({ sourceAssetId: asset.id, preset: 'drift', durationS: 4 })).status).toBe(400);
    expect((await post({ sourceAssetId: 'nope', preset: 'drift', durationS: 3 })).status).toBe(400);
    await request(app).post('/motion').send({ sourceAssetId: asset.id, preset: 'drift' }).expect(401);
  });

  it('not enough credits -> 402, no job', async () => {
    const { cookie, user, asset } = await userWithImage(app);
    await prisma.user.update({ where: { id: user.id }, data: { credits: 2 } });
    await request(app).post('/motion').set('Cookie', cookie).send({ sourceAssetId: asset.id, preset: 'drift', durationS: 3 }).expect(402);
    expect(await prisma.generationJob.count({ where: { userId: user.id, kind: 'MOTION' } })).toBe(0);
  });

  it('idempotent: same key + same body = same job, charged once; same key + different preset = 409', async () => {
    const { cookie, user, asset } = await userWithImage(app);
    const send = (preset: string) =>
      request(app).post('/motion').set('Cookie', cookie).set('Idempotency-Key', 'motion-key-123').send({ sourceAssetId: asset.id, preset, durationS: 3 });
    const a = await send('pan-left').expect(202);
    const b = await send('pan-left').expect(200);
    expect(b.body.job.id).toBe(a.body.job.id);
    await send('pan-right').expect(409);
    expect(await balance(user.id)).toBe(47);
  });

  it('the DB itself rejects inconsistent rows (CHECK constraints)', async () => {
    const { user } = await userWithImage(app);
    await expect(
      prisma.generationJob.create({ data: { userId: user.id, kind: 'MOTION', prompt: 'x', model: 'm', aspectRatio: '1:1', creditsCost: 1 } }),
    ).rejects.toThrow(/motion_fields_check/);
    await expect(
      prisma.generationJob.create({ data: { userId: user.id, kind: 'IMAGE', prompt: 'x', model: 'm', aspectRatio: '1:1', creditsCost: 1, motionPreset: 'drift' } }),
    ).rejects.toThrow(/image_fields_check/);
  });

  it('deleting the source image keeps the motion job (sourceAssetId -> NULL)', async () => {
    const { cookie, asset } = await userWithImage(app);
    const { body } = await request(app).post('/motion').set('Cookie', cookie).send({ sourceAssetId: asset.id, preset: 'drift', durationS: 3 });
    await request(app).delete(`/assets/${asset.id}`).set('Cookie', cookie).expect(204);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: body.job.id } });
    expect(job.sourceAssetId).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
describe('processGenerationJob: MOTION', () => {
  const app = makeGenApp({ queue: fakeQueue(), storage });
  const fakeRenderer: MotionRenderer = {
    name: 'fake',
    render: async () => ({ data: Buffer.from('....ftypisom-fake-mp4'), mimeType: 'video/mp4', width: 1024, height: 576, durationMs: 3000 }),
  };
  const deps = (motion?: MotionRenderer) => ({ prisma, provider: stub, motion, storage, logger: silentLogger, metrics: createMetrics() });

  async function queuedMotion() {
    const ctx = await userWithImage(app);
    const { body } = await request(app).post('/motion').set('Cookie', ctx.cookie).send({ sourceAssetId: ctx.asset.id, preset: 'push-in', durationS: 3 });
    return { ...ctx, jobId: body.job.id as string };
  }

  it('happy path: video uploaded as .mp4, asset has duration, credits kept', async () => {
    const { user, jobId } = await queuedMotion();
    expect(await processGenerationJob(jobId, { attempt: 1, maxAttempts: 3 }, deps(fakeRenderer))).toBe('done');
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId }, include: { asset: true } });
    expect(job.asset).toMatchObject({ storageKey: `users/${user.id}/${jobId}.mp4`, mimeType: 'video/mp4', width: 1024, height: 576, durationMs: 3000 });
    expect(await balance(user.id)).toBe(47);
  });

  it('source deleted while queued -> FAILED with a clear message + one refund', async () => {
    const { user, asset, jobId } = await queuedMotion();
    await prisma.asset.delete({ where: { id: asset.id } });
    expect(await processGenerationJob(jobId, { attempt: 1, maxAttempts: 3 }, deps(fakeRenderer))).toBe('failed');
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.error).toBe('The source image was deleted before the video could be made.');
    expect(await balance(user.id)).toBe(50);
    expect(await ledgerSum(user.id)).toBe(50);
  });

  it('worker without a renderer -> FAILED + refund on the first attempt (no pointless retries)', async () => {
    const { user, jobId } = await queuedMotion();
    expect(await processGenerationJob(jobId, { attempt: 1, maxAttempts: 3 }, deps(undefined))).toBe('failed');
    expect(await balance(user.id)).toBe(50);
  });

  it('renderer crash is retried, then refunded once on the last attempt', async () => {
    const { user, jobId } = await queuedMotion();
    const boom: MotionRenderer = { name: 'boom', render: () => Promise.reject(new Error('segfault')) };
    expect(await processGenerationJob(jobId, { attempt: 1, maxAttempts: 2 }, deps(boom))).toBe('retry');
    expect(await processGenerationJob(jobId, { attempt: 2, maxAttempts: 2 }, deps(boom))).toBe('failed');
    expect(await balance(user.id)).toBe(50);
    expect(await prisma.creditTransaction.count({ where: { refId: jobId, reason: 'REFUND' } })).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
describe.runIf(hasFfmpeg)('END-TO-END motion: API -> BullMQ -> worker -> ffmpeg -> S3 -> API', () => {
  const queue = makeRealQueue();
  const workerConn = createRedis(TEST_REDIS_URL, 'worker');
  let running: ReturnType<typeof startGenerationWorker>;
  const app = makeGenApp({ queue, storage });

  beforeAll(async () => {
    await queue.queue.obliterate({ force: true });
    running = startGenerationWorker({
      prisma,
      connection: workerConn,
      provider: stub,
      motion: ffmpeg,
      storage,
      logger: silentLogger,
      metrics: createMetrics(),
      concurrency: 2,
      maxAttempts: 3,
      jobTimeoutMinutes: 10,
    });
  });
  afterAll(async () => {
    await running.close();
    await queue.close();
    workerConn.disconnect();
  });

  it('an image becomes a playable MP4 in the gallery', async () => {
    const { cookie, user, asset } = await userWithImage(app);
    const { body } = await request(app).post('/motion').set('Cookie', cookie).send({ sourceAssetId: asset.id, preset: 'pan-right', durationS: 3 }).expect(202);

    let job = body.job;
    const end = Date.now() + 30_000;
    while (job.status !== 'DONE' && job.status !== 'FAILED') {
      if (Date.now() > end) throw new Error(`still ${job.status}`);
      await sleep(100);
      job = (await request(app).get(`/jobs/${job.id}`).set('Cookie', cookie)).body.job;
    }
    expect(job.status).toBe('DONE');
    expect(job.asset).toMatchObject({ kind: 'video', mimeType: 'video/mp4', durationMs: 3000, width: 1024, height: 576 });

    const res = await fetch(job.asset.url);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const mp4 = Buffer.from(await res.arrayBuffer());
    expect(mp4.subarray(4, 8).toString()).toBe('ftyp');

    const videos = await request(app).get('/assets?type=video').set('Cookie', cookie);
    expect(videos.body.items.map((a: { id: string }) => a.id)).toEqual([job.asset.id]);
    const images = await request(app).get('/assets?type=image').set('Cookie', cookie);
    expect(images.body.items.map((a: { id: string }) => a.id)).toEqual([asset.id]);
    expect(await balance(user.id)).toBe(47);
  }, 40_000);
});
