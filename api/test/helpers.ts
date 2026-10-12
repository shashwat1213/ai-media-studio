import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../src/config/app-config.js';
import { createApp } from '../src/app.js';
import { createRedis } from '../src/lib/redis.js';
import { createStorage, type Storage } from '../src/lib/storage.js';
import { createJobQueue, type JobQueue } from '../src/modules/generation/queue.js';
import { createLogger } from '../src/observability/logger.js';

export const testConfig: AppConfig = {
  corsOrigin: 'http://localhost:5173',
  jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
  jwtTtlDays: 7,
  bcryptCost: 4, // fast hashing in tests; prod uses 12
  signupBonusCredits: 50,
  authRateLimit: 1000,
  secureCookies: false,
  providerMode: 'stub',
  maxActiveJobsPerUser: 3,
  generateRateLimit: 1000,
};

export const prisma = new PrismaClient(); // DATABASE_URL points at the test DB (vitest.config.ts)

export function makeApp(overrides: Partial<AppConfig> = {}) {
  return createApp({ prisma, config: { ...testConfig, ...overrides } });
}

export async function resetDb() {
  await prisma.$executeRawUnsafe('TRUNCATE "Asset", "GenerationJob", "CreditTransaction", "User" CASCADE');
}

// ---- Phase 2: real Redis + real S3-compatible storage (Silo/MinIO locally, service containers in CI) ----

// Redis db 1 so tests never touch the dev queue (db 0) that a running dev worker consumes.
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

export function makeTestStorage(): Storage {
  return createStorage({
    bucket: process.env.TEST_S3_BUCKET ?? 'ai-media-assets-test',
    region: 'us-east-1',
    endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    forcePathStyle: true,
    signedUrlTtlSeconds: 300,
  });
}

export const silentLogger = createLogger('test');

/** A queue that records ids instead of talking to Redis (API tests that don't need a worker). */
export function fakeQueue(opts: { fail?: boolean } = {}): JobQueue & { ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    async enqueue(id: string) {
      if (opts.fail) throw new Error('redis down');
      ids.push(id);
    },
    async close() {},
  };
}

export function makeGenApp(deps: { queue?: JobQueue; storage?: Storage; overrides?: Partial<AppConfig> } = {}) {
  return createApp({
    prisma,
    config: { ...testConfig, ...deps.overrides },
    queue: deps.queue ?? fakeQueue(),
    storage: deps.storage ?? makeTestStorage(),
  });
}

export function makeRealQueue() {
  const connection = createRedis(TEST_REDIS_URL, 'producer');
  const q = createJobQueue(connection, { maxAttempts: 3, backoffMs: 50 });
  return {
    ...q,
    connection,
    async close() {
      await q.close();
      connection.disconnect();
    },
  };
}

export function cookieOf(res: { headers: Record<string, unknown> }) {
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}
