/**
 * The model catalogs: the ONLY models users can pick, and what each costs in credits.
 * Prices live in code (not fetched live) so the price shown in the UI is always the price
 * charged, and a provider price change can't silently change our pricing.
 *
 * One catalog per provider, because model ids are provider-specific:
 *   - OpenRouter (paid) ids:   "recraft/recraft-v4.1-flash"
 *   - Cloudflare Workers AI:   "@cf/black-forest-labs/flux-1-schnell"
 * The stub (free fake images) uses the OpenRouter catalog so the UI looks the same.
 *
 * Credits: asymmetric pricing (00_PROJECT_BASE §4a). A heavier model costs more credits.
 */
export const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export type ProviderMode = 'stub' | 'openrouter' | 'cloudflare';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  credits: number;
  /** What one image costs US (USD). 0 = inside a free allowance. Never sent to the browser. */
  usdPerImage: number;
  /** Ratios this model can produce. Some models only output squares. */
  aspectRatios: readonly AspectRatio[];
  /** Provider-specific knobs (e.g. diffusion steps). Never sent to the browser. */
  params?: { steps?: number };
}

/**
 * OpenRouter Image API, prices checked 2026-10-12:
 *   GET https://openrouter.ai/api/v1/images/models/<id>/endpoints  -> pricing
 * NOTE (2026-10-13): OpenRouter has NO free image models (every `:free` model is text-only).
 */
export const OPENROUTER_MODELS: readonly ModelInfo[] = [
  {
    id: 'recraft/recraft-v4.1-flash',
    name: 'Recraft V4.1 Flash',
    description: 'Fastest and cheapest. Great for quick drafts and ideas.',
    credits: 2,
    usdPerImage: 0.007,
    aspectRatios: ASPECT_RATIOS,
  },
  {
    id: 'bytedance-seed/seedream-5-0-flash',
    name: 'Seedream 5.0 Flash',
    description: 'Balanced quality and speed. A good default for most prompts.',
    credits: 5,
    usdPerImage: 0.018,
    aspectRatios: ASPECT_RATIOS,
  },
  {
    id: 'qwen/qwen-image-3',
    name: 'Qwen Image 3',
    description: 'Highest quality of the three, strongest at rendering text in images.',
    credits: 8,
    usdPerImage: 0.03,
    aspectRatios: ASPECT_RATIOS,
  },
] as const;

/**
 * Cloudflare Workers AI, checked 2026-10-13 (developers.cloudflare.com/workers-ai/platform/pricing):
 * the free allocation is 10,000 Neurons per day (resets 00:00 UTC, no card needed).
 *   flux-1-schnell: 4.8 neurons per 512x512 tile + 9.6 per step. Output is 1024x1024 (4 tiles):
 *     4 steps = 19.2 + 38.4 = ~58 neurons  -> ~170 images/day free
 *     8 steps = 19.2 + 76.8 = ~96 neurons  -> ~100 images/day free
 *   It takes only { prompt, steps }: no width/height, so square only.
 * Credits mirror that cost ratio, so users burn the free allowance proportionally.
 */
export const CLOUDFLARE_MODELS: readonly ModelInfo[] = [
  {
    id: '@cf/black-forest-labs/flux-1-schnell',
    name: 'FLUX.1 Schnell',
    description: 'Fast, sharp and photoreal. 4 diffusion steps, a few seconds per image.',
    credits: 2,
    usdPerImage: 0,
    aspectRatios: ['1:1'],
    params: { steps: 4 },
  },
  {
    id: '@cf/black-forest-labs/flux-1-schnell:hq',
    name: 'FLUX.1 Schnell HQ',
    description: 'Same model, twice the diffusion steps: finer detail, a little slower.',
    credits: 4,
    usdPerImage: 0,
    aspectRatios: ['1:1'],
    params: { steps: 8 },
  },
] as const;

export function catalogFor(mode: ProviderMode): readonly ModelInfo[] {
  return mode === 'cloudflare' ? CLOUDFLARE_MODELS : OPENROUTER_MODELS;
}

/** Every model id any provider knows. A job keeps its model id even if the provider changes later. */
const ALL_MODELS = [...OPENROUTER_MODELS, ...CLOUDFLARE_MODELS];

export function findModel(id: string, catalog: readonly ModelInfo[] = ALL_MODELS): ModelInfo | undefined {
  return catalog.find((m) => m.id === id);
}

/** Back-compat: the default (stub/OpenRouter) catalog. */
export const MODELS = OPENROUTER_MODELS;

/** The provider's own model name: our ids may carry a ":variant" suffix (same model, other params). */
export function upstreamModelId(id: string): string {
  const i = id.indexOf(':', id.startsWith('@cf/') ? 4 : 0);
  return i === -1 ? id : id.slice(0, i);
}
