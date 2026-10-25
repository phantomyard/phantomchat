import {chromium} from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';

const app = express();
app.use(express.static('dist'));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
try {
  for(const viewport of [{width: 1366, height: 900}, {width: 390, height: 844}]) {
    const context = await browser.newContext({viewport});
    // Keep the smoke test entirely local; it must never touch live relays.
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/');
    await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
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
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('combobox', {name: 'Release channel'}).selectOption('preview');
    await page.waitForURL('**/preview/index.html?channel=preview');
    await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
    assert.equal(await page.locator('#manifest').getAttribute('href'), '/site.webmanifest');
    assert.equal(await page.evaluate(() => localStorage.getItem('channel-smoke-existing-setting')), 'keep');
    await page.reload();
    await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
    assert.equal(await page.getByRole('combobox', {name: 'Release channel'}).inputValue(), 'preview');
    await page.goto(origin + '/');
    await page.waitForURL('**/preview/index.html');
    await page.getByRole('combobox', {name: 'Release channel'}).selectOption('stable');
    await page.waitForURL('**/index.html?channel=stable');
    await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
    await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
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
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
