import { execSync } from 'node:child_process';

/** Runs once before all tests: bring the test database schema up to date. */
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://studio:studio@localhost:5433/ai_media_studio_test?schema=public';
  // `migrate deploy` = apply committed migrations only (never generates new ones). Same command prod uses.
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
