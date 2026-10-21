import { ProviderError } from '../generation/providers/types.js';
import type { DirectorModel } from './director.js';
import type { PictureEngine } from './local-ai.js';

/**
 * Cloud engines for the Scene Director, for servers WITHOUT a GPU (e.g. the public demo VM).
 * Both run on Cloudflare Workers AI's free daily allocation (same account as image generation):
 *   - director LLM: Llama 3.3 70B (JSON mode)   ~2 s per shot list (measured 21 Oct 2026)
 *   - pictures:     DreamShaper 8 LCM, 512x768   ~2.5 s per picture
 * No HD upscale, no same-face, no AI video: those stay on the local GPU (the engine simply has
 * no clip()/faces(), and localAiStatus reports upscale/faceRef/video = false).
 */
export const CF_DIRECTOR_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CF_PICTURE_MODEL = '@cf/lykon/dreamshaper-8-lcm';

export interface CloudflareAiOptions {
  accountId: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const QUOTA = "Today's free AI quota is used up. It resets at 00:00 UTC.";

function runner(o: CloudflareAiOptions) {
  const doFetch = o.fetchImpl ?? fetch;
  return async (model: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const t = AbortSignal.timeout(o.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(o.accountId)}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, t]) : t,
      });
    } catch (err) {
      throw new ProviderError(`cloudflare network error: ${(err as Error).message}`, { retryable: true, userMessage: 'Could not reach the AI provider.' });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429 || /\b4006\b|neurons|daily/i.test(text)) {
        throw new ProviderError(`cloudflare ${res.status}: ${text.slice(0, 200)}`, { status: res.status, retryable: false, userMessage: QUOTA });
      }
      throw new ProviderError(`cloudflare ${model} HTTP ${res.status}`, {
        status: res.status,
        retryable: res.status >= 500,
        userMessage: res.status >= 500 ? 'The AI provider failed. Try again.' : 'The AI provider refused the request.',
      });
    }
    return res;
  };
}

export function createCloudflareDirector(o: CloudflareAiOptions): DirectorModel {
  const run = runner(o);
  return {
    name: 'cloudflare-llm',
    async complete(system, user, signal) {
      const res = await run(CF_DIRECTOR_MODEL, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
      }, signal);
      const json = (await res.json().catch(() => ({}))) as { result?: { response?: unknown; choices?: { message?: { content?: string } }[] } };
      const r = json.result;
      // Workers AI answers either OpenAI-style (choices) or legacy ({ response }), and in JSON mode
      // `response` can already be a parsed object.
      const out = r?.choices?.[0]?.message?.content ?? r?.response;
      if (out === undefined || out === null) throw new ProviderError('cloudflare llm returned nothing', { retryable: true, userMessage: 'The AI returned no shot list.' });
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
}

/** Workers AI image models accept 256..2048 px in steps of 8. */
const snap = (n: number) => Math.min(2048, Math.max(256, Math.round(n / 8) * 8));

export function createCloudflarePictures(o: CloudflareAiOptions): PictureEngine {
  const run = runner(o);
  return {
    name: 'cloudflare-sd15',
    async picture(req, signal) {
      const width = snap(req.width);
      const height = snap(req.height);
      const res = await run(CF_PICTURE_MODEL, {
        prompt: req.prompt.slice(0, 2000),
        ...(req.negative ? { negative_prompt: req.negative.slice(0, 2000) } : {}),
        width,
        height,
        num_steps: 8,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      }, signal);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 100 || !(data[0] === 0x89 && data[1] === 0x50)) {
        throw new ProviderError('cloudflare returned no picture', { retryable: true, userMessage: 'The AI provider returned no picture.' });
      }
      return { data, mimeType: 'image/png', seed: req.seed ?? null, width, height };
    },
  };
}
