// @ts-nocheck
/**
 * Local Chromium check: inside the desktop app the visible name is
 * "Phantomyard Desktop" (window title + boot splash), while the browser PWA
 * still shows "PhantomChat".
 *
 * The desktop case is simulated by defining window.phantomchatDesktop before
 * any page script runs, which is what the Electron preload does.
 *
 * CHROMIUM_PATH overrides the browser when Playwright's pinned build is absent.
 *
 * Start Vite separately, then run:
 * FUZZ_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-desktop-name.ts
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = process.env.FUZZ_APP_URL || 'http://localhost:8080';

async function snapshot(browser, desktop: boolean) {
  const ctx = await browser.newContext();
  if(desktop) {
    // A string, not a function: tsx rewrites functions with helpers that do
    // not exist in the page, so the init script would throw silently.
    await ctx.addInitScript({content: 'window.phantomchatDesktop = {getVersion: () => Promise.resolve("0.0.0-test")};'});
  }
  const page = await ctx.newPage();
  await page.goto(APP_URL, {waitUntil: 'domcontentloaded'});
  const early = await page.evaluate(() => ({
    title: document.title,
    splashTitle: document.querySelector('#phantomchat-boot-splash .nbs-title')?.textContent ?? null,
    splashAccent: document.querySelector('#phantomchat-boot-splash .nbs-title span')?.textContent ?? null
  }));
  // The app must not put the old name back once it has booted.
  await page.waitForTimeout(8000);
  const late = await page.evaluate(() => document.title);
  await ctx.close();
  return {...early, late};
}

async function main() {
  const browser = await chromium.launch({
    ...launchOptions,
    ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})
  });
  try {
    const desktop = await snapshot(browser, true);
    console.log('desktop', desktop);
    assert.equal(desktop.title, 'Phantomyard Desktop');
    assert.equal(desktop.late, 'Phantomyard Desktop');
    assert.equal(desktop.splashTitle, 'Phantomyard Desktop');
    assert.equal(desktop.splashAccent, 'Desktop');

    const web = await snapshot(browser, false);
    console.log('web', web);
    assert.equal(web.title, 'PhantomChat');
    assert.equal(web.late, 'PhantomChat');
    assert.equal(web.splashTitle, 'PhantomChat');
    console.log('PASS');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
