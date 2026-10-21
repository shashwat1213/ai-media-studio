import { z } from 'zod';

/**
 * The Editor's timeline: the user's own screenshots / screen recordings plus generated title/end
 * cards, laid end to end with transitions, with captions and highlight boxes on top, rendered to
 * one MP4 by ffmpeg in the worker.
 *
 * Two shapes:
 *  - EditRequest: what the browser (or a template / the AI director) sends.
 *  - EditSpec:    what we STORE on the job (GenerationJob.editSpec). Normalised by the API against
 *                 the real upload metadata: every clip has an explicit kind, length, motion and
 *                 position on the timeline, and the total length is known. The worker renders
 *                 exactly this; nothing is re-derived.
 */

export const EDIT_FORMATS = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
} as const;
export type EditFormat = keyof typeof EDIT_FORMATS;

export const EDIT_FPS = 30;
export const EDIT_LIMITS = {
  clips: 30,
  texts: 40,
  boxes: 20,
  maxTotalS: 120,
  minClipS: 0.5,
  maxImageClipS: 30,
  textChars: 200,
  textLines: 3,
  audio: 4,
  karaokeWords: 2000,
} as const;

/** Credits: 1 per started 5 seconds of output (CPU work scales with length). */
export const EDIT_SECONDS_PER_CREDIT = 5;
export const editCost = (totalS: number) => Math.max(1, Math.ceil(totalS / EDIT_SECONDS_PER_CREDIT - 1e-9));

/** Stored in GenerationJob.model for EDIT jobs (metrics/labels group by it). */
export const EDIT_MODEL_ID = 'editor/ffmpeg';

export const TEXT_SIZES = { s: 0.035, m: 0.05, l: 0.07, xl: 0.1 } as const;

/** ffmpeg xfade transitions we expose (a curated subset: all verified to render). */
export const TRANSITIONS = ['none', 'fade', 'fadeblack', 'dissolve', 'slideleft', 'slideup', 'smoothleft', 'wipeleft', 'zoomin', 'circleopen'] as const;
export type Transition = (typeof TRANSITIONS)[number];
/** Upper bound for one transition; shortened automatically for short clips. */
export const TRANSITION_MAX_S = 0.5;

/** Camera moves on still images (Ken Burns). 'auto' = we pick a varied sequence. */
export const IMAGE_MOTIONS = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'] as const;
export type ImageMotion = (typeof IMAGE_MOTIONS)[number];
const AUTO_SEQUENCE: ImageMotion[] = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left', 'pan-up', 'zoom-in', 'pan-down'];

export const TEXT_ANIMS = ['none', 'fade', 'slide'] as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors must look like #RRGGBB');
const frac = z.number().min(0).max(1);
const seconds = z.number().min(0).max(EDIT_LIMITS.maxTotalS);
// Round to milliseconds: keeps the stored spec (and the ffmpeg command) tidy and deterministic.
const ms = (n: number) => Math.round(n * 1000) / 1000;

/** An audio file on the timeline (voice-over, music): placed at `atS`, optionally trimmed. */
const AudioTrack = z.object({
  uploadId: z.string().uuid('uploadId must be an upload id'),
  atS: z.number().min(0).max(EDIT_LIMITS.maxTotalS).default(0),
  trimStartS: z.number().min(0).max(3600).default(0),
  /** Default: to the end of the file (or the video, whichever is first). */
  trimEndS: z.number().min(0).max(3600).optional(),
  /** 0..2 (1 = as recorded). */
  volume: z.number().min(0).max(2).default(1),
  /** Duck = lower this track while a voice-over is speaking (music under narration). */
  duck: z.boolean().default(false),
});

/** Word-by-word captions generated from a transcript (reels-style). */
const AutoCaptions = z.object({
  /** Which upload's transcript (a voice-over or a video clip with speech). */
  uploadId: z.string().uuid(),
  /** Where that audio starts on the output timeline (the API fills this for clips/tracks). */
  y: frac.default(0.72),
  size: z.enum(['s', 'm', 'l', 'xl']).default('l'),
  color: hex.default('#ffffff'),
  highlight: hex.default('#facc15'),
  style: z.enum(['box', 'outline']).default('outline'),
  maxWords: z.number().int().min(1).max(8).default(3),
});


/** User text: control characters removed, CRLF normalised, bounded lines. */
const cleanText = (maxLines: number, maxChars: number) =>
  z
    .string()
    .max(maxChars, `Text must be at most ${maxChars} characters`)
    // eslint-disable-next-line no-control-regex
    .transform((s) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim())
    .refine((s) => s.split('\n').length <= maxLines, `At most ${maxLines} lines`);

