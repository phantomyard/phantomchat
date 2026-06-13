// @ts-nocheck
/**
 * Shared helper for removing UI overlays that intercept Playwright clicks.
 *
 * Add new selectors here when introducing a full-screen overlay, banner,
 * modal, or pointer-event interceptor. One source of truth for all E2E
 * tests that need to interact with the underlying UI.
 *
 * Tests that LEGITIMATELY need one of these overlays present (e.g. the
 * Tor startup flow tests) should NOT call this helper and should query
 * the specific overlay directly.
 */

import type {Page} from 'playwright';

/**
 * Selectors for full-screen overlays, banners and error panels that can
 * block E2E click/type interactions. Keep alphabetically sorted within
 * each category so diffs stay small.
 */
const BLOCKING_SELECTORS: readonly string[] = [
  // Vite dev-mode overlays
  'vite-error-overlay',
  'vite-plugin-checker-error-overlay',

  // Nostra startup banners
  '.tor-startup-banner',
  '.tor-startup-banner-mount'
];

/**
 * Removes all known blocking overlays from the current page.
 * Idempotent and safe to call multiple times.
 */
export async function dismissOverlays(page: Page): Promise<void> {
  await page.evaluate((selectors: string[]) => {
    for(const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }
  }, [...BLOCKING_SELECTORS]);
}
