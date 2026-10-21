import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../lib/run-process.js';
import { ProviderError } from '../generation/providers/types.js';
import { MODEST_PREFIX } from './scene.js';
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
export const CF_PICTURE_GUIDANCE = 1.5;

export interface CloudflareAiOptions {
  accountId: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Mean brightness (0-255) of a picture; default = ffmpeg signalstats. Injectable for tests. */
  brightness?: (png: Buffer) => Promise<number>;
}

/**
 * The hosted LCM model sometimes returns an (almost) black frame, its safety filter's output.
 * A shot that is pure black ruins the reel, so such a picture is regenerated with another seed.
 * Measured 21 Oct 2026: blocked frame mean luma 15, normal night street 69.
 */
export const BLACK_FRAME_LUMA = 24;
const PICTURE_TRIES = 3;

export async function meanLuma(png: Buffer, ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg'): Promise<number> {
  const dir = await mkdtemp(path.join(tmpdir(), 'luma-'));
  try {
    const f = path.join(dir, 'p.png');
    await writeFile(f, png);
    const { stdout } = await runProcess(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', f, '-vf', 'scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'],
      { timeoutMs: 20_000 },
    );
    const m = /YAVG=([\d.]+)/.exec(stdout);
    return m ? Number(m[1]) : 255; // can't tell -> don't block the scene
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

/**
 * The hosted model ignores A1111-style weights, so `(modestly dressed:1.4)` is just noise and the
 * local modesty prefix does nothing there. Measured on Workers AI, 21 Oct 2026, 6 seeds, same brief:
 *   local prefix as-is                       -> 3/4 bare midriffs, childlike faces
 *   "adult woman, long-sleeved top, covered" -> 6/6 adults, 6/6 crop tops
 *   naming a long kurta + trousers (below)   -> 6/6 adults, 6/6 fully covered
 */
export const CLOUD_MODEST = 'adult Indian woman in her twenties wearing a long knee-length kurta with full sleeves and loose trousers, modest traditional outfit, fully covered';
export const CLOUD_NEGATIVE_EXTRA = 'child, kid, teen, see-through';

/** Local (A1111-weighted) prompt -> what the hosted model understands. Pure. */
export function cloudPrompt(prompt: string, negative?: string): { prompt: string; negative?: string } {
  const modest = prompt.startsWith(MODEST_PREFIX);
  const body = (modest ? prompt.slice(MODEST_PREFIX.length).replace(/^,\s*/, '') : prompt)
    .replace(/\(([^()]+?):\d+(?:\.\d+)?\)/g, '$1'); // (word:1.3) -> word
  return {
    prompt: (modest ? `${CLOUD_MODEST}, ${body}` : body).slice(0, 2000),
    negative: modest ? [CLOUD_NEGATIVE_EXTRA, negative].filter(Boolean).join(', ').slice(0, 2000) : negative?.slice(0, 2000),
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
      const brightness = o.brightness ?? ((b: Buffer) => meanLuma(b));
      const p = cloudPrompt(req.prompt, req.negative);
      let seed = req.seed;
      for (let attempt = 1; ; attempt++) {
        const res = await run(CF_PICTURE_MODEL, {
          prompt: p.prompt,
          ...(p.negative ? { negative_prompt: p.negative } : {}),
          width,
          height,
          num_steps: 8,
          // LCM models need a LOW guidance: the API default (7.5) burns the colours (measured
          // 21 Oct 2026, same seed: 7.5 = neon green blowout, 1.5 = natural photo). Local uses cfg ~2.
          guidance: CF_PICTURE_GUIDANCE,
          ...(seed !== undefined ? { seed } : {}),
        }, signal);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length < 100 || !(data[0] === 0x89 && data[1] === 0x50)) {
          throw new ProviderError('cloudflare returned no picture', { retryable: true, userMessage: 'The AI provider returned no picture.' });
        }
        if (attempt >= PICTURE_TRIES || (await brightness(data)) >= BLACK_FRAME_LUMA) {
          return { data, mimeType: 'image/png', seed: seed ?? null, width, height };
        }
        seed = ((seed ?? 0) + 7919 * attempt) % 2_147_483_647; // a different picture next time
      }
    },
  };
}
