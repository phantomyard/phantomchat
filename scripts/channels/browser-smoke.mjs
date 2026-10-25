import {chromium} from 'playwright';
import express from 'express';
import {mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createDisposableIdentity, identityFingerprint, writeOfflineMessage, assertOfflineMessage, openChannelSettings} from './runtime-identity.mjs';

const app = express();
app.use(express.static(process.env.CHANNEL_SMOKE_DIST || 'dist'));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const watchdog = setTimeout(() => { console.error('Browser smoke exceeded 4 minutes'); process.exit(1); }, 240000);
const browser = await chromium.launch({headless: true, proxy: {server: 'http://127.0.0.1:9', bypass: '127.0.0.1'}});
try {
  for(const viewport of [{width: 1366, height: 900}, {width: 390, height: 844}]) {
    console.log(`Starting browser round trip: ${viewport.width}`);
    const context = await browser.newContext({viewport});
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(45000);
    // Keep the smoke test entirely local; it must never touch live relays.
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/');
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
    const identity = await createDisposableIdentity(page);
    await page.emulateMedia({colorScheme: 'dark'});
    await page.waitForTimeout(350);
    const stableAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim().toLowerCase());
    await writeOfflineMessage(page, 'channel-fixture-stable', 101);
    await page.evaluate(async() => {
      localStorage.setItem('channel-smoke-existing-setting', 'keep');
      const request = indexedDB.open('channel-smoke-existing-data', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put({content: 'existing data'}, 'message');
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
      db.close();
    });
    let acceptPreview = false;
    page.on('dialog', dialog => acceptPreview ? dialog.accept() : dialog.dismiss());
    await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('account', '1'); history.replaceState(null, '', url); });
    console.log(`Opening channel settings: ${viewport.width}, ${page.url()}`);
    await openChannelSettings(page);
    assert.equal(await page.getByRole('combobox').count(), 0);
    await page.getByRole('radio', {name: 'Preview', exact: true}).locator('../..').click();
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.getByRole('radio', {name: 'Stable', exact: true}).isChecked(), true);
    acceptPreview = true;
    await page.getByRole('radio', {name: 'Stable', exact: true}).focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForURL(url => url.pathname === '/preview/index.html' && url.searchParams.get('channel') === 'preview');
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes('/preview/'));
    assert.equal(await page.evaluate(async() => new URL((await navigator.serviceWorker.ready).scope).pathname), '/preview/');
    assert.equal(new URL(page.url()).searchParams.get('account'), '1');
    console.log(`Checking identity: ${viewport.width}, ${page.url()}`);
    await identityFingerprint(page, identity);
    await assertOfflineMessage(page, 'channel-fixture-stable', 101);
    await writeOfflineMessage(page, 'channel-fixture-preview', 102);
    assert.ok(['#456783', '#8aacc8'].includes(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim().toLowerCase())), 'Preview must render quiet stock accents on an existing Stable profile');
    assert.equal(await page.locator('#manifest').getAttribute('href'), '/site.webmanifest');
    assert.equal(await page.evaluate(() => localStorage.getItem('channel-smoke-existing-setting')), 'keep');
    await page.reload();
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
    console.log(`Opening channel settings: ${viewport.width}, ${page.url()}`);
    await openChannelSettings(page);
    assert.equal(await page.getByRole('radio', {name: 'Preview', exact: true}).isChecked(), true);
    for(const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({colorScheme});
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      mkdirSync('.channel-build/screenshots', {recursive: true});
      await page.screenshot({path: `.channel-build/screenshots/updates-${viewport.width}-${colorScheme}.png`});
    }
    await page.goto(origin + '/');
    await page.waitForURL('**/preview/index.html');
    await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('account', '1'); history.replaceState(null, '', url); });
    console.log(`Opening channel settings: ${viewport.width}, ${page.url()}`);
    await openChannelSettings(page);
    await page.getByRole('radio', {name: 'Stable', exact: true}).locator('../..').click();
    await page.waitForURL(url => url.pathname === '/index.html' && url.searchParams.get('channel') === 'stable');
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
    assert.equal(new URL(page.url()).searchParams.get('account'), '1');
    console.log(`Checking identity: ${viewport.width}, ${page.url()}`);
    await identityFingerprint(page, identity);
    await assertOfflineMessage(page, 'channel-fixture-stable', 101);
    await assertOfflineMessage(page, 'channel-fixture-preview', 102);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim().toLowerCase()), stableAccent, 'Stable must retain its palette through the round trip');
    const stored = await page.evaluate(async() => {
      const request = indexedDB.open('channel-smoke-existing-data', 1);
      const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
      const get = db.transaction('records').objectStore('records').get('message');
      const value = await new Promise(resolve => { get.onsuccess = () => resolve(get.result); });
      db.close();
      return value;
    });
    assert.equal(stored.content, 'existing data');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Browser channel round-trip passed: ${viewport.width}x${viewport.height}`);
  }
} catch(error) {
  console.error(error);
  throw error;
} finally {
  clearTimeout(watchdog);
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
