import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Nostra.chat E2E tests.
 *
 * Runs E2E tests against the local dev server on port 8080.
 * The webServer block automatically starts `pnpm start` before tests
 * and keeps it running for the test session.
 */
export default defineConfig({
  testDir: './src/tests/nostra',

  // Timeout per test — 120s to accommodate PBKDF2 key derivation (~5s per user × 2)
  timeout: 120_000,

  // Run all tests in parallel by default
  fullyParallel: true,

  // Prevent retries for E2E tests (we want fast, predictable feedback)
  retries: 0,

  // Workers: use 1 for tests that orchestrate multiple contexts
  // (avoids port/relay conflicts between workers)
  workers: 1,

  // Reporter: use list for CI, line for local dev
  reporter: process.env.CI ? 'list' : 'line',

  use: {
    // Base URL for relative navigations
    baseURL: 'http://localhost:8080/nostra',

    // Capture console output for debugging
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Headless by default; set AGENT_BROWSER_HEADED=1 in the environment
        // to run in headed mode for visual debugging
        headless: !process.env.AGENT_BROWSER_HEADED,
      },
    },
  ],

  // Automatically start the dev server before running tests
  webServer: {
    command: 'pnpm start',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
