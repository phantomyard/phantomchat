// @ts-nocheck
/**
 * E2E Test: Consent-gated update popup flow
 *
 * Simulates an update_available event by stashing a fake manifest on window,
 * clicks the hamburger update button, asserts the UpdateConsent popup appears,
 * clicks Ignora, asserts snooze + decline counter persist in localStorage.
 *
 * Requires: `pnpm build && pnpm preview` running at http://localhost:4173
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
    await page.goto(APP_URL);
    await page.waitForTimeout(3000); // let SW install

    // Stash a fake pending update on window
    await page.evaluate(() => {
      (window as any).__nostraPendingUpdate = {
        manifest: {
          version: '0.99.0',
          gitSha: 'deadbeefcafe1234',
          published: '2026-04-21T12:00:00Z',
          signingKeyFingerprint: 'ed25519:unset',
          rotation: null,
          changelog: 'E2E test release notes',
          bundleHashes: {}
        },
        signature: 'stub-signature'
      };
    });

    // Click hamburger update button
    const btn = await page.$('[data-update-btn]');
    if(!btn) {
      console.error('FAIL: data-update-btn not found');
      errors++;
    } else {
      await btn.click();
      await page.waitForTimeout(500);

      // Popup should be visible
      const popup = await page.$('text=Aggiornamento disponibile');
      if(!popup) {
        console.error('FAIL: update consent popup did not open');
        errors++;
      } else {
        console.log('PASS: update consent popup opened');

        // Click "Ignora"
        const ignoraBtn = await page.$('text=Ignora');
        if(ignoraBtn) {
          await ignoraBtn.click();
          await page.waitForTimeout(300);

          // Snooze state persisted
          const state = await page.evaluate(() => ({
            version: localStorage.getItem('nostra.update.snoozedVersion'),
            count: localStorage.getItem('nostra.update.declineCount.0.99.0')
          }));
          if(state.version === '0.99.0' && state.count === '1') {
            console.log('PASS: decline persisted to localStorage');
          } else {
            console.error('FAIL: decline not persisted correctly', state);
            errors++;
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  process.exit(errors === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
