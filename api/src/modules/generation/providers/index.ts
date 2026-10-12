import type { SharedEnv } from '../../../config/env.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createStubProvider } from './stub.js';
import type { ImageProvider } from './types.js';

/** Picks the provider from config. No key => stub, always: we never spend money by accident. */
export function providerFromEnv(env: SharedEnv): ImageProvider {
  if (env.AI_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY) {
    return createOpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY, timeoutMs: env.PROVIDER_TIMEOUT_MS });
  }
  return createStubProvider(env.STUB_DELAY_MS);
}

export function providerMode(env: Pick<SharedEnv, 'AI_PROVIDER' | 'OPENROUTER_API_KEY'>): 'stub' | 'openrouter' {
  return env.AI_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY ? 'openrouter' : 'stub';
}
