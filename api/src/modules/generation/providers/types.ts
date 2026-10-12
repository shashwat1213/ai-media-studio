/**
 * The AI provider boundary. The worker only knows this interface, so swapping
 * OpenRouter for another vendor (or the free stub) touches nothing else.
 */
export interface GenerateRequest {
  prompt: string;
  model: string;
  aspectRatio: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  /** What the provider charged us, if it reports it (OpenRouter: usage.cost). */
  costUsd?: number;
}

export interface ImageProvider {
  readonly name: 'stub' | 'openrouter';
  generate(req: GenerateRequest): Promise<GeneratedImage>;
}

/**
 * A provider failure with two extra facts the worker needs:
 * - retryable: is trying again likely to help? (network blip, 5xx, 429 -> yes; bad request, content policy -> no)
 * - userMessage: what we can safely show the user. Raw provider errors can contain internals.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly status?: number;
  constructor(message: string, opts: { retryable: boolean; userMessage: string; status?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.userMessage = opts.userMessage;
    this.status = opts.status;
  }
}
