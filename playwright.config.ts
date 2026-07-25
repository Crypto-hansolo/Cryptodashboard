import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration.
 *
 * Runs against a production build with a seeded database and ingestion disabled.
 * That combination is deliberate: live connectors would make assertions
 * time-dependent and network-dependent, and the point of these tests is the UI
 * contract, not whether CoinDesk's feed is up.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // A failing E2E is usually a real regression, but a flaky one wastes far more
  // time than one retry costs.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The terminal is a dense desktop UI; testing it at phone width would only
    // assert the responsive fallback.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /*
         * Use full Chromium rather than the headless shell, which is a separate
         * download that `devices['Desktop Chrome']` would otherwise resolve to.
         */
        channel: 'chromium',

        /*
         * Allow an externally-provided browser binary.
         *
         * CI runs `npx playwright install`, so the default resolution is correct
         * there and this is unset. Some dev images ship Chromium built for a
         * different Playwright revision, where the version-stamped path will not
         * match; pointing `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at the existing binary
         * avoids a redundant multi-hundred-MB download. Not hardcoded, because a
         * container-specific path does not belong in the repo.
         */
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],

  webServer: {
    command: `npm run start -w apps/web -- -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // No live collection: the suite asserts on seeded data.
      INGESTION_ENABLED: 'false',
      // No model required, so E2E does not depend on a GPU or a downloaded model.
      LLM_PROVIDER: 'null',
      EMBEDDING_PROVIDER: 'null',
      WEB_PORT: String(PORT),
    },
  },
});