const Text = z
  .object({
    text: cleanText(EDIT_LIMITS.textLines, EDIT_LIMITS.textChars).refine((s) => s.length > 0, 'Text cannot be empty'),
    startS: seconds,
    endS: seconds,
    /** Centre of the text block, as a fraction of the frame. */
    x: frac.default(0.5),
    y: frac.default(0.85),
    size: z.enum(['s', 'm', 'l', 'xl']).default('m'),
    color: hex.default('#ffffff'),
    style: z.enum(['box', 'outline', 'plain']).default('box'),
    anim: z.enum(TEXT_ANIMS).default('none'),
  })
  .refine((t) => t.endS > t.startS, { message: 'Text must end after it starts', path: ['endS'] });

const Box = z
  .object({
    x: frac,
    y: frac,
    w: z.number().min(0.01).max(1),
    h: z.number().min(0.01).max(1),
    startS: seconds,
    endS: seconds,
    color: hex.default('#facc15'),
  })
  .refine((b) => b.endS > b.startS, { message: 'Highlight must end after it starts', path: ['endS'] });

const Card = z.object({
  title: cleanText(2, 80),
  subtitle: cleanText(2, 120).default(''),
  bg: hex.default('#7c3aed'),
  /** Second colour = diagonal gradient. Same as bg = solid. */
  bg2: hex.optional(),
  color: hex.default('#ffffff'),
});

const UploadClip = z.object({
  uploadId: z.string().uuid('uploadId must be an upload id'),
  /** Images: how long to show it. */
  durationS: z.number().min(EDIT_LIMITS.minClipS).max(EDIT_LIMITS.maxImageClipS).optional(),
  /** Videos: which part to use. Defaults to the whole recording. */
  trimStartS: z.number().min(0).max(3600).optional(),
  trimEndS: z.number().min(0).max(3600).optional(),
  fit: z.enum(['contain', 'cover']).default('contain'),
  /** Images only: Ken Burns move. */
  motion: z.enum([...IMAGE_MOTIONS, 'auto']).default('none'),
  /** Videos only: keep the clip's own sound, and how loud (0 = mute). */
  volume: z.number().min(0).max(2).default(1),
});

const CardClip = z.object({
  card: Card,
  durationS: z.number().min(EDIT_LIMITS.minClipS).max(10).default(2),
});

export const EditRequestSchema = z.object({
  title: z.string().trim().max(100).optional(),
  format: z.enum(Object.keys(EDIT_FORMATS) as [EditFormat, ...EditFormat[]]).default('16:9'),
  background: hex.default('#0b0b10'),
  transition: z.enum(TRANSITIONS).default('none'),
  clips: z
    .array(z.union([CardClip, UploadClip]))
    .min(1, 'Add at least one clip')
    .max(EDIT_LIMITS.clips, `At most ${EDIT_LIMITS.clips} clips`),
  texts: z.array(Text).max(EDIT_LIMITS.texts, `At most ${EDIT_LIMITS.texts} captions`).default([]),
  boxes: z.array(Box).max(EDIT_LIMITS.boxes, `At most ${EDIT_LIMITS.boxes} highlights`).default([]),
  audio: z.array(AudioTrack).max(EDIT_LIMITS.audio, `At most ${EDIT_LIMITS.audio} audio tracks`).default([]),
  autoCaptions: AutoCaptions.nullable().default(null),
});
export type EditRequest = z.infer<typeof EditRequestSchema>;
export type EditRequestInput = z.input<typeof EditRequestSchema>;
export type CardSpec = z.infer<typeof Card>;

interface SpecClipBase {
  lengthS: number;
  /** Where this clip starts on the output timeline (transitions overlap neighbours). */
  atS: number;
}
export interface SpecMediaClip extends SpecClipBase {
  kind: 'image' | 'video';
  uploadId: string;
  /** Offset into the source (videos), 0 for images. */
  startS: number;
  fit: 'contain' | 'cover';
  motion: ImageMotion;
  /** Videos with a sound track: its volume (0 = muted / no sound). */
  volume: number;
}

export interface SpecAudio {
  uploadId: string;
  atS: number;
  startS: number;
  lengthS: number;
  volume: number;
  duck: boolean;
}

