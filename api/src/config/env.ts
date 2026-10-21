import { z } from 'zod';

/**
 * All configuration comes from environment variables (12-factor app).
 * Validated ONCE at boot: a missing/wrong value crashes the process immediately
 * with a readable message instead of failing randomly later.
 *
 * Two processes read config: the API (server.ts) and the worker (worker.ts).
 * They share the infrastructure settings (db, redis, s3, ai); only the API needs auth secrets.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** Treat an empty string as "not set" for an optional variable. */
const emptyAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

const SharedSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  // Bearer token protecting GET /metrics. Required in production (see refine below).
  METRICS_TOKEN: z.string().min(16).optional(),

  // --- Queue (Redis + BullMQ) ---
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // --- Object storage (S3 in prod, MinIO/Silo locally) ---
  // S3_ENDPOINT unset = real AWS S3. Locally: the MinIO URL the *server* can reach.
  S3_ENDPOINT: z.string().url().optional(),
  // The URL the *browser* can reach (presigned links are signed for this host). Defaults to S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('ai-media-assets'),
  // Unset in prod: the ECS task role provides credentials (no keys anywhere).
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'), // MinIO needs path-style URLs (host/bucket/key)
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

  // --- AI provider ---
  // 'stub' = free local fake images. 'cloudflare' = real AI on Workers AI's FREE daily allocation
  // (needs an account id + API token). 'openrouter' = real, PAID calls; needs a key.
  AI_PROVIDER: z.enum(['stub', 'cloudflare', 'openrouter']).default('stub'),
  OPENROUTER_API_KEY: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  STUB_DELAY_MS: z.coerce.number().int().min(0).default(2500),
  // Speech (voice-over + transcription). 'auto' = Cloudflare when its credentials are set, else the
  // free offline stub. Same free daily Workers AI allocation as the images.
  SPEECH_PROVIDER: z.enum(['auto', 'cloudflare', 'stub']).default('auto'),
  // Local AI (scripts/local-ai): LLM director on :8081, pictures/Piper/whisper gateway on :8082.
  // Unset = Scene Director uses the offline stubs (tests/CI); the editor works either way.
  // docker-compose passes `${VAR:-}` as an EMPTY string when the host has no value (e.g. CI),
  // so "" means "not set" here, not "invalid URL".
  LOCAL_AI_URL: emptyAsUnset(z.string().url().optional()),
  LOCAL_LLM_URL: emptyAsUnset(z.string().url().optional()),
  /** Optional second LLM for Hinglish -> Devanagari (Gemma-3-4B on :8083). Defaults to LOCAL_LLM_URL. */
  LOCAL_SCRIBE_URL: emptyAsUnset(z.string().url().optional()),
  LOCAL_AI_TOKEN: emptyAsUnset(z.string().min(16).optional()),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // --- Jobs ---
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().positive().default(3),
  JOB_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
});

const ApiSchema = SharedSchema.extend({
  /** ffmpeg/ffprobe for voice-over joining (the API image ships them). */
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // >= 32 chars: HS256 needs a long random secret to resist brute force.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().min(0).default(50),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20), // requests / 15 min / IP
  GENERATE_RATE_LIMIT: z.coerce.number().int().positive().default(30), // POST /generate per minute per user
});

const WorkerSchema = SharedSchema.extend({
  WORKER_PORT: z.coerce.number().int().positive().default(4001), // /health + /metrics
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /** ffmpeg binary for MOTION jobs (image -> MP4). Installed in the Docker image; on a dev machine use the system one. */
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
});

const needsMetricsToken = (e: { NODE_ENV: string; METRICS_TOKEN?: string }) =>
  e.NODE_ENV !== 'production' || Boolean(e.METRICS_TOKEN);
const needsKey = (e: { AI_PROVIDER: string; OPENROUTER_API_KEY?: string }) =>
  e.AI_PROVIDER !== 'openrouter' || Boolean(e.OPENROUTER_API_KEY);
const needsCloudflare = (e: { AI_PROVIDER: string; CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string }) =>
  e.AI_PROVIDER !== 'cloudflare' || Boolean(e.CLOUDFLARE_ACCOUNT_ID && e.CLOUDFLARE_API_TOKEN);

function finalize<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine(needsMetricsToken, { message: 'METRICS_TOKEN is required in production', path: ['METRICS_TOKEN'] })
    .refine(needsKey, { message: 'OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter', path: ['OPENROUTER_API_KEY'] })
    .refine(needsCloudflare, {
      message: 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when AI_PROVIDER=cloudflare',
      path: ['CLOUDFLARE_API_TOKEN'],
    });
}

export type SharedEnv = z.infer<typeof SharedSchema>;
export type Env = z.infer<typeof ApiSchema>;
export type WorkerEnv = z.infer<typeof WorkerSchema>;

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parse(finalize(ApiSchema) as unknown as z.ZodType<Env>, source);
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parse(finalize(WorkerSchema) as unknown as z.ZodType<WorkerEnv>, source);
}
