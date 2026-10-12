import { ProviderError, type GenerateRequest, type GeneratedImage, type ImageProvider } from './types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/images';

interface OpenRouterImageResponse {
  data?: { b64_json?: string; media_type?: string }[];
  usage?: { cost?: number };
  error?: { message?: string };
}

/**
 * Real AI via OpenRouter's dedicated Image API (researched 2026-10-12):
 *   POST /api/v1/images { model, prompt, aspect_ratio, n } -> { data: [{ b64_json, media_type }], usage: { cost } }
 * Billing is all-or-nothing: a failed generation returns an error and is NOT billed.
 *
 * `fetchImpl` is injectable so tests can simulate every response without spending money.
 */
export function createOpenRouterProvider(opts: {
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  appUrl?: string;
}): ImageProvider {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    name: 'openrouter',
    async generate({ prompt, model, aspectRatio, signal }: GenerateRequest): Promise<GeneratedImage> {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
            // Optional attribution headers OpenRouter uses for its app rankings.
            'HTTP-Referer': opts.appUrl ?? 'https://github.com/shashwat1213/ai-media-studio',
            'X-Title': 'AI Media Studio',
          },
          body: JSON.stringify({ model, prompt, aspect_ratio: aspectRatio, n: 1 }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        // DNS failure, connection reset, timeout: all worth retrying.
        throw new ProviderError(`openrouter network error: ${(err as Error).message}`, {
          retryable: true,
          userMessage: 'Could not reach the AI provider.',
        });
      }

      const body = (await res.json().catch(() => ({}))) as OpenRouterImageResponse;
      if (!res.ok) throw classify(res.status, body.error?.message);

      const first = body.data?.[0];
      if (!first?.b64_json) {
        throw new ProviderError('openrouter returned no image', {
          retryable: true,
          userMessage: 'The AI provider returned no image.',
        });
      }
      return {
        data: Buffer.from(first.b64_json, 'base64'),
        mimeType: first.media_type ?? 'image/png',
        costUsd: body.usage?.cost,
      };
    },
  };
}

/** HTTP status -> retry decision + safe message. */
export function classify(status: number, detail = ''): ProviderError {
  const msg = `openrouter ${status}: ${detail}`.trim();
  if (status === 429) return new ProviderError(msg, { status, retryable: true, userMessage: 'The AI provider is busy. Please try again.' });
  if (status >= 500) return new ProviderError(msg, { status, retryable: true, userMessage: 'The AI provider is temporarily unavailable.' });
  if (status === 401 || status === 402 || status === 403)
    // Our key / our OpenRouter balance: not the user's fault, and retrying won't fix it.
    return new ProviderError(msg, { status, retryable: false, userMessage: 'Image generation is unavailable right now.' });
  return new ProviderError(msg, { status, retryable: false, userMessage: 'The model rejected this prompt.' });
}
