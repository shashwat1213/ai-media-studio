import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { cookieOf, fakeQueue, makeTestStorage, prisma, resetDb, testConfig } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { createStubSpeech } from '../audio/speech.js';
import { EditRequestSchema, normaliseEdit, type UploadInfo } from '../editor/edit-spec.js';
import type { PublicItem } from '../library/library.js';
import { createStubDirector, type DirectorModel } from './director.js';
import { alignCaptionWords, buildDraft, shotLength, faceCharacterFor, imagePromptFor, pickSound, produceScene, shotStarts, type SceneScript } from './scene.js';
import { failAndRefund, SCENE_COST, sceneCost, SCENE_AI_MOTION_EXTRA, SCENE_HD_EXTRA } from './scenes.routes.js';
import { picturesFromEnv } from './index.js';
import type { PictureEngine, PictureRequest } from './local-ai.js';
import type { SharedEnv } from '../../config/env.js';
import { ProviderError } from '../generation/providers/types.js';

const storage = makeTestStorage();
beforeAll(() => storage.ensureBucket());
beforeEach(resetDb);
afterAll(async () => {
  storage.destroy();
  await prisma.$disconnect();
});
const log = pino({ level: 'silent' });

const item = (handle: string, kind: PublicItem['kind'], description: string, settings: Record<string, unknown> = {}): PublicItem => ({
  id: handle, kind, handle, name: handle, description, settings, imageUploadId: null, createdAt: new Date(0), updatedAt: new Date(0),
});
const shot = (o: Partial<SceneScript['shots'][number]> = {}) => ({ visual: 'walking', camera: 'zoomin' as const, durationS: 4, narration: '', roman: '', sound: '', onScreen: '', uses: [], ...o });

describe('scene (pure)', () => {
  it('picture prompt: character first, then place, then the action and style; character seed kept', () => {
    const lib = [item('goa', 'PLACE', 'goa beach'), item('riya', 'CHARACTER', 'woman, yellow kurta', { seed: 42 }), item('look', 'STYLE', '', { promptSuffix: 'film grain', negative: 'cartoon' })];
    const p = imagePromptFor(shot({ visual: 'smiling at the sea', uses: ['goa', 'riya'] }), lib);
    expect(p.prompt).toBe('woman, yellow kurta, goa beach, smiling at the sea, film grain');
    expect(p.seed).toBe(42);
    expect(p.negative).toMatch(/^cartoon, lowres/);
    expect(imagePromptFor(shot(), []).prompt).toBe('walking, cinematic photo, highly detailed, sharp focus');
  });

  it('pickSound: best tag overlap with the descriptions + mood; music preferred on ties; needs a file', () => {
    const sounds = [
      item('rain', 'SOUND', 'rain on a tin roof', { uploadId: 'u1', tags: ['rain', 'monsoon'], role: 'ambience' }),
      item('lofi', 'SOUND', 'calm lofi beat', { uploadId: 'u2', tags: ['calm', 'cozy'], role: 'music' }),
      item('nofile', 'SOUND', 'rain rain rain', { tags: ['rain'] }),
    ];
    expect(pickSound('light rain, distant traffic', 'nostalgic', sounds)?.handle).toBe('rain');
    expect(pickSound('soft breeze', 'calm', sounds)?.handle).toBe('lofi');
    expect(pickSound('explosions', 'epic', sounds)).toBeNull();
  });

  it('captions use the SCRIPT words (not what whisper misheard), timed by what was heard', () => {
    const heard = [
      { w: 'सूरत', s: 0.3, e: 0.7 }, // misheard सूरज
      { w: 'डूब', s: 0.8, e: 1.1 },
      { w: 'रहा', s: 1.1, e: 1.3 },
      { w: 'है', s: 1.3, e: 1.5 },
    ];
    // Same word count -> 1:1 timings, script spelling.
    expect(alignCaptionWords([{ text: 'सूरज डूब रहा है', startS: 0.2, endS: 1.6 }], heard).map((w) => w.w)).toEqual(['सूरज', 'डूब', 'रहा', 'है']);
    expect(alignCaptionWords([{ text: 'Suraj doob raha hai', startS: 0.2, endS: 1.6 }], heard)[0]).toEqual({ w: 'Suraj', s: 0.3, e: 0.7 });
    // Different count -> the heard window split by word length, in order, no gaps.
    const split = alignCaptionWords([{ text: 'Sun is setting', startS: 0.2, endS: 1.6 }], heard);
    expect(split.map((w) => w.w)).toEqual(['Sun', 'is', 'setting']);
    expect(split[0]!.s).toBe(0.3);
    expect(split[2]!.e).toBeCloseTo(1.5, 3);
    // Nothing heard in that shot -> the shot's own voice window.
    expect(alignCaptionWords([{ text: 'a b', startS: 5, endS: 6 }], heard)).toEqual([{ w: 'a', s: 5, e: 5.5 }, { w: 'b', s: 5.5, e: 6 }]);
  });

  it('draft: shots long enough for their narration, overlapped by the crossfade, texts placed inside', () => {
    const script: SceneScript = {
      title: 'T', mood: 'calm', language: 'hi', format: '9:16',
      shots: [shot({ imageUploadId: 'a', voiceS: 5, onScreen: 'Hi' }), shot({ imageUploadId: 'b', camera: 'static' }), shot({ /* failed picture */ })],
    };
    expect(shotStarts(script)).toEqual([0, 5.1, 8.6]);
    const d = buildDraft(script);
    expect(d.clips).toEqual([
      { uploadId: 'a', durationS: 5.6, fit: 'cover', motion: 'zoom-in' },
      { uploadId: 'b', durationS: 4, fit: 'cover', motion: 'none' },
    ]);
    expect(d.texts).toEqual([expect.objectContaining({ text: 'Hi', startS: 0.3, endS: 5.2 })]);
  });
});

