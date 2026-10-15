import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  testConfig,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { createRedis } from '../../lib/redis.js';
import { createMetrics } from '../../observability/metrics.js';
import { processGenerationJob } from '../generation/processor.js';
import { createStubProvider } from '../generation/providers/stub.js';
import { startGenerationWorker } from '../generation/worker.js';
import { buildEditArgs } from './edit-filter.js';
import { createEditRenderer, type EditRenderer } from './edit-renderer.js';
import { EDIT_MODEL_ID, EditRequestSchema, EditSpecError, editCost, normaliseEdit, parseStoredSpec, type UploadInfo } from './edit-spec.js';
import { TEMPLATES, buildFromTemplate, findTemplate } from './templates.js';
import { ProbeError, interpretProbe, probeMedia } from './probe.js';
import { sweepStaleUploads } from './uploads.service.js';

const storage = makeTestStorage();
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const IMG = '00000000-0000-4000-8000-000000000001';
const VID = '00000000-0000-4000-8000-000000000002';
const infos = new Map<string, UploadInfo>([
  [IMG, { id: IMG, kind: 'image', durationMs: null }],
  [VID, { id: VID, kind: 'video', durationMs: 4000 }],
]);
const parse = (b: object) => EditRequestSchema.parse(b);

let fixtures: { dir: string; png: Buffer; webm: Buffer };
beforeAll(async () => {
  await storage.ensureBucket();
  const dir = await mkdtemp(path.join(tmpdir(), 'edit-fixtures-'));
  if (hasFfmpeg) {
    // A real "screenshot" and a real 4 s "screen recording" (WebM/VP8, written to a pipe like
    // MediaRecorder does, so the header has no duration).
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=900x1400', '-frames:v', '1', path.join(dir, 's.png')]);
    const webm = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '4', '-c:v', 'libvpx', '-b:v', '500k', '-f', 'webm', '-']);
    fixtures = { dir, png: await readFile(path.join(dir, 's.png')), webm };
  } else {
    fixtures = { dir, png: Buffer.alloc(0), webm: Buffer.alloc(0) };
  }
});
beforeEach(resetDb);
afterAll(async () => {
  await rm(fixtures.dir, { recursive: true, force: true });
  storage.destroy();
  await prisma.$disconnect();
});

// -------------------------------------------------------------------------------------------
describe('edit spec: validation + normalisation (pure)', () => {
  it('normalises clips against the real uploads and computes the total', () => {
    const spec = normaliseEdit(
      parse({ clips: [{ uploadId: IMG, durationS: 2.5 }, { uploadId: VID, trimStartS: 1 }], texts: [{ text: 'Hi', startS: 0, endS: 99 }] }),
      infos,
    );
    expect(spec.clips).toEqual([
      { uploadId: IMG, kind: 'image', startS: 0, lengthS: 2.5, fit: 'contain', motion: 'none', atS: 0, volume: 0 },
      { uploadId: VID, kind: 'video', startS: 1, lengthS: 3, fit: 'contain', motion: 'none', atS: 2.5, volume: 0 }, // no sound track
    ]);
    expect(spec.totalS).toBe(5.5);
    expect(spec.texts[0]).toMatchObject({ text: 'Hi', endS: 5.5, x: 0.5, y: 0.85, size: 'm', style: 'box', anim: 'none' }); // end clamped
    expect(spec).toMatchObject({ v: 3, transition: 'none', transitionS: 0, audio: [], autoCaptions: null });
    expect(spec.format).toBe('16:9');
  });

  it('images default to 3 s; trim end past the recording is clamped to its length', () => {
    const spec = normaliseEdit(parse({ clips: [{ uploadId: IMG }, { uploadId: VID, trimStartS: 0.5, trimEndS: 60 }] }), infos);
    expect(spec.clips.map((c) => c.lengthS)).toEqual([3, 3.5]);
  });

  it('user-fixable problems are EditSpecErrors with clear messages', () => {
    const bad = (b: object, msg: RegExp) => expect(() => normaliseEdit(parse(b), infos)).toThrow(msg);
    bad({ clips: [{ uploadId: '00000000-0000-4000-8000-000000000009' }] }, /Clip 1: file not found/);
    bad({ clips: [{ uploadId: VID, trimStartS: 5 }] }, /trim starts after the recording ends/);
    bad({ clips: [{ uploadId: VID, trimStartS: 3.8 }] }, /keep at least 0.5s/);
    bad({ clips: [{ uploadId: IMG }], texts: [{ text: 'late', startS: 3, endS: 4 }] }, /Caption 1 starts after the video ends/);
    bad({ clips: Array.from({ length: 5 }, () => ({ uploadId: IMG, durationS: 30 })) }, /limit is 120s/);
    expect(() => normaliseEdit(parse({ clips: [{ uploadId: '00000000-0000-4000-8000-000000000009' }] }), infos)).toThrow(EditSpecError);
  });

  it('schema: text is cleaned (control chars, CRLF) and bounded; colors and ranges are checked', () => {
    const r = parse({ clips: [{ uploadId: IMG }], texts: [{ text: '  a\u0007b\r\nc  ', startS: 0, endS: 1 }] });
    expect(r.texts[0]!.text).toBe('ab\nc');
    const fails = (b: object) => expect(EditRequestSchema.safeParse(b).success).toBe(false);
    fails({ clips: [] });
    fails({ clips: [{ uploadId: IMG }], texts: [{ text: '   ', startS: 0, endS: 1 }] });
    fails({ clips: [{ uploadId: IMG }], texts: [{ text: 'a\nb\nc\nd', startS: 0, endS: 1 }] });
    fails({ clips: [{ uploadId: IMG }], texts: [{ text: 'x', startS: 2, endS: 1 }] });
    fails({ clips: [{ uploadId: IMG }], texts: [{ text: 'x', startS: 0, endS: 1, color: 'red' }] });
    fails({ clips: [{ uploadId: IMG }], boxes: [{ x: 1.2, y: 0, w: 0.1, h: 0.1, startS: 0, endS: 1 }] });
    fails({ clips: [{ uploadId: IMG }], format: '4:3' });
    fails({ clips: Array.from({ length: 31 }, () => ({ uploadId: IMG })) });
    fails({ clips: [{ uploadId: IMG, motion: 'spin' }] });
    fails({ clips: [{ uploadId: IMG }], transition: 'explode' });
  });

  it('highlights are clipped to the frame', () => {
    const spec = normaliseEdit(parse({ clips: [{ uploadId: IMG }], boxes: [{ x: 0.8, y: 0.9, w: 0.5, h: 0.5, startS: 0, endS: 1 }] }), infos);
    expect(spec.boxes[0]).toMatchObject({ w: 0.2, h: 0.1 });
  });

  it('cost: 1 credit per started 5 seconds', () => {
    expect([0.5, 5, 5.001, 10, 12, 120].map(editCost)).toEqual([1, 1, 2, 2, 3, 24]);
  });

  it('parseStoredSpec rejects anything that is not a v1 spec', () => {
    const spec = normaliseEdit(parse({ clips: [{ uploadId: IMG }] }), infos);
    expect(parseStoredSpec(spec)).toEqual(spec);
    expect(parseStoredSpec(null)).toBeNull();
    expect(parseStoredSpec({ ...spec, v: 2 })).toBeNull(); // old shape: never rendered by the new worker
    expect(parseStoredSpec({ ...spec, clips: [] })).toBeNull();
    expect(parseStoredSpec({ ...spec, format: '4:3' })).toBeNull();
  });
});

