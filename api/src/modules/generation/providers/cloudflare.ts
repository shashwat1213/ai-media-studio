import { findModel, upstreamModelId } from '../models.js';
import { classify as classifyStatus } from './openrouter.js';
import { ProviderError, type GenerateRequest, type GeneratedImage, type ImageProvider } from './types.js';

interface CloudflareRunResponse {
  success?: boolean;
  result?: { image?: string };
  errors?: { code?: number; message?: string }[];
}

/**
 * Real AI images on Cloudflare Workers AI's FREE allocation (10,000 Neurons/day, no card).
 * REST API, checked 2026-10-13:
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
 *   Authorization: Bearer <API token with "Workers AI: Read" + "Workers AI: Edit">
 *   body { prompt, steps }  ->  { success, result: { image: <base64 JPEG> }, errors }
 *
 * flux-1-schnell has no width/height inputs: it always returns a 1024x1024 JPEG, which is why
 * the Cloudflare catalog only offers 1:1. When the daily allocation runs out, Cloudflare answers
 * 429 (or 4006 in the error body); that's not retryable today, so the user gets a clear message
 * and their credits back instead of three pointless retries.
 *
 * `fetchImpl` is injectable so tests never hit the network.
 */
export function createCloudflareProvider(opts: {
  accountId: string;
  apiToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): ImageProvider {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    name: 'cloudflare',
    async generate({ prompt, model, signal }: GenerateRequest): Promise<GeneratedImage> {
      const info = findModel(model);
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/ai/run/${upstreamModelId(model)}`;
      const timeout = AbortSignal.timeout(opts.timeoutMs);

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiToken}`, 'Content-Type': 'application/json' },
          // The model's max prompt is 2048 chars; ours is capped at 1000 by the API schema.
          body: JSON.stringify({ prompt, steps: info?.params?.steps ?? 4 }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        throw new ProviderError(`cloudflare network error: ${(err as Error).message}`, {
          retryable: true,
          userMessage: 'Could not reach the AI provider.',
        });
      }

      const body = (await res.json().catch(() => ({}))) as CloudflareRunResponse;
      const detail = body.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') ?? '';

      if (!res.ok || body.success === false) {
        if (res.status === 429 || /\b4006\b|neurons|daily/i.test(detail)) {
          throw new ProviderError(`cloudflare ${res.status}: ${detail}`, {
            status: res.status,
            retryable: false,
            userMessage: "Today's free image quota is used up. It resets at 00:00 UTC.",
          });
        }
        const e = classifyStatus(res.ok ? 502 : res.status, detail);
        throw new ProviderError(e.message.replace(/^openrouter/, 'cloudflare'), {
          status: e.status,
          retryable: e.retryable,
          userMessage: e.userMessage,
        });
      }

      const b64 = body.result?.image;
      if (!b64) {
        throw new ProviderError('cloudflare returned no image', {
          retryable: true,
          userMessage: 'The AI provider returned no image.',
        });
      }
      const data = Buffer.from(b64, 'base64');
      return { data, mimeType: sniffMime(data), width: 1024, height: 1024, costUsd: 0 };
    },
  };
}

/** The API returns base64 without a media type: read the magic bytes. */
export function sniffMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}