// -------------------------------------------------------------------------------------------
// The same stub the worker uses without a local AI (honours `upscale` by returning the HD size).
const stubPictures: PictureEngine = picturesFromEnv({} as SharedEnv);
const deps = (director: DirectorModel = createStubDirector(), pictures: PictureEngine = stubPictures) => ({ prisma, storage, director, pictures, speech: createStubSpeech(), logger: log });

async function userWithLibrary() {
  const u = await prisma.user.create({ data: { email: `s${Math.random()}@example.com`, passwordHash: 'x', credits: 50 } });
  await prisma.libraryItem.createMany({
    data: [
      { userId: u.id, kind: 'CHARACTER', handle: 'riya', name: 'Riya', description: 'woman, yellow kurta', settings: { seed: 7 } },
      { userId: u.id, kind: 'VOICE', handle: 'narrator', name: 'N', description: '', settings: { engine: 'aura', voice: 'luna', language: 'en' } },
    ],
  });
  return u;
}

describe('produceScene (stub engines, real DB + storage + ffmpeg)', () => {
  it('plan -> pictures + voice per shot -> one narration track with captions -> a draft the editor accepts', async () => {
    const u = await userWithLibrary();
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya walks. She smiles. Sunset.', language: 'en', format: '9:16', targetS: 12, voice: 'narrator' } });
    expect(await produceScene(s.id, deps())).toBe('ready');
    const done = await prisma.scene.findUniqueOrThrow({ where: { id: s.id } });
    expect(done).toMatchObject({ status: 'READY', progress: null, error: null });
    const script = done.script as unknown as SceneScript;
    expect(script.shots).toHaveLength(3);
    for (const sh of script.shots) expect(sh).toMatchObject({ imageUploadId: expect.any(String), voiceUploadId: expect.any(String) });
    expect(script.shots[0]!.imagePrompt).toMatch(/^woman, yellow kurta, cinematic still of @riya walks/);

    const uploads = await prisma.upload.findMany({ where: { userId: u.id } });
    expect(uploads.filter((x) => x.source === 'AI_IMAGE')).toHaveLength(3);
    const narration = uploads.find((x) => x.fileName.endsWith('narration.mp3'))!;
    expect(narration).toMatchObject({ transcriptStatus: 'DONE', hasAudio: true, voice: 'luna' });

    // The draft must pass the editor's own validation against the user's real uploads.
    const draft = done.draft as Record<string, unknown>;
    const infos = new Map<string, UploadInfo>(
      uploads.map((x) => [x.id, { id: x.id, kind: x.mimeType.startsWith('audio/') ? 'audio' : 'image', durationMs: x.durationMs, hasAudio: x.hasAudio, words: (x.transcript as { words?: UploadInfo['words'] } | null)?.words ?? null }]),
    );
    const spec = normaliseEdit(EditRequestSchema.parse(draft), infos);
    expect(spec.clips).toHaveLength(3);
    expect(spec.audio).toHaveLength(1);
    expect(spec.autoCaptions?.words.length).toBeGreaterThan(0);
    expect(spec.format).toBe('9:16');

    expect(await produceScene(s.id, deps())).toBe('skipped'); // already READY
  }, 60_000);

  it('HD scene: every picture is requested upscaled and stored at its REAL (HD) size; the draft still validates', async () => {
    const u = await userWithLibrary();
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya walks. She smiles.', language: 'en', format: '9:16', targetS: 8, voice: 'narrator', hd: true } });
    const asked: PictureRequest[] = [];
    const spy: PictureEngine = { name: 'spy', picture: (r) => (asked.push(r), stubPictures.picture(r)) };
    expect(await produceScene(s.id, deps(createStubDirector(), spy))).toBe('ready');
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) expect(r).toMatchObject({ width: 512, height: 768, upscale: true });
    const pics = await prisma.upload.findMany({ where: { userId: u.id, source: 'AI_IMAGE' } });
    expect(pics).toHaveLength(asked.length);
    for (const x of pics) expect(x).toMatchObject({ width: 1280, height: 1920 });
    const done = await prisma.scene.findUniqueOrThrow({ where: { id: s.id } });
    const uploads = await prisma.upload.findMany({ where: { userId: u.id } });
    const infos = new Map<string, UploadInfo>(
      uploads.map((x) => [x.id, { id: x.id, kind: x.mimeType.startsWith('audio/') ? 'audio' : 'image', durationMs: x.durationMs, hasAudio: x.hasAudio, words: (x.transcript as { words?: UploadInfo['words'] } | null)?.words ?? null }]),
    );
    expect(normaliseEdit(EditRequestSchema.parse(done.draft), infos).clips.length).toBe(asked.length);
  }, 60_000);

  it('face reference: shots with a consented CHARACTER photo get its bytes; others and other users\' photos do not', async () => {
    const u = await userWithLibrary();
    const png = await (await stubPictures.picture({ prompt: 'face', width: 64, height: 64 })).data;
    const key = `uploads/${u.id}/face.png`;
    await storage.put(key, png, 'image/png');
    const face = await prisma.upload.create({ data: { userId: u.id, status: 'READY', storageKey: key, fileName: 'face.png', mimeType: 'image/png', bytes: png.length } });
    await prisma.libraryItem.updateMany({ where: { userId: u.id, handle: 'riya' }, data: { imageUploadId: face.id, settings: { seed: 7, faceRef: true, faceConsent: 'ai_generated' } } });
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya walks. A sunset over the sea.', language: 'en', format: '9:16', targetS: 8, voice: 'narrator' } });
    const asked: PictureRequest[] = [];
    const spy: PictureEngine = { name: 'spy', picture: (r) => (asked.push(r), stubPictures.picture(r)) };
    // the stub director puts every mentioned handle on every shot
    expect(await produceScene(s.id, deps(createStubDirector(), spy))).toBe('ready');
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) expect(r.faceRef?.equals(png)).toBe(true);

    // pure rule: needs faceRef + consent + an image, and the character must be in the shot
    const base = { id: 'x', kind: 'CHARACTER' as const, handle: 'riya', name: 'R', description: '', imageUploadId: 'img', createdAt: new Date(0), updatedAt: new Date(0) };
    const sh = { visual: 'v', camera: 'static' as const, durationS: 3, narration: '', roman: '', sound: '', onScreen: '', uses: ['riya'] };
    expect(faceCharacterFor(sh, [{ ...base, settings: { faceRef: true, faceConsent: 'self' } }])?.handle).toBe('riya');
    expect(faceCharacterFor(sh, [{ ...base, settings: { faceRef: true } }])).toBeNull(); // no consent
    expect(faceCharacterFor(sh, [{ ...base, imageUploadId: null, settings: { faceRef: true, faceConsent: 'self' } }])).toBeNull();
    expect(faceCharacterFor({ ...sh, uses: [] }, [{ ...base, settings: { faceRef: true, faceConsent: 'self' } }])).toBeNull();

    // someone else's upload id smuggled into the library row -> no face sent
    const other = await prisma.user.create({ data: { email: `o${Math.random()}@example.com`, passwordHash: 'x', credits: 0 } });
    const theirs = await prisma.upload.create({ data: { userId: other.id, status: 'READY', storageKey: `uploads/${other.id}/f.png`, fileName: 'f.png', mimeType: 'image/png', bytes: 1 } });
    await prisma.libraryItem.updateMany({ where: { userId: u.id, handle: 'riya' }, data: { imageUploadId: theirs.id } });
    const s2 = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya smiles.', language: 'en', format: '1:1', targetS: 6, voice: 'narrator' } });
    asked.length = 0;
    expect(await produceScene(s2.id, deps(createStubDirector(), spy))).toBe('ready');
    expect(asked.every((r) => !r.faceRef)).toBe(true);
  }, 60_000);

  it('AI video scene: every shot gets a moving clip exactly its length, the draft uses the clips, a retry keeps them', async () => {
    const u = await userWithLibrary();
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya walks. A sunset over the sea.', language: 'en', format: '9:16', targetS: 8, voice: 'narrator', motion: 'ai' } });
    const clips: { prompt: string; seconds: number; refBytes: number }[] = [];
    const engine: PictureEngine = { ...stubPictures, name: 'spy', clip: (r, sig) => (clips.push({ prompt: r.prompt, seconds: r.seconds, refBytes: r.ref.length }), stubPictures.clip!(r, sig)) };
    expect(await produceScene(s.id, deps(createStubDirector(), engine))).toBe('ready');
    const done = await prisma.scene.findUniqueOrThrow({ where: { id: s.id } });
    const shots = (done.script as unknown as SceneScript).shots;
    expect(clips.length).toBe(shots.length);
    expect(clips.every((c) => c.refBytes > 0 && c.prompt.length > 0)).toBe(true);
    for (const sh of shots) {
      const v = await prisma.upload.findUniqueOrThrow({ where: { id: sh.videoUploadId! } });
      expect(v).toMatchObject({ userId: u.id, source: 'AI_VIDEO', mimeType: 'video/mp4', hasAudio: false });
      expect(Math.abs((v.durationMs ?? 0) / 1000 - shotLength(sh))).toBeLessThan(0.15); // the clip covers its shot
    }
    expect(clips.map((c) => c.seconds)).toEqual(shots.map((sh) => shotLength(sh)));
    const draftClips = (done.draft as { clips: { uploadId: string; trimEndS?: number; motion?: string }[] }).clips;
    expect(draftClips.map((c) => c.uploadId)).toEqual(shots.map((sh) => sh.videoUploadId));
    expect(draftClips.every((c) => c.motion === undefined && c.trimEndS! > 0)).toBe(true);

    // Resumable: fail it, retry -> the existing clips are reused, not re-made.
    await prisma.scene.update({ where: { id: s.id }, data: { status: 'PRODUCING', draft: Prisma.DbNull } });
    clips.length = 0;
    expect(await produceScene(s.id, deps(createStubDirector(), engine))).toBe('ready');
    expect(clips).toHaveLength(0);

    // still scenes never ask for clips
    const still = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya smiles.', language: 'en', format: '1:1', targetS: 6, voice: 'narrator' } });
    expect(await produceScene(still.id, deps(createStubDirector(), engine))).toBe('ready');
    expect(clips).toHaveLength(0);
  }, 90_000);

  it('AI video scene without a video engine fails with a clear message', async () => {
    const u = await userWithLibrary();
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya walks.', language: 'en', format: '9:16', targetS: 6, voice: 'narrator', motion: 'ai' } });
    const noClip: PictureEngine = { name: 'pics', picture: stubPictures.picture };
    expect(await produceScene(s.id, deps(createStubDirector(), noClip))).toBe('failed');
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s.id } })).error).toMatch(/AI video is not available/);
  });

  it('buildDraft: a shot with a moving clip uses the clip (trimmed to the shot), others keep the picture + camera move', () => {
    const base = { visual: 'v', camera: 'zoomin' as const, durationS: 3, narration: '', roman: '', sound: '', onScreen: '', uses: [] };
    const d = buildDraft({ title: 't', mood: 'calm', shots: [{ ...base, imageUploadId: 'img1', videoUploadId: 'vid1' }, { ...base, imageUploadId: 'img2' }] } as unknown as SceneScript);
    expect(d.clips).toEqual([
      { uploadId: 'vid1', trimStartS: 0, trimEndS: 3, fit: 'cover', volume: 0 },
      { uploadId: 'img2', durationS: 3, fit: 'cover', motion: 'zoom-in' },
    ]);
  });

  it('a fast (non-HD) scene never asks for an upscale', async () => {
    const u = await userWithLibrary();
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: '@riya walks.', language: 'en', format: '1:1', targetS: 6, voice: 'narrator' } });
    const asked: PictureRequest[] = [];
    const spy: PictureEngine = { name: 'spy', picture: (r) => (asked.push(r), stubPictures.picture(r)) };
    expect(await produceScene(s.id, deps(createStubDirector(), spy))).toBe('ready');
    expect(asked.every((r) => !r.upscale)).toBe(true);
  }, 60_000);

  it('a broken director -> FAILED with a user-safe message; retryable errors are rethrown for the queue', async () => {
    const u = await userWithLibrary();
    const s = await prisma.scene.create({ data: { userId: u.id, prompt: 'anything', language: 'hi', format: '1:1', targetS: 10, voice: 'narrator' } });
    const flaky: DirectorModel = { name: 'x', complete: () => Promise.reject(new ProviderError('down', { retryable: true, userMessage: 'The local AI is not running.' })) };
    await expect(produceScene(s.id, deps(flaky))).rejects.toThrow(ProviderError);
    expect(await prisma.scene.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: 'FAILED', error: 'The local AI is not running.' });
  });
});

