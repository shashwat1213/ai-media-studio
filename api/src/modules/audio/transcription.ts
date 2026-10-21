import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { HttpError, notFound } from '../../lib/errors.js';
import { runProcess } from '../../lib/run-process.js';
import type { Storage } from '../../lib/storage.js';
import { applyDebit, applyGrant } from '../credits/credits.service.js';
import { ProviderError } from '../generation/providers/types.js';
import type { SpeechProvider, Transcript } from './speech.js';

/**
 * Speech-to-text for an upload's sound (a video with speech, or an audio file).
 *
 * Money + state, same rules as generation jobs:
 *  - request: debit credits + mark PENDING in ONE transaction, then enqueue
 *  - worker:  extract audio -> transcribe -> DONE (guarded: only from PENDING)
 *  - failure: FAILED + refund, exactly once (guarded transition + the ledger's one-REFUND-per-refId index)
 * Voice-overs we generated ourselves are transcribed for free (we know they are speech).
 */

/** 1 credit per started minute of audio. */
export const STT_SECONDS_PER_CREDIT = 60;
export const sttCost = (durationMs: number) => Math.max(1, Math.ceil(durationMs / 1000 / STT_SECONDS_PER_CREDIT));

/** Whisper input: mono 16 kHz, low bitrate MP3 (~4 KB/s): small to upload, plenty for speech. */
export const STT_EXTRACT_ARGS = (input: string, output: string) => [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  '-i', input,
  '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
  output,
];

/** Cloudflare Whisper accepts a whole file per request; 10 minutes of 32 kbps MP3 is ~2.4 MB. */
const MAX_STT_BYTES = 8 * 1024 * 1024;

export async function requestTranscription(
  prisma: PrismaClient,
  enqueue: (uploadId: string, ref: string) => Promise<void>,
  userId: string,
  uploadId: string,
  opts: { language?: string } = {},
) {
  const u = await prisma.upload.findFirst({ where: { id: uploadId, userId, status: 'READY' } });
  if (!u) throw notFound('File not found');
  if (!u.hasAudio) throw new HttpError(400, 'This file has no sound to transcribe');
  if (u.transcriptStatus === 'PENDING') return { status: 'PENDING' as const, cost: u.transcriptCost ?? 0 };
  if (u.transcriptStatus === 'DONE') return { status: 'DONE' as const, cost: 0 };

  const cost = u.source === 'TTS' ? 0 : sttCost(u.durationMs ?? 0);
  // A fresh ref per request: the ledger's partial unique index allows one REFUND per ref, so a
  // second attempt after a refunded failure can be refunded too, never the same one twice.
  const ref = `stt:${u.id}:${randomUUID().slice(0, 8)}`;
  const claimed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.upload.updateMany({
      where: { id: u.id, userId, transcriptStatus: { in: ['NONE', 'FAILED'] } },
      data: { transcriptStatus: 'PENDING', transcriptCost: cost, transcriptRef: cost ? ref : null, transcriptAt: new Date(), transcriptError: null, transcript: opts.language ? { language: opts.language } : undefined },
    });
    if (count === 0) return false; // a parallel request won
    if (cost > 0) await applyDebit(tx, userId, cost, 'GENERATION', ref);
    return true;
  });
  if (!claimed) return { status: 'PENDING' as const, cost: 0 };

  try {
    await enqueue(u.id, ref.split(':')[2]!);
  } catch {
    await failTranscription(prisma, u.id, 'Could not queue the transcription. Your credits were refunded.');
    throw new HttpError(503, 'Transcription queue is unavailable. Your credits were refunded, please try again.');
  }
  return { status: 'PENDING' as const, cost };
}

/** PENDING -> FAILED + refund the reserved credits, at most once. */
export async function failTranscription(prisma: PrismaClient, uploadId: string, message: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const u = await tx.upload.findUnique({ where: { id: uploadId }, select: { userId: true, transcriptCost: true, transcriptRef: true, transcriptStatus: true } });
    if (!u) return false;
    const { count } = await tx.upload.updateMany({
      where: { id: uploadId, transcriptStatus: 'PENDING' },
      data: { transcriptStatus: 'FAILED', transcriptError: message, transcript: undefined },
    });
    if (count === 0) return false;
    if (u.transcriptCost && u.transcriptRef) await applyGrant(tx, u.userId, u.transcriptCost, 'REFUND', u.transcriptRef);
    return true;
  });
}

export interface TranscribeDeps {
  prisma: PrismaClient;
  storage: Storage;
  speech: SpeechProvider;
  logger: Logger;
  ffmpegPath?: string;
}

/** Worker side. Returns 'retry' for transient failures (BullMQ backs off and tries again). */
export async function processTranscription(
  uploadId: string,
  info: { attempt: number; maxAttempts: number; signal?: AbortSignal },
  deps: TranscribeDeps,
): Promise<'done' | 'failed' | 'skipped' | 'retry'> {
  const log = deps.logger.child({ uploadId, attempt: info.attempt, task: 'transcribe' });
  const u = await deps.prisma.upload.findUnique({ where: { id: uploadId } });
  if (!u || u.transcriptStatus !== 'PENDING') return 'skipped';
  const language = (u.transcript as { language?: string } | null)?.language;

  let transcript: Transcript;
  const dir = await mkdtemp(path.join(tmpdir(), 'stt-'));
  try {
    const src = path.join(dir, 'src');
    const mp3 = path.join(dir, 'speech.mp3');
    await deps.storage.download(u.storageKey, src);
    await runProcess(deps.ffmpegPath ?? 'ffmpeg', STT_EXTRACT_ARGS(src, mp3), { timeoutMs: 120_000, signal: info.signal });
    const audio = await readFile(mp3);
    if (audio.length > MAX_STT_BYTES) throw new ProviderError('audio too long for one request', { retryable: false, userMessage: 'This file is too long to transcribe.' });
    transcript = await deps.speech.transcribe(audio, { language, signal: info.signal });
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError((err as Error).message, { retryable: true, userMessage: 'Transcription failed.' });
    if (pe.retryable && info.attempt < info.maxAttempts) {
      log.warn({ err: pe.message }, 'transcription failed, will retry');
      return 'retry';
    }
    log.warn({ err: pe.message }, 'transcription failed for good, refunding');
    await failTranscription(deps.prisma, uploadId, pe.userMessage);
    return 'failed';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const { count } = await deps.prisma.upload.updateMany({
    where: { id: uploadId, transcriptStatus: 'PENDING' },
    data: { transcriptStatus: 'DONE', transcript: transcript as object, transcriptError: null },
  });
  if (count === 0) return 'skipped'; // swept/failed meanwhile: don't overwrite
  log.info({ words: transcript.words.length, language: transcript.language }, 'transcription done');
  return 'done';
}

/** Transcriptions stuck in PENDING (worker died, Redis wiped): fail + refund after the timeout. */
export async function sweepStuckTranscriptions(prisma: PrismaClient, timeoutMinutes: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000);
  const stuck = await prisma.upload.findMany({ where: { transcriptStatus: 'PENDING', transcriptAt: { lt: cutoff } }, select: { id: true }, take: 100 });
  let n = 0;
  for (const u of stuck) if (await failTranscription(prisma, u.id, 'Transcription timed out. Your credits were refunded.')) n++;
  return n;
}
