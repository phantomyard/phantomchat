// @ts-nocheck
/**
 * E2E Test: 10.12 Relay status shows real state, 10.13 Settings relay list
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
    await input.fill('RelayTest');
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(12000);
  await dismiss(page);
}

async function clickMenuItem(page, text) {
  const pos = await page.evaluate((t) => {
    const items = document.querySelectorAll('.btn-menu-item');
    for(const item of items) {
      if(item.textContent?.trim().includes(t) && item.offsetParent !== null) {
        const r = item.getBoundingClientRect();
        if(r.width > 0 && r.height > 0) return {x: r.left + r.width / 2, y: r.top + r.height / 2};
      }
    }
    return null;
  }, text);
  if(!pos) return false;
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  return true;
}

async function openHamburger(page) {
  await dismiss(page);
  const pos = await page.evaluate(() => {
    const btn = document.querySelector('.sidebar-header .btn-menu-toggle');
    if(!btn) return null;
    const r = btn.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  });
  if(!pos) return false;
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1000);
  return true;
}

async function clickRow(page, text) {
  const pos = await page.evaluate((t) => {
    const rows = document.querySelectorAll('.row, .sidebar-left-section-content .row-title');
    for(const el of rows) {
      const title = el.querySelector ? (el.querySelector('.row-title')?.textContent?.trim() || el.textContent?.trim()) : el.textContent?.trim();
      if(title?.includes(t) && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        if(r.width > 0 && r.height > 0) return {x: r.left + r.width / 2, y: r.top + r.height / 2};
      }
    }
    return null;
  }, text);
  if(!pos) return false;
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  return true;
}

// === 10.12: Status page shows relay connected/disconnected ===
async function test10_12() {
  console.log('=== Test 10.12: Relay real status ===');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const page = await ctx.newPage();
  await createId(page);

  await openHamburger(page);
  const clicked = await clickMenuItem(page, 'Status');
  if(!clicked) {
    await page.screenshot({path: '/tmp/e2e-10-12-no-status.png'});
    console.error('FAIL: Could not click Status');
    await browser.close();
    return false;
  }
  console.log('Status clicked');

  // Wait for relay connections
  await page.waitForTimeout(15000);
  await page.screenshot({path: '/tmp/e2e-10-12.png'});

  const relayInfo = await page.evaluate(() => {
    const rows = document.querySelectorAll('.row');
    const relays = [];
    rows.forEach(row => {
      const t = row.querySelector('.row-title')?.textContent?.trim();
      const s = row.querySelector('.row-subtitle')?.textContent?.trim();
      if(t?.includes('wss://')) relays.push({url: t, status: s});
    });
    return relays;
  });
  console.log('Relays:', JSON.stringify(relayInfo));

  await browser.close();

  if(relayInfo.length === 0) {
    console.error('FAIL: No relay rows found');
    return false;
  }
  const hasRealStatus = relayInfo.some(r => r.status?.includes('Connected') || r.status?.includes('Disconnected') || r.status?.includes('Connecting'));
  if(!hasRealStatus) {
    console.error('FAIL: No real status found, statuses:', relayInfo.map(r => r.status));
    return false;
  }
  console.log('PASS: 10.12');
  return true;
}

// === 10.13: Settings → Nostr Relays shows relay list ===
async function test10_13() {
  console.log('=== Test 10.13: Settings relay list ===');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const page = await ctx.newPage();
  await createId(page);

  await openHamburger(page);
  const clicked = await clickMenuItem(page, 'Settings');
  if(!clicked) {
    console.error('FAIL: Could not click Settings');
    await browser.close();
    return false;
  }
  await page.waitForTimeout(3000);
  await page.screenshot({path: '/tmp/e2e-10-13-settings.png'});

  // Find and click "Nostr Relays" row
  const relayClicked = await clickRow(page, 'Nostr Relay');
  console.log('Nostr Relay clicked:', relayClicked);

  if(!relayClicked) {
    // Try scrolling to find it
    const allRows = await page.evaluate(() => {
      const rows = document.querySelectorAll('.row');
      return Array.from(rows).map(r => r.querySelector('.row-title')?.textContent?.trim()).filter(Boolean);
    });
    console.log('Available rows:', allRows);
    await page.screenshot({path: '/tmp/e2e-10-13-no-relay-row.png'});
    console.error('FAIL: Could not find Nostr Relay row');
    await browser.close();
    return false;
  }

  await page.waitForTimeout(3000);
  await page.screenshot({path: '/tmp/e2e-10-13.png'});

  const relays = await page.evaluate(() => {
    // Look for relay URLs anywhere on the page
    const allText = document.querySelectorAll('.row-title, .relay-url, [class*="relay"]');
    const wss = [];
    allText.forEach(el => {
      const t = el.textContent?.trim();
      if(t?.includes('wss://')) wss.push(t);
    });
    // Fallback: any .row with wss://
    if(wss.length === 0) {
      document.querySelectorAll('.row').forEach(r => {
        const t = r.querySelector('.row-title')?.textContent?.trim();
        if(t?.includes('wss://')) wss.push(t);
      });
    }
    return wss;
  });
  console.log('Relays found:', relays);

  await browser.close();

  if(relays.length === 0) {
    console.error('FAIL: No relays in settings');
    return false;
  }
  console.log('PASS: 10.13');
  return true;
}

async function main() {
  const r = {};
  r['10.12'] = await test10_12();
  r['10.13'] = await test10_13();

  console.log('\n=== Results ===');
  for(const [k, v] of Object.entries(r)) console.log(`${k}: ${v ? 'PASS' : 'FAIL'}`);
  if(!Object.values(r).every(v => v)) process.exit(1);
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
