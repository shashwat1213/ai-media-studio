import type { SharedEnv } from '../../config/env.js';
import { createStubImageBytes } from './stub-picture.js';
import { createLocalDirector, createStubDirector, type DirectorModel } from './director.js';
import { createLocalPictures, type PictureEngine } from './local-ai.js';

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
  return { name: 'stub', picture: async (req) => ({ data: await createStubImageBytes(req.width, req.height), mimeType: 'image/png', seed: req.seed ?? 0 }) };
}

/** Is the local AI up? (cheap health checks; used by the UI to explain why scenes can't run). */
export async function localAiStatus(env: SharedEnv): Promise<{ llm: boolean; image: boolean }> {
  if (!env.LOCAL_AI_TOKEN) return { llm: false, image: false };
  const ok = async (url?: string) => {
    if (!url) return false;
    try {
      const r = await fetch(`${url.replace(/\/$/, '')}/health`, { headers: { Authorization: `Bearer ${env.LOCAL_AI_TOKEN}` }, signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  };
  const [llm, image] = await Promise.all([ok(env.LOCAL_LLM_URL), ok(env.LOCAL_AI_URL)]);
  return { llm, image };
}
