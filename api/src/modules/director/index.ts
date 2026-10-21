import type { SharedEnv } from '../../config/env.js';
import { createStubClipBytes, createStubImageBytes } from './stub-picture.js';
import { createLocalDirector, createStubDirector, type DirectorModel } from './director.js';
import { createLocalPictures, hdSize, type PictureEngine } from './local-ai.js';

export function directorFromEnv(env: SharedEnv): DirectorModel {
  if (env.LOCAL_LLM_URL && env.LOCAL_AI_TOKEN) {
    const d = createLocalDirector({ baseUrl: env.LOCAL_LLM_URL, apiKey: env.LOCAL_AI_TOKEN });
    return d;
  }
  return createStubDirector();
}

export function scribeFromEnv(env: SharedEnv): DirectorModel | undefined {
  if (env.LOCAL_SCRIBE_URL && env.LOCAL_AI_TOKEN) return createLocalDirector({ baseUrl: env.LOCAL_SCRIBE_URL, apiKey: env.LOCAL_AI_TOKEN, timeoutMs: 120_000 });
  return undefined;
}

export function picturesFromEnv(env: SharedEnv): PictureEngine {
  if (env.LOCAL_AI_URL && env.LOCAL_AI_TOKEN) return createLocalPictures({ baseUrl: env.LOCAL_AI_URL, token: env.LOCAL_AI_TOKEN });
  return {
    name: 'stub',
    picture: async (req) => {
      const { width, height } = req.upscale ? hdSize(req.width, req.height) : { width: req.width, height: req.height };
      return { data: await createStubImageBytes(width, height), mimeType: 'image/png', seed: req.seed ?? 0, width, height };
    },
    clip: async (req) => {
      const w = Math.round(req.width / 4) * 2, h = Math.round(req.height / 4) * 2;
      return { data: await createStubClipBytes(w, h, req.seconds), mimeType: 'video/mp4', width: w, height: h };
    },
  };
}

export interface LocalAiStatus {
  llm: boolean;
  image: boolean;
  /** The gateway has the ESRGAN model, so HD pictures are possible. */
  upscale: boolean;
  /** The gateway has IP-Adapter, so library characters can keep the same face. */
  faceRef: boolean;
  /** The gateway has the Wan models, so shots can be animated (AI video). */
  video: boolean;
}

/** Is the local AI up? (cheap health checks; used by the UI to explain why scenes can't run). */
export async function localAiStatus(env: SharedEnv): Promise<LocalAiStatus> {
  if (!env.LOCAL_AI_TOKEN) return { llm: false, image: false, upscale: false, faceRef: false, video: false };
  const health = async (url?: string): Promise<Record<string, unknown> | null> => {
    if (!url) return null;
    try {
      const r = await fetch(`${url.replace(/\/$/, '')}/health`, { headers: { Authorization: `Bearer ${env.LOCAL_AI_TOKEN}` }, signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      return ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const [llm, gw] = await Promise.all([health(env.LOCAL_LLM_URL), health(env.LOCAL_AI_URL)]);
  return { llm: llm !== null, image: gw !== null, upscale: gw?.upscale === true, faceRef: gw?.faceRef === true, video: gw?.video === true };
}
