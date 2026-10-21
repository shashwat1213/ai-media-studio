import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { cookieOf, makeGenApp, makeTestStorage, prisma, resetDb } from '../../../test/helpers.js';
import { loadWorkerEnv } from '../../config/env.js';
import { createCloudflareProvider, sniffMime } from './providers/cloudflare.js';
import { providerFromEnv, providerMode } from './providers/index.js';
import { CLOUDFLARE_MODELS, catalogFor, findModel, upstreamModelId } from './models.js';
import { ProviderError } from './providers/types.js';

// Cloudflare Workers AI provider. No network, no quota used: fetch is faked.

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
const opts = { accountId: 'acc123', apiToken: 'tok', timeoutMs: 5000 };

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected a failure');
}

describe('Cloudflare provider', () => {
  it('calls the documented REST endpoint with steps from the catalog, strips the variant suffix, decodes the image', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const p = createCloudflareProvider({
      ...opts,
      fetchImpl: fakeFetch(200, { success: true, result: { image: jpeg.toString('base64') } }, (url, init) => sent.push({ url, init })),
    });

    const img = await p.generate({ prompt: 'a red fox', model: '@cf/black-forest-labs/flux-1-schnell', aspectRatio: '1:1' });
    await p.generate({ prompt: 'a red fox', model: '@cf/black-forest-labs/flux-1-schnell:hq', aspectRatio: '1:1' });

    expect(sent[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/black-forest-labs/flux-1-schnell');
    expect(sent[1]!.url).toBe(sent[0]!.url); // :hq is OUR variant, same upstream model
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ prompt: 'a red fox', steps: 4 });
    expect(JSON.parse(sent[1]!.init.body as string)).toEqual({ prompt: 'a red fox', steps: 8 });
    expect(img).toMatchObject({ mimeType: 'image/jpeg', width: 1024, height: 1024, costUsd: 0 });
    expect(img.data.equals(jpeg)).toBe(true);
  });

  it('daily free quota exhausted -> permanent, friendly message (no pointless retries)', async () => {
    const byStatus = await failure(
      createCloudflareProvider({ ...opts, fetchImpl: fakeFetch(429, { success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] }) })
        .generate({ prompt: 'x', model: CLOUDFLARE_MODELS[0]!.id, aspectRatio: '1:1' }),
    );
    expect(byStatus.retryable).toBe(false);
    expect(byStatus.userMessage).toMatch(/free image quota/);

    const byCode = await failure(
      createCloudflareProvider({ ...opts, fetchImpl: fakeFetch(400, { success: false, errors: [{ code: 4006, message: 'limit' }] }) })
        .generate({ prompt: 'x', model: CLOUDFLARE_MODELS[0]!.id, aspectRatio: '1:1' }),
    );
    expect(byCode.userMessage).toMatch(/free image quota/);
  });

  it('maps other failures: 5xx retryable, 401 permanent, provider detail never reaches the user', async () => {
    for (const [status, retryable] of [[500, true], [503, true], [401, false], [400, false]] as const) {
      const e = await failure(
        createCloudflareProvider({ ...opts, fetchImpl: fakeFetch(status, { success: false, errors: [{ code: 1, message: 'secret internal detail' }] }) })
          .generate({ prompt: 'x', model: CLOUDFLARE_MODELS[0]!.id, aspectRatio: '1:1' }),
      );
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.retryable).toBe(retryable);
      expect(e.message).toMatch(/^cloudflare/);
      expect(e.userMessage).not.toContain('secret');
    }
  });

  it('a 200 with success:false or no image is treated as an error', async () => {
    const notOk = await failure(
      createCloudflareProvider({ ...opts, fetchImpl: fakeFetch(200, { success: false, errors: [{ message: 'odd' }] }) })
        .generate({ prompt: 'x', model: CLOUDFLARE_MODELS[0]!.id, aspectRatio: '1:1' }),
    );
    expect(notOk.retryable).toBe(true); // treated like a 502
    const empty = await failure(
      createCloudflareProvider({ ...opts, fetchImpl: fakeFetch(200, { success: true, result: {} }) })
        .generate({ prompt: 'x', model: CLOUDFLARE_MODELS[0]!.id, aspectRatio: '1:1' }),
    );
    expect(empty.message).toBe('cloudflare returned no image');
  });

  it('network failure is retryable', async () => {
    const down = createCloudflareProvider({
      ...opts,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const e = await failure(down.generate({ prompt: 'x', model: CLOUDFLARE_MODELS[0]!.id, aspectRatio: '1:1' }));
    expect(e.retryable).toBe(true);
  });

  it('sniffs the image type from magic bytes', () => {
    expect(sniffMime(jpeg)).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image/png');
    expect(sniffMime(Buffer.from('524946460000000057454250', 'hex'))).toBe('image/webp');
  });
});

