import { ProviderError } from '../generation/providers/types.js';
import { AURA_VOICES, parseWhisper, type SpeechProvider, type Voice } from '../audio/speech.js';

/**
 * Clients for the LOCAL AI gateway (scripts/local-ai/gateway.py) running on the user's machine:
 * pictures (stable-diffusion.cpp on the GPU), Piper voices (Hindi + English), whisper.cpp STT.
 * Containers reach it at http://host.docker.internal:8082 with a shared bearer token.
 */

export interface LocalAiOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const down = (err: unknown) =>
  new ProviderError(`local ai unreachable: ${(err as Error).message}`, {
    retryable: true,
    userMessage: 'The local AI is not running. Start it with scripts/local-ai/start.sh.',
  });

function client(o: LocalAiOptions) {
  const doFetch = o.fetchImpl ?? fetch;
  return async (path: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal }) => {
    const t = AbortSignal.timeout(init.timeoutMs ?? o.timeoutMs ?? 300_000);
    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${o.token}`, ...(init.headers ?? {}) },
        signal: init.signal ? AbortSignal.any([init.signal, t]) : t,
      });
    } catch (err) {
      throw down(err);
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new ProviderError(`local ai ${path} HTTP ${res.status}`, { retryable, userMessage: retryable ? 'The local AI failed. Try again.' : 'The local AI refused the request.', status: res.status });
    }
    return res;
  };
}

/** Piper voices as library-friendly entries. Ids are the model names the gateway lists. */
export const PIPER_VOICES: Voice[] = [
  { id: 'hi_IN-rohan-medium', name: 'Rohan (Hindi)', style: 'Male, clear narrator', gender: 'male' },
  { id: 'hi_IN-pratham-medium', name: 'Pratham (Hindi)', style: 'Male, warm', gender: 'male' },
  { id: 'hi_IN-priyamvada-medium', name: 'Priyamvada (Hindi)', style: 'Female, soft', gender: 'female' },
  { id: 'en_US-ryan-high', name: 'Ryan (English, offline)', style: 'Male, clear narrator', gender: 'male' },
  { id: 'en_US-lessac-medium', name: 'Lessac (English, offline)', style: 'Female, neutral', gender: 'female' },
  { id: 'en_GB-alan-medium', name: 'Alan (British English, offline)', style: 'Male, calm', gender: 'male' },
];

/** Default narrator per spoken language when the user didn't pick one that fits. */
export const DEFAULT_NARRATOR = { hi: 'hi_IN-rohan-medium', en: 'en_US-ryan-high' } as const;
/** Which language a voice speaks (Piper ids carry it; Aura is English). */
export const voiceLanguage = (id: string): 'hi' | 'en' => (id.startsWith('hi_') ? 'hi' : 'en');

export interface PictureRequest {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed?: number;
  /** HD: upscale x4 on the GPU (Real-ESRGAN) to a 1920px long side; returns a JPEG. */
  upscale?: boolean;
  /** Same face in every shot: a PNG/JPEG of the character's face (IP-Adapter). */
  faceRef?: Buffer;
  faceStrength?: number;
}
export interface Picture {
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  seed: number | null;
  /** Real output size (differs from the request when upscaled). */
  width: number;
  height: number;
}
export interface PictureEngine {
  readonly name: string;
  picture(req: PictureRequest, signal?: AbortSignal): Promise<Picture>;
}

/** Final size of an HD (upscaled) picture: long side 1920, even numbers, same shape. Pure. */
export const HD_LONG_SIDE = 1920;
export function hdSize(w: number, h: number): { width: number; height: number } {
  const k = HD_LONG_SIDE / Math.max(w, h);
  return { width: Math.round((w * k) / 2) * 2, height: Math.round((h * k) / 2) * 2 };
}

export function createLocalPictures(o: LocalAiOptions): PictureEngine {
  const call = client(o);
  return {
    name: 'local-sd15',
    async picture(req, signal) {
      const res = await call('/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: req.prompt, negative: req.negative, width: req.width, height: req.height, seed: req.seed, steps: 6,
          ...(req.upscale ? { upscale: true } : {}),
          ...(req.faceRef ? { faceRef: req.faceRef.toString('base64'), faceStrength: req.faceStrength ?? 0.65 } : {}),
        }),
        signal,
        // SD (~12 s) + ESRGAN x4 (~31 s) on a 4 GB GPU, queued behind other pictures.
        timeoutMs: req.upscale ? 600_000 : undefined,
      });
      const num = (h: string) => {
        const v = res.headers.get(h);
        const n = v === null || v === '' ? NaN : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const mimeType = (res.headers.get('content-type') ?? '').startsWith('image/jpeg') ? 'image/jpeg' : 'image/png';
      const fallback = req.upscale ? hdSize(req.width, req.height) : { width: req.width, height: req.height };
      return {
        data: Buffer.from(await res.arrayBuffer()),
        mimeType,
        seed: num('x-seed'),
        width: num('x-width') ?? fallback.width,
        height: num('x-height') ?? fallback.height,
      };
    },
  };
}

/**
 * Speech on the local gateway: Piper TTS (Hindi + English) and whisper.cpp STT. Implements the same
 * SpeechProvider interface as Cloudflare, so voice-overs / transcription work with either.
 */
export function createLocalSpeech(o: LocalAiOptions): SpeechProvider {
  const call = client(o);
  return {
    name: 'local',
    voices: PIPER_VOICES,
    async speak(text, voice, signal) {
      const res = await call('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }), signal, timeoutMs: 120_000 });
      return { data: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/wav' };
    },
    async transcribe(audio, opts = {}) {
      const q = opts.language ? `?language=${encodeURIComponent(opts.language)}` : '';
      const res = await call(`/transcribe${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(audio), signal: opts.signal, timeoutMs: 900_000 });
      return parseWhisper((await res.json()) as Parameters<typeof parseWhisper>[0]);
    },
  };
}

/**
 * Route by voice: Piper ids go to the local gateway, Aura ids to Cloudflare. Transcription prefers
 * local (no daily quota), falling back to the cloud if the local one is down.
 */
export function createSpeechRouter(local: SpeechProvider | null, cloud: SpeechProvider | null): SpeechProvider {
  const all = [...(local?.voices ?? []), ...(cloud?.voices ?? [])];
  const isLocal = (v: string) => Boolean(local?.voices.some((x) => x.id === v));
  return {
    name: [local?.name, cloud?.name].filter(Boolean).join('+') || 'none',
    voices: all,
    async speak(text, voice, signal) {
      const p = isLocal(voice) ? local : cloud;
      if (!p) throw new ProviderError('no speech provider for voice', { retryable: false, userMessage: 'That voice is not available.' });
      return p.speak(text, voice, signal);
    },
    async transcribe(audio, opts) {
      if (local) {
        try {
          return await local.transcribe(audio, opts);
        } catch (err) {
          if (!cloud || !(err instanceof ProviderError) || !err.retryable) throw err;
        }
      }
      if (!cloud) throw new ProviderError('no transcription provider', { retryable: false, userMessage: 'Transcription is unavailable.' });
      return cloud.transcribe(audio, opts);
    },
  };
}

export const isAuraVoice = (v: string) => AURA_VOICES.some((x) => x.id === v);