/** Karaoke captions, resolved to OUTPUT-timeline word times by the API. */
export interface SpecAutoCaptions {
  y: number;
  size: 's' | 'm' | 'l' | 'xl';
  color: string;
  highlight: string;
  style: 'box' | 'outline';
  maxWords: number;
  words: { w: string; s: number; e: number }[];
}
export interface SpecCardClip extends SpecClipBase {
  kind: 'card';
  card: CardSpec;
}
export type SpecClip = SpecMediaClip | SpecCardClip;

export interface EditSpec {
  v: 3;
  format: EditFormat;
  background: string;
  transition: Transition;
  /** Length of each transition (0 when transition = none or a single clip). */
  transitionS: number;
  clips: SpecClip[];
  texts: EditRequest['texts'];
  boxes: EditRequest['boxes'];
  audio: SpecAudio[];
  autoCaptions: SpecAutoCaptions | null;
  totalS: number;
}

/** What normalise() needs to know about each referenced upload. */
export interface UploadInfo {
  id: string;
  kind: 'image' | 'video' | 'audio';
  durationMs: number | null;
  /** Videos: has a sound track. Audio: always true. */
  hasAudio?: boolean;
  /** Word timings in the FILE's own time (seconds), when transcribed. */
  words?: { w: string; s: number; e: number }[] | null;
}

/** A user-fixable problem with the request (-> 400 with a clear message). */
export class EditSpecError extends Error {}

/**
 * Transition length for a set of clip lengths: at most 0.5 s, and never more than 40% of the
 * shortest clip (xfade needs both sides to be longer than the overlap).
 */
export function transitionLength(transition: Transition, lengths: number[]): number {
  if (transition === 'none' || lengths.length < 2) return 0;
  return ms(Math.min(TRANSITION_MAX_S, Math.min(...lengths) * 0.4));
}

/** Clip start times + total, given lengths and the overlap. Shared with the browser preview. */
export function timeline(lengths: number[], overlapS: number): { at: number[]; total: number } {
  const at: number[] = [];
  let t = 0;
  lengths.forEach((len, i) => {
    at.push(ms(t));
    t += len - (i < lengths.length - 1 ? overlapS : 0);
  });
  return { at, total: ms(t) };
}

/**
 * Resolve a request against the real uploads: decide each clip's exact length and motion, check
 * trims fit inside the recording, lay clips on the timeline, and check captions/highlights sit
 * inside it. Pure (no DB), so every rule is unit-tested directly.
 */
