// @ts-nocheck
/**
 * E2E Test: Cache-only boot with network blocked
 *
 * Verifies the consent-gate invariant: after SW installs, the app boots from
 * cache even when all network requests are blocked (except manifest probe URLs
 * which are allowed to fail silently).
 *
 * Requires: `pnpm build && pnpm preview` at http://localhost:4173
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:4173';

async function main() {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let errors = 0;

  try {
    // First load: SW installs, precaches
    await page.goto(APP_URL);
    await page.waitForTimeout(5000);

    const swReady = await page.evaluate(() => !!navigator.serviceWorker.controller);
    if(!swReady) {
      console.error('FAIL: SW not active after first load');
      errors++;
    } else {
      console.log('PASS: SW active');
    }

    // Block all network
    await ctx.route('**/*', (route) => {
      // Allow manifest (probe) to fail naturally; block everything else
      route.abort();
    });

    // Reload — must load from cache
    await page.reload();
    await page.waitForTimeout(5000);

    // App should still render something (sidebarLeft container)
    const hasNav = await page.evaluate(() => !!document.querySelector('nav, aside, #column-left'));
    if(!hasNav) {
      console.error('FAIL: app did not render from cache with network blocked');
      errors++;
    } else {
      console.log('PASS: app rendered from cache offline');
    }
  } finally {
    await browser.close();
  }

  process.exit(errors === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
