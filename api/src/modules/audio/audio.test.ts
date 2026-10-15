import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cookieOf, fakeQueue, makeRealQueue, makeTestStorage, prisma, resetDb, silentLogger, TEST_REDIS_URL, testConfig } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { createRedis } from '../../lib/redis.js';
import { createMetrics } from '../../observability/metrics.js';
import { createEditRenderer, specToAss } from '../editor/edit-renderer.js';
import { audioGraph, buildEditArgs } from '../editor/edit-filter.js';
import { EditRequestSchema, normaliseEdit, type UploadInfo } from '../editor/edit-spec.js';
import { assColor, assEscape, assTime, buildAss, groupWords } from '../editor/ass.js';
import { interpretProbe, probeMedia } from '../editor/probe.js';
import { createStubProvider } from '../generation/providers/stub.js';
import { startGenerationWorker } from '../generation/worker.js';
import { ProviderError } from '../generation/providers/types.js';
import { createCloudflareSpeech, createStubSpeech, parseWhisper, wavTone, type SpeechProvider } from './speech.js';
import { failTranscription, processTranscription, requestTranscription, sttCost, sweepStuckTranscriptions } from './transcription.js';
import { chunkScript, ttsCost } from './voiceover.js';

const storage = makeTestStorage();
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
let dir: string;
beforeAll(async () => {
  await storage.ensureBucket();
  dir = await mkdtemp(path.join(tmpdir(), 'audio-test-'));
});
beforeEach(resetDb);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  storage.destroy();
  await prisma.$disconnect();
});

const IMG = '00000000-0000-4000-8000-000000000001';
const VID = '00000000-0000-4000-8000-000000000002';
const VO = '00000000-0000-4000-8000-000000000004';
const MU = '00000000-0000-4000-8000-000000000005';
const words = [
  { w: 'Welcome', s: 0, e: 0.5 },
  { w: 'to', s: 0.5, e: 0.7 },
  { w: 'Goa.', s: 0.7, e: 1.1 },
  { w: 'Day', s: 1.4, e: 1.7 },
  { w: 'one', s: 1.7, e: 2.0 },
];
const infos = new Map<string, UploadInfo>([
  [IMG, { id: IMG, kind: 'image', durationMs: null }],
  [VID, { id: VID, kind: 'video', durationMs: 5000, hasAudio: true, words: [{ w: 'clip', s: 1.2, e: 1.5 }, { w: 'talk', s: 4.5, e: 4.9 }] }],
  [VO, { id: VO, kind: 'audio', durationMs: 2500, hasAudio: true, words }],
  [MU, { id: MU, kind: 'audio', durationMs: 30000, hasAudio: true }],
]);
const parse = (b: object) => EditRequestSchema.parse(b);

