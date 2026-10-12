/**
 * Job pipeline benchmark.  Run:  npm run bench:pipeline
 *
 * Measures the QUEUE + WORKER + STORAGE overhead, not AI speed: the provider is the stub
 * with 0 ms delay, so every millisecond measured is our own code + Postgres + Redis + S3.
 *
 * For each worker concurrency: create N jobs directly (credits reserved like the API does),
 * enqueue them all, start a worker, and time until every job is DONE. Then verify:
 *   every job DONE, one asset per job, no refunds, ledger sum == balance for every user.
 *
 * Uses the TEST database + Redis db 1 + the test bucket, never dev data.
 */
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { createRedis } from '../src/lib/redis.js';
import { createStorage } from '../src/lib/storage.js';
import { applyDebit } from '../src/modules/credits/credits.service.js';
import { createJobQueue } from '../src/modules/generation/queue.js';
import { createStubProvider } from '../src/modules/generation/providers/stub.js';
import { startGenerationWorker } from '../src/modules/generation/worker.js';
import { createLogger } from '../src/observability/logger.js';

const DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://studio:studio@localhost:5433/ai_media_studio_test?schema=public';
process.env.DATABASE_URL = DB_URL;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
const JOBS = Number(process.env.PIPELINE_JOBS ?? 200);
const CONCURRENCIES = (process.env.PIPELINE_CONCURRENCY ?? '1,4,8').split(',').map(Number);
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const prisma = new PrismaClient({ datasourceUrl: DB_URL });
const storage = createStorage({
  bucket: 'ai-media-assets-test',
  region: 'us-east-1',
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true,
  signedUrlTtlSeconds: 300,
});
const logger = createLogger('test');

const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function run(concurrency: number) {
  await prisma.$executeRawUnsafe('TRUNCATE "Asset", "GenerationJob", "CreditTransaction", "User" CASCADE');
  const producer = createRedis(REDIS_URL, 'producer');
  const queue = createJobQueue(producer, { maxAttempts: 3, backoffMs: 100 });
  await queue.queue.obliterate({ force: true });

  // 20 users sharing the jobs, each with enough credits (reserved exactly like POST /generate).
  const users = await Promise.all(
    Array.from({ length: 20 }, (_, i) => prisma.user.create({ data: { email: `pipe${i}-${randomUUID()}@bench.local`, passwordHash: 'x' } })),
  );
  for (const u of users) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { credits: 1000 } });
      await tx.creditTransaction.create({ data: { userId: u.id, delta: 1000, reason: 'PURCHASE', balanceAfter: 1000 } });
    });
  }
  const ids: string[] = [];
  for (let i = 0; i < JOBS; i++) {
    const userId = users[i % users.length]!.id;
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await applyDebit(tx, userId, 2, 'GENERATION', id);
      await tx.generationJob.create({
        data: { id, userId, prompt: `pipeline bench ${i}`, model: 'recraft/recraft-v4.1-flash', aspectRatio: '1:1', creditsCost: 2 },
      });
    });
    ids.push(id);
  }
  await Promise.all(ids.map((id) => queue.enqueue(id)));

  const workerConn = createRedis(REDIS_URL, 'worker');
  const started = Date.now();
  const worker = startGenerationWorker({
    prisma,
    connection: workerConn,
    provider: createStubProvider(0),
    storage,
    logger,
    concurrency,
    maxAttempts: 3,
    jobTimeoutMinutes: 10,
  });

  for (;;) {
    const done = await prisma.generationJob.count({ where: { status: { in: ['DONE', 'FAILED'] } } });
    if (done === JOBS) break;
    if (Date.now() - started > 5 * 60_000) throw new Error('pipeline benchmark timed out');
    await sleep(25);
  }
  const wallMs = Date.now() - started;

  const jobs = await prisma.generationJob.findMany({ select: { status: true, startedAt: true, finishedAt: true } });
  const perJob = jobs.map((j) => j.finishedAt!.getTime() - j.startedAt!.getTime());
  const failed = jobs.filter((j) => j.status !== 'DONE').length;
  const assets = await prisma.asset.count();
  const refunds = await prisma.creditTransaction.count({ where: { reason: 'REFUND' } });
  const drift = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "User" u
    WHERE u.credits <> (SELECT COALESCE(SUM(delta), 0) FROM "CreditTransaction" t WHERE t."userId" = u.id)`;

  await worker.close();
  await queue.close();
  producer.disconnect();
  workerConn.disconnect();

  return {
    concurrency,
    jobs: JOBS,
    wallSeconds: +(wallMs / 1000).toFixed(2),
    jobsPerSecond: +(JOBS / (wallMs / 1000)).toFixed(1),
    perJobP50Ms: pct(perJob, 50),
    perJobP95Ms: pct(perJob, 95),
    failed,
    assets,
    refunds,
    usersWithLedgerDrift: Number(drift[0]!.n),
  };
}

await storage.ensureBucket();
const results = [];
for (const c of CONCURRENCIES) {
  console.log(`▶ ${JOBS} jobs, worker concurrency ${c}…`);
  const r = await run(c);
  console.log('  ', r);
  results.push(r);
}
const machine = {
  date: new Date().toISOString().slice(0, 10),
  cpu: os.cpus()[0]?.model.trim(),
  threads: os.cpus().length,
  ramGb: Math.round(os.totalmem() / 1024 ** 3),
  node: process.version,
};
writeFileSync(path.join(ROOT, 'api', 'bench', 'pipeline-results.json'), JSON.stringify({ machine, results }, null, 2) + '\n');
await prisma.$disconnect();
storage.destroy();
