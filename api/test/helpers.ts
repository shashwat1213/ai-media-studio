import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../src/config/app-config.js';
import { createApp } from '../src/app.js';

export const testConfig: AppConfig = {
  corsOrigin: 'http://localhost:5173',
  jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
  jwtTtlDays: 7,
  bcryptCost: 4, // fast hashing in tests; prod uses 12
  signupBonusCredits: 50,
  authRateLimit: 1000,
  secureCookies: false,
};

export const prisma = new PrismaClient(); // DATABASE_URL points at the test DB (vitest.config.ts)

export function makeApp(overrides: Partial<AppConfig> = {}) {
  return createApp({ prisma, config: { ...testConfig, ...overrides } });
}

export async function resetDb() {
  await prisma.$executeRawUnsafe('TRUNCATE "CreditTransaction", "User" CASCADE');
}
