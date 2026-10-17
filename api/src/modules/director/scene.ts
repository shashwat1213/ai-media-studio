import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { runProcess } from '../../lib/run-process.js';
import type { Storage } from '../../lib/storage.js';
import { probeMedia } from '../editor/probe.js';
import type { SpeechProvider, Word } from '../audio/speech.js';
import type { PublicItem } from '../library/library.js';
import { ProviderError } from '../generation/providers/types.js';
import { beatUnitS, matchStock, snapToBeat, stockArgs, stockTrack, type StockTrack } from '../audio/stock-music.js';
import { direct, spokenLanguage, type DirectorModel, type SceneLanguage, type Script, type Shot } from './director.js';
import type { PictureEngine } from './local-ai.js';
import { placeCaptions, placeTitle, type FaceBox, type SceneFormat } from './placement.js';

/**
 * Scene production (runs in the worker): script -> for each shot a picture and a narration clip,
 * a sound bed picked from the user's SOUND library by the shot's sound description, then an
 * editor draft (EditRequest) the user opens, tweaks and renders.
 *
 * Every made file is a normal Upload of the user (AI_IMAGE / TTS), so the editor, credits-free
 * re-renders, deletion and ownership checks all work unchanged.
 */

export interface SceneShot extends Shot {
  /** Picture + narration produced for this shot. */
  imageUploadId?: string;
  /** AI-video scenes: the picture, animated (an MP4 exactly shotLength long). Used instead of the picture. */
  videoUploadId?: string;
  voiceUploadId?: string;
  /** Narration word timings (shot-local seconds) for karaoke captions. */
  words?: Word[];
  voiceS?: number;
  seed?: number;
  /** The full prompt sent to the picture model (shown in the storyboard). */
  imagePrompt?: string;
  /** Faces found in the picture (0..1) + its size; on-screen titles are placed away from them. */
  faces?: FaceBox[];
  picSize?: { w: number; h: number };
  error?: string;
}

export interface SceneScript extends Omit<Script, 'shots'> {
  shots: SceneShot[];
  /** Library SOUND chosen as the bed, if any. */
  soundUploadId?: string;
  /** Built-in music bed (stock-music.ts) chosen after planning; shots are cut on its beat. */
  music?: { id: string; bpm?: number; uploadId?: string };
  /** Built-in ambience (rain, ocean…) matched from the sound descriptions. */
  ambience?: { id: string; uploadId?: string };
  /** Beat unit (s) every cut snaps to; set when music with a tempo is chosen. */
  beatS?: number;
  /** Music/ambience were chosen (once per scene). */
  stockChosen?: boolean;
}

export const SCENE_FORMAT_PX: Record<string, { w: number; h: number }> = {
  '9:16': { w: 512, h: 768 },
  '16:9': { w: 768, h: 448 },
  '1:1': { w: 640, h: 640 },
};

/**
 * Picture prompt for a shot. SD 1.5 reads only ~75 tokens and weights the START most, so the
 * identity of each library item (character look, place) goes FIRST, verbatim, every time; then the
 * shot's own action/framing; then the style. That ordering is what keeps a character's clothes and
 * hair the same across shots (tested: putting the description after the action let the model
 * change the kurta's colour). Pure.
 */
/** The character whose face this shot should keep (first CHARACTER in the shot with a consented face reference). Pure. */
export function faceCharacterFor(shot: Shot, library: PublicItem[]): PublicItem | null {
  return library.find((i) => i.kind === 'CHARACTER' && shot.uses.includes(i.handle) && i.imageUploadId && i.settings.faceRef === true && Boolean(i.settings.faceConsent)) ?? null;
}

/**
 * SD 1.5 (DreamShaper) drifts towards "glamour" outfits for people, especially with words like dance /
 * night / neon: an emerald saree came out as a crop top with a bare midriff in 3 of 4 shots (16 Oct).
 * Measured on the same seed: negatives alone don't hold at LCM cfg 1.5; a WEIGHTED prefix at the
 * start of the prompt (+ cfg 2 in the gateway) keeps people dressed as described. Applied to every shot
 * that shows a person; objects/landscapes are left alone.
 */
