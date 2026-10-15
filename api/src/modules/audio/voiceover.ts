import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { HttpError, tooManyRequests } from '../../lib/errors.js';
import { runProcess } from '../../lib/run-process.js';
import type { Storage } from '../../lib/storage.js';
import { applyDebit, applyGrant } from '../credits/credits.service.js';
import { ProviderError } from '../generation/providers/types.js';
import { probeMedia } from '../editor/probe.js';
import type { SpeechProvider } from './speech.js';

/**
 * Voice-over: the user's script -> an MP3 in their media library (an Upload with source TTS),
 * ready to drop on the audio track and to auto-caption (transcription is free for these).
 *
 * Runs in the API request (a few seconds per paragraph), not the queue: the user is waiting for
 * it, and it's short. Credits are debited first and refunded if anything fails, in the same
 * request (no half state survives: the upload row is only created on success).
 */

export const TTS_MAX_CHARS = 3000;
/** 1 credit per started 500 characters. */
export const TTS_CHARS_PER_CREDIT = 500;
export const ttsCost = (chars: number) => Math.max(1, Math.ceil(chars / TTS_CHARS_PER_CREDIT));
/** Aura works best on short inputs; we send at most this much per request and join the parts. */
const CHUNK_CHARS = 400;
/** Short silence between chunks so joined sentences don't run together. */
const GAP_S = 0.25;

/** Split a script into sentence-ish chunks under `max` characters. Pure, unit-tested. */
export function chunkScript(text: string, max = CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Sentence ends (incl. the Devanagari danda), keeping the punctuation.
  const sentences = clean.match(/[^.!?।]+[.!?।]*\s*/g) ?? [clean];
  const chunks: string[] = [];
  let cur = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      // One very long sentence: break on commas, then on spaces.
      if (cur) chunks.push(cur);
      let rest = s;
      while (rest.length > max) {
        const cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf(' ', max));
        const at = cut > max * 0.4 ? cut + 1 : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest; // the tail starts the next chunk
      continue;
    }
    if ((cur + ' ' + s).trim().length > max) {
      chunks.push(cur);
      cur = s;
    } else cur = (cur + ' ' + s).trim();
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface VoiceoverDeps {
  prisma: PrismaClient;
  storage: Storage;
  speech: SpeechProvider;
  ffmpegPath?: string;
  maxUploadsPerUser?: number;
}

export async function createVoiceover(deps: VoiceoverDeps, userId: string, input: { script: string; voice: string; title?: string }) {
  const { prisma, storage, speech } = deps;
  const script = input.script.replace(/\r\n?/g, '\n').trim();
  if (!script) throw new HttpError(400, 'Write a script first');
  if (script.length > TTS_MAX_CHARS) throw new HttpError(400, `Script is too long (max ${TTS_MAX_CHARS} characters)`);
  if (!speech.voices.some((v) => v.id === input.voice)) throw new HttpError(400, 'Unknown voice');
  const count = await prisma.upload.count({ where: { userId } });
  if (count >= (deps.maxUploadsPerUser ?? 200)) throw tooManyRequests(`You have ${count} files. Delete some first.`);

  const cost = ttsCost(script.length);
  const id = randomUUID();
  const ref = `tts:${id}`;
  await prisma.$transaction((tx) => applyDebit(tx, userId, cost, 'GENERATION', ref)); // 402 if too poor

  const dir = await mkdtemp(path.join(tmpdir(), 'tts-'));
  const storageKey = `uploads/${userId}/${id}.mp3`;
  try {
    const chunks = chunkScript(script);
    const parts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = await speech.speak(chunks[i]!, input.voice);
      const f = path.join(dir, `p${i}.${r.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`);
      await writeFile(f, r.data);
      parts.push(f);
    }
    // Join (with a short pause) and normalise to one 48 kHz mono MP3. Also fixes MP3 headers.
    const out = path.join(dir, 'voice.mp3');
    const inputs = parts.flatMap((p) => ['-i', p]);
    const graph =
      parts.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=mono,apad=pad_dur=${i < parts.length - 1 ? GAP_S : 0}[p${i}]`).join(';') +
      `;${parts.map((_, i) => `[p${i}]`).join('')}concat=n=${parts.length}:v=0:a=1[a]`;
    await runProcess(
      deps.ffmpegPath ?? 'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputs, '-filter_complex', graph, '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '128k', out],
      { timeoutMs: 60_000 },
    );
    const info = await probeMedia(out, 'audio/mpeg');
    const data = await readFile(out);
    await storage.put(storageKey, data, 'audio/mpeg');
    const name = (input.title?.trim() || script.split('\n')[0]!.slice(0, 40)).replace(/[^\w .()-]/g, '_') || 'voice-over';
    return await prisma.upload.create({
      data: {
        id,
        userId,
        status: 'READY',
        source: 'TTS',
        storageKey,
        fileName: `${name}.mp3`,
        mimeType: 'audio/mpeg',
        bytes: data.length,
        durationMs: info.durationMs,
        hasAudio: true,
        script,
        voice: input.voice,
      },
    });
  } catch (err) {
    await storage.remove(storageKey).catch(() => undefined);
    await prisma.$transaction((tx) => applyGrant(tx, userId, cost, 'REFUND', ref));
    if (err instanceof ProviderError) throw new HttpError(err.status === 429 ? 429 : 502, `${err.userMessage} Your credits were refunded.`);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
