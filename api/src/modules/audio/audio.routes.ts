import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import type { Storage } from '../../lib/storage.js';
import { requireAuth } from '../auth/require-auth.js';
import type { UploadService } from '../editor/uploads.service.js';
import type { SpeechProvider } from './speech.js';
import { STT_SECONDS_PER_CREDIT, requestTranscription } from './transcription.js';
import { TTS_CHARS_PER_CREDIT, TTS_MAX_CHARS, createVoiceover } from './voiceover.js';

const VoiceoverSchema = z.object({
  script: z.string().max(TTS_MAX_CHARS, `Script is too long (max ${TTS_MAX_CHARS} characters)`),
  voice: z.string().max(30),
  title: z.string().trim().max(60).optional(),
});
const TranscribeSchema = z.object({
  /** ISO-639-1 hint ('en', 'hi'...). Omit to auto-detect. */
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});
const IdParam = z.object({ id: z.string().uuid() });

export function audioRouter(opts: {
  prisma: PrismaClient;
  storage: Storage;
  speech: SpeechProvider;
  uploads: UploadService;
  jwtSecret: string;
  enqueueTranscription?: (uploadId: string, ref: string) => Promise<void>;
  rateLimit: number;
  ffmpegPath?: string;
}): Router {
  const router = Router();
  const auth = requireAuth(opts.jwtSecret);
  // Per user: both endpoints spend the free AI quota.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: opts.rateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.userId!,
    message: { error: 'Too many requests, slow down' },
  });
  // Samples are public (no user): per IP, and generous (they're cached after the first play).
  const limiterPublic = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  router.get('/audio/config', (_req, res) => {
    res.json({
      provider: opts.speech.name,
      voices: opts.speech.voices,
      tts: { maxChars: TTS_MAX_CHARS, charsPerCredit: TTS_CHARS_PER_CREDIT },
      stt: { secondsPerCredit: STT_SECONDS_PER_CREDIT },
    });
  });

  /**
   * A short sample of each voice, generated once and cached in storage (no per-click quota use).
   * Public: the same 1-sentence clip for everyone; the voice id is checked against the list.
   */
  router.get('/audio/sample/:voice', limiterPublic, async (req, res) => {
    const voice = opts.speech.voices.find((v) => v.id === req.params.voice);
    if (!voice) throw new HttpError(404, 'Unknown voice');
    const key = `samples/${opts.speech.name}/${voice.id}.mp3`;
    if (!(await opts.storage.head(key))) {
      const r = await opts.speech.speak(`Hi, I'm ${voice.name}. This is how your voice-over will sound.`, voice.id);
      await opts.storage.put(key, r.data, r.mimeType);
    }
    res.redirect(302, await opts.storage.signedUrl(key));
  });

  /** Script -> voice-over MP3 in the user's library. Synchronous: a few seconds. */
  router.post('/voiceovers', auth, limiter, async (req, res) => {
    const input = VoiceoverSchema.parse(req.body);
    const upload = await createVoiceover({ prisma: opts.prisma, storage: opts.storage, speech: opts.speech, ffmpegPath: opts.ffmpegPath }, req.userId!, input);
    res.status(201).json({ upload: await opts.uploads.get(req.userId!, upload.id) });
  });

  /** Start speech-to-text on a video/audio upload. 202: poll GET /uploads/:id. */
  router.post('/uploads/:id/transcribe', auth, limiter, async (req, res) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(404, 'Not found');
    if (!opts.enqueueTranscription) throw new HttpError(503, 'Transcription is unavailable');
    const input = TranscribeSchema.parse(req.body ?? {});
    const r = await requestTranscription(opts.prisma, opts.enqueueTranscription, req.userId!, parsed.data.id, input);
    res.status(r.status === 'DONE' ? 200 : 202).json(r);
  });

  return router;
}
