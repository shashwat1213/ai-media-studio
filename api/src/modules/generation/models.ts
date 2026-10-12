/**
 * The model catalog: the ONLY list of models users can pick, and what each costs.
 * Prices are in code (not fetched live) so the price shown in the UI is always
 * the price charged, and a provider price change can't silently change our pricing.
 *
 * USD prices: OpenRouter Image API endpoints, checked 2026-10-12
 *   GET https://openrouter.ai/api/v1/images/models/<id>/endpoints  -> pricing[].cost_usd
 * Credits: asymmetric pricing (00_PROJECT_BASE §4a). A pricier model costs more credits.
 */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  credits: number;
  usdPerImage: number;
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'recraft/recraft-v4.1-flash',
    name: 'Recraft V4.1 Flash',
    description: 'Fastest and cheapest. Great for quick drafts and ideas.',
    credits: 2,
    usdPerImage: 0.007,
  },
  {
    id: 'bytedance-seed/seedream-5-0-flash',
    name: 'Seedream 5.0 Flash',
    description: 'Balanced quality and speed. A good default for most prompts.',
    credits: 5,
    usdPerImage: 0.018,
  },
  {
    id: 'qwen/qwen-image-3',
    name: 'Qwen Image 3',
    description: 'Highest quality of the three, strongest at rendering text in images.',
    credits: 8,
    usdPerImage: 0.03,
  },
] as const;

/** Aspect ratios every model in the catalog supports (checked against each endpoint's supported_parameters). */
export const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const MODEL_IDS = MODELS.map((m) => m.id) as [string, ...string[]];

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