// -------------------------------------------------------------------------------------------
describe('speech (pure)', () => {
  it('parseWhisper: words with timings, trimmed, bad entries dropped', () => {
    const t = parseWhisper({
      text: ' Hi there. ',
      transcription_info: { language: 'en', duration: 2.0 },
      segments: [{ words: [{ word: ' Hi', start: 0, end: 0.3 }, { word: ' ', start: 0.3, end: 0.4 }, { word: ' there.', start: 0.5, end: 0.4 }, { word: 'ok', start: 0.6, end: 0.9 }] }],
    });
    expect(t).toEqual({ language: 'en', text: 'Hi there.', words: [{ w: 'Hi', s: 0, e: 0.3 }, { w: 'ok', s: 0.6, e: 0.9 }], durationS: 2 });
    expect(() => parseWhisper(undefined)).toThrow(ProviderError);
  });

  it('cloudflare: maps HTTP errors to retryable/permanent with user-safe messages; never logs the token', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fake = (status: number, body: BodyInit = '{}') =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response(body, { status, headers: { 'content-type': status === 200 ? 'audio/mpeg' : 'application/json' } });
      }) as typeof fetch;
    const sp = (status: number, body?: BodyInit) => createCloudflareSpeech({ accountId: 'acc', apiToken: 'tok', fetchImpl: fake(status, body) });
    await expect(sp(429).speak('hi', 'luna')).rejects.toMatchObject({ retryable: true, userMessage: expect.stringMatching(/daily AI quota/) });
    await expect(sp(500).transcribe(Buffer.from('x'))).rejects.toMatchObject({ retryable: true });
    await expect(sp(400).speak('hi', 'luna')).rejects.toMatchObject({ retryable: false, userMessage: 'Voice-over failed.' });
    const ok = await sp(200, new Uint8Array(500)).speak('hi', 'luna');
    expect(ok.mimeType).toBe('audio/mpeg');
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/deepgram/aura-2-en');
    expect(calls[0]!.auth).toBe('Bearer tok');
  });

  it('chunkScript: sentences grouped under the limit; long sentences split on commas/spaces; danda counts', () => {
    expect(chunkScript('  ')).toEqual([]);
    expect(chunkScript('One. Two! Three?', 10)).toEqual(['One. Two!', 'Three?']);
    expect(chunkScript('नमस्ते दोस्तों। आज गोवा।', 15)).toEqual(['नमस्ते दोस्तों।', 'आज गोवा।']);
    const long = chunkScript('alpha beta gamma, delta epsilon zeta eta theta', 20);
    expect(long.every((c) => c.length <= 20)).toBe(true);
    expect(long.join(' ')).toBe('alpha beta gamma, delta epsilon zeta eta theta');
  });

  it('pricing: TTS 1 credit / 500 chars, STT 1 credit / started minute', () => {
    expect([1, 500, 501, 3000].map(ttsCost)).toEqual([1, 1, 2, 6]);
    expect([1, 60_000, 60_001, 600_000].map(sttCost)).toEqual([1, 1, 2, 10]);
  });
});

describe('ASS captions (pure)', () => {
  it('colours, times, and escaping: user text cannot inject override tags or escapes', () => {
    expect(assColor('#facc15')).toBe('&H0015CCFA');
    expect(assColor('#000000', 0x4d)).toBe('&H4D000000');
    expect(assTime(3725.456)).toBe('1:02:05.46');
    expect(assEscape('{\\b1}hi\\N\nnext')).toBe('\\{\\\u2060b1\\}hi\\\u2060N\\Nnext');
  });

  it('groupWords: ≤ N words, break on sentence end / pause, lines stay up across small gaps', () => {
    const lines = groupWords(words, { maxWords: 3 });
    expect(lines.map((l) => l.words.map((w) => w.w).join(' '))).toEqual(['Welcome to Goa.', 'Day one']);
    expect(lines[0]!.endS).toBe(1.4); // held until the next line (gap 0.3 s)
  });

  it('karaoke: one dialogue per line, \\k durations in centiseconds cover gaps', () => {
    const ass = buildAss(1080, 1920, [], { lines: groupWords(words, { maxWords: 3 }), y: 0.7, size: 76, color: '#ffffff', highlight: '#facc15', style: 'outline' });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('{\\an5\\pos(540,1344)}{\\k50}Welcome {\\k20}to {\\k70}Goa.');
    expect(ass).toMatch(/Dialogue: 1,0:00:01\.40,0:00:02\.00,K,.*\{\\k30\}Day \{\\k30\}one/);
  });

  it('spec -> ass: captions (fade/slide), karaoke at output time, card titles; null when no text', () => {
    const spec = normaliseEdit(
      parse({
        format: '9:16',
        clips: [{ card: { title: 'Goa', subtitle: 'नमस्ते' }, durationS: 1 }, { uploadId: IMG, durationS: 3 }],
        texts: [{ text: 'Hello {x}', startS: 1, endS: 2, anim: 'slide' }],
        audio: [{ uploadId: VO, atS: 1 }],
        autoCaptions: { uploadId: VO },
      }),
      infos,
    );
    const ass = specToAss(spec)!;
    expect(ass).toContain('\\fad(350,350)}Hello \\{x\\}');
    expect(ass).toContain('\\move(540,1709,540,1632,0,350)'); // y 0.85 of 1920, rising 4%
    expect(ass).toContain('Goa\\N{\\fs49\\alpha&H26&}नमस्ते');
    expect(ass).toMatch(/Dialogue: 1,0:00:01\.00,.*\{\\k50\}Welcome/); // word times shifted by atS = 1
    expect(specToAss(normaliseEdit(parse({ clips: [{ uploadId: IMG }] }), infos))).toBeNull();
  });
});

