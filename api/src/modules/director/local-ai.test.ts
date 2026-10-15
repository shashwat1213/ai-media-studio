import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SharedEnv } from '../../config/env.js';
import type { SpeechProvider } from '../audio/speech.js';
import { ProviderError } from '../generation/providers/types.js';
import { directorFromEnv, localAiStatus, picturesFromEnv, scribeFromEnv } from './index.js';
import { createLocalPictures, createLocalSpeech, createSpeechRouter, hdSize, isAuraVoice, PIPER_VOICES } from './local-ai.js';

/**
 * A fake local-AI gateway on a real TCP port: the clients go through real fetch, real headers,
 * real status codes. No GPU or model needed.
 */
const TOKEN = 'test-token-0123456789abcdef';
interface Seen { method: string; url: string; auth?: string; type?: string; body: Buffer }
let server: Server;
let base = '';
let seen: Seen[] = [];
let reply: (s: Seen) => { status?: number; headers?: Record<string, string>; body?: string | Buffer; delayMs?: number } = () => ({});

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const s: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, type: req.headers['content-type'], body: await read(req) };
    seen.push(s);
    const r = reply(s);
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    if (res.destroyed) return;
    res.writeHead(r.status ?? 200, r.headers ?? {});
    res.end(r.body ?? '');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  seen = [];
  reply = () => ({});
});