describe('edit filter (pure): the exact ffmpeg command', () => {
  const spec = normaliseEdit(
    parse({
      transition: 'none',
      clips: [{ uploadId: IMG, durationS: 2 }, { uploadId: VID, trimStartS: 1, fit: 'cover' }],
      texts: [{ text: "it's 100%: done\nline 2", startS: 0, endS: 2 }],
      boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, startS: 2, endS: 3 }],
    }),
    infos,
  );
  const io = (clipFiles: string[], textFiles: string[][] = [], cardFiles: ({ title: string[]; subtitle: string[] } | null)[] = []) => ({
    clipFiles,
    textFiles,
    cardFiles,
    fontFile: '/f/font.ttf',
    output: '/t/out.mp4',
  });
  const args = buildEditArgs(spec, io(['/t/c0', '/t/c1'], [['/t/a', '/t/b']]));
  const graph = args[args.indexOf('-filter_complex') + 1]!;

  it('still images loop for their length; videos seek to the trim on the input side', () => {
    expect(args.join(' ')).toContain('-loop 1 -framerate 30 -t 2 -i /t/c0');
    expect(args.join(' ')).toContain('-ss 1 -t 3 -i /t/c1');
  });

  it('contain letterboxes on the background, cover crops; every clip has an exact length; cut = concat', () => {
    expect(graph).toContain('[0:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0b10');
    expect(graph).toContain('[1:v]scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080');
    expect(graph).toContain('trim=duration=2,setpts=PTS-STARTPTS,settb=AVTB');
    expect(graph).toContain('[c0][c1]concat=n=2:v=1:a=0[base]');
  });

  it('captions: one drawtext per line, read from files, no text expansion; user text never in the command', () => {
    expect(graph.match(/drawtext=/g)).toHaveLength(2);
    expect(graph).toContain("textfile='/t/a':expansion=none");
    expect(graph).toContain("textfile='/t/b':expansion=none");
    expect(graph).toContain("enable='between(t,0,2)'");
    expect(graph).not.toContain('alpha='); // anim: none
    expect(args.join(' ')).not.toContain('100%');
    expect(args.join(' ')).not.toContain("it's");
  });

  it('highlights become drawbox in pixels; output is H.264 yuv420p, faststart, exact length', () => {
    expect(graph).toContain("drawbox=x=192:y=108:w=384:h=216:color=0xfacc15:t=6:enable='between(t,2,3)'");
    expect(args.join(' ')).toContain('-map [out] -t 5 -r 30 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p');
    expect(args).toContain('+faststart');
    expect(args.at(-1)).toBe('/t/out.mp4');
  });

  it('a single clip with no overlays is a pass-through', () => {
    const s = normaliseEdit(parse({ clips: [{ uploadId: IMG }] }), infos);
    const g = buildEditArgs(s, io(['/x']));
    expect(g[g.indexOf('-filter_complex') + 1]).toMatch(/\[c0\]null\[base\];\[base\]null\[out\]$/);
  });

  it('transitions: xfade chain at each clip start; the overlap shortens the video', () => {
    const s = normaliseEdit(
      parse({ transition: 'slideleft', clips: [{ uploadId: IMG, durationS: 2 }, { uploadId: IMG, durationS: 3 }, { uploadId: VID }] }),
      infos,
    );
    expect(s.transitionS).toBe(0.5);
    expect(s.clips.map((c) => c.atS)).toEqual([0, 1.5, 4]);
    expect(s.totalS).toBe(8); // 2 + 3 + 4 - 2 x 0.5
    const g = buildEditArgs(s, io(['/a', '/b', '/c']));
    const fg = g[g.indexOf('-filter_complex') + 1]!;
    expect(fg).toContain('[c0][c1]xfade=transition=slideleft:duration=0.5:offset=1.5[x1]');
    expect(fg).toContain('[x1][c2]xfade=transition=slideleft:duration=0.5:offset=4[base]');
    expect(fg).not.toContain('concat');
  });

  it('short clips get shorter transitions (40% of the shortest clip)', () => {
    const s = normaliseEdit(parse({ transition: 'fade', clips: [{ uploadId: IMG, durationS: 0.5 }, { uploadId: IMG, durationS: 2 }] }), infos);
    expect(s.transitionS).toBe(0.2);
    expect(s.totalS).toBe(2.3);
  });

  it('image motion: one input frame, zoompan on a 2x canvas, eased; auto varies the move', () => {
    const s = normaliseEdit(parse({ clips: [{ uploadId: IMG, durationS: 2, motion: 'auto' }, { uploadId: IMG, durationS: 2, motion: 'auto' }] }), infos);
    expect(s.clips.map((c) => (c.kind === 'image' ? c.motion : ''))).toEqual(['zoom-in', 'pan-right']);
    const g = buildEditArgs(s, io(['/a', '/b']));
    const fg = g[g.indexOf('-filter_complex') + 1]!;
    expect(g.join(' ')).toContain('-i /a -i /b'); // no -loop for moving stills
    expect(fg).toContain('scale=3840:2160:force_original_aspect_ratio=decrease');
    expect(fg).toContain("zoompan=z='1+0.15*((on/59)*(on/59)*(3-2*(on/59)))'");
    expect(fg).toContain(':d=60:s=1920x1080:fps=30');
  });

  it('cards: generated by lavfi (gradient or solid), title/subtitle from files that fade in', () => {
    const s = normaliseEdit(
      parse({
        format: '9:16',
        clips: [{ card: { title: 'Hello', subtitle: 'World', bg: '#7c3aed', bg2: '#db2777' } }, { card: { title: 'Bye', bg: '#111111' }, durationS: 1 }],
      }),
      infos,
    );
    const g = buildEditArgs(s, io(['', ''], [], [{ title: ['/k/t0'], subtitle: ['/k/s0'] }, { title: ['/k/t1'], subtitle: [] }]));
    const all = g.join(' ');
    expect(all).toContain('-f lavfi -i gradients=s=1080x1920:c0=0x7c3aed:c1=0xdb2777');
    expect(all).toContain('-f lavfi -i color=c=0x111111:s=1080x1920:r=30:d=1');
    expect(all).toContain("textfile='/k/t0':expansion=none:fontsize=97");
    expect(all).toContain("textfile='/k/s0':expansion=none:fontsize=49");
    expect(all).toMatch(/alpha='1\*min\(1,max\(0,\(t-0\.1\)\/0\.5\)\)'/);
    expect(s.clips[0]!.kind).toBe('card');
  });

  it('caption animation: fade = alpha ramp in and out; slide also rises', () => {
    const s = normaliseEdit(
      parse({ clips: [{ uploadId: IMG, durationS: 4 }], texts: [{ text: 'a', startS: 1, endS: 3, anim: 'slide' }] }),
      infos,
    );
    const fg = buildEditArgs(s, io(['/a'], [['/t']])).join(' ');
    expect(fg).toContain("alpha='if(lt(t,1),0,if(lt(t,1.35),(t-1)/0.35,if(gt(t,2.65),max(0,(3-t)/0.35),1)))'");
    expect(fg).toContain('+43*max(0,1-(t-1)/0.35)');
  });

  it('font sizes follow the short side, so 9:16 text is not huge', () => {
    const s = normaliseEdit(parse({ format: '9:16', clips: [{ uploadId: IMG }], texts: [{ text: 'a', startS: 0, endS: 1, size: 'm' }] }), infos);
    expect(buildEditArgs(s, io(['/a'], [['/t']])).join(' ')).toContain('fontsize=54:'); // 1080 * 0.05
  });
});