describe('edit spec v3: audio + auto captions (pure)', () => {
  it('audio tracks are placed, trimmed to the video, and checked', () => {
    const spec = normaliseEdit(parse({ clips: [{ uploadId: IMG, durationS: 6 }], audio: [{ uploadId: VO, atS: 1 }, { uploadId: MU, duck: true, volume: 0.5 }] }), infos);
    expect(spec.audio).toEqual([
      { uploadId: VO, atS: 1, startS: 0, lengthS: 2.5, volume: 1, duck: false },
      { uploadId: MU, atS: 0, startS: 0, lengthS: 6, volume: 0.5, duck: true }, // 30 s music cut to the 6 s video
    ]);
    const bad = (b: object, re: RegExp) => expect(() => normaliseEdit(parse(b), infos)).toThrow(re);
    bad({ clips: [{ uploadId: IMG }], audio: [{ uploadId: IMG }] }, /has no sound/);
    bad({ clips: [{ uploadId: IMG }], audio: [{ uploadId: VO, atS: 5 }] }, /starts after the video ends/);
    bad({ clips: [{ uploadId: VO }] }, /audio files go on the audio track/);
  });

  it('video clips keep their sound (volume) only if they have one', () => {
    const noSound = new Map(infos);
    noSound.set(VID, { ...infos.get(VID)!, hasAudio: false });
    expect((normaliseEdit(parse({ clips: [{ uploadId: VID, volume: 0.7 }] }), infos).clips[0] as { volume: number }).volume).toBe(0.7);
    expect((normaliseEdit(parse({ clips: [{ uploadId: VID, volume: 0.7 }] }), noSound).clips[0] as { volume: number }).volume).toBe(0);
  });

  it('auto captions from a video clip: only words inside the trim, shifted to output time', () => {
    const spec = normaliseEdit(
      parse({ clips: [{ uploadId: IMG, durationS: 2 }, { uploadId: VID, trimStartS: 1, trimEndS: 3 }], autoCaptions: { uploadId: VID } }),
      infos,
    );
    expect(spec.autoCaptions!.words).toEqual([{ w: 'clip', s: 2.2, e: 2.5 }]); // 'talk' (4.5 s) was trimmed away
  });

  it('auto captions need a transcript and the file on the timeline', () => {
    const bad = (b: object, re: RegExp) => expect(() => normaliseEdit(parse(b), infos)).toThrow(re);
    bad({ clips: [{ uploadId: IMG }], autoCaptions: { uploadId: MU } }, /no transcript yet/);
    bad({ clips: [{ uploadId: IMG }], autoCaptions: { uploadId: VO } }, /add that file to the video or the audio track/);
  });
});

