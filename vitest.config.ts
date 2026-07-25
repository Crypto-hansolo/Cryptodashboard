import { defineConfig } from 'vitest/config';

/**
 * Root config. Test discovery is split across projects in vitest.workspace.ts;
 * this file carries the settings that apply to the whole run (coverage).
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/*.d.ts',
        // Port/type declaration modules contain no executable logic.
        'packages/core/src/ports/**',
        'packages/db/src/generated/**',
        'packages/worker/src/main.ts',
        // Test-support code. Covered incidentally by whatever uses it, and its own
        // coverage number means nothing.
        'packages/*/src/testing.ts',
        'packages/connectors/src/connector-fixtures.ts',
      ],
      /*
       * Thresholds for the *unit* suite only — coverage is not collected for the
       * integration run.
       *
       * That matters when reading the numbers: `@cid/db` reports 0% here while
       * being the most thoroughly tested package in the repo, because its
       * contract is SQL behaviour (generated tsvector columns, HNSW ordering,
       * `DISTINCT ON`, cursor stability) and 101 integration tests exercise it
       * against real Postgres. Mocking Prisma to raise this number would test the
       * mock. It is deliberately left in the denominator rather than excluded, so
       * the global figure stays honest about what the fast suite proves.
       *
       * Set just below the current numbers: high enough that deleting tests
       * fails, low enough that adding an adapter does not.
       */
      thresholds: {
        statements: 62,
        branches: 80,
        functions: 80,
        lines: 62,
      },
    },
  },
});