describe('templates: files -> a complete, renderable timeline', () => {
  const items = [
    { uploadId: IMG, kind: 'image' as const, durationMs: null },
    { uploadId: VID, kind: 'video' as const, durationMs: 4000 },
  ];

  it('every template builds a valid request that normalises', () => {
    for (const t of TEMPLATES) {
      const req = parse(buildFromTemplate(t, items, { title: 'My trip' }));
      const spec = normaliseEdit(req, infos);
      expect(spec.format).toBe(t.format);
      expect(spec.totalS).toBeGreaterThan(2);
      expect(spec.clips.filter((c) => c.kind === 'card')).toHaveLength((t.intro ? 1 : 0) + (t.outro ? 1 : 0));
    }
  });

  it('reel: intro card with the title, cover fit, auto motion, outro; long recordings keep the middle', () => {
    const req = buildFromTemplate(findTemplate('reel-punchy')!, items, { title: 'Goa', subtitle: '3 days' });
    expect(req.clips[0]).toMatchObject({ card: { title: 'Goa', subtitle: '3 days' } });
    expect(req.clips[1]).toMatchObject({ uploadId: IMG, fit: 'cover', motion: 'auto', durationS: 1.6 });
    expect(req.clips[2]).toMatchObject({ uploadId: VID, trimStartS: 0.5, trimEndS: 3.5 });
    expect(req.clips[3]).toMatchObject({ card: { title: 'Follow for more' } });
  });

  it('tutorial: "Step N" captions placed inside each media clip, clear of the transitions', () => {
    const req = parse(buildFromTemplate(findTemplate('tutorial-steps')!, items));
    expect(req.texts.map((t) => t.text)).toEqual(['Step 1', 'Step 2']);
    const spec = normaliseEdit(req, infos);
    const img = spec.clips[1]!;
    expect(spec.texts[0]!.startS).toBeCloseTo(img.atS + spec.transitionS, 2);
    expect(spec.texts[0]!.endS).toBeCloseTo(img.atS + img.lengthS - spec.transitionS, 2);
  });

  it('own captions win over auto captions; targetS stretches still-image time', () => {
    const req = buildFromTemplate(findTemplate('tutorial-steps')!, [{ ...items[0]!, caption: 'Open Settings' }], { targetS: 20 });
    expect(req.texts?.[0]?.text).toBe('Open Settings');
    expect((req.clips[1] as { durationS: number }).durationS).toBe(6); // capped at 6 s per still
  });
});