describe('audio graph (pure)', () => {
  it('no sound anywhere -> no audio output (silent MP4 as before)', () => {
    const spec = normaliseEdit(parse({ clips: [{ uploadId: IMG }] }), infos);
    expect(audioGraph(spec, 0)).toEqual({ chains: [], out: null });
    expect(buildEditArgs(spec, { clipFiles: ['/a'], textFiles: [], cardFiles: [], fontFile: '/f', output: '/o' })).toContain('-an');
  });

  it('voice + ducked music + clip sound: placed, side-chained, mixed, limited, exact length', () => {
    const spec = normaliseEdit(
      parse({ clips: [{ uploadId: IMG, durationS: 2 }, { uploadId: VID, trimStartS: 1, trimEndS: 4, volume: 0.6 }], audio: [{ uploadId: VO, atS: 1 }, { uploadId: MU, duck: true, volume: 0.8 }] }),
      infos,
    );
    const g = audioGraph(spec, 2);
    const all = g.chains.join(';');
    expect(g.out).toBe('aout');
    expect(all).toContain('[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start=0:duration=3,asetpts=PTS-STARTPTS,volume=0.6,adelay=2000:all=1,apad=whole_dur=5[ca1]');
    expect(all).toContain('[2:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start=0:duration=2.5,asetpts=PTS-STARTPTS,volume=1,adelay=1000:all=1');
    expect(all).toContain('[ca1k][ta0k]amix=inputs=2:normalize=0[key]');
    expect(all).toContain('[ta1][key]sidechaincompress=threshold=0.005:ratio=20');
    expect(all).toContain('[ca1m][ta0m][ta1d]amix=inputs=3:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled,atrim=duration=5[aout]');
    const args = buildEditArgs(spec, { clipFiles: ['/a', '/v'], audioFiles: ['/vo', '/mu'], textFiles: [], cardFiles: [], fontFile: '/f', output: '/o' });
    expect(args.join(' ')).toContain('-i /vo -i /mu');
    expect(args.join(' ')).toContain('-map [aout] -c:a aac -b:a 160k -ar 48000');
    expect(args).not.toContain('-an');
  });

  it('libass captions replace drawtext when an .ass file is given', () => {
    const spec = normaliseEdit(parse({ clips: [{ uploadId: IMG }], texts: [{ text: 'x', startS: 0, endS: 1 }] }), infos);
    const fg = buildEditArgs(spec, { clipFiles: ['/a'], textFiles: [['/t']], cardFiles: [], assFile: '/c.ass', fontsDir: '/fonts', fontFile: '/f', output: '/o' }).join(' ');
    expect(fg).toContain("ass='/c.ass':fontsdir='/fonts'");
    expect(fg).not.toContain('drawtext');
  });
});

describe('probe: audio files and video sound tracks (pure)', () => {
  const j = (streams: object[], format: object = {}) => JSON.stringify({ streams, format });
  it('audio accepted with length; videos report whether they have sound', () => {
    expect(interpretProbe(j([{ codec_type: 'audio', codec_name: 'mp3' }], { duration: '3.5' }), 'audio/mpeg')).toEqual({
      kind: 'audio', width: 0, height: 0, durationMs: 3500, codec: 'mp3', hasAudio: true,
    });
    expect(interpretProbe(j([{ codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }, { codec_type: 'audio', codec_name: 'aac' }], { duration: '1' }), 'video/mp4').hasAudio).toBe(true);
    expect(interpretProbe(j([{ codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }], { duration: '1' }), 'video/mp4').hasAudio).toBe(false);
    expect(() => interpretProbe(j([{ codec_type: 'video', codec_name: 'png', width: 2, height: 2 }]), 'audio/mpeg')).toThrow(/Not a recognised audio/);
  });
});

// -------------------------------------------------------------------------------------------
async function newUser(app: ReturnType<typeof createApp>) {
  const email = `a${Math.random()}@example.com`;
  const cookie = cookieOf(await request(app).post('/auth/register').send({ email, password: 'password-123' }));
  return { cookie, user: await prisma.user.findUniqueOrThrow({ where: { email } }) };
}
const balance = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).credits;
const ledgerSum = async (id: string) => (await prisma.creditTransaction.aggregate({ where: { userId: id }, _sum: { delta: true } }))._sum.delta;