export const MODEST_PREFIX = '(modestly dressed:1.4), (full-sleeve top covering the stomach:1.3), fully clothed';
export const MODEST_NEGATIVE = 'cleavage, bare midriff, navel, crop top, bra, bikini, lingerie, thigh slit, bare legs, off-shoulder, revealing clothes, sexy';
const PERSON_RE = /\b(wom[ae]n|girls?|lady|ladies|m[ae]n|boys?|guys?|person|people|she|he|her|his|they|dancer|model|traveller|traveler|athlete|couple|bride|groom|actress|actor|kid|friends?)\b/i;
export const showsPerson = (shot: Shot, library: PublicItem[]) =>
  PERSON_RE.test(shot.visual) || library.some((i) => i.kind === 'CHARACTER' && shot.uses.includes(i.handle));

export function imagePromptFor(shot: Shot, library: PublicItem[]): { prompt: string; negative?: string; seed?: number } {
  const used = library.filter((i) => shot.uses.includes(i.handle));
  const style = library.find((i) => i.kind === 'STYLE');
  const ids = used.filter((i) => i.description && (i.kind === 'CHARACTER' || i.kind === 'PLACE'));
  // Characters first (most important to keep), then places.
  ids.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'CHARACTER' ? -1 : 1));
  const person = showsPerson(shot, library);
  const parts = [...(person ? [MODEST_PREFIX] : []), ...ids.map((i) => i.description), shot.visual];
  parts.push((style?.settings.promptSuffix as string | undefined) ?? 'cinematic photo, highly detailed, sharp focus');
  const ch = ids.find((i) => i.kind === 'CHARACTER' && typeof i.settings.seed === 'number');
  const negative = [style?.settings.negative as string | undefined, 'lowres, blurry, bad anatomy, deformed hands, extra fingers, text, watermark, logo', person ? MODEST_NEGATIVE : undefined]
    .filter(Boolean)
    .join(', ');
  return { prompt: parts.join(', ').slice(0, 1400), negative, seed: ch?.settings.seed as number | undefined };
}