describe('probe (pure): trust the decoded content, not the name', () => {
  const j = (streams: object[], format: object = {}) => JSON.stringify({ streams, format });
  it('accepts real images and videos and reports their facts', () => {
    expect(interpretProbe(j([{ codec_type: 'video', codec_name: 'png', width: 900, height: 1400 }]), 'image/png')).toEqual({
      kind: 'image', width: 900, height: 1400, durationMs: null, codec: 'png', hasAudio: false,
    });
    expect(interpretProbe(j([{ codec_type: 'video', codec_name: 'vp8', width: 640, height: 360 }], { duration: '4.0' }), 'video/webm')).toMatchObject({
      kind: 'video', durationMs: 4000,
    });
  });
  it('rejects non-media, wrong kinds, oversized and over-long files', () => {
    const bad = (json: string, mime: Parameters<typeof interpretProbe>[1], msg: RegExp) => expect(() => interpretProbe(json, mime)).toThrow(msg);
    bad('not json', 'image/png', /Not a recognised/);
    bad(j([{ codec_type: 'audio', codec_name: 'mp3' }]), 'video/mp4', /Not a recognised/);
    bad(j([{ codec_type: 'video', codec_name: 'h264', width: 10, height: 10 }], { duration: '1' }), 'image/png', /Not a PNG, JPEG or WebP/);
    bad(j([{ codec_type: 'video', codec_name: 'png', width: 9000, height: 10 }]), 'image/png', /too large/);
    bad(j([{ codec_type: 'video', codec_name: 'gif', width: 10, height: 10 }], { duration: '1' }), 'video/mp4', /Unsupported video codec/);
    bad(j([{ codec_type: 'video', codec_name: 'h264', width: 10, height: 10 }], { duration: '601' }), 'video/mp4', /too long/);
    bad(j([{ codec_type: 'video', codec_name: 'h264', width: 10, height: 10 }]), 'video/mp4', /video length/);
    expect(() => interpretProbe('x', 'image/png')).toThrow(ProbeError);
  });
});

describe.runIf(hasFfmpeg)('probe (real ffprobe)', () => {
  it('a MediaRecorder-style WebM (no duration in the header) still gets its length', async () => {
    const f = path.join(fixtures.dir, 'p.webm');
    await writeFile(f, fixtures.webm);
    const r = await probeMedia(f, 'video/webm');
    expect(r).toMatchObject({ kind: 'video', width: 640, height: 360, codec: 'vp8' });
    expect(r.durationMs).toBeGreaterThan(3800);
    expect(r.durationMs).toBeLessThanOrEqual(4000);
  });
  it('a text file renamed to .png is rejected', async () => {
    const f = path.join(fixtures.dir, 'fake.png');
    await writeFile(f, 'hello, I am not a picture');
    await expect(probeMedia(f, 'image/png')).rejects.toThrow(ProbeError);
  });
});