describe.runIf(hasFfmpeg)('voice-over API (stub voice, real ffmpeg + storage)', () => {
  const app = createApp({ prisma, config: testConfig, queue: fakeQueue(), storage, speech: createStubSpeech() });

  it('script -> MP3 in the library (READY, TTS, has sound, real length), charged by length', async () => {
    const { cookie, user } = await newUser(app);
    const script = 'Welcome to Goa. Day one, we hit the beach at sunrise. ' + 'More words here. '.repeat(40);
    const res = await request(app).post('/voiceovers').set('Cookie', cookie).send({ script, voice: 'luna', title: 'Goa intro' }).expect(201);
    expect(res.body.upload).toMatchObject({ status: 'READY', kind: 'audio', source: 'TTS', voice: 'luna', mimeType: 'audio/mpeg', hasAudio: true, fileName: 'Goa intro.mp3' });
    expect(res.body.upload.durationMs).toBeGreaterThan(5000);
    expect(await balance(user.id)).toBe(50 - ttsCost(script.trim().length));
    const mp3 = Buffer.from(await (await fetch(res.body.upload.url)).arrayBuffer());
    expect(mp3.length).toBeGreaterThan(1000);
    expect((await request(app).get('/uploads?type=audio').set('Cookie', cookie)).body.items).toHaveLength(1);
    const cfg = await request(app).get('/audio/config').expect(200);
    expect(cfg.body.voices.map((v: { id: string }) => v.id)).toContain('luna');
  });

  it('provider failure -> 502 + full refund, no file left behind', async () => {
    const broken: SpeechProvider = {
      ...createStubSpeech(),
      speak: () => Promise.reject(new ProviderError('down', { retryable: true, userMessage: 'Voice-over is temporarily unavailable.' })),
    };
    const app2 = createApp({ prisma, config: testConfig, queue: fakeQueue(), storage, speech: broken });
    const { cookie, user } = await newUser(app2);
    const r = await request(app2).post('/voiceovers').set('Cookie', cookie).send({ script: 'Hello there.', voice: 'luna' }).expect(502);
    expect(r.body.error).toMatch(/refunded/);
    expect(await balance(user.id)).toBe(50);
    expect(await ledgerSum(user.id)).toBe(50);
    expect(await prisma.upload.count({ where: { userId: user.id } })).toBe(0);
  });

  it('validation: empty/too long script, unknown voice, no credits, auth', async () => {
    const { cookie, user } = await newUser(app);
    const post = (b: object) => request(app).post('/voiceovers').set('Cookie', cookie).send(b);
    expect((await post({ script: '   ', voice: 'luna' })).status).toBe(400);
    expect((await post({ script: 'x'.repeat(3001), voice: 'luna' })).status).toBe(400);
    expect((await post({ script: 'hi', voice: 'nobody' })).status).toBe(400);
    await prisma.user.update({ where: { id: user.id }, data: { credits: 0 } });
    expect((await post({ script: 'hi', voice: 'luna' })).status).toBe(402);
    await request(app).post('/voiceovers').send({ script: 'hi', voice: 'luna' }).expect(401);
  });
});

