/**
 * Shared Playwright launch options for E2E tests.
 *
 * Environment variables:
 *   E2E_HEADED=1        — run with visible browser window (default: headless)
 *   E2E_SLOWMO=500      — slow down actions by N ms (useful with headed mode)
 *   E2E_DEVTOOLS=1      — open Chrome DevTools on launch (implies headed)
 *
 * Usage:
 *   import {launchOptions} from './helpers/launch-options';
 *   const browser = await chromium.launch(launchOptions);
 *
 * Examples:
 *   npx tsx src/tests/e2e/e2e-bidirectional.ts                     # headless (CI default)
 *   E2E_HEADED=1 npx tsx src/tests/e2e/e2e-bidirectional.ts        # visible browser
 *   E2E_HEADED=1 E2E_SLOWMO=300 npx tsx src/tests/e2e/e2e-bidirectional.ts  # slow debug
 *   E2E_DEVTOOLS=1 npx tsx src/tests/e2e/e2e-bidirectional.ts      # devtools open
 */

// @ts-nocheck
import type {LaunchOptions} from 'playwright';

const headed = !!process.env.E2E_HEADED || !!process.env.E2E_DEVTOOLS;
const slowMo = process.env.E2E_SLOWMO ? Number(process.env.E2E_SLOWMO) : undefined;
const devtools = !!process.env.E2E_DEVTOOLS;

export const launchOptions: LaunchOptions = {
  headless: !headed,
  ...(slowMo && {slowMo}),
  ...(devtools && {devtools})
};