// -------------------------------------------------------------------------------------------
/** Register a user and return their cookie + id. */
async function newUser(app: ReturnType<typeof makeGenApp>) {
  const email = `e${Math.random()}@example.com`;
  const cookie = cookieOf(await request(app).post('/auth/register').send({ email, password: 'password-123' }));
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie, user };
}

/** Do what the browser does: create, POST the file to the presigned URL, complete. */
async function upload(app: ReturnType<typeof makeGenApp>, cookie: string, file: Buffer, mimeType: string, fileName = 'f') {
  const created = await request(app).post('/uploads').set('Cookie', cookie).send({ fileName, mimeType, bytes: file.length });
  if (created.status !== 201) return { created };
  const { url, fields } = created.body.post as { url: string; fields: Record<string, string> };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(file)], { type: mimeType }));
  const s3 = await fetch(url, { method: 'POST', body: form });
  const completed = await request(app).post(`/uploads/${created.body.upload.id}/complete`).set('Cookie', cookie);
  return { created, s3, completed };
}

const balance = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).credits;
const ledgerSum = async (id: string) => (await prisma.creditTransaction.aggregate({ where: { userId: id }, _sum: { delta: true } }))._sum.delta;

describe.runIf(hasFfmpeg)('uploads API (real MinIO + real ffprobe)', () => {
  const app = makeGenApp({ queue: fakeQueue(), storage });

  it('image + screen recording: presigned POST -> complete -> READY with real metadata', async () => {
    const { cookie } = await newUser(app);
    const img = await upload(app, cookie, fixtures.png, 'image/png', 'C:\\Users\\me\\shot 1.png');
    expect(img.s3!.status).toBe(204);
    expect(img.completed!.status).toBe(200);
    expect(img.completed!.body.upload).toMatchObject({ status: 'READY', kind: 'image', width: 900, height: 1400, fileName: 'shot 1.png' });
    expect(img.completed!.body.upload.url).toMatch(/^http/);

    const vid = await upload(app, cookie, fixtures.webm, 'video/webm', 'rec.webm');
    expect(vid.completed!.body.upload).toMatchObject({ status: 'READY', kind: 'video', width: 640, height: 360 });
    expect(vid.completed!.body.upload.durationMs).toBeGreaterThan(3800);

    const list = await request(app).get('/uploads').set('Cookie', cookie).expect(200);
    expect(list.body.items).toHaveLength(2);
    expect((await request(app).get('/uploads?type=video').set('Cookie', cookie)).body.items).toHaveLength(1);
  }, 30_000);

  it('a fake file (text pretending to be a PNG) is rejected and cleaned up', async () => {
    const { cookie, user } = await newUser(app);
    const r = await upload(app, cookie, Buffer.from('definitely not a png'), 'image/png');
    expect(r.completed!.status).toBe(400);
    expect(r.completed!.body.error).toMatch(/Not a/);
    expect(await prisma.upload.count({ where: { userId: user.id } })).toBe(0);
  });

  it('S3 itself enforces the signed policy: a different Content-Type is refused', async () => {
    const { cookie } = await newUser(app);
    const created = await request(app).post('/uploads').set('Cookie', cookie).send({ fileName: 'a.png', mimeType: 'image/png', bytes: 10 }).expect(201);
    const form = new FormData();
    for (const [k, v] of Object.entries(created.body.post.fields as Record<string, string>)) form.append(k, k === 'Content-Type' ? 'text/html' : v);
    form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }));
    const s3 = await fetch(created.body.post.url, { method: 'POST', body: form });
    expect(s3.status).toBe(403);
  });

  it('validation: unsupported type, too big, complete before upload, other users, auth', async () => {
    const { cookie } = await newUser(app);
    const create = (b: object) => request(app).post('/uploads').set('Cookie', cookie).send(b);
    expect((await create({ fileName: 'a.gif', mimeType: 'image/gif', bytes: 10 })).status).toBe(400);
    expect((await create({ fileName: 'a.png', mimeType: 'image/png', bytes: 16 * 1024 * 1024 })).status).toBe(413);
    const pending = await create({ fileName: 'a.png', mimeType: 'image/png', bytes: 10 }).expect(201);
    await request(app).post(`/uploads/${pending.body.upload.id}/complete`).set('Cookie', cookie).expect(409);

    const other = await newUser(app);
    await request(app).post(`/uploads/${pending.body.upload.id}/complete`).set('Cookie', other.cookie).expect(404);
    await request(app).delete(`/uploads/${pending.body.upload.id}`).set('Cookie', other.cookie).expect(404);
    await request(app).post('/uploads').send({ fileName: 'a.png', mimeType: 'image/png', bytes: 10 }).expect(401);
    // PENDING uploads are not listed.
    expect((await request(app).get('/uploads').set('Cookie', cookie)).body.items).toHaveLength(0);
  });

  it('delete removes the row and the object; the sweeper clears abandoned uploads', async () => {
    const { cookie, user } = await newUser(app);
    const r = await upload(app, cookie, fixtures.png, 'image/png');
    const id = r.completed!.body.upload.id;
    const key = (await prisma.upload.findUniqueOrThrow({ where: { id } })).storageKey;
    await request(app).delete(`/uploads/${id}`).set('Cookie', cookie).expect(204);
    expect(await storage.head(key)).toBeNull();

    await request(app).post('/uploads').set('Cookie', cookie).send({ fileName: 'a.png', mimeType: 'image/png', bytes: 10 }).expect(201);
    expect(await sweepStaleUploads(prisma, storage, 60)).toBe(0); // fresh: kept
    expect(await sweepStaleUploads(prisma, storage, 60, new Date(Date.now() + 61 * 60_000))).toBe(1);
    expect(await prisma.upload.count({ where: { userId: user.id } })).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
describe('POST /edits (API, fake probe)', () => {
  const app = createApp({
    prisma,
    config: testConfig,
    queue: fakeQueue(),
    storage,
    probe: async () => ({ kind: 'image', width: 100, height: 100, durationMs: null, codec: 'png', hasAudio: false }),
  });
  async function readyUpload(userId: string, mimeType = 'image/png', durationMs: number | null = null) {
    return prisma.upload.create({
      data: { userId, status: 'READY', storageKey: `uploads/${userId}/${Math.random()}.png`, fileName: 'x', mimeType, bytes: 10, width: 100, height: 100, durationMs },
    });
  }

  it('creates an EDIT job: normalised spec stored, priced by length, credits reserved', async () => {
    const { cookie, user } = await newUser(app);
    const a = await readyUpload(user.id);
    const v = await readyUpload(user.id, 'video/mp4', 9000);
    const res = await request(app)
      .post('/edits')
      .set('Cookie', cookie)
      .send({ title: 'How to export', clips: [{ uploadId: a.id, durationS: 3 }, { uploadId: v.id, trimEndS: 8 }], texts: [{ text: 'Click Export', startS: 0, endS: 3 }] })
      .expect(202);
    expect(res.body.job).toMatchObject({ kind: 'EDIT', status: 'QUEUED', model: EDIT_MODEL_ID, prompt: 'How to export', aspectRatio: '16:9', creditsCost: 3 });
    expect(res.body.job.edit.totalS).toBe(11);
    expect(await balance(user.id)).toBe(47);
    expect(await ledgerSum(user.id)).toBe(47);
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: res.body.job.id } });
    expect(row.durationS).toBe(11);
  });

  it("someone else's (or a pending) upload is 'file not found'; nothing charged", async () => {
    const owner = await newUser(app);
    const thief = await newUser(app);
    const theirs = await readyUpload(owner.user.id);
    const r = await request(app).post('/edits').set('Cookie', thief.cookie).send({ clips: [{ uploadId: theirs.id }] }).expect(400);
    expect(r.body.error).toBe('Clip 1: file not found');
    const pending = await prisma.upload.create({
      data: { userId: thief.user.id, storageKey: `uploads/${thief.user.id}/p.png`, fileName: 'p', mimeType: 'image/png', bytes: 1 },
    });
    await request(app).post('/edits').set('Cookie', thief.cookie).send({ clips: [{ uploadId: pending.id }] }).expect(400);
    expect(await balance(thief.user.id)).toBe(50);
  });

  it('idempotent: same key + same edit = same job; same key + different edit = 409', async () => {
    const { cookie, user } = await newUser(app);
    const a = await readyUpload(user.id);
    const send = (text: string) =>
      request(app).post('/edits').set('Cookie', cookie).set('Idempotency-Key', 'edit-key-123').send({ clips: [{ uploadId: a.id }], texts: [{ text, startS: 0, endS: 1 }] });
    const first = await send('A').expect(202);
    expect((await send('A').expect(200)).body.job.id).toBe(first.body.job.id);
    await send('B').expect(409);
    expect(await balance(user.id)).toBe(49);
  });

  it('not enough credits -> 402; the DB refuses an EDIT row without a spec', async () => {
    const { cookie, user } = await newUser(app);
    const a = await readyUpload(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { credits: 0 } });
    await request(app).post('/edits').set('Cookie', cookie).send({ clips: [{ uploadId: a.id }] }).expect(402);
    await expect(
      prisma.generationJob.create({ data: { userId: user.id, kind: 'EDIT', prompt: 'x', model: 'm', aspectRatio: '16:9', creditsCost: 1, durationS: 3 } }),
    ).rejects.toThrow(/edit_fields_check/);
    await expect(
      prisma.generationJob.create({ data: { userId: user.id, kind: 'IMAGE', prompt: 'x', model: 'm', aspectRatio: '1:1', creditsCost: 1, editSpec: {} } }),
    ).rejects.toThrow(/spec_only_edit_check/);
  });

  it('POST /edits/build: template + own files -> draft (not charged); foreign files and unknown templates -> 400', async () => {
    const { cookie, user } = await newUser(app);
    const a = await readyUpload(user.id);
    const ok = await request(app).post('/edits/build').set('Cookie', cookie).send({ templateId: 'tutorial-steps', uploadIds: [a.id] }).expect(200);
    expect(ok.body.draft.texts[0].text).toBe('Step 1');
    expect(ok.body.totalS).toBeGreaterThan(5);
    expect(await balance(user.id)).toBe(50);

    await request(app).post('/edits/build').set('Cookie', cookie).send({ templateId: 'nope', uploadIds: [a.id] }).expect(400);
    const other = await newUser(app);
    const r = await request(app).post('/edits/build').set('Cookie', other.cookie).send({ templateId: 'tutorial-steps', uploadIds: [a.id] }).expect(400);
    expect(r.body.error).toBe('File 1 not found');
    await request(app).post('/edits/build').send({ templateId: 'tutorial-steps', uploadIds: [a.id] }).expect(401);
  });

  it('GET /editor/config exposes formats, limits and pricing; GET /jobs?kind=EDIT filters', async () => {
    const { body } = await request(app).get('/editor/config').expect(200);
    expect(body.formats.map((f: { id: string }) => f.id)).toEqual(['16:9', '9:16', '1:1']);
    expect(body).toMatchObject({ secondsPerCredit: 5, limits: { maxTotalS: 120, clips: 30 } });
    expect(body.templates.map((t: { id: string }) => t.id)).toContain('reel-punchy');
    expect(body.transitions).toContain('slideleft');
    const { cookie, user } = await newUser(app);
    const a = await readyUpload(user.id);
    await request(app).post('/edits').set('Cookie', cookie).send({ clips: [{ uploadId: a.id }] }).expect(202);
    expect((await request(app).get('/jobs?kind=EDIT').set('Cookie', cookie)).body.items).toHaveLength(1);
    expect((await request(app).get('/jobs?kind=IMAGE').set('Cookie', cookie)).body.items).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------
describe('processGenerationJob: EDIT', () => {
  const app = createApp({ prisma, config: testConfig, queue: fakeQueue(), storage });
  const fake: EditRenderer = {
    name: 'fake',
    render: async ({ spec, fetchClip }) => {
      for (let i = 0; i < spec.clips.length; i++) await fetchClip(i, path.join(fixtures.dir, `fake-${i}`));
      return { data: Buffer.from('....ftypisom-fake'), mimeType: 'video/mp4', width: 1920, height: 1080, durationMs: spec.totalS * 1000 };
    },
  };
  const deps = (editor?: EditRenderer) => ({ prisma, provider: createStubProvider(0), editor, storage, logger: silentLogger, metrics: createMetrics() });

  async function queuedEdit() {
    const { cookie, user } = await newUser(app);
    const key = `uploads/${user.id}/src.png`;
    await storage.put(key, Buffer.from('png-bytes'), 'image/png');
    const up = await prisma.upload.create({ data: { userId: user.id, status: 'READY', storageKey: key, fileName: 'x', mimeType: 'image/png', bytes: 9 } });
    const { body } = await request(app).post('/edits').set('Cookie', cookie).send({ clips: [{ uploadId: up.id, durationS: 4 }] }).expect(202);
    return { user, up, jobId: body.job.id as string };
  }

  it('happy path: MP4 asset with the edit length, credits kept', async () => {
    const { user, jobId } = await queuedEdit();
    expect(await processGenerationJob(jobId, { attempt: 1, maxAttempts: 3 }, deps(fake))).toBe('done');
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId }, include: { asset: true } });
    expect(job.asset).toMatchObject({ storageKey: `users/${user.id}/${jobId}.mp4`, mimeType: 'video/mp4', width: 1920, height: 1080, durationMs: 4000 });
    expect(await balance(user.id)).toBe(49);
  });

  it('a source deleted while queued -> FAILED with a clear message + exactly one refund', async () => {
    const { user, up, jobId } = await queuedEdit();
    await prisma.upload.delete({ where: { id: up.id } });
    expect(await processGenerationJob(jobId, { attempt: 1, maxAttempts: 3 }, deps(fake))).toBe('failed');
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).error).toMatch(/was deleted before the video could be made/);
    expect(await balance(user.id)).toBe(50);
    expect(await ledgerSum(user.id)).toBe(50);
  });

  it('no renderer -> FAILED + refund at once; renderer crash -> retried, refunded once at the end', async () => {
    const a = await queuedEdit();
    expect(await processGenerationJob(a.jobId, { attempt: 1, maxAttempts: 3 }, deps(undefined))).toBe('failed');
    expect(await balance(a.user.id)).toBe(50);

    const b = await queuedEdit();
    const boom: EditRenderer = { name: 'boom', render: () => Promise.reject(new Error('ffmpeg exited with 1')) };
    expect(await processGenerationJob(b.jobId, { attempt: 1, maxAttempts: 2 }, deps(boom))).toBe('retry');
    expect(await processGenerationJob(b.jobId, { attempt: 2, maxAttempts: 2 }, deps(boom))).toBe('failed');
    expect(await prisma.creditTransaction.count({ where: { refId: b.jobId, reason: 'REFUND' } })).toBe(1);
    expect(await balance(b.user.id)).toBe(50);
  });
});