describe('local pictures (stable-diffusion.cpp gateway)', () => {
  it('POSTs the prompt with the bearer token and returns PNG bytes + the seed header', async () => {
    reply = () => ({ headers: { 'content-type': 'image/png', 'x-seed': '4242' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    const pics = createLocalPictures({ baseUrl: `${base}/`, token: TOKEN }); // trailing slash is trimmed
    const out = await pics.picture({ prompt: 'arjun at the ghat', negative: 'blurry', width: 512, height: 768, seed: 7 });
    expect(out).toEqual({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png', seed: 4242, width: 512, height: 768 });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/image', auth: `Bearer ${TOKEN}`, type: 'application/json' });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ prompt: 'arjun at the ghat', negative: 'blurry', width: 512, height: 768, seed: 7, steps: 6 });
  });

  it('HD: sends upscale:true, returns the JPEG with the REAL size from the gateway headers', async () => {
    reply = () => ({ headers: { 'content-type': 'image/jpeg', 'x-seed': '9', 'x-width': '1280', 'x-height': '1920' }, body: Buffer.from([0xff, 0xd8, 0xff]) });
    const out = await createLocalPictures({ baseUrl: base, token: TOKEN }).picture({ prompt: 'p', width: 512, height: 768, upscale: true });
    expect(JSON.parse(seen[0]!.body.toString())).toMatchObject({ upscale: true, width: 512, height: 768 });
    expect(out).toMatchObject({ mimeType: 'image/jpeg', width: 1280, height: 1920, seed: 9 });
  });

  it('HD without size headers (older gateway) -> computed HD size; non-HD never sends `upscale`', async () => {
    reply = () => ({ headers: { 'content-type': 'image/jpeg' }, body: 'x' });
    const pics = createLocalPictures({ baseUrl: base, token: TOKEN });
    expect(await pics.picture({ prompt: 'p', width: 768, height: 448, upscale: true })).toMatchObject({ width: 1920, height: 1120 });
    await pics.picture({ prompt: 'p', width: 64, height: 64 });
    expect(JSON.parse(seen[1]!.body.toString())).not.toHaveProperty('upscale');
  });

  it('hdSize: long side 1920, even, same shape', () => {
    expect(hdSize(512, 768)).toEqual({ width: 1280, height: 1920 });
    expect(hdSize(768, 448)).toEqual({ width: 1920, height: 1120 });
    expect(hdSize(640, 640)).toEqual({ width: 1920, height: 1920 });
  });

  it('missing / non-numeric seed header -> seed null', async () => {
    reply = () => ({ headers: { 'x-seed': 'abc' }, body: 'x' });
    const out = await createLocalPictures({ baseUrl: base, token: TOKEN }).picture({ prompt: 'p', width: 64, height: 64 });
    expect(out.seed).toBeNull();
  });

  it('HTTP 5xx / 429 -> retryable; 4xx -> not retryable, with a user-safe message', async () => {
    const pics = createLocalPictures({ baseUrl: base, token: TOKEN });
    for (const [status, retryable] of [[500, true], [503, true], [429, true], [400, false], [401, false]] as const) {
      reply = () => ({ status });
      const err = await pics.picture({ prompt: 'p', width: 64, height: 64 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable, status });
      expect((err as ProviderError).userMessage).toBe(retryable ? 'The local AI failed. Try again.' : 'The local AI refused the request.');
    }
  });

  it('gateway not running -> retryable "start it" error (never a raw ECONNREFUSED)', async () => {
    const pics = createLocalPictures({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
    const err = (await pics.picture({ prompt: 'p', width: 64, height: 64 }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toMatch(/scripts\/local-ai\/start\.sh/);
  });

  it('a hung gateway is cut off by the timeout; a caller abort also stops it', async () => {
    reply = () => ({ delayMs: 2000 });
    const slow = createLocalPictures({ baseUrl: base, token: TOKEN, timeoutMs: 100 });
    const t0 = Date.now();
    await expect(slow.picture({ prompt: 'p', width: 64, height: 64 })).rejects.toBeInstanceOf(ProviderError);
    expect(Date.now() - t0).toBeLessThan(1500);

    const ac = new AbortController();
    const p = createLocalPictures({ baseUrl: base, token: TOKEN }).picture({ prompt: 'p', width: 64, height: 64 }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('local speech (Piper TTS + whisper.cpp)', () => {
  it('speak: POST /tts {text, voice} -> WAV bytes', async () => {
    reply = () => ({ headers: { 'content-type': 'audio/wav' }, body: 'RIFFdata' });
    const sp = createLocalSpeech({ baseUrl: base, token: TOKEN });
    expect(sp.voices).toBe(PIPER_VOICES);
    const out = await sp.speak('पहली बार वाराणसी आया', 'hi_IN-rohan-medium');
    expect(out).toEqual({ data: Buffer.from('RIFFdata'), mimeType: 'audio/wav' });
    expect(seen[0]!.url).toBe('/tts');
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ text: 'पहली बार वाराणसी आया', voice: 'hi_IN-rohan-medium' });
  });

  it('transcribe: raw audio bytes up, language in the query, whisper JSON parsed into words', async () => {
    reply = () => ({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: ' पहली बार ',
        transcription_info: { language: 'hi', duration: 1.5 },
        segments: [{ words: [{ word: ' पहली', start: 0.1, end: 0.5 }, { word: 'बार', start: 0.5, end: 0.9 }, { word: ' ', start: 1, end: 1 }] }],
      }),
    });
    const sp = createLocalSpeech({ baseUrl: base, token: TOKEN });
    const t = await sp.transcribe(Buffer.from([1, 2, 3, 4]), { language: 'hi' });
    expect(seen[0]).toMatchObject({ url: '/transcribe?language=hi', type: 'application/octet-stream' });
    expect([...seen[0]!.body]).toEqual([1, 2, 3, 4]);
    expect(t).toEqual({ language: 'hi', text: 'पहली बार', words: [{ w: 'पहली', s: 0.1, e: 0.5 }, { w: 'बार', s: 0.5, e: 0.9 }], durationS: 1.5 });

    await sp.transcribe(Buffer.from([0]));
    expect(seen[1]!.url).toBe('/transcribe'); // no language -> auto-detect
  });
});

describe('speech router (local Piper + cloud Aura)', () => {
  const fake = (name: string, voices: string[], fail?: ProviderError): SpeechProvider & { calls: string[] } => {
    const calls: string[] = [];
    return {
      name,
      calls,
      voices: voices.map((id) => ({ id, name: id, style: '', gender: 'male' as const })),
      async speak(_t, v) {
        calls.push(`speak:${v}`);
        return { data: Buffer.from(name), mimeType: 'audio/wav' };
      },
      async transcribe() {
        calls.push('transcribe');
        if (fail) throw fail;
        return { language: 'hi', text: name, words: [], durationS: 0 };
      },
    };
  };

  it('routes voices to the provider that owns them; lists both', async () => {
    const local = fake('local', ['hi_IN-rohan-medium']);
    const cloud = fake('cloud', ['aura-orion']);
    const r = createSpeechRouter(local, cloud);
    expect(r.name).toBe('local+cloud');
    expect(r.voices.map((v) => v.id)).toEqual(['hi_IN-rohan-medium', 'aura-orion']);
    await r.speak('x', 'hi_IN-rohan-medium');
    await r.speak('x', 'aura-orion');
    expect(local.calls).toEqual(['speak:hi_IN-rohan-medium']);
    expect(cloud.calls).toEqual(['speak:aura-orion']);
  });

  it('transcription prefers local; falls back to cloud only on a RETRYABLE local failure', async () => {
    const down = new ProviderError('down', { retryable: true, userMessage: 'x' });
    const refused = new ProviderError('bad audio', { retryable: false, userMessage: 'x' });
    const cloud = fake('cloud', []);
    expect((await createSpeechRouter(fake('local', []), cloud).transcribe(Buffer.alloc(1))).text).toBe('local');
    expect(cloud.calls).toEqual([]);
    expect((await createSpeechRouter(fake('local', [], down), cloud).transcribe(Buffer.alloc(1))).text).toBe('cloud');
    await expect(createSpeechRouter(fake('local', [], refused), cloud).transcribe(Buffer.alloc(1))).rejects.toBe(refused);
    await expect(createSpeechRouter(fake('local', [], down), null).transcribe(Buffer.alloc(1))).rejects.toBe(down);
  });

  it('no provider -> clear non-retryable errors', async () => {
    const none = createSpeechRouter(null, null);
    expect(none.name).toBe('none');
    await expect(none.speak('x', 'aura-orion')).rejects.toMatchObject({ retryable: false, userMessage: 'That voice is not available.' });
    await expect(none.transcribe(Buffer.alloc(1))).rejects.toMatchObject({ retryable: false, userMessage: 'Transcription is unavailable.' });
    // cloud only: a Piper voice isn't owned by anyone local, so it goes to the cloud provider
    const cloud = fake('cloud', ['aura-orion']);
    await createSpeechRouter(null, cloud).speak('x', 'hi_IN-rohan-medium');
    expect(cloud.calls).toEqual(['speak:hi_IN-rohan-medium']);
  });

  it('isAuraVoice', () => {
    expect(isAuraVoice('hi_IN-rohan-medium')).toBe(false);
  });
});

describe('wiring from env', () => {
  const env = (o: Partial<SharedEnv>) => o as SharedEnv;

  it('no local AI configured -> stub director / stub pictures / no scribe', async () => {
    expect(directorFromEnv(env({})).name).toBe('stub');
    expect(scribeFromEnv(env({}))).toBeUndefined();
    const pics = picturesFromEnv(env({}));
    expect(pics.name).toBe('stub');
    const out = await pics.picture({ prompt: 'p', width: 64, height: 96, seed: 3 });
    expect(out).toMatchObject({ mimeType: 'image/png', seed: 3, width: 64, height: 96 });
    expect(await pics.picture({ prompt: 'p', width: 512, height: 768, upscale: true })).toMatchObject({ width: 1280, height: 1920 });
    expect(out.data.subarray(1, 4).toString()).toBe('PNG');
  });

  it('URL without the token is NOT enough (never call the gateway unauthenticated)', () => {
    expect(directorFromEnv(env({ LOCAL_LLM_URL: base })).name).toBe('stub');
    expect(picturesFromEnv(env({ LOCAL_AI_URL: base })).name).toBe('stub');
  });

  it('URL + token -> local engines', () => {
    const e = env({ LOCAL_LLM_URL: base, LOCAL_SCRIBE_URL: base, LOCAL_AI_URL: base, LOCAL_AI_TOKEN: TOKEN });
    expect(directorFromEnv(e).name).toBe('local-llm');
    expect(scribeFromEnv(e)?.name).toBe('local-llm');
    expect(picturesFromEnv(e).name).toBe('local-sd15');
  });

  it('localAiStatus: health checks with the token; down / no token / no URL -> false', async () => {
    let upscale = true;
    reply = (s) =>
      s.auth === `Bearer ${TOKEN}` && s.url === '/health'
        ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, upscale }) }
        : { status: 401 };
    expect(await localAiStatus(env({ LOCAL_LLM_URL: base, LOCAL_AI_URL: `${base}/`, LOCAL_AI_TOKEN: TOKEN }))).toEqual({ llm: true, image: true, upscale: true });
    upscale = false;
    expect(await localAiStatus(env({ LOCAL_LLM_URL: base, LOCAL_AI_URL: base, LOCAL_AI_TOKEN: TOKEN }))).toEqual({ llm: true, image: true, upscale: false });
    reply = () => ({ status: 200, body: 'not json' }); // llama-server style health: still "up", no upscale claim
    expect(await localAiStatus(env({ LOCAL_LLM_URL: base, LOCAL_AI_URL: base, LOCAL_AI_TOKEN: TOKEN }))).toEqual({ llm: true, image: true, upscale: false });
    reply = (s) => ({ status: s.auth === `Bearer ${TOKEN}` ? 200 : 401 });
    expect(await localAiStatus(env({ LOCAL_LLM_URL: base, LOCAL_AI_URL: base, LOCAL_AI_TOKEN: 'wrong-token-0123456789' }))).toEqual({ llm: false, image: false, upscale: false });
    expect(await localAiStatus(env({ LOCAL_LLM_URL: 'http://127.0.0.1:1', LOCAL_AI_TOKEN: TOKEN }))).toEqual({ llm: false, image: false, upscale: false });
    expect(await localAiStatus(env({ LOCAL_LLM_URL: base }))).toEqual({ llm: false, image: false, upscale: false });
  });
});