export function normaliseEdit(req: EditRequest, uploads: Map<string, UploadInfo>): EditSpec {
  let autoIndex = 0;
  const base = req.clips.map((c, i): Omit<SpecMediaClip, 'atS'> | Omit<SpecCardClip, 'atS'> => {
    if ('card' in c) {
      if (!c.card.title && !c.card.subtitle) throw new EditSpecError(`Clip ${i + 1}: a card needs a title`);
      return { kind: 'card', card: c.card, lengthS: ms(c.durationS) };
    }
    const u = uploads.get(c.uploadId);
    if (!u) throw new EditSpecError(`Clip ${i + 1}: file not found`);
    if (u.kind === 'audio') throw new EditSpecError(`Clip ${i + 1}: audio files go on the audio track, not the picture track`);
    if (u.kind === 'image') {
      const motion = c.motion === 'auto' ? AUTO_SEQUENCE[autoIndex++ % AUTO_SEQUENCE.length]! : c.motion;
      return { kind: 'image', uploadId: u.id, startS: 0, lengthS: ms(c.durationS ?? 3), fit: c.fit, motion, volume: 0 };
    }
    const srcS = (u.durationMs ?? 0) / 1000;
    const start = c.trimStartS ?? 0;
    const end = Math.min(c.trimEndS ?? srcS, srcS);
    if (start >= srcS) throw new EditSpecError(`Clip ${i + 1}: trim starts after the recording ends (${srcS.toFixed(1)}s)`);
    if (end - start < EDIT_LIMITS.minClipS) throw new EditSpecError(`Clip ${i + 1}: keep at least ${EDIT_LIMITS.minClipS}s of the recording`);
    return { kind: 'video', uploadId: u.id, startS: ms(start), lengthS: ms(end - start), fit: c.fit, motion: 'none', volume: u.hasAudio ? c.volume : 0 };
  });

  const lengths = base.map((c) => c.lengthS);
  const transitionS = transitionLength(req.transition, lengths);
  const { at, total: totalS } = timeline(lengths, transitionS);
  const clips = base.map((c, i) => ({ ...c, atS: at[i]! }) as SpecClip);

  if (totalS > EDIT_LIMITS.maxTotalS) {
    throw new EditSpecError(`The video would be ${totalS.toFixed(1)}s long; the limit is ${EDIT_LIMITS.maxTotalS}s`);
  }
  // Overlays that start after the end would never show: almost certainly a UI bug, say so.
  // Ends past the end are clamped (dragging a caption to "the end" is a normal thing to do).
  const clampEnd = <T extends { startS: number; endS: number }>(o: T, what: string, i: number): T => {
    if (o.startS >= totalS) throw new EditSpecError(`${what} ${i + 1} starts after the video ends (${totalS.toFixed(1)}s)`);
    return { ...o, startS: ms(o.startS), endS: ms(Math.min(o.endS, totalS)) };
  };
  // ---- audio tracks ----
  const audio: SpecAudio[] = req.audio.map((a, i) => {
    const u = uploads.get(a.uploadId);
    if (!u) throw new EditSpecError(`Audio ${i + 1}: file not found`);
    if (u.kind === 'image' || !u.hasAudio) throw new EditSpecError(`Audio ${i + 1}: that file has no sound`);
    if (a.atS >= totalS) throw new EditSpecError(`Audio ${i + 1} starts after the video ends (${totalS.toFixed(1)}s)`);
    const srcS = (u.durationMs ?? 0) / 1000;
    if (a.trimStartS >= srcS) throw new EditSpecError(`Audio ${i + 1}: trim starts after the file ends`);
    const end = Math.min(a.trimEndS ?? srcS, srcS, a.trimStartS + (totalS - a.atS));
    if (end - a.trimStartS < 0.1) throw new EditSpecError(`Audio ${i + 1}: nothing left to play`);
    return { uploadId: u.id, atS: ms(a.atS), startS: ms(a.trimStartS), lengthS: ms(end - a.trimStartS), volume: a.volume, duck: a.duck };
  });

  // ---- auto captions: source-time words -> output-time words ----
  let autoCaptions: SpecAutoCaptions | null = null;
  if (req.autoCaptions) {
    const ac = req.autoCaptions;
    const u = uploads.get(ac.uploadId);
    if (!u?.words) throw new EditSpecError('Auto captions: that file has no transcript yet');
    // Where is that file's audio on the output timeline? An audio track, or a video clip.
    const windows: { atS: number; startS: number; lengthS: number }[] = [
      ...audio.filter((a) => a.uploadId === u.id),
      ...clips.filter((c): c is SpecMediaClip => c.kind === 'video' && c.uploadId === u.id).map((c) => ({ atS: c.atS, startS: c.startS, lengthS: c.lengthS })),
    ];
    if (!windows.length) throw new EditSpecError('Auto captions: add that file to the video or the audio track first');
    const words: SpecAutoCaptions['words'] = [];
    for (const win of windows) {
      for (const wd of u.words) {
        if (wd.s < win.startS || wd.e > win.startS + win.lengthS) continue;
        const s0 = win.atS + wd.s - win.startS;
        if (s0 >= totalS) continue;
        words.push({ w: wd.w, s: ms(s0), e: ms(Math.min(totalS, win.atS + wd.e - win.startS)) });
      }
    }
    words.sort((a, b) => a.s - b.s);
    autoCaptions = { y: ac.y, size: ac.size, color: ac.color, highlight: ac.highlight, style: ac.style, maxWords: ac.maxWords, words: words.slice(0, EDIT_LIMITS.karaokeWords) };
  }

  return {
    v: 3,
    format: req.format,
    background: req.background.toLowerCase(),
    transition: transitionS > 0 ? req.transition : 'none',
    transitionS,
    clips,
    texts: req.texts.map((t, i) => clampEnd(t, 'Caption', i)),
    boxes: req.boxes.map((b, i) => clampEnd({ ...b, w: ms(Math.min(b.w, 1 - b.x)), h: ms(Math.min(b.h, 1 - b.y)) }, 'Highlight', i)),
    audio,
    autoCaptions,
    totalS,
  };
}

/** Read a stored spec back (the worker never trusts the JSON column blindly). */
export function parseStoredSpec(value: unknown): EditSpec | null {
  const v = value as EditSpec | null;
  if (!v || v.v !== 3 || !Array.isArray(v.clips) || v.clips.length === 0 || !(v.format in EDIT_FORMATS)) return null;
  return v;
}

/** Upload ids a spec references (cards have none). */
export const specUploadIds = (spec: EditSpec) => [
  ...new Set([...spec.clips.flatMap((c) => (c.kind === 'card' ? [] : [c.uploadId])), ...spec.audio.map((a) => a.uploadId)]),
];
