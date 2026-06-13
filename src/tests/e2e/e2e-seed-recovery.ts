// @ts-nocheck
/**
 * E2E: Recovery Phrase + Key Protection UI after Onboarding
 *
 * Original symptom reported by user: "non c'è un UI per recuperare le 12 parole
 * dopo l'onboarding". Two fixes in one file:
 *
 *   1. Regression: AppNostraSecurityTab used to pass a plain object as
 *      `checkboxField` to Row(), triggering a swallowed TypeError and rendering
 *      an empty tab. Covered by asserting the Key Protection tab has the radio
 *      picker and Recovery section.
 *
 *   2. Discoverability + UI split: Seed Phrase has been moved out of the
 *      Key Protection tab into a dedicated "Recovery Phrase" tab, reached from
 *      a top-level row in Privacy & Security. Covered by asserting both rows
 *      exist, each opens a distinct tab with its own container class, and the
 *      Recovery Phrase tab renders a styled 12-chip grid after Reveal.
 */
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

interface TestResult { id: string; passed: boolean; detail?: string }
const results: TestResult[] = [];
function record(id: string, passed: boolean, detail?: string) {
  results.push({id, passed, detail});
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
}

async function dismiss(page: Page) {
  await page.evaluate(() =>
    document.querySelectorAll('vite-plugin-checker-error-overlay').forEach(e => e.remove())
  );
}

async function createId(page: Page, name: string) {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(12000);
  await dismiss(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill(name);
    const skip = page.getByText('SKIP');
    if(await skip.isVisible().catch(() => false)) {
      await skip.click();
    } else {
      await page.getByRole('button', {name: 'Get Started'}).click();
    }
  }
  await page.waitForTimeout(8000);
}

async function openSettings(page: Page) {
  await dismiss(page);
  await page.locator('.sidebar-tools-button').first().click({timeout: 5000});
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    for(const item of document.querySelectorAll('.btn-menu-item')) {
      if(item.textContent?.includes('Settings')) { (item as HTMLElement).click(); return; }
    }
  });
  await page.waitForTimeout(1500);
  await dismiss(page);
}

async function clickRowByTitle(page: Page, containerSelector: string, rx: RegExp): Promise<string | null> {
  return page.evaluate(({sel, pattern}) => {
    const r = new RegExp(pattern, 'i');
    for(const row of document.querySelectorAll(`${sel} .row`)) {
      const title = row.querySelector('.row-title')?.textContent || '';
      if(r.test(title)) { (row as HTMLElement).click(); return title; }
    }
    return null;
  }, {sel: containerSelector, pattern: rx.source});
}

async function closeCurrentTab(page: Page, containerSelector: string) {
  await page.evaluate((sel) => {
    const btn = document.querySelector(`${sel} .sidebar-close-button`) as HTMLElement | null;
    btn?.click();
  }, containerSelector);
  await page.waitForTimeout(800);
}

