import { ProviderError } from '../generation/providers/types.js';

/**
 * The speech boundary: text -> voice (TTS) and audio -> words with timings (STT).
 * The rest of the app only knows these interfaces, so the free Cloudflare models can be swapped
 * for a local model (Piper / whisper.cpp via an HTTP server) or a paid one without touching
 * routes, credits or the renderer.
 */

export interface Voice {
  id: string;
  name: string;
  /** Short description for the picker. */
  style: string;
  gender: 'female' | 'male';
}

export interface TtsResult {
  data: Buffer;
  mimeType: 'audio/mpeg' | 'audio/wav';
}

export interface Word {
  /** The word as spoken (with punctuation). */
  w: string;
  /** Start / end in seconds. */
  s: number;
  e: number;
}

export interface Transcript {
  language: string;
  text: string;
  words: Word[];
  durationS: number;
}

export interface SpeechProvider {
  readonly name: string;
  readonly voices: Voice[];
  speak(text: string, voice: string, signal?: AbortSignal): Promise<TtsResult>;
  /** `audio` = a small mono MP3/WAV (the worker extracts and downsamples it first). */
  transcribe(audio: Buffer, opts?: { language?: string; signal?: AbortSignal }): Promise<Transcript>;
}

/** Deepgram Aura-2 (English) voices available on Workers AI. All verified to respond. */
export const AURA_VOICES: Voice[] = [
  { id: 'luna', name: 'Luna', style: 'Friendly, upbeat', gender: 'female' },
  { id: 'asteria', name: 'Asteria', style: 'Clear, confident', gender: 'female' },
  { id: 'thalia', name: 'Thalia', style: 'Energetic, bright', gender: 'female' },
  { id: 'athena', name: 'Athena', style: 'Calm, professional', gender: 'female' },
  { id: 'helena', name: 'Helena', style: 'Warm, natural', gender: 'female' },
  { id: 'orion', name: 'Orion', style: 'Steady, approachable', gender: 'male' },
  { id: 'arcas', name: 'Arcas', style: 'Natural, smooth', gender: 'male' },
  { id: 'apollo', name: 'Apollo', style: 'Confident, casual', gender: 'male' },
  { id: 'zeus', name: 'Zeus', style: 'Deep, authoritative', gender: 'male' },
  { id: 'hermes', name: 'Hermes', style: 'Expressive, engaging', gender: 'male' },
];

const TTS_MODEL = '@cf/deepgram/aura-2-en';
const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';

function errorFor(status: number, what: string): ProviderError {
  // 429 / 5xx: try again later. 4xx: our request is wrong; retrying won't help.
  const retryable = status === 429 || status >= 500;
  const userMessage =
    status === 429 ? 'The free daily AI quota is used up. Try again tomorrow.' : retryable ? `${what} is temporarily unavailable.` : `${what} failed.`;
  return new ProviderError(`cloudflare ${what} HTTP ${status}`, { retryable, userMessage, status });
}

/**
 * Cloudflare Workers AI: Deepgram Aura-2 for TTS (returns MP3 bytes), Whisper large-v3-turbo for
 * STT (word timestamps). Both run on the account's FREE daily allocation.
 * Measured: ~1.5-2 s per sentence of TTS; ~21 s to transcribe 126 s of speech.
 */
export function createCloudflareSpeech(opts: { accountId: string; apiToken: string; timeoutMs?: number; fetchImpl?: typeof fetch }): SpeechProvider {
  const base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/`;
  const doFetch = opts.fetchImpl ?? fetch;
  const call = (model: string, body: unknown, signal?: AbortSignal) =>
    doFetch(base + model, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 120_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });

  return {
    name: 'cloudflare',
    voices: AURA_VOICES,
    async speak(text, voice, signal) {
      const res = await call(TTS_MODEL, { text, speaker: voice, encoding: 'mp3' }, signal);
      if (!res.ok) throw errorFor(res.status, 'Voice-over');
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 100) throw new ProviderError('tts returned an empty file', { retryable: true, userMessage: 'Voice-over failed.' });
      return { data, mimeType: 'audio/mpeg' };
    },
    async transcribe(audio, o = {}) {
      const res = await call(STT_MODEL, { audio: audio.toString('base64'), ...(o.language ? { language: o.language } : {}) }, o.signal);
      if (!res.ok) throw errorFor(res.status, 'Transcription');
      const json = (await res.json()) as {
        result?: {
          text?: string;
          transcription_info?: { language?: string; duration?: number };
          segments?: { words?: { word: string; start: number; end: number }[] }[];
        };
      };
      return parseWhisper(json.result);
    },
  };
}

/** Whisper (turbo) result -> our Transcript. Pure, unit-tested with canned output. */
export function parseWhisper(r: {
  text?: string;
  transcription_info?: { language?: string; duration?: number };
  segments?: { words?: { word: string; start: number; end: number }[] }[];
} | undefined): Transcript {
  if (!r) throw new ProviderError('empty transcription', { retryable: true, userMessage: 'Transcription failed.' });
  const words: Word[] = [];
  for (const seg of r.segments ?? []) {
    for (const w of seg.words ?? []) {
      const text = w.word.trim();
      if (!text || !(w.end >= w.start)) continue;
      words.push({ w: text, s: round(w.start), e: round(w.end) });
    }
  }
  return { language: r.transcription_info?.language ?? 'unknown', text: (r.text ?? '').trim(), words, durationS: round(r.transcription_info?.duration ?? words.at(-1)?.e ?? 0) };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Free, offline stand-in for tests and stub mode: a sine "voice" whose length follows the text,
 * and a "transcription" that returns one word per 0.4 s. Deterministic.
 */
export function createStubSpeech(): SpeechProvider {
  return {
    name: 'stub',
    voices: AURA_VOICES.slice(0, 2),
    async speak(text) {
      const seconds = Math.max(1, Math.min(60, text.split(/\s+/).length * 0.35));
      return { data: wavTone(seconds), mimeType: 'audio/wav' };
    },
    async transcribe(audio) {
      // The worker always sends 32 kbps MP3 (STT_EXTRACT_ARGS) = 4000 bytes per second.
      const durationS = audio.length / 4000;
      const words: Word[] = [];
      for (let t = 0; t + 0.4 <= durationS && words.length < 500; t += 0.4) words.push({ w: `word${words.length + 1}`, s: round(t), e: round(t + 0.35) });
      return { language: 'en', text: words.map((w) => w.w).join(' '), words, durationS: round(durationS) };
    },
  };
}

/** 16 kHz mono 16-bit WAV of a quiet 220 Hz tone. */
export function wavTone(seconds: number): Buffer {
  const rate = 16000;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  return buf;
}
