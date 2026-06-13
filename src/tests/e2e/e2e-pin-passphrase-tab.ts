/**
 * E2E regression for the "Privacy and Security → PIN / Passphrase" empty-tab bug.
 *
 * Flow: onboarding → hamburger → Settings → "Privacy and Security" row →
 *       click "PIN / Passphrase" row → assert the Security tab rendered its sections.
 *
 * Run: npx tsx src/tests/e2e/e2e-pin-passphrase-tab.ts
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function dismiss(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('vite-plugin-checker-error-overlay, vite-error-overlay')
      .forEach((el) => el.remove());
  });
}

async function createId(page: Page) {
  await page.goto(APP_URL);
  await page.waitForTimeout(10000);
  await dismiss(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const input = page.getByRole('textbox');
  if(await input.isVisible().catch(() => false)) {
    await input.fill('PinTest');
    const skip = page.getByText('SKIP', {exact: true});
    if(await skip.isVisible().catch(() => false)) await skip.click();
    else await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(10000);
  await dismiss(page);
}

async function clickMenuItem(page: Page, text: string) {
  const pos = await page.evaluate((t) => {
    const items = document.querySelectorAll('.btn-menu-item');
    for(const item of items) {
      if(item.textContent?.trim().includes(t) && (item as HTMLElement).offsetParent !== null) {
        const r = item.getBoundingClientRect();
        if(r.width > 0 && r.height > 0) return {x: r.left + r.width / 2, y: r.top + r.height / 2};
      }
    }
    return null;
  }, text);
  if(!pos) return false;
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

async function openHamburger(page: Page) {
  await dismiss(page);
  const pos = await page.evaluate(() => {
    const btn = document.querySelector('.sidebar-header .btn-menu-toggle');
    if(!btn) return null;
    const r = (btn as HTMLElement).getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  });
  if(!pos) return false;
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1000);
  return true;
}

async function clickRow(page: Page, text: string) {
  const pos = await page.evaluate((t) => {
    const rows = document.querySelectorAll('.row');
    for(const el of rows) {
      const title = el.querySelector('.row-title')?.textContent?.trim() || '';
      if(title.includes(t) && (el as HTMLElement).offsetParent !== null) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if(r.width > 0 && r.height > 0) return {x: r.left + r.width / 2, y: r.top + r.height / 2};
      }
    }
    return null;
  }, text);
  if(!pos) return false;
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

async function main() {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if(msg.type() === 'error') {
      const t = msg.text();
      // Only flag errors that point back at the empty-tab bug (init throws).
      if(t.includes('open tab error') ||
         (t.includes('classList') && t.includes('nostra'))) {
        errors.push('console.error: ' + t);
      }
    }
  });

  try {
    console.log('[1/5] Onboarding...');
    await createId(page);

    console.log('[2/5] Opening hamburger → Settings...');
    await openHamburger(page);
    if(!(await clickMenuItem(page, 'Settings'))) throw new Error('cannot click Settings');
    await page.waitForTimeout(2000);

    console.log('[3/5] Clicking "Privacy and Security" row...');
    if(!(await clickRow(page, 'Privacy'))) {
      await page.screenshot({path: '/tmp/e2e-pin-no-privacy-row.png'});
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.row .row-title')).map((r: any) => r.textContent?.trim())
      );
      console.error('Settings rows:', rows);
      throw new Error('cannot click Privacy row');
    }
    await page.waitForTimeout(2000);

    console.log('[4/5] Clicking "PIN / Passphrase" row...');
    if(!(await clickRow(page, 'PIN / Passphrase'))) {
      await page.screenshot({path: '/tmp/e2e-pin-no-row.png'});
      throw new Error('cannot click PIN / Passphrase row');
    }
    await page.waitForTimeout(2000);

    console.log('[5/5] Inspecting Security tab...');
    await page.screenshot({path: '/tmp/e2e-pin-result.png', fullPage: true});

    const diag = await page.evaluate(() => {
      const tab = document.querySelector('.nostra-security-settings') as HTMLElement | null;
      if(!tab) return {found: false};
      const title = tab.querySelector('.sidebar-header__title')?.textContent?.trim() || '';
      const content = tab.querySelector('.sidebar-content') as HTMLElement | null;
      const contentChildren = content?.children.length || 0;
      const rows = tab.querySelectorAll('.row').length;
      const sections = tab.querySelectorAll('.sidebar-left-section, .sidebar-left-section-content').length;
      const text = content?.innerText?.slice(0, 400) || '';
      const rect = tab.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      return {found: true, title, contentChildren, rows, sections, text, visible};
    });

    console.log('Tab diagnostics:', JSON.stringify(diag, null, 2));
    if(errors.length) console.log('Captured errors:', errors);

    if(!diag.found) {
      console.error('FAIL: .nostra-security-settings tab not mounted');
      process.exit(1);
    }
    if(!diag.visible) {
      console.error('FAIL: tab exists but not visible');
      process.exit(1);
    }
    if(diag.contentChildren === 0 || diag.rows === 0) {
      console.error('FAIL: Security tab content is EMPTY (contentChildren=' +
        diag.contentChildren + ', rows=' + diag.rows + ')');
      process.exit(1);
    }
    if(errors.length) {
      console.error('FAIL: init-time errors detected');
      process.exit(1);
    }

    console.log('PASS: Security tab rendered with', diag.rows, 'rows,', diag.contentChildren, 'content children');
    process.exit(0);
  } catch(err) {
    console.error('ERROR:', err);
    console.error('Captured errors:', errors);
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