(async() => {
  console.log('\n=== E2E: Recovery Phrase + Key Protection UI ===\n');
  const browser = await chromium.launch(launchOptions);
  let exitCode = 0;

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => { pageErrors.push(String(err)); });
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if(msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // ── Setup ──
    console.log('  Creating identity...');
    await createId(page, 'SeedRecoveryUser');
    const chatListVisible = await page.locator('.sidebar-header').first()
      .isVisible({timeout: 5000}).catch(() => false);
    record('setup', chatListVisible);
    if(!chatListVisible) throw new Error('App did not load');

    console.log('  Opening Settings → Privacy & Security...');
    await openSettings(page);
    record('settings-open', await page.evaluate(() => !!document.querySelector('.settings-container')));
    await clickRowByTitle(page, '.settings-container', /privacy/);
    await page.waitForTimeout(1500);
    const privacyOpen = await page.evaluate(() => !!document.querySelector('.privacy-container'));
    record('privacy-tab-open', privacyOpen);
    if(!privacyOpen) throw new Error('Privacy tab did not open');

    // ── Both rows present in Key Protection section ──
    const rowsPresent = await page.evaluate(() => {
      const titles = Array.from(document.querySelectorAll('.privacy-container .row .row-title'))
        .map(t => t.textContent || '');
      return {
        pin: titles.some(t => /pin.*passphrase/i.test(t)),
        recovery: titles.some(t => /recovery phrase/i.test(t))
      };
    });
    record('pin-passphrase-row-present', rowsPresent.pin);
    record('recovery-phrase-row-present', rowsPresent.recovery);

    // ── Path A: Key Protection tab — must NOT contain seed viewer ──
    console.log('  Opening Key Protection tab...');
    await clickRowByTitle(page, '.privacy-container', /pin.*passphrase/);
    await page.waitForTimeout(1500);
    const keyProtection = await page.evaluate(() => {
      const container = document.querySelector('.nostra-security-settings');
      if(!container) return null;
      const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim() || '');
      const sections = container.querySelectorAll('.sidebar-left-section').length;
      const hasRadios = container.querySelectorAll('.protection-radio-group .row').length;
      const hasViewSeed = buttons.some(t => /view seed phrase|reveal recovery/i.test(t));
      const hasForgot = Array.from(container.querySelectorAll('.row .row-title'))
        .some(t => /forgot/i.test(t.textContent || ''));
      return {sections, hasRadios, hasViewSeed, hasForgot};
    });
    record('key-protection-tab-mounted', !!keyProtection);
    record('key-protection-has-sections', (keyProtection?.sections ?? 0) >= 2,
      `${keyProtection?.sections ?? 0} sections — 0 means the Row() bug regressed`);
    record('key-protection-has-radios', (keyProtection?.hasRadios ?? 0) === 3,
      `${keyProtection?.hasRadios ?? 0} radio rows`);
    record('key-protection-has-forgot-row', !!keyProtection?.hasForgot);
    record('key-protection-no-seed-viewer', !keyProtection?.hasViewSeed,
      keyProtection?.hasViewSeed ? 'seed viewer still mixed in here' : 'seed viewer correctly absent');

    // Surface any swallowed Row TypeError
    const rowErrors = [...pageErrors, ...consoleErrors]
      .filter(m => /classList|checkboxField|TypeError.*Row/i.test(m));
    if(rowErrors.length > 0) {
      console.log('  [DIAG] Row errors:');
      for(const e of rowErrors) console.log('    -', e.slice(0, 200));
    }

    await closeCurrentTab(page, '.nostra-security-settings');

    // ── Path B: Recovery Phrase tab — dedicated, prettier ──
    console.log('  Opening Recovery Phrase tab...');
    await clickRowByTitle(page, '.privacy-container', /recovery phrase/);
    await page.waitForTimeout(1500);
    const seedTab = await page.evaluate(() => {
      const container = document.querySelector('.nostra-seed-phrase-tab');
      if(!container) return null;
      const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim() || '');
      return {
        mounted: true,
        hasWarningCard: !!container.querySelector('.seed-warning-card'),
        hasRevealBtn: buttons.some(t => /reveal recovery phrase/i.test(t)),
        gridHiddenInitially: !!container.querySelector('.seed-grid-wrapper[style*="none"]'),
        hasProtectionPicker: container.querySelectorAll('.protection-radio-group .row').length > 0
      };
    });
    record('seed-tab-mounted', !!seedTab);
    record('seed-tab-has-warning-card', !!seedTab?.hasWarningCard);
    record('seed-tab-has-reveal-btn', !!seedTab?.hasRevealBtn);
    record('seed-tab-grid-hidden-initially', !!seedTab?.gridHiddenInitially);
    record('seed-tab-no-protection-picker', !seedTab?.hasProtectionPicker,
      seedTab?.hasProtectionPicker ? 'protection picker leaked in' : 'correctly isolated');

    // ── Click Reveal ──
    console.log('  Clicking Reveal Recovery Phrase...');
    await page.evaluate(() => {
      const container = document.querySelector('.nostra-seed-phrase-tab')!;
      for(const b of container.querySelectorAll('button')) {
        if(/reveal recovery phrase/i.test(b.textContent || '')) { (b as HTMLElement).click(); return; }
      }
    });
    await page.waitForTimeout(1200);

    // ── Verify pretty 12-chip grid renders ──
    const grid = await page.evaluate(() => {
      const chips = document.querySelectorAll('.nostra-seed-phrase-tab .seed-word-chip');
      return Array.from(chips).map(chip => ({
        num: chip.querySelector('.seed-word-chip__num')?.textContent?.trim() || '',
        word: chip.querySelector('.seed-word-chip__word')?.textContent?.trim() || ''
      }));
    });
    record('seed-grid-12-chips', grid.length === 12, `found ${grid.length} chips`);
    const wellFormed = grid.length === 12
      && grid.every((c, i) => c.num === String(i + 1) && /^[a-z]+$/i.test(c.word));
    record('seed-chips-well-formed', wellFormed,
      wellFormed ? 'all chips have correct number + BIP39-shaped word' : `malformed: ${JSON.stringify(grid.slice(0, 3))}`);

    // ── Auxiliary pretty-UI affordances ──
    const affordances = await page.evaluate(() => {
      const container = document.querySelector('.nostra-seed-phrase-tab')!;
      const btns = Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim() || '');
      return {
        hasCopy: btns.some(t => /^copy/i.test(t)),
        hasHide: btns.some(t => /^hide/i.test(t)),
        hasCountdownBar: !!container.querySelector('.seed-countdown__bar'),
        revealBtnHidden: !!container.querySelector('.seed-reveal-btn[style*="none"]')
      };
    });
    record('seed-has-copy-button', affordances.hasCopy);
    record('seed-has-hide-button', affordances.hasHide);
    record('seed-has-countdown-bar', affordances.hasCountdownBar);
    record('seed-reveal-btn-hidden-after-reveal', affordances.revealBtnHidden);

    // ── Summary ──
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    console.log(`\n=== Results: ${passed}/${results.length} passed, ${failed} failed ===\n`);
    if(failed > 0) exitCode = 1;
  } catch(err) {
    console.error('\n[FATAL]', err);
    exitCode = 1;
  } finally {
    await browser.close();
    process.exit(exitCode);
  }
})();