/** Best SOUND item for a description: most tag/word overlaps, music beds preferred. Pure. */
export function pickSound(description: string, mood: string, sounds: PublicItem[]): PublicItem | null {
  const words = new Set(`${description} ${mood}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));
  let best: { item: PublicItem; score: number } | null = null;
  for (const s of sounds) {
    if (!s.settings.uploadId) continue;
    const tags = [...((s.settings.tags as string[] | undefined) ?? []), ...s.name.toLowerCase().split(/\s+/), ...s.description.toLowerCase().split(/[^a-z]+/)];
    const hits = tags.filter((t) => words.has(t.toLowerCase())).length;
    if (hits === 0) continue; // a bonus must never pick an unrelated sound
    const score = hits + (s.settings.role === 'music' ? 0.5 : 0);
    if (!best || score > best.score) best = { item: s, score };
  }
  return best?.item ?? null;
}

/** Director camera words -> the editor's Ken Burns moves. */
export const CAMERA_TO_MOTION = {
  zoomin: 'zoom-in',
  zoomout: 'zoom-out',
  panleft: 'pan-left',
  panright: 'pan-right',
  panup: 'pan-up',
  pandown: 'pan-down',
  static: 'none',
} as const satisfies Record<Shot['camera'], string>;

/** Hero shots: the opening and the closing shot (the moments people remember). Pure. */
export const isHeroShot = (i: number, n: number) => i === 0 || i === n - 1;

/** Where each shot starts on the output timeline (clips overlap by the 0.5 s crossfade). Pure. */
export const SCENE_TRANSITION_S = 0.5;
/**
 * How long a shot is on screen: its planned duration, or longer when its narration needs it. With a
 * beat (`beatS`), lengthened so every cut lands on the music's beat (see snapToBeat). Pure.
 */
export const shotLength = (s: SceneShot, beatS?: number) => {
  const base = Math.round(Math.max(s.durationS, (s.voiceS ?? 0) + 0.6) * 100) / 100;
  return beatS ? snapToBeat(base, beatS, SCENE_TRANSITION_S) : base;
};
export function shotStarts(script: SceneScript): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const s of script.shots) {
    starts.push(Math.round(t * 1000) / 1000);
    if (s.imageUploadId) t += shotLength(s, script.beatS) - SCENE_TRANSITION_S;
  }
  return starts;
}
/** Total length of the scene's video (the last shot's end). Pure. */
export function sceneLength(script: SceneScript): number {
  const starts = shotStarts(script);
  let end = 0;
  script.shots.forEach((s, i) => {
    if (s.imageUploadId) end = starts[i]! + shotLength(s, script.beatS);
  });
  return Math.round(end * 1000) / 1000;
}

/** Mood word (from the director) -> a stock music bed, when the brief itself names nothing. */
const MOOD_MUSIC: Record<string, string> = { upbeat: 'sunny', calm: 'lofi', romantic: 'lofi', dramatic: 'cinematic', epic: 'cinematic', mysterious: 'cinematic', sad: 'cinematic', tense: 'cinematic', angry: 'cinematic', energetic: 'pulse', happy: 'sunny' };

/**
 * Built-in music + ambience for a scene. Music: the user's choice ('none' / a track id), else (auto)
 * what the BRIEF and the shots' sound lines name ("dance", "chai", "motivational"), else the
 * director's mood. Skipped when the user's own library already gave a music bed. Ambience: only when
 * the sound lines / brief name one (rain, waves, traffic…) and the library gave no ambience. Pure.
 */
export function chooseStock(
  choice: string,
  brief: string,
  script: Pick<SceneScript, 'mood' | 'shots'>,
  libraryBed: PublicItem | null,
): { music: StockTrack | null; ambience: StockTrack | null } {
  const sounds = script.shots.map((s) => s.sound).join(' ');
  const bedRole = libraryBed?.settings.role;
  let music: StockTrack | null = null;
  if (choice !== 'none' && bedRole !== 'music') {
    // Priority: the user's words (brief) > the director's mood > words in its sound lines. A stray
    // "quiet hum" in one shot's sound line must not turn an angry, dramatic scene into lo-fi.
    const mood = MOOD_MUSIC[script.mood.toLowerCase()];
    music = choice !== 'auto' ? stockTrack(choice) : (matchStock(brief, 'music') ?? (mood ? stockTrack(mood) : null) ?? matchStock(sounds, 'music') ?? stockTrack('lofi'));
    if (music?.role !== 'music') music = null;
  }
  const ambience = bedRole === 'ambience' ? null : matchStock(`${sounds} ${brief}`, 'ambience');
  return { music, ambience };
}

/**
 * Script + produced shots -> the editor draft's picture side: one clip per shot (camera move as
 * Ken Burns, long enough for its narration + a breath), crossfades, on-screen texts.
 * Audio (one joined narration track + the ducked sound bed) and karaoke captions are added by
 * produceScene once those files exist. Pure, unit-tested.
 */
export function buildDraft(script: SceneScript) {
  const starts = shotStarts(script);
  const clips: unknown[] = [];
  const texts: unknown[] = [];
  script.shots.forEach((s, i) => {
    if (!s.imageUploadId) return;
    const len = shotLength(s, script.beatS);
    clips.push(
      s.videoUploadId
        ? { uploadId: s.videoUploadId, trimStartS: 0, trimEndS: len, fit: 'cover', volume: 0 }
        : { uploadId: s.imageUploadId, durationS: len, fit: 'cover', motion: CAMERA_TO_MOTION[s.camera] },
    );
    if (s.onScreen) {
      const st = starts[i]!;
      // Away from the faces in this shot's picture (0.14 when none were found, as before).
      const y = placeTitle(s.faces, s.onScreen, script.format as SceneFormat, s.picSize ?? SCENE_FORMAT_PX[script.format]);
      texts.push({ text: s.onScreen, startS: Math.round((st + 0.3) * 100) / 100, endS: Math.round((st + len - 0.4) * 100) / 100, x: 0.5, y, size: 'l', color: '#ffffff', style: 'box', anim: 'slide' });
    }
  });
  return { title: script.title, format: script.format, transition: 'fade', background: '#000000', clips, texts, boxes: [] as unknown[] };
}

/**
 * Caption words = the SCRIPT's words (exactly what the director wrote, in Devanagari or Roman),
 * timed by speech recognition. Whisper only supplies timing: its spelling can be wrong (it heard
 * "सूरत" for "सूरज"), the script can't.
 * Per shot: the recognised words inside that shot's narration window give the timing; when the
 * counts match they're used 1:1, otherwise the window is split by word length. Shots whose voice
 * wasn't recognised at all fall back to the shot's own voice window. Pure, unit-tested.
 */
export function alignCaptionWords(
  lines: { text: string; startS: number; endS: number }[],
  heard: Word[],
): Word[] {
  const out: Word[] = [];
  const r = (n: number) => Math.round(n * 1000) / 1000;
  for (const line of lines) {
    const words = line.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const inside = heard.filter((w) => w.s >= line.startS - 0.15 && w.s < line.endS + 0.15);
    if (inside.length === words.length) {
      words.forEach((w, i) => out.push({ w, s: r(inside[i]!.s), e: r(inside[i]!.e) }));
      continue;
    }
    const from = inside.length ? inside[0]!.s : line.startS;
    const to = inside.length ? inside.at(-1)!.e : line.endS;
    const span = Math.max(0.2, to - from);
    const weights = words.map((w) => Math.max(1, w.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = from;
    words.forEach((w, i) => {
      const d = (span * weights[i]!) / total;
      out.push({ w, s: r(t), e: r(t + d) });
      t += d;
    });
  }
  return out;
}

export interface ProduceDeps {
  prisma: PrismaClient;
  storage: Storage;
  director: DirectorModel;
  /** Hinglish -> Devanagari model (optional; defaults to the director). */
  scribe?: DirectorModel;
  pictures: PictureEngine;
  speech: SpeechProvider;
  logger: Logger;
  ffmpegPath?: string;
}

async function saveUpload(deps: ProduceDeps, userId: string, data: Buffer, mime: string, ext: string, name: string, extra: Partial<Prisma.UploadUncheckedCreateInput>) {
  const id = randomUUID();
  const storageKey = `uploads/${userId}/${id}.${ext}`;
  await deps.storage.put(storageKey, data, mime);
  return deps.prisma.upload.create({
    data: { id, userId, status: 'READY', storageKey, fileName: name, mimeType: mime, bytes: data.length, ...extra },
  });
}

/**
 * All narration in ONE audio file (one Piper/Aura voice, one transcript), each shot's line placed at
 * its shot's start with silence between. The editor gets one voice track + exact karaoke timings,
 * and stays within its 4-audio-track limit for any number of shots.
 */
async function narrationTrack(deps: ProduceDeps, dir: string, script: SceneScript, starts: number[]) {
  const parts: { file: string; at: number }[] = [];
  for (let i = 0; i < script.shots.length; i++) {
    const s = script.shots[i]!;
    if (!s.voiceUploadId || !s.voiceS) continue;
    const u = await deps.prisma.upload.findUniqueOrThrow({ where: { id: s.voiceUploadId } });
    const f = path.join(dir, `n${i}`);
    await deps.storage.download(u.storageKey, f);
    parts.push({ file: f, at: starts[i]! + 0.2 });
  }
  if (!parts.length) return null;
  const out = path.join(dir, 'narration.mp3');
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  const graph =
    parts.map((p, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${Math.round(p.at * 1000)}:all=1[a${i}]`).join(';') +
    `;${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:normalize=0:duration=longest[a]`;
  await runProcess(deps.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputs, '-filter_complex', graph, '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '128k', out], { timeoutMs: 120_000 });
  return out;
}

/** Face boxes for title placement. Best effort: no detector / an error -> undefined (default spot). */
async function findFaces(deps: ProduceDeps, image: Buffer, log: Logger, signal?: AbortSignal): Promise<FaceBox[] | undefined> {
  if (!deps.pictures.faces) return undefined;
  try {
    return await deps.pictures.faces(image, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    log.warn({ err: (err as Error).message }, 'face detection skipped');
    return undefined;
  }
}

/** Plan (LLM) + produce (pictures, voice, sound) + draft. Updates the Scene row as it goes. */
/** The scene was stopped (FAILED) while it was being made. */
class SceneStopped extends Error {}

export async function produceScene(sceneId: string, deps: ProduceDeps, signal?: AbortSignal): Promise<'ready' | 'failed' | 'skipped'> {
  const { prisma } = deps;
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene || scene.status === 'READY' || scene.status === 'FAILED') return 'skipped';
  const log = deps.logger.child({ sceneId });
  // Progress writes double as a cancellation check: a scene stopped meanwhile (FAILED, e.g. by a
  // moderator) is never flipped back, and production stops at the next step.
  const progress = async (p: string) => {
    const { count } = await prisma.scene.updateMany({ where: { id: sceneId, status: { in: ['PLANNING', 'PRODUCING'] } }, data: { progress: p } });
    if (count === 0) throw new SceneStopped();
  };

  const library = (await prisma.libraryItem.findMany({ where: { userId: scene.userId } })).map((i) => ({ ...i, settings: (i.settings ?? {}) as Record<string, unknown> })) as PublicItem[];
  const mentioned = new Set([...scene.prompt.matchAll(/@([a-z0-9_]{2,32})/gi)].map((m) => m[1]!.toLowerCase()));
  const libForPrompt = library.filter((i) => mentioned.has(i.handle) || i.kind === 'STYLE');

  // The narrator: a VOICE library item (@handle) or a raw voice id.
  const voiceItem = library.find((i) => i.kind === 'VOICE' && i.handle === scene.voice);
  const voiceId = (voiceItem?.settings.voice as string | undefined) ?? scene.voice;

  const dir = await mkdtemp(path.join(tmpdir(), 'scene-'));
  try {
    // 1) Plan.
    let script: SceneScript = scene.script as unknown as SceneScript;
    if (!script) {
      await progress('Writing the script…');
      const s = await direct(deps.director, { prompt: scene.prompt, language: scene.language as SceneLanguage, format: scene.format as '9:16', targetS: scene.targetS, library: libForPrompt }, signal, deps.scribe ?? deps.director);
      script = { ...s, shots: s.shots };
      const { count } = await prisma.scene.updateMany({ where: { id: sceneId, status: { in: ['PLANNING', 'PRODUCING'] } }, data: { status: 'PRODUCING', title: s.title, script: script as unknown as Prisma.InputJsonValue } });
      if (count === 0) throw new SceneStopped();
    }

    // 1b) Music, chosen now so every shot (and every AI-video clip) is cut to its beat.
    // Once per scene (a retry keeps the choice). Never re-time a scene whose AI clips already exist.
    if (!script.stockChosen) {
      const bed = pickSound(script.shots.map((s) => s.sound).join(' '), script.mood, library.filter((i) => i.kind === 'SOUND'));
      const { music, ambience } = chooseStock(scene.music, scene.prompt, script, bed);
      script.music = music ? { id: music.id, bpm: music.bpm } : undefined;
      script.ambience = ambience ? { id: ambience.id } : undefined;
      const madeClips = script.shots.some((s) => s.videoUploadId);
      script.beatS = music?.bpm && !madeClips ? beatUnitS(music.bpm) : undefined;
      script.stockChosen = true;
      await prisma.scene.update({ where: { id: sceneId }, data: { script: script as unknown as Prisma.InputJsonValue } });
    }

    const px = SCENE_FORMAT_PX[scene.format] ?? SCENE_FORMAT_PX['9:16']!;
    const n = script.shots.length;
    const faceCache = new Map<string, Buffer | null>();
    // 2) Pictures (GPU, one at a time) and narration (CPU) per shot. Resumable: done shots are skipped.
    for (let i = 0; i < n; i++) {
      const s = script.shots[i]!;
      if (!s.imageUploadId) {
        await progress(scene.hd ? `Picture ${i + 1} of ${n} (HD)…` : `Picture ${i + 1} of ${n}…`);
        const ip = imagePromptFor(s, library);
        // Same face in every shot: the character's reference photo (must still be the user's own READY upload).
        const faceItem = faceCharacterFor(s, library);
        let faceRef: Buffer | undefined;
        if (faceItem?.imageUploadId) {
          if (!faceCache.has(faceItem.imageUploadId)) {
            const ref = await prisma.upload.findFirst({ where: { id: faceItem.imageUploadId, userId: scene.userId, status: 'READY', mimeType: { in: ['image/png', 'image/jpeg'] } } });
            faceCache.set(faceItem.imageUploadId, ref ? await deps.storage.get(ref.storageKey) : null);
          }
          faceRef = faceCache.get(faceItem.imageUploadId) ?? undefined;
        }
        const pic = await deps.pictures.picture({ prompt: ip.prompt, negative: ip.negative, width: px.w, height: px.h, seed: ip.seed, upscale: scene.hd, faceRef }, signal);
        const ext = pic.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const up = await saveUpload(deps, scene.userId, pic.data, pic.mimeType, ext, `shot-${i + 1}.${ext}`, { source: 'AI_IMAGE', width: pic.width, height: pic.height, script: ip.prompt });
        s.imageUploadId = up.id;
        s.imagePrompt = ip.prompt;
        s.seed = pic.seed ?? undefined;
        s.picSize = { w: pic.width, h: pic.height };
        s.faces = await findFaces(deps, pic.data, log, signal);
      }
      if (s.narration && !s.voiceUploadId) {
        await progress(`Voice ${i + 1} of ${n}…`);
        const v = await deps.speech.speak(s.narration, voiceId, signal);
        const f = path.join(dir, `v${i}`);
        await writeFile(f, v.data);
        const info = await probeMedia(f, v.mimeType === 'audio/wav' ? 'audio/wav' : 'audio/mpeg');
        const up = await saveUpload(deps, scene.userId, v.data, v.mimeType, v.mimeType === 'audio/wav' ? 'wav' : 'mp3', `voice-${i + 1}.${v.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`, {
          source: 'TTS', hasAudio: true, durationMs: info.durationMs, script: s.narration, voice: voiceId,
        });
        s.voiceUploadId = up.id;
        s.voiceS = (info.durationMs ?? 0) / 1000;
      }
      await prisma.scene.update({ where: { id: sceneId }, data: { script: script as unknown as Prisma.InputJsonValue } });
    }

    // 2b) AI video: animate each shot's picture (GPU, ~7 min each). After all voices so each clip is
    // exactly as long as its shot. Resumable like the rest: a retried scene keeps finished clips.
    if (scene.motion === 'ai' || scene.motion === 'hero') {
      if (!deps.pictures.clip) throw new ProviderError('no video engine', { retryable: false, userMessage: 'AI video is not available. Start the local AI with the Wan models.' });
      for (let i = 0; i < n; i++) {
        const s = script.shots[i]!;
        if (s.videoUploadId || !s.imageUploadId) continue;
        if (scene.motion === 'hero' && !isHeroShot(i, n)) continue;
        const preset = scene.motion === 'hero' ? 'fast' : 'full';
        await progress(scene.motion === 'hero' ? `Moving shot ${i + 1} (hero, ~3 min)…` : `Moving shot ${i + 1} of ${n} (AI video, ~7 min each)…`);
        const pic = await prisma.upload.findFirstOrThrow({ where: { id: s.imageUploadId, userId: scene.userId } });
        const len = shotLength(s, script.beatS);
        const clip = await deps.pictures.clip({ prompt: s.visual, ref: await deps.storage.get(pic.storageKey), width: px.w, height: px.h, seconds: len, seed: s.seed, preset }, signal);
        const f = path.join(dir, `m${i}.mp4`);
        await writeFile(f, clip.data);
        const info = await probeMedia(f, 'video/mp4');
        const up = await saveUpload(deps, scene.userId, clip.data, 'video/mp4', 'mp4', `shot-${i + 1}-moving.mp4`, {
          source: 'AI_VIDEO', width: info.width ?? clip.width, height: info.height ?? clip.height, durationMs: info.durationMs, hasAudio: false, script: s.visual,
        });
        s.videoUploadId = up.id;
        await prisma.scene.update({ where: { id: sceneId }, data: { script: script as unknown as Prisma.InputJsonValue } });
      }
    }

    // 3) Sound bed from the library.
    const allSound = script.shots.map((s) => s.sound).join(' ');
    const bed = pickSound(allSound, script.mood, library.filter((i) => i.kind === 'SOUND'));
    script.soundUploadId = (bed?.settings.uploadId as string | undefined) ?? undefined;

    // 4) One narration track (exact positions) + its transcript for karaoke captions.
    await progress('Assembling…');
    const draft = buildDraft(script);
    const starts = shotStarts(script);
    const narr = await narrationTrack(deps, dir, script, starts);
    const audioTracks: unknown[] = [];
    let autoCaptions: unknown = null;
    if (narr) {
      const data = await readFile(narr);
      const info = await probeMedia(narr, 'audio/mpeg');
      const up = await saveUpload(deps, scene.userId, data, 'audio/mpeg', 'mp3', `${(script.title || 'scene').replace(/[^\w .()-]/g, '_').slice(0, 40)} - narration.mp3`, {
        source: 'TTS', hasAudio: true, durationMs: info.durationMs, script: script.shots.map((s) => s.narration).filter(Boolean).join(' '), voice: voiceId,
      });
      audioTracks.push({ uploadId: up.id, atS: 0, trimStartS: 0, volume: 1, duck: false });
      // Karaoke: transcribe the joined narration (free: it's our own TTS). Best effort.
      try {
        await progress('Captions…');
        const mp3 = path.join(dir, 'stt.mp3');
        await runProcess(deps.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', narr, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', mp3], { timeoutMs: 60_000 });
        const lang = scene.language as SceneLanguage;
        const tr = await deps.speech.transcribe(await readFile(mp3), { language: spokenLanguage(lang), signal });
        // Caption text = the script (Roman for Hinglish), timed by what was heard.
        const lines = script.shots.flatMap((s, i) =>
          s.narration && s.voiceS ? [{ text: lang === 'hinglish' ? s.roman || s.narration : s.narration, startS: starts[i]! + 0.2, endS: starts[i]! + 0.2 + s.voiceS }] : [],
        );
        const words = alignCaptionWords(lines, tr.words);
        const transcript = { language: tr.language, text: lines.map((l) => l.text).join(' '), words, durationS: tr.durationS };
        await prisma.upload.update({ where: { id: up.id }, data: { transcriptStatus: 'DONE', transcript: transcript as unknown as Prisma.InputJsonValue, transcriptCost: 0 } });
        const capY = placeCaptions(script.shots.filter((s) => s.imageUploadId).map((s) => s.faces), script.format as SceneFormat, script.shots.find((s) => s.picSize)?.picSize ?? SCENE_FORMAT_PX[script.format]);
        if (words.length) autoCaptions = { uploadId: up.id, y: capY, size: 'l', color: '#ffffff', highlight: '#facc15', style: 'outline', maxWords: lang === 'hinglish' || lang === 'en' ? 4 : 3 };
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'scene captions skipped');
      }
    }
    if (script.soundUploadId) audioTracks.push({ uploadId: script.soundUploadId, atS: 0, trimStartS: 0, volume: 0.45, duck: true });
    // Built-in music / ambience, rendered to the scene's exact length (beat 1 = the first frame).
    // Both duck under the narration; ambience sits lower. Kept on the script so a retry reuses them.
    const total = sceneLength(script);
    for (const key of ['music', 'ambience'] as const) {
      const pick = script[key];
      const track = pick ? stockTrack(pick.id) : null;
      if (!pick || !track || total <= 0) continue;
      if (!pick.uploadId) {
        await progress(key === 'music' ? `Music: ${track.name}…` : `Ambience: ${track.name}…`);
        const f = path.join(dir, `${key}.mp3`);
        await runProcess(deps.ffmpegPath ?? 'ffmpeg', stockArgs(track.id, total, f), { timeoutMs: 120_000, signal });
        const data = await readFile(f);
        const info = await probeMedia(f, 'audio/mpeg');
        const up = await saveUpload(deps, scene.userId, data, 'audio/mpeg', 'mp3', `${track.name}.mp3`, { source: 'MUSIC', hasAudio: true, durationMs: info.durationMs, script: track.id });
        pick.uploadId = up.id;
        await prisma.scene.update({ where: { id: sceneId }, data: { script: script as unknown as Prisma.InputJsonValue } });
      }
      audioTracks.push({ uploadId: pick.uploadId, atS: 0, trimStartS: 0, volume: track.volume, duck: true });
    }
    const finalDraft = { ...draft, audio: audioTracks, autoCaptions };

    const { count: finished } = await prisma.scene.updateMany({
      where: { id: sceneId, status: { in: ['PLANNING', 'PRODUCING'] } },
      data: { status: 'READY', progress: null, script: script as unknown as Prisma.InputJsonValue, draft: finalDraft as unknown as Prisma.InputJsonValue },
    });
    if (finished === 0) throw new SceneStopped();
    log.info({ shots: n }, 'scene ready');
    return 'ready';
  } catch (err) {
    if (err instanceof SceneStopped) {
      log.warn('scene stopped while producing');
      return 'failed';
    }
    const msg = err instanceof ProviderError ? err.userMessage : 'Something went wrong while making the scene.';
    log.warn({ err: (err as Error).message }, 'scene failed');
    // Progress so far (pictures already made) is kept in `script`; the user can retry.
    await prisma.scene.update({ where: { id: sceneId }, data: { status: 'FAILED', error: msg, progress: null } });
    if (err instanceof ProviderError && err.retryable) throw err; // let the queue retry
    return 'failed';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
