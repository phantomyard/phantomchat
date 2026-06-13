// @ts-nocheck
/**
 * E2E Test: dev update popup trigger + consent flow.
 *
 * Exercises the dev-trigger path that mirrors the prod probe flow:
 *   1. __triggerUpdatePopup() dispatches update_available_signed
 *   2. the stash listener populates window.__nostraPendingUpdate
 *   3. showUpdateConsentPopup mounts the UpdateConsent component
 *   4. clicking "Ignora" calls declineUpdate, which persists snooze +
 *      decline counter to localStorage
 *
 * Previously __triggerUpdatePopup() dispatched dead events
 * (update_available / update_integrity_check_completed) with no listeners,
 * so nothing happened. This test guards against regressing that wiring.
 *
 * In prod the same update_available_signed event is dispatched by
 * runProbeIfDue() and caught by the auto-show listener in src/index.ts,
 * which invokes showUpdateConsentPopup directly — the popup render path
 * covered here is identical to what a prod user sees on boot after a
 * deploy.
 *
 * Assumes `pnpm start` is already running at localhost:8080.
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';
const FAKE_VERSION = '99.0.0';

async function main(): Promise<void> {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await ctx.newPage();

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if(msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.stack || err.message));

  let failed = 0;
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); failed++; };
  const pass = (msg: string) => { console.log(`PASS: ${msg}`); };

  try {
    // Vite dev first-headless-load pattern.
    await page.goto(APP_URL, {waitUntil: 'load'});
    await page.waitForTimeout(5000);
    await page.reload({waitUntil: 'load'});

    // Wait for app boot to complete (either onboarding or main chat mounted).
    await page.waitForSelector(
      'button:has-text("Create New Identity"), button:has-text("CREATE NEW IDENTITY"), .sidebar-header, #page-chats',
      {timeout: 30_000}
    );

    // Clear any leftover snooze state from prior runs.
    await page.evaluate((v) => {
      localStorage.removeItem('nostra.update.snoozedVersion');
      localStorage.removeItem('nostra.update.snoozedUntil');
      localStorage.removeItem(`nostra.update.declineCount.${v}`);
      delete (window as any).__nostraPendingUpdate;
    }, FAKE_VERSION);

    // dev-trigger.install() is kicked off by index.ts DEV branch during boot.
    // Give it a beat to import the chain (update-popup-controller + dev-trigger).
    await page.waitForFunction(() => typeof (window as any).__triggerUpdatePopup === 'function', {timeout: 10_000});
    pass('__triggerUpdatePopup exposed on window');

    // Fire the trigger — returns the generated manifest.
    const triggered = await page.evaluate(async(version) => {
      return await (window as any).__triggerUpdatePopup({version});
    }, FAKE_VERSION);

    if(!triggered?.manifest || triggered.manifest.version !== FAKE_VERSION) {
      fail(`__triggerUpdatePopup returned unexpected payload: ${JSON.stringify(triggered)}`);
    } else {
      pass('__triggerUpdatePopup returned manifest');
    }

    // Stash listener should have populated __nostraPendingUpdate.
    const stashed = await page.evaluate(() => (window as any).__nostraPendingUpdate);
    if(!stashed || stashed.manifest?.version !== FAKE_VERSION) {
      fail(`window.__nostraPendingUpdate not populated: ${JSON.stringify(stashed)}`);
    } else {
      pass('window.__nostraPendingUpdate populated by stash listener');
    }

    // Popup title renders.
    const titleLocator = page.locator('text=Aggiornamento disponibile');
    await titleLocator.waitFor({state: 'visible', timeout: 5000}).catch(() => {});
    if(await titleLocator.count() === 0) {
      fail('UpdateConsent popup title not visible');
    } else {
      pass('UpdateConsent popup title visible');
    }

    // Popup shows the fake version.
    const versionText = await page.locator(`text=${FAKE_VERSION}`).first().textContent().catch(() => null);
    if(!versionText || !versionText.includes(FAKE_VERSION)) {
      fail(`version ${FAKE_VERSION} not rendered in popup`);
    } else {
      pass(`version ${FAKE_VERSION} rendered`);
    }

    // Both action buttons present.
    const ignoraBtn = page.locator('button:has-text("Ignora")');
    const accettaBtn = page.locator('button:has-text("Accetta")');
    if(await ignoraBtn.count() === 0) fail('Ignora button missing');
    else pass('Ignora button rendered');
    if(await accettaBtn.count() === 0) fail('Accetta button missing');
    else pass('Accetta button rendered');

    // Click Ignora → declineUpdate runs.
    await ignoraBtn.first().click();
    await page.waitForTimeout(500);

    // Popup should be unmounted.
    if(await titleLocator.count() !== 0) {
      fail('popup still mounted after clicking Ignora');
    } else {
      pass('popup unmounted after Ignora');
    }

    // Snooze + decline count persisted to localStorage.
    const lsState = await page.evaluate((v) => ({
      snoozedVersion: localStorage.getItem('nostra.update.snoozedVersion'),
      snoozedUntil: localStorage.getItem('nostra.update.snoozedUntil'),
      declineCount: localStorage.getItem(`nostra.update.declineCount.${v}`)
    }), FAKE_VERSION);

    if(lsState.snoozedVersion !== FAKE_VERSION) fail(`snoozedVersion = ${lsState.snoozedVersion}, expected ${FAKE_VERSION}`);
    else pass('snoozedVersion persisted');

    const until = parseInt(lsState.snoozedUntil || '0', 10);
    if(!(until > Date.now())) fail(`snoozedUntil = ${until} is not in the future`);
    else pass('snoozedUntil in future');

    if(lsState.declineCount !== '1') fail(`declineCount = ${lsState.declineCount}, expected "1"`);
    else pass('declineCount incremented to 1');

    // No unexpected page errors during the flow.
    const relevantErrors = consoleErrors.filter((e) =>
      !/DEV_STUB_SIGNATURE/.test(e) && !/DEV/.test(e)
    );
    if(relevantErrors.length > 0) {
      console.warn(`WARN: ${relevantErrors.length} console errors seen (informational):`);
      relevantErrors.forEach((e) => console.warn('  -', e.slice(0, 200)));
    }
  } catch(err) {
    await page.screenshot({path: '/tmp/e2e-update-popup-fail.png'}).catch(() => {});
    console.error('FAIL: exception during test. Screenshot at /tmp/e2e-update-popup-fail.png');
    console.error(err);
    failed++;
  } finally {
    await browser.close();
  }

  if(failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nAll assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
