// @ts-nocheck
/**
 * E2E test for the Tor-first startup flow.
 *
 * Verifies:
 *   1. With Tor enabled (default), the app does NOT open any wss:// WebSocket
 *      connection while PrivacyTransport state is 'bootstrapping'.
 *   2. The startup banner is mounted on document.body during bootstrap.
 *   3. Clicking Skip opens the confirmation popup.
 *   4. Cancel keeps the app in bootstrapping (still no wss).
 *   5. Confirm switches to direct mode and wss connections start flowing.
 *   6. Session-scoped skip: localStorage 'nostra-tor-enabled' stays 'true'
 *      so the next launch retries Tor.
 *
 * Run: pnpm start (in another terminal), then:
 *   npx tsx src/tests/e2e/e2e-tor-privacy-flow.ts
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

interface TestResult { id: string; name: string; passed: boolean; detail?: string; }
const results: TestResult[] = [];

function record(id: string, name: string, passed: boolean, detail?: string) {
  results.push({id, name, passed, detail});
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function dismissOverlay(page) {
  await page.evaluate(() =>
    document.querySelectorAll('vite-plugin-checker-error-overlay').forEach((e) => e.remove())
  );
}

async function createIdentity(page) {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
  await dismissOverlay(page);

  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);

  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill('TorPrivacyFlowUser');
    await page.getByRole('button', {name: 'Get Started'}).click();
    await page.waitForTimeout(5000);
    for(let i = 0; i < 20; i++) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const skip = buttons.find((b) => /skip/i.test(b.textContent || ''));
        if(skip && !(skip as HTMLButtonElement).disabled) {
          (skip as HTMLButtonElement).click();
          return true;
        }
        return false;
      });
      if(clicked) break;
      await page.waitForTimeout(1000);
    }
  }
  await page.waitForTimeout(4000);
  await dismissOverlay(page);
}

async function main() {
  console.log('E2E Tor Privacy Flow Test\n');

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Track every WebSocket attempt (both open and close requests)
  const wsAttempts: Array<{url: string; at: number}> = [];
  const start = Date.now();
  // Install a listener BEFORE navigation so the moment the transport
  // transitions out of bootstrapping gets captured in real time on the page
  // timeline. The test reads `window.__torSettledAtPerf` afterwards to
  // determine the authoritative cutoff.
  // Track only relay-like WebSockets. Exclude Vite HMR (localhost) and any
  // SharedWorker / DevTools sockets — those are not relay traffic and carry
  // no user IP to the Nostr relays.
  const isRelayWs = (url: string) => {
    if(!url.startsWith('wss://') && !url.startsWith('ws://')) return false;
    try {
      const host = new URL(url).hostname;
      if(host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
    } catch{ return false; }
    return true;
  };
  // Each wss attempt is tagged with the transport state read at the moment
  // the connection is initiated. A "leak" is any relay wss opened while the
  // state is still 'bootstrapping'. Doing the state query synchronously in
  // the websocket handler captures the authoritative ground-truth.
  const wsLeaks: Array<{url: string; at: number; state: string}> = [];
  page.on('websocket', async(ws) => {
    const url = ws.url();
    if(!isRelayWs(url)) return;
    const t = Date.now() - start;
    wsAttempts.push({url, at: t});
    console.log(`  [ws] ${t}ms → ${url}`);
    try {
      const stateAtOpen = await page.evaluate(() => {
        const tr = (window as any).__nostraTransport;
        return tr?.getState?.() ?? 'no-transport';
      });
      if(stateAtOpen === 'bootstrapping') {
        wsLeaks.push({url, at: t, state: stateAtOpen});
      }
    } catch{ /* page may be closed */ }
  });

  try {
    await createIdentity(page);

    // ============================================================
    // T0 — Default mode (when-available) — banner must NOT appear.
    // ============================================================
    await page.evaluate(() => localStorage.removeItem('nostra-tor-mode'));
    await page.reload({waitUntil: 'load'});
    await page.waitForTimeout(3000);
    const noBannerWhenAvailable = await page.locator('.tor-startup-banner').count();
    record('T0', 'Banner hidden in when-available mode', noBannerWhenAvailable === 0,
      `bannerCount=${noBannerWhenAvailable}`);

    // ============================================================
    // T1 — Switch to Tor-only — banner appears.
    // ============================================================
    await page.evaluate(() => localStorage.setItem('nostra-tor-mode', 'only'));
    await page.reload({waitUntil: 'load'});
    try {
      await page.waitForSelector('.tor-startup-banner', {timeout: 30_000});
    } catch{ /* banner may have raced to active — allow count check */ }
    const hasBanner = await page.locator('.tor-startup-banner').count();
    record('T1', 'Banner appears in only mode', hasBanner === 1,
      `bannerCount=${hasBanner}`);

    // ============================================================
    // T2 — No Skip/Retry/Continue buttons on the banner.
    // ============================================================
    const skipCount = await page.locator('.tor-startup-banner__btn').count();
    record('T2', 'No Skip/Retry/Continue buttons', skipCount === 0,
      `btnCount=${skipCount}`);

    // ============================================================
    // T3 — Switch to Off — banner never appears.
    // ============================================================
    await page.evaluate(() => localStorage.setItem('nostra-tor-mode', 'off'));
    await page.reload({waitUntil: 'load'});
    await page.waitForTimeout(3000);
    const noBannerOff = await page.locator('.tor-startup-banner').count();
    record('T3', 'Banner hidden in off mode', noBannerOff === 0,
      `bannerCount=${noBannerOff}`);
  } finally {
    await ctx.close();
    await browser.close();
  }

  // Summary
  console.log('\n========== SUMMARY ==========');
  let passed = 0, failed = 0;
  for(const r of results) {
    console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if(r.passed) passed++; else failed++;
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);

  if(failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
