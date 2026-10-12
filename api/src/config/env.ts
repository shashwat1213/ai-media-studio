import { z } from 'zod';

/**
 * All configuration comes from environment variables (12-factor app).
 * Validated ONCE at boot: a missing/wrong value crashes the process immediately
 * with a readable message instead of failing randomly later.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // >= 32 chars: HS256 needs a long random secret to resist brute force.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().min(0).default(50),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20), // requests / 15 min / IP
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