// -------------------------------------------------------------------------------------------
describe.runIf(hasFfmpeg)('END-TO-END editor: upload -> API -> BullMQ -> worker -> ffmpeg -> S3', () => {
  const queue = makeRealQueue();
  const workerConn = createRedis(TEST_REDIS_URL, 'worker');
  let running: ReturnType<typeof startGenerationWorker>;
  const app = makeGenApp({ queue, storage });

  beforeAll(async () => {
    await queue.queue.obliterate({ force: true });
    running = startGenerationWorker({
      prisma,
      connection: workerConn,
      provider: createStubProvider(0),
      editor: createEditRenderer(),
      storage,
      logger: silentLogger,
      metrics: createMetrics(),
      concurrency: 1,
      maxAttempts: 2,
      jobTimeoutMinutes: 10,
    });
  });
  afterAll(async () => {
    await running.close();
    await queue.close();
    workerConn.disconnect();
  });

  it('a screenshot + a screen recording with captions and a highlight become one playable 1080p MP4', async () => {
    const { cookie, user } = await newUser(app);
    const shot = (await upload(app, cookie, fixtures.png, 'image/png')).completed!.body.upload;
    const rec = (await upload(app, cookie, fixtures.webm, 'video/webm')).completed!.body.upload;

    const { body } = await request(app)
      .post('/edits')
      .set('Cookie', cookie)
      .send({
        title: 'Tutorial',
        format: '16:9',
        transition: 'fade',
        clips: [{ uploadId: shot.id, durationS: 2 }, { uploadId: rec.id, trimStartS: 1, trimEndS: 3.5 }],
        texts: [
          { text: "Step 1: open 'Settings' — 100% %{pts}\nthen click Save", startS: 0, endS: 2, size: 'l' },
          { text: 'Done!', startS: 2, endS: 4.5, y: 0.15, style: 'outline', color: '#facc15' },
        ],
        boxes: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2, startS: 3, endS: 4.5 }],
      })
      .expect(202);
    expect(body.job.creditsCost).toBe(1); // 2 + 2.5 - 0.5 fade overlap = 4 s

    let job = body.job;
    const end = Date.now() + 60_000;
    while (job.status !== 'DONE' && job.status !== 'FAILED') {
      if (Date.now() > end) throw new Error(`still ${job.status}`);
      await sleep(150);
      job = (await request(app).get(`/jobs/${job.id}`).set('Cookie', cookie)).body.job;
    }
    expect(job.error).toBeNull();
    expect(job.status).toBe('DONE');
    expect(job.asset).toMatchObject({ kind: 'video', mimeType: 'video/mp4', width: 1920, height: 1080, durationMs: 4000 });

    const mp4 = Buffer.from(await (await fetch(job.asset.url)).arrayBuffer());
    const out = path.join(fixtures.dir, 'e2e.mp4');
    await writeFile(out, mp4);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height:format=duration', '-of', 'json', out]);
    const p = JSON.parse(probe.toString());
    expect(p.streams[0]).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080 });
    expect(Number(p.format.duration)).toBeCloseTo(4, 1);
    expect(await balance(user.id)).toBe(49);
    expect((await request(app).get('/assets?type=video').set('Cookie', cookie)).body.items).toHaveLength(1);
  }, 90_000);

  it('template build -> render: a 9:16 reel with cards, Ken Burns stills and slide transitions', async () => {
    const { cookie } = await newUser(app);
    const shot = (await upload(app, cookie, fixtures.png, 'image/png')).completed!.body.upload;
    const rec = (await upload(app, cookie, fixtures.webm, 'video/webm')).completed!.body.upload;

    const built = await request(app)
      .post('/edits/build')
      .set('Cookie', cookie)
      .send({ templateId: 'reel-punchy', uploadIds: [shot.id, rec.id, shot.id], title: "Goa '26: 100%", captions: { [rec.id]: 'Sunset run' } })
      .expect(200);
    expect(built.body.draft.format).toBe('9:16');
    expect(built.body.draft.clips).toHaveLength(5);
    // Nothing charged for building.
    expect((await request(app).get('/credits').set('Cookie', cookie)).body.balance).toBe(50);

    const { body } = await request(app).post('/edits').set('Cookie', cookie).send(built.body.draft).expect(202);
    let job = body.job;
    const end = Date.now() + 90_000;
    while (job.status !== 'DONE' && job.status !== 'FAILED') {
      if (Date.now() > end) throw new Error(`still ${job.status}`);
      await sleep(200);
      job = (await request(app).get(`/jobs/${job.id}`).set('Cookie', cookie)).body.job;
    }
    expect(job.error).toBeNull();
    expect(job.asset).toMatchObject({ width: 1080, height: 1920 });
    expect(job.asset.durationMs).toBe(Math.round(built.body.totalS * 1000));
  }, 120_000);
});