describe('scenes API', () => {
  const enqueued: string[] = [];
  const app = createApp({ prisma, config: testConfig, queue: { ...fakeQueue(), enqueueScene: async (id: string) => void enqueued.push(id) }, storage, speech: createStubSpeech() });
  async function login() {
    const email = `a${Math.random()}@example.com`;
    const cookie = cookieOf(await request(app).post('/auth/register').send({ email, password: 'password-123' }));
    return { cookie, user: await prisma.user.findUniqueOrThrow({ where: { email } }) };
  }

  it('create: validates, charges, enqueues; config lists voices; others cannot see it', async () => {
    const { cookie, user } = await login();
    const cfg = await request(app).get('/scenes/config').set('Cookie', cookie).expect(200);
    expect(cfg.body).toMatchObject({ cost: SCENE_COST, hdCost: sceneCost(true), localAi: { llm: false, image: false, upscale: false, faceRef: false, video: false } });
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'nobody' })).status).toBe(400);
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'x', voice: 'luna' })).status).toBe(400);
    const r = await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat in Goa', voice: 'luna', targetS: 15 }).expect(202);
    expect(r.body.scene).toMatchObject({ status: 'PLANNING', language: 'en', format: '9:16', targetS: 15 }); // auto: written in English
    expect(enqueued).toContain(r.body.scene.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(50 - SCENE_COST);

    const other = await login();
    await request(app).get(`/scenes/${r.body.scene.id}`).set('Cookie', other.cookie).expect(404);
    expect((await request(app).get('/scenes').set('Cookie', other.cookie)).body.items).toEqual([]);
    await request(app).delete(`/scenes/${r.body.scene.id}`).set('Cookie', cookie).expect(409); // still being made
  });

  it('at most 2 running scenes per user; not enough credits -> 402', async () => {
    const { cookie, user } = await login();
    for (let i = 0; i < 2; i++) await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: `scene ${i}`, voice: 'luna' }).expect(202);
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'third', voice: 'luna' })).status).toBe(429);
    await prisma.scene.updateMany({ where: { userId: user.id }, data: { status: 'FAILED' } });
    await prisma.user.update({ where: { id: user.id }, data: { credits: 1 } });
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'poor', voice: 'luna' })).status).toBe(402);
  });

  it('failure refunds exactly once; retry charges again and its failure is refunded too', async () => {
    const { cookie, user } = await login();
    const r = await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna' }).expect(202);
    const id = r.body.scene.id;
    expect(await failAndRefund(prisma, id, 'boom')).toBe(true);
    expect(await failAndRefund(prisma, id, 'boom')).toBe(false);
    const bal = async () => (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits;
    expect(await bal()).toBe(50);

    await request(app).post(`/scenes/${id}/retry`).set('Cookie', cookie).expect(202);
    expect(await bal()).toBe(50 - SCENE_COST);
    await request(app).post(`/scenes/${id}/retry`).set('Cookie', cookie).expect(409); // not FAILED any more
    expect(await failAndRefund(prisma, id, 'again')).toBe(true);
    expect(await bal()).toBe(50);
    const sum = await prisma.creditTransaction.aggregate({ where: { userId: user.id }, _sum: { delta: true } });
    expect(sum._sum.delta).toBe(50); // ledger == balance
    await request(app).delete(`/scenes/${id}`).set('Cookie', cookie).expect(204);
  });

  it('storyboard: a READY scene carries signed URLs for its own pictures only', async () => {
    const { cookie, user } = await login();
    const mine = await prisma.upload.create({ data: { userId: user.id, status: 'READY', storageKey: `uploads/${user.id}/a.png`, fileName: 'a.png', mimeType: 'image/png', bytes: 1, source: 'AI_IMAGE' } });
    const other = await login();
    const theirs = await prisma.upload.create({ data: { userId: other.user.id, status: 'READY', storageKey: `uploads/${other.user.id}/b.png`, fileName: 'b.png', mimeType: 'image/png', bytes: 1 } });
    const s = await prisma.scene.create({
      data: { userId: user.id, prompt: 'a test scene', language: 'en', format: '9:16', targetS: 10, voice: 'luna', status: 'FAILED', script: { title: 't', shots: [{ imageUploadId: mine.id }, { imageUploadId: theirs.id }] } },
    });
    const { body } = await request(app).get(`/scenes/${s.id}`).set('Cookie', cookie).expect(200);
    expect(Object.keys(body.scene.images)).toEqual([mine.id]); // a forged id in the script is not signed
    expect(body.scene.images[mine.id]).toMatch(/^http/);
    expect(body.scene).not.toHaveProperty('userId');
  });

  it('HD: refused (409, nothing charged) without the upscaler; with it, charged the HD price, and a retry charges HD again', async () => {
    const { cookie, user } = await login();
    const bal = async () => (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits;
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna', hd: true })).status).toBe(409);
    expect(await bal()).toBe(50);
    expect(await prisma.scene.count({ where: { userId: user.id } })).toBe(0);

    const hdApp = createApp({ prisma, config: testConfig, queue: { ...fakeQueue(), enqueueScene: async () => {} }, storage, speech: createStubSpeech(), localAi: async () => ({ llm: true, image: true, upscale: true, faceRef: true, video: true }) });
    const r = await request(hdApp).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna', hd: true }).expect(202);
    expect(r.body.scene).toMatchObject({ hd: true });
    expect(sceneCost(true)).toBeGreaterThan(SCENE_COST);
    expect(await bal()).toBe(50 - sceneCost(true));
    expect(await failAndRefund(prisma, r.body.scene.id, 'boom')).toBe(true);
    expect(await bal()).toBe(50); // the full HD price comes back
    await request(hdApp).post(`/scenes/${r.body.scene.id}/retry`).set('Cookie', cookie).expect(202);
    expect(await bal()).toBe(50 - sceneCost(true));
    const sum = await prisma.creditTransaction.aggregate({ where: { userId: user.id }, _sum: { delta: true } });
    expect(sum._sum.delta).toBe(await bal()); // ledger == balance
  });

  it('content policy: a sexual brief is refused (400) before anything is charged or queued', async () => {
    const { cookie, user } = await login();
    const r = await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a girl showing tits', voice: 'luna' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not make sexual or nude content/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(50);
    expect(await prisma.scene.count({ where: { userId: user.id } })).toBe(0);
  });

  it('AI video: refused (409, nothing charged) without the Wan models; with them charged the AI price; retry charges it again', async () => {
    const { cookie, user } = await login();
    const bal = async () => (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits;
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna', motion: 'ai' })).status).toBe(409);
    expect(await bal()).toBe(50);
    expect((await request(app).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna', motion: 'warp' })).status).toBe(400);
    const vidApp = createApp({ prisma, config: testConfig, queue: { ...fakeQueue(), enqueueScene: async () => {} }, storage, speech: createStubSpeech(), localAi: async () => ({ llm: true, image: true, upscale: false, faceRef: false, video: true }) });
    const r = await request(vidApp).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna', motion: 'ai' }).expect(202);
    expect(r.body.scene).toMatchObject({ motion: 'ai', hd: false });
    expect(sceneCost(false, 'ai')).toBe(SCENE_COST + SCENE_AI_MOTION_EXTRA);
    expect(await bal()).toBe(50 - sceneCost(false, 'ai'));
    expect(await failAndRefund(prisma, r.body.scene.id, 'boom')).toBe(true);
    expect(await bal()).toBe(50);
    await request(vidApp).post(`/scenes/${r.body.scene.id}/retry`).set('Cookie', cookie).expect(202);
    expect(await bal()).toBe(50 - sceneCost(false, 'ai'));
    // HD + AI video stack
    expect(sceneCost(true, 'ai')).toBe(SCENE_COST + SCENE_HD_EXTRA + SCENE_AI_MOTION_EXTRA);
    const cfg = await request(vidApp).get('/scenes/config').set('Cookie', cookie).expect(200);
    expect(cfg.body).toMatchObject({ aiMotionExtra: SCENE_AI_MOTION_EXTRA, localAi: { video: true } });
  });

  it('voice-over language: Auto follows the brief; the narrator always speaks that language', async () => {
    const bilingual = createApp({
      prisma, config: testConfig, queue: { ...fakeQueue(), enqueueScene: async () => {} }, storage,
      speech: { ...createStubSpeech(), voices: [...createStubSpeech().voices, { id: 'hi_IN-rohan-medium', name: 'Rohan', style: '', gender: 'male' as const }, { id: 'en_US-ryan-high', name: 'Ryan', style: '', gender: 'male' as const }] },
    });
    const email = `l${Math.random()}@example.com`;
    const cookie = cookieOf(await request(bilingual).post('/auth/register').send({ email, password: 'password-123' }));
    const make = async (body: object) => (await request(bilingual).post('/scenes').set('Cookie', cookie).send(body).expect(202)).body.scene;
    const clear = () => prisma.scene.updateMany({ where: { user: { email } }, data: { status: 'FAILED' } });

    // asked for English in a Hinglish brief, with a Hindi narrator picked -> English + an English narrator
    expect(await make({ prompt: 'ek ladka Jaipur mein cycle chala raha hai, english voice over chahiye', voice: 'hi_IN-rohan-medium' })).toMatchObject({ language: 'en', voice: 'en_US-ryan-high' });
    // no voice sent: default narrator for the language
    expect(await make({ prompt: 'A girl reads in a library, narration in Hindi' })).toMatchObject({ language: 'hi', voice: 'hi_IN-rohan-medium' });
    await clear();
    // explicit language wins over the brief; a fitting voice is kept
    expect(await make({ prompt: 'English voice-over please', language: 'hinglish', voice: 'hi_IN-rohan-medium' })).toMatchObject({ language: 'hinglish', voice: 'hi_IN-rohan-medium' });
    expect(await make({ prompt: 'a cat on a roof', language: 'en', voice: 'luna' })).toMatchObject({ language: 'en', voice: 'luna' });
    await clear();
    // a library VOICE item is checked by the language its voice id speaks
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.libraryItem.create({ data: { userId: user.id, kind: 'VOICE', handle: 'dadi', name: 'Dadi', description: '', settings: { engine: 'piper', voice: 'hi_IN-rohan-medium', language: 'hi' } } });
    expect(await make({ prompt: 'subah subah chai peeta hai aur ganga ko dekhta hai', voice: 'dadi' })).toMatchObject({ language: 'hinglish', voice: 'dadi' });
    expect(await make({ prompt: 'A dog runs on the beach', voice: 'dadi' })).toMatchObject({ language: 'en', voice: 'en_US-ryan-high' });
    await clear();
    // no Hindi voice on this server -> clear 400, nothing charged
    const before = (await prisma.user.findUniqueOrThrow({ where: { email } })).credits;
    const r = await request(app).post('/scenes').set('Cookie', (await login()).cookie).send({ prompt: 'narration in Hindi, a temple' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/No Hindi voice/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).credits).toBe(before);
  });

  it('queue down -> refund + 503', async () => {
    const down = createApp({ prisma, config: testConfig, queue: { ...fakeQueue(), enqueueScene: () => Promise.reject(new Error('redis')) }, storage });
    const email = `d${Math.random()}@example.com`;
    const cookie = cookieOf(await request(down).post('/auth/register').send({ email, password: 'password-123' }));
    await request(down).post('/scenes').set('Cookie', cookie).send({ prompt: 'a cat', voice: 'luna' }).expect(503);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).credits).toBe(50);
  });
});
