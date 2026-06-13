/**
 * Smoke test: verify that LocalRelay starts, accepts WebSocket connections,
 * and can be injected into a Playwright browser context.
 *
 * Run: npx tsx src/tests/e2e/e2e-local-relay-smoke.ts
 */
// @ts-nocheck
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';

const APP_URL = 'http://localhost:8080';

async function main() {
  const relay = new LocalRelay();
  console.log('=== Starting local relay ===');
  await relay.start();
  console.log('  Relay running at:', relay.url);

  const healthy = await relay.isHealthy();
  console.log('  Health check:', healthy ? 'PASS' : 'FAIL');
  if(!healthy) { await relay.stop(); process.exit(1); }

  console.log('\n=== Testing Playwright injection ===');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  // Navigate to app and check if relay config was injected
  await page.goto(APP_URL);
  await page.waitForTimeout(8000);

  // Dismiss vite overlay
  await page.evaluate(() => {
    document.querySelectorAll('vite-plugin-checker-error-overlay, vite-error-overlay').forEach((el) => el.remove());
  });

  // Create identity
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const nameInput = page.getByRole('textbox');
  if(await nameInput.isVisible()) {
    await nameInput.fill('RelayTest');
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(10000);

  // Check what relays the ChatAPI connected to
  const relayInfo = await page.evaluate(() => {
    const ca = (window as any).__nostraChatAPI;
    if(!ca) return {error: 'no ChatAPI'};
    const pool = (ca as any).relayPool;
    if(!pool) return {error: 'no pool'};
    const entries = (pool as any).relayEntries || [];
    return {
      count: entries.length,
      relays: entries.map((e: any) => ({
        url: e.config?.url || e.url,
        connected: e.instance?.connectionState || 'unknown'
      }))
    };
  });

  console.log('  ChatAPI relay info:', JSON.stringify(relayInfo, null, 2));

  const usesLocalRelay = relayInfo.relays?.some((r: any) => r.url?.includes('localhost:7777'));
  console.log('\n=== Results ===');
  console.log('  Local relay injected:', usesLocalRelay ? 'PASS' : 'FAIL');
  console.log('  Connected:', relayInfo.relays?.some((r: any) => r.connected === 'connected') ? 'PASS' : 'FAIL');

  await ctx.close();
  await browser.close();

  console.log('\n=== Stopping relay ===');
  await relay.stop();
  console.log('  Done');

  if(!usesLocalRelay) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
