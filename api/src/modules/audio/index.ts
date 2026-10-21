import type { SharedEnv } from '../../config/env.js';
import { createCloudflareSpeech, createStubSpeech, type SpeechProvider } from './speech.js';
import { createLocalSpeech, createSpeechRouter } from '../director/local-ai.js';

/**
 * Which speech provider is active. Local (Piper Hindi/English + whisper.cpp) when LOCAL_AI_* is
 * set; Cloudflare (Aura English + Whisper) when its credentials are; both = routed by voice, with
 * transcription preferring local (no daily quota). Neither = the free offline stub.
 */
export function speechFromEnv(env: SharedEnv): SpeechProvider {
  const hasCf = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) && env.SPEECH_PROVIDER !== 'stub';
  const hasLocal = Boolean(env.LOCAL_AI_URL && env.LOCAL_AI_TOKEN) && env.SPEECH_PROVIDER !== 'stub';
  const cloud = hasCf ? createCloudflareSpeech({ accountId: env.CLOUDFLARE_ACCOUNT_ID!, apiToken: env.CLOUDFLARE_API_TOKEN!, timeoutMs: env.PROVIDER_TIMEOUT_MS }) : null;
  const local = hasLocal ? createLocalSpeech({ baseUrl: env.LOCAL_AI_URL!, token: env.LOCAL_AI_TOKEN! }) : null;
  if (!cloud && !local) return createStubSpeech();
  if (cloud && !local) return cloud;
  return createSpeechRouter(local, cloud);
}
