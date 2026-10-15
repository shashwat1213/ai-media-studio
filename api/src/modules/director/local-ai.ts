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
  { id: 'en_US-lessac-medium', name: 'Lessac (English, offline)', style: 'Female, neutral', gender: 'female' },
];

export interface PictureRequest {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed?: number;
}
export interface PictureEngine {
  readonly name: string;
  picture(req: PictureRequest, signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string; seed: number | null }>;
}

export function createLocalPictures(o: LocalAiOptions): PictureEngine {
  const call = client(o);
  return {
    name: 'local-sd15',
    async picture(req, signal) {
      const res = await call('/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: req.prompt, negative: req.negative, width: req.width, height: req.height, seed: req.seed, steps: 6 }),
        signal,
      });
      const seed = Number(res.headers.get('x-seed'));
      return { data: Buffer.from(await res.arrayBuffer()), mimeType: 'image/png', seed: Number.isFinite(seed) ? seed : null };
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