describe('transcription: credits + state (fake queue, stub speech)', () => {
  const queue = fakeQueue();
  const enqueued: string[] = [];
  const app = createApp({ prisma, config: testConfig, queue: { ...queue, enqueueTranscription: async (id: string) => void enqueued.push(id) }, storage, speech: createStubSpeech() });
  const deps = (speech: SpeechProvider = createStubSpeech()) => ({ prisma, storage, speech, logger: silentLogger });

  async function soundFile(userId: string, opts: { source?: 'UPLOAD' | 'TTS'; hasAudio?: boolean; durationMs?: number } = {}) {
    const key = `uploads/${userId}/${Math.random()}.wav`;
    await storage.put(key, wavTone(2), 'audio/wav');
    return prisma.upload.create({
      data: {
        userId, status: 'READY', storageKey: key, fileName: 'a.wav', mimeType: 'audio/wav', bytes: 10,
        durationMs: opts.durationMs ?? 90_000, hasAudio: opts.hasAudio ?? true, source: opts.source ?? 'UPLOAD',
        ...(opts.source === 'TTS' ? { script: 'hi', voice: 'luna' } : {}),
      },
    });
  }

  it('request: 202, PENDING, 2 credits for 90 s reserved, enqueued once; repeat requests are no-ops', async () => {
    const { cookie, user } = await newUser(app);
    const u = await soundFile(user.id);
    const r = await request(app).post(`/uploads/${u.id}/transcribe`).set('Cookie', cookie).send({ language: 'hi' }).expect(202);
    expect(r.body).toEqual({ status: 'PENDING', cost: 2 });
    await request(app).post(`/uploads/${u.id}/transcribe`).set('Cookie', cookie).send({}).expect(202);
    expect(await balance(user.id)).toBe(48);
    expect(enqueued.filter((x) => x === u.id)).toHaveLength(1);
    const row = await prisma.upload.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({ transcriptStatus: 'PENDING', transcriptCost: 2, transcript: { language: 'hi' } });
  });

  it('voice-overs are transcribed free; silent files, other users and bad ids are refused', async () => {
    const { cookie, user } = await newUser(app);
    const tts = await soundFile(user.id, { source: 'TTS' });
    expect((await request(app).post(`/uploads/${tts.id}/transcribe`).set('Cookie', cookie).expect(202)).body.cost).toBe(0);
    expect(await balance(user.id)).toBe(50);
    const silent = await soundFile(user.id, { hasAudio: false });
    expect((await request(app).post(`/uploads/${silent.id}/transcribe`).set('Cookie', cookie).expect(400)).body.error).toMatch(/no sound/);
    const other = await newUser(app);
    await request(app).post(`/uploads/${tts.id}/transcribe`).set('Cookie', other.cookie).expect(404);
    await request(app).post('/uploads/nope/transcribe').set('Cookie', cookie).expect(404);
  });

  it('worker: extract audio -> transcribe -> DONE with words; GET /uploads/:id returns them', async () => {
    const { cookie, user } = await newUser(app);
    const u = await soundFile(user.id);
    await requestTranscription(prisma, async () => {}, user.id, u.id);
    expect(await processTranscription(u.id, { attempt: 1, maxAttempts: 3 }, deps())).toBe('done');
    const { body } = await request(app).get(`/uploads/${u.id}`).set('Cookie', cookie).expect(200);
    expect(body.upload.transcriptStatus).toBe('DONE');
    expect(body.upload.transcript.words.length).toBeGreaterThan(2); // stub: a word per 0.4 s of the 2 s tone
    expect(await processTranscription(u.id, { attempt: 1, maxAttempts: 3 }, deps())).toBe('skipped'); // already done
  });

  it('failure: retried, then FAILED + exactly one refund; a new request after that works and charges again', async () => {
    const { user } = await newUser(app);
    const u = await soundFile(user.id);
    await requestTranscription(prisma, async () => {}, user.id, u.id);
    const boom: SpeechProvider = { ...createStubSpeech(), transcribe: () => Promise.reject(new Error('socket hang up')) };
    expect(await processTranscription(u.id, { attempt: 1, maxAttempts: 2 }, deps(boom))).toBe('retry');
    expect(await processTranscription(u.id, { attempt: 2, maxAttempts: 2 }, deps(boom))).toBe('failed');
    expect(await failTranscription(prisma, u.id, 'again')).toBe(false); // second refund impossible
    expect(await balance(user.id)).toBe(50);
    expect(await ledgerSum(user.id)).toBe(50);
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: u.id } })).transcriptError).toBe('Transcription failed.');

    await requestTranscription(prisma, async () => {}, user.id, u.id);
    expect(await balance(user.id)).toBe(48);
    expect(await processTranscription(u.id, { attempt: 2, maxAttempts: 2 }, deps(boom))).toBe('failed');
    expect(await balance(user.id)).toBe(50); // the second attempt is refunded too (its own ref)
  });

  it('queue down -> immediate refund + 503; sweeper refunds stuck PENDING once', async () => {
    const down = createApp({ prisma, config: testConfig, queue: { ...queue, enqueueTranscription: () => Promise.reject(new Error('redis')) }, storage });
    const { cookie, user } = await newUser(down);
    const u = await soundFile(user.id);
    await request(down).post(`/uploads/${u.id}/transcribe`).set('Cookie', cookie).expect(503);
    expect(await balance(user.id)).toBe(50);

    await requestTranscription(prisma, async () => {}, user.id, u.id);
    expect(await sweepStuckTranscriptions(prisma, 10)).toBe(0);
    expect(await sweepStuckTranscriptions(prisma, 10, new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(await sweepStuckTranscriptions(prisma, 10, new Date(Date.now() + 11 * 60_000))).toBe(0);
    expect(await balance(user.id)).toBe(50);
  });
});

