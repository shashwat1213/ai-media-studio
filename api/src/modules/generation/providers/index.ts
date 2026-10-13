import type { SharedEnv } from '../../../config/env.js';
import type { ProviderMode } from '../models.js';
import { createCloudflareProvider } from './cloudflare.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createStubProvider } from './stub.js';
import type { ImageProvider } from './types.js';

type ProviderEnv = Pick<SharedEnv, 'AI_PROVIDER' | 'OPENROUTER_API_KEY' | 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN'>;

/**
 * Which provider is really active. Missing credentials => stub, always: we never call a real
 * provider by accident (the env schema also refuses to boot in that case, belt and braces).
 */
export function providerMode(env: ProviderEnv): ProviderMode {
  if (env.AI_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.AI_PROVIDER === 'cloudflare' && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) return 'cloudflare';
  return 'stub';
}

export function providerFromEnv(env: SharedEnv): ImageProvider {
  switch (providerMode(env)) {
    case 'openrouter':
      return createOpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY!, timeoutMs: env.PROVIDER_TIMEOUT_MS });
    case 'cloudflare':
      return createCloudflareProvider({
        accountId: env.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: env.CLOUDFLARE_API_TOKEN!,
        timeoutMs: env.PROVIDER_TIMEOUT_MS,
      });
    default:
      return createStubProvider(env.STUB_DELAY_MS);
  }
}
