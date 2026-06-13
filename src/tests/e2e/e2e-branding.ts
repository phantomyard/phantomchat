// @ts-nocheck
/**
 * E2E Test: 11.1 Branding — Hamburger menu → More → "Nostra.chat v0.0.1"
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function dismiss(page) {
  await page.evaluate(() => document.querySelectorAll('vite-plugin-checker-error-overlay').forEach(e => e.remove()));
}

async function createId(page) {
  await page.goto(APP_URL);
  await page.waitForTimeout(10000);
  await dismiss(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill('BrandTest');
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(12000);
  await dismiss(page);
}

async function main() {
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const page = await ctx.newPage();

  await createId(page);

  // Open hamburger menu
  const hamPos = await page.evaluate(() => {
    const btn = document.querySelector('.sidebar-header .btn-menu-toggle');
    if(!btn) return null;
    const r = btn.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  });
  if(!hamPos) {
    await page.screenshot({path: '/tmp/e2e-11-1-no-hamburger.png'});
    console.error('FAIL: No hamburger button found');
    process.exit(1);
  }
  await page.mouse.move(hamPos.x, hamPos.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1000);

  // Find "More" item — text may include icon characters, so use includes()
  const morePos = await page.evaluate(() => {
    const items = document.querySelectorAll('.btn-menu-item');
    for(const item of items) {
      const t = item.textContent?.trim();
      if(t && t.includes('More') && item.offsetParent !== null) {
        const r = item.getBoundingClientRect();
        if(r.width > 0 && r.height > 0) {
          return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }
      }
    }
    return null;
  });

  if(!morePos) {
    await page.screenshot({path: '/tmp/e2e-11-1-no-more.png'});
    console.error('FAIL: No "More" item found');
    process.exit(1);
  }

  // Hover on More to trigger submenu opening
  await page.mouse.move(morePos.x, morePos.y);
  await page.waitForTimeout(1500);
  // If submenu didn't open via hover, click it
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.waitForTimeout(2000);

  // Look for branding in submenu
  const brand = await page.evaluate(() => {
    const footers = document.querySelectorAll('.btn-menu-footer-text');
    for(const f of footers) {
      const t = f.textContent?.trim();
      if(t) return t;
    }
    return null;
  });

  if(brand?.includes('Nostra.chat')) {
    console.log('PASS: 11.1 — Brand:', brand);
  } else {
    await page.screenshot({path: '/tmp/e2e-11-1-fail.png'});
    // Try to find any text containing Nostra in visible menus
    const debug = await page.evaluate(() => {
      const all = document.querySelectorAll('[class*="menu"]');
      return Array.from(all).map(el => ({
        cls: el.className,
        text: el.textContent?.slice(0, 100)
      })).filter(x => x.text);
    });
    console.error('FAIL: 11.1 — Brand not found. Got:', brand);
    console.error('Menu elements:', JSON.stringify(debug.slice(0, 5)));
    process.exit(1);
  }

  await browser.close();
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