// -------------------------------------------------------------------------------------------
describe.runIf(hasFfmpeg)('END-TO-END: voice-over + karaoke captions + ducked music + clip sound -> one MP4', () => {
  const queue = makeRealQueue();
  const workerConn = createRedis(TEST_REDIS_URL, 'worker');
  const speech = createStubSpeech();
  let running: ReturnType<typeof startGenerationWorker>;
  const app = createApp({ prisma, config: testConfig, queue, storage, speech });

  beforeAll(async () => {
    await queue.queue.obliterate({ force: true });
    running = startGenerationWorker({
      prisma, connection: workerConn, provider: createStubProvider(0), editor: createEditRenderer(), speech, storage,
      logger: silentLogger, metrics: createMetrics(), concurrency: 2, maxAttempts: 2, jobTimeoutMinutes: 10,
    });
  });
  afterAll(async () => {
    await running.close();
    await queue.close();
    workerConn.disconnect();
  });

  async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 60_000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (done(v)) return v;
      if (Date.now() > end) throw new Error('timeout');
      await sleep(150);
    }
  }

  it('renders with an AAC track; the transcript drives word-by-word captions', async () => {
    const { cookie, user } = await newUser(app);
    // A video WITH sound, uploaded like the browser does.
    const vid = path.join(dir, 'talk.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=f=500:d=4', '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', vid]);
    const buf = await readFile(vid);
    const created = await request(app).post('/uploads').set('Cookie', cookie).send({ fileName: 'talk.mp4', mimeType: 'video/mp4', bytes: buf.length }).expect(201);
    const form = new FormData();
    for (const [k, v] of Object.entries(created.body.post.fields as Record<string, string>)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'video/mp4' }));
    expect((await fetch(created.body.post.url, { method: 'POST', body: form })).status).toBe(204);
    const clip = (await request(app).post(`/uploads/${created.body.upload.id}/complete`).set('Cookie', cookie).expect(200)).body.upload;
    expect(clip.hasAudio).toBe(true);

    const music = path.join(dir, 'music.wav');
    await writeFile(music, wavTone(8));
    const vo = (await request(app).post('/voiceovers').set('Cookie', cookie).send({ script: 'Welcome to Goa. Day one at the beach.', voice: 'luna' }).expect(201)).body.upload;
    await request(app).post(`/uploads/${vo.id}/transcribe`).set('Cookie', cookie).expect(202);
    const done = await poll(
      async () => (await request(app).get(`/uploads/${vo.id}`).set('Cookie', cookie)).body.upload,
      (u) => u.transcriptStatus === 'DONE' || u.transcriptStatus === 'FAILED',
    );
    expect(done.transcriptStatus).toBe('DONE');

    const { body } = await request(app)
      .post('/edits')
      .set('Cookie', cookie)
      .send({
        format: '9:16',
        clips: [{ card: { title: 'Goa', subtitle: 'नमस्ते' }, durationS: 1 }, { uploadId: clip.id, volume: 0.5 }],
        audio: [{ uploadId: vo.id, atS: 0.5 }],
        autoCaptions: { uploadId: vo.id },
      })
      .expect(202);
    expect(body.job.edit.autoCaptions.words.length).toBeGreaterThan(0);
    const job = await poll(
      async () => (await request(app).get(`/jobs/${body.job.id}`).set('Cookie', cookie)).body.job,
      (j) => j.status === 'DONE' || j.status === 'FAILED',
      90_000,
    );
    expect(job.error).toBeNull();
    const out = path.join(dir, 'e2e-audio.mp4');
    await writeFile(out, Buffer.from(await (await fetch(job.asset.url)).arrayBuffer()));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', out]).toString());
    expect(probe.streams.map((s: { codec_type: string; codec_name: string }) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(['audio:aac', 'video:h264']);
    expect((await probeMedia(out, 'video/mp4')).hasAudio).toBe(true);
    expect(user.id).toBeTruthy();
  }, 150_000);
});
