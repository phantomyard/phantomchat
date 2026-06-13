// @ts-nocheck
/**
 * Dev-mode boot smoke test.
 *
 * Guards against regressions like:
 *   - `updateBootstrap` running in dev and throwing a false CompromiseAlertError
 *     (gated behind `import.meta.env.PROD` in src/index.ts).
 *   - Circular-init TDZ on `PopupPeer` during onboarding mount, caused by
 *     static imports that pull the popups/* graph into the boot cascade
 *     (`resetLocalData.ts` lazy-loads `confirmationPopup` for this reason).
 *
 * Both bugs render as broken dev-mode boot but pass every existing unit/e2e
 * test, because units stub out the boot chain and prod e2e hits Rollup
 * bundles where the cycle is resolved at bundle-time.
 *
 * The test boots a fresh incognito context against the running Vite dev
 * server at `localhost:8080` and asserts:
 *   - onboarding mounts (CREATE NEW IDENTITY button visible)
 *   - no compromise alert overlay is present
 *   - no "Cannot access <X> before initialization" console errors
 *   - no "Failed to mount onboarding" console errors
 *
 * Assumes `pnpm start` is already running (standard E2E precondition —
 * `run-all.sh` spawns it if not).
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';

const FATAL_ERROR_PATTERNS = [
  /Cannot access '\w+' before initialization/,
  /Failed to mount onboarding/,
  /CompromiseAlertError/,
  /PAGE MOUNT ERROR/
];

async function main(): Promise<void> {
  const browser = await chromium.launch(launchOptions);
  // Fresh context so we never see state from a prior run influencing boot.
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await ctx.newPage();

  const fatalErrors: string[] = [];
  page.on('console', (msg) => {
    if(msg.type() !== 'error') return;
    const text = msg.text();
    if(FATAL_ERROR_PATTERNS.some((re) => re.test(text))) {
      fatalErrors.push(text);
    }
  });
  page.on('pageerror', (err) => {
    const text = err.stack || err.message;
    if(FATAL_ERROR_PATTERNS.some((re) => re.test(text))) {
      fatalErrors.push(text);
    }
  });

  // Vite HMR first-headless-load pattern: goto + wait + reload.
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});

  try {
    // Wait for EITHER the onboarding CTA or the main chat UI to mount.
    // Whichever it is, it proves the boot cascade completed without the TDZ
    // short-circuit we saw before the fix. 30s covers first-boot Vite compile
    // on a cold cache.
    await page.waitForSelector(
      'button:has-text("Create New Identity"), button:has-text("CREATE NEW IDENTITY"), .sidebar-header, #page-chats',
      {timeout: 30_000}
    );
  } catch(err) {
    await page.screenshot({path: '/tmp/e2e-dev-boot-smoke-fail.png'}).catch(() => {});
    console.error('FAIL: nothing mounted within 30s. Screenshot at /tmp/e2e-dev-boot-smoke-fail.png');
    console.error(err);
    process.exit(1);
  }

  // The dev-mode compromise alert overlay covers the body when Step 1a
  // false-positives. If we see it in dev, the PROD gate is broken.
  const compromiseVisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1')).some((h) =>
      (h.textContent || '').includes('Possibile compromissione rilevata')
    )
  );
  if(compromiseVisible) {
    console.error('FAIL: compromise alert rendered in dev mode — updateBootstrap PROD gate regressed.');
    process.exit(1);
  }

  // Allow post-load async rejections (e.g. late module-eval errors) to fire.
  await page.waitForTimeout(2000);

  if(fatalErrors.length > 0) {
    console.error('FAIL: fatal boot errors detected on dev-mode boot:');
    for(const e of fatalErrors) console.error('  -', e);
    process.exit(1);
  }

  console.log('PASS: dev-mode boot smoke — onboarding mounted, no compromise alert, no TDZ errors.');
  await browser.close();
}

main().catch((err) => {
  console.error('FAIL (unexpected):', err);
  process.exit(1);
});
