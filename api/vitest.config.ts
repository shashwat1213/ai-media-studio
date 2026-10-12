import { defineConfig } from 'vitest/config';

// Integration tests run against a REAL Postgres in a separate database, so they
// can never touch dev data. CI overrides TEST_DATABASE_URL to its service container.
const testDbUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://studio:studio@localhost:5433/ai_media_studio_test?schema=public';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: { DATABASE_URL: testDbUrl, NODE_ENV: 'test' },
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database and truncate it between tests -> run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/server.ts', 'src/types/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // CI fails if coverage drops below these (set just under the measured values).
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
