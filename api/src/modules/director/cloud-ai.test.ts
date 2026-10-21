import { describe, expect, it } from 'vitest';
import type { SharedEnv } from '../../config/env.js';
import { ProviderError } from '../generation/providers/types.js';
import { CF_DIRECTOR_MODEL, CF_PICTURE_MODEL, createCloudflareDirector, createCloudflarePictures } from './cloud-ai.js';
import { directorFromEnv, localAiStatus, picturesFromEnv } from './index.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);

function fakeFetch(respond: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });
    return respond(url, body);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const opts = (fetchImpl: typeof fetch) => ({ accountId: 'acc/1', apiToken: 'tok', fetchImpl });

describe('Cloudflare director (cloud Scene Director LLM)', () => {
  it('sends system + user in JSON mode and returns the content (OpenAI-style answer)', async () => {
    const f = fakeFetch(() => json({ result: { choices: [{ message: { content: '{"shots":[]}' } }] } }));
    const out = await createCloudflareDirector(opts(f.impl)).complete('SYS', 'USR');
    expect(out).toBe('{"shots":[]}');
    expect(f.calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acc%2F1/ai/run/${CF_DIRECTOR_MODEL}`);
    expect(f.calls[0]!.auth).toBe('Bearer tok');
    expect(f.calls[0]!.body).toMatchObject({ messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }], response_format: { type: 'json_object' } });
  });

  it('accepts the legacy { response } shape, as a string or an already-parsed object', async () => {
    const a = fakeFetch(() => json({ result: { response: '{"a":1}' } }));
    expect(await createCloudflareDirector(opts(a.impl)).complete('s', 'u')).toBe('{"a":1}');
    const b = fakeFetch(() => json({ result: { response: { a: 1 } } }));
    expect(await createCloudflareDirector(opts(b.impl)).complete('s', 'u')).toBe('{"a":1}');
  });

  it('empty answer -> retryable error', async () => {
    const f = fakeFetch(() => json({ result: {} }));
    await expect(createCloudflareDirector(opts(f.impl)).complete('s', 'u')).rejects.toMatchObject({ retryable: true });
  });

  it('daily quota (429 / 4006) -> NOT retryable, clear message; 5xx retryable; 4xx not', async () => {
    const q = fakeFetch(() => new Response('{"errors":[{"code":4006}]}', { status: 429 }));
    const err = await createCloudflareDirector(opts(q.impl)).complete('s', 'u').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: false, userMessage: expect.stringContaining('free AI quota') });
    const s = fakeFetch(() => new Response('x', { status: 503 }));
    await expect(createCloudflareDirector(opts(s.impl)).complete('s', 'u')).rejects.toMatchObject({ retryable: true });
    const c = fakeFetch(() => new Response('bad', { status: 400 }));
    await expect(createCloudflareDirector(opts(c.impl)).complete('s', 'u')).rejects.toMatchObject({ retryable: false });
  });

  it('network failure -> retryable', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(createCloudflareDirector(opts(impl)).complete('s', 'u')).rejects.toMatchObject({ retryable: true });
  });
});

describe('Cloudflare pictures (cloud Scene Director images)', () => {
  it('snaps the size to multiples of 8 within 256..2048, passes negative + seed, returns the PNG', async () => {
    const f = fakeFetch(() => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
    const pic = await createCloudflarePictures(opts(f.impl)).picture({ prompt: 'p', negative: 'nude', width: 513, height: 3000, seed: 7 });
    expect(f.calls[0]!.url.endsWith(CF_PICTURE_MODEL)).toBe(true);
    expect(f.calls[0]!.body).toMatchObject({ prompt: 'p', negative_prompt: 'nude', width: 512, height: 2048, seed: 7 });
    expect(pic).toMatchObject({ mimeType: 'image/png', seed: 7, width: 512, height: 2048 });
    expect(pic.data.equals(PNG)).toBe(true);
  });

  it('no seed -> seed null; not a PNG -> retryable error', async () => {
    const ok = fakeFetch(() => new Response(PNG));
    expect((await createCloudflarePictures(opts(ok.impl)).picture({ prompt: 'p', width: 64, height: 64 })).seed).toBeNull();
    expect(ok.calls[0]!.body).toMatchObject({ width: 256, height: 256 });
    expect(ok.calls[0]!.body).not.toHaveProperty('negative_prompt');
    const bad = fakeFetch(() => new Response('oops'));
    await expect(createCloudflarePictures(opts(bad.impl)).picture({ prompt: 'p', width: 512, height: 768 })).rejects.toMatchObject({ retryable: true });
  });

  it('has no clip() or faces(): AI video / face boxes stay on the local GPU', () => {
    const e = createCloudflarePictures(opts(fakeFetch(() => new Response(PNG)).impl));
    expect(e.clip).toBeUndefined();
    expect(e.faces).toBeUndefined();
  });
});

describe('wiring: DIRECTOR_PROVIDER=cloudflare', () => {
  const env = (o: Partial<SharedEnv>) => ({ DIRECTOR_PROVIDER: 'auto', PROVIDER_TIMEOUT_MS: 1000, ...o }) as SharedEnv;
  const cf = { DIRECTOR_PROVIDER: 'cloudflare' as const, CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' };

  it('cloud engines when asked for and credentials exist', async () => {
    expect(directorFromEnv(env(cf)).name).toBe('cloudflare-llm');
    expect(picturesFromEnv(env(cf)).name).toBe('cloudflare-sd15');
    expect(await localAiStatus(env(cf))).toEqual({ llm: true, image: true, upscale: false, faceRef: false, video: false });
  });

  it('auto (default) or missing credentials -> stubs, never a silent cloud call', () => {
    expect(directorFromEnv(env({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' })).name).toBe('stub');
    expect(picturesFromEnv(env({ DIRECTOR_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a' })).name).toBe('stub');
  });

  it('a configured local AI always wins over the cloud', () => {
    const e = env({ ...cf, LOCAL_LLM_URL: 'http://h:1', LOCAL_AI_URL: 'http://h:2', LOCAL_AI_TOKEN: 'x'.repeat(16) });
    expect(directorFromEnv(e).name).toBe('local-llm');
    expect(picturesFromEnv(e).name).toBe('local-sd15');
  });
});
