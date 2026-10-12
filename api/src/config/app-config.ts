import type { Env } from './env.js';

/** The subset of configuration the Express app needs. Tests build this directly. */
export interface AppConfig {
  corsOrigin: string;
  jwtSecret: string;
  jwtTtlDays: number;
  bcryptCost: number;
  signupBonusCredits: number;
  authRateLimit: number;
  secureCookies: boolean; // true in production (HTTPS only)
}

export function toAppConfig(env: Env): AppConfig {
  return {
    corsOrigin: env.CORS_ORIGIN,
    jwtSecret: env.JWT_SECRET,
    jwtTtlDays: env.JWT_TTL_DAYS,
    bcryptCost: env.BCRYPT_COST,
    signupBonusCredits: env.SIGNUP_BONUS_CREDITS,
    authRateLimit: env.AUTH_RATE_LIMIT,
    secureCookies: env.NODE_ENV === 'production',
  };
}