describe('provider selection + catalogs', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_SECRET: 'x'.repeat(32), S3_FORCE_PATH_STYLE: 'true' };

  it('uses Cloudflare only when BOTH the account id and token are set', () => {
    expect(providerMode({ AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' })).toBe('cloudflare');
    expect(providerMode({ AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a' })).toBe('stub');
    expect(providerMode({ AI_PROVIDER: 'stub', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' })).toBe('stub');
    const w = loadWorkerEnv({ ...base, AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' });
    expect(providerFromEnv(w).name).toBe('cloudflare');
  });

  it('refuses to boot with AI_PROVIDER=cloudflare and missing credentials', () => {
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    console.error = () => {};
    try {
      expect(() => loadWorkerEnv({ ...base, AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a' })).toThrow('exit 1');
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });

  it('catalog helpers', () => {
    expect(catalogFor('cloudflare')).toBe(CLOUDFLARE_MODELS);
    expect(catalogFor('stub').map((m) => m.id)).toContain('recraft/recraft-v4.1-flash');
    expect(findModel('@cf/black-forest-labs/flux-1-schnell:hq')?.params?.steps).toBe(8);
    expect(findModel('nope')).toBeUndefined();
    expect(upstreamModelId('@cf/black-forest-labs/flux-1-schnell:hq')).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(upstreamModelId('recraft/recraft-v4.1-flash')).toBe('recraft/recraft-v4.1-flash');
  });
});

describe('API with the Cloudflare catalog', () => {
  const storage = makeTestStorage();

  it('lists only Cloudflare models (no internal fields), validates model + ratio, charges the catalog price', async () => {
    await resetDb();
    const app = makeGenApp({ storage, overrides: { providerMode: 'cloudflare' } });

    const models = await request(app).get('/generate/models').expect(200);
    expect(models.body.mode).toBe('cloudflare');
    expect(models.body.models.map((m: { id: string }) => m.id)).toEqual(CLOUDFLARE_MODELS.map((m) => m.id));
    expect(models.body.models[0]).not.toHaveProperty('usdPerImage');
    expect(models.body.models[0]).not.toHaveProperty('params');
    expect(models.body.models[0].aspectRatios).toEqual(['1:1']);

    const reg = await request(app).post('/auth/register').send({ email: 'cf@example.com', password: 'password-123' });
    const cookie = cookieOf(reg);

    // An OpenRouter model id isn't valid while Cloudflare is active.
    await request(app).post('/generate').set('Cookie', cookie).send({ prompt: 'a fox', model: 'recraft/recraft-v4.1-flash' }).expect(400);
    // Square-only model: 16:9 rejected with a field error.
    const bad = await request(app)
      .post('/generate')
      .set('Cookie', cookie)
      .send({ prompt: 'a fox', model: '@cf/black-forest-labs/flux-1-schnell', aspectRatio: '16:9' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/aspect ratio/);

    await request(app)
      .post('/generate')
      .set('Cookie', cookie)
      .send({ prompt: 'a fox', model: '@cf/black-forest-labs/flux-1-schnell:hq', aspectRatio: '1:1' })
      .expect(202);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: reg.body.user.id } })).credits).toBe(50 - 4);
    storage.destroy();
  });
});
