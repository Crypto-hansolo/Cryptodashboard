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
      ],
      thresholds: {
        statements: 55,
        branches: 70,
        functions: 60,
        lines: 55,
      },
    },
  },
});
