import { defineWorkspace } from 'vitest/config';

/**
 * Two test projects with different contracts:
 *
 *  - `unit`        pure and hermetic: no network, no database, no docker. This is
 *                  what `npm test` runs and what gates every push.
 *  - `integration` requires Postgres + Redis (`docker compose up -d postgres redis`).
 *                  Each file guards on DATABASE_URL and skips cleanly without it.
 *
 * E2E lives separately under Playwright (`npm run test:e2e`).
 * Coverage thresholds are configured in vitest.config.ts.
 */
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      globals: false,
      include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      globals: false,
      include: ['packages/*/tests/integration/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
      // Integration tests share one database; running files in parallel would
      // have them truncating each other's fixtures.
      fileParallelism: false,
    },
  },
]);
