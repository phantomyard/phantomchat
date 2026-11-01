// Release gate for moving an existing install onto the thin shell. A profile is
// created by the last bundled release, then opened by the new shell against the
// real Stable site: nothing the user set up may need doing again.
//
// PHANTOMCHAT_OLD_APP_DIR is the unpacked app.asar of that release.
import {_electron} from 'playwright';
import {existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';
import {createDisposableIdentity, identityFingerprint, writeOfflineMessage, assertOfflineMessage} from './runtime-identity.mjs';

const oldApp = process.env.PHANTOMCHAT_OLD_APP_DIR;
assert.ok(oldApp && existsSync(join(oldApp, 'dist/index.html')), 'PHANTOMCHAT_OLD_APP_DIR must hold a bundled release');

mkdirSync('.channel-build', {recursive: true});
const dir = mkdtempSync(resolve('.channel-build/upgrade-'));
const profile = join(dir, 'profile');
const oldMain = join(resolve(oldApp), 'electron/dist/main.cjs');
const newMain = resolve('electron/dist/main.cjs');
const OLD_BLOCK = '/^https?:|^wss?:/'; // its own bundle, nothing live
const NEW_BLOCK = '/^wss?:/'; // https for the frontend, relays still blocked

function writeEntry(name, main, blocked, userData = profile) {
  const entry = join(dir, name);
  writeFileSync(entry, `const {app, session} = require('electron');
app.setPath('userData', ${JSON.stringify(userData)});
app.setPath('sessionData', ${JSON.stringify(userData)});
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: ${blocked}.test(details.url)})));
require(${JSON.stringify(main)});
`);
  return entry;
}

const launch = (entry) => _electron.launch({args: ['--no-sandbox', entry], timeout: 60000});

const readStorage = (page) => page.evaluate(async() => {
  const stores = {};
  for(const {name} of await indexedDB.databases()) {
    const request = indexedDB.open(name);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for(const store of db.objectStoreNames) {
      const count = db.transaction(store).objectStore(store).count();
      stores[name + '/' + store] = await new Promise((resolve, reject) => {
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
    }
    db.close();
  }
  return {stores, local: Object.fromEntries(Object.entries(localStorage))};
});

const serviceWorkerScripts = (page) => page.evaluate(async() =>
  (await navigator.serviceWorker.getRegistrations())
  .map((registration) => (registration.active || registration.waiting || registration.installing)?.scriptURL)
  .filter(Boolean));

const PHANTOM = {pubkey: 'c'.repeat(64), peerId: 1000000000000042, displayName: 'upgrade-phantom', mappedAt: 1};

const seedPhantom = (page) => page.evaluate((phantom) => new Promise((resolve, reject) => {
  const request = indexedDB.open('phantomchat-virtual-peers');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('mappings', 'readwrite');
    tx.objectStore('mappings').put(phantom);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  };
}), PHANTOM);

const readPhantom = (page) => page.evaluate((pubkey) => new Promise((resolve, reject) => {
  const request = indexedDB.open('phantomchat-virtual-peers');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const get = db.transaction('mappings').objectStore('mappings').get(pubkey);
    get.onsuccess = () => {
      db.close();
      resolve(get.result);
    };
    get.onerror = () => reject(get.error);
  };
}), PHANTOM.pubkey);

const CHANNEL_KEY = 'phantomchat-release-channel';
const bootSplash = '#phantomchat-boot-splash';
const assertSignedIn = async(page) => {
  await page.locator(bootSplash).waitFor({state: 'hidden', timeout: 120000});
  assert.equal(await page.getByRole('button', {name: 'Create New Identity', exact: true}).count(), 0, 'upgrade must not fall back to onboarding');
};

let desktop;
try {
  // The old release.
  desktop = await launch(writeEntry('old.cjs', oldMain, OLD_BLOCK));
  let page = await desktop.firstWindow();
  await page.locator(bootSplash).waitFor({state: 'hidden', timeout: 45000});
  const identity = await createDisposableIdentity(page);
  await writeOfflineMessage(page, 'upgrade-fixture', 201);
  await page.evaluate(() => localStorage.setItem('upgrade-fixture', 'preserved'));
  await seedPhantom(page);
  await page.waitForFunction(async() => (await navigator.serviceWorker.getRegistrations()).some((r) => r.active), undefined, {timeout: 30000});
  const oldScripts = await serviceWorkerScripts(page);
  assert.ok(oldScripts.length > 0, 'the old release must leave a service worker, or retiring it proves nothing');
  const before = await readStorage(page);
  await desktop.close();

  // The new shell on that profile.
  const newEntry = writeEntry('new.cjs', newMain, NEW_BLOCK);
  desktop = await launch(newEntry);
  page = await desktop.firstWindow();
  assert.equal(new URL(page.url()).pathname, '/__shell/splash.html', 'an upgraded install must start on the bootstrap');
  await page.waitForURL((url) => url.pathname === '/index.html', {timeout: 60000});
  await assertSignedIn(page);
  await identityFingerprint(page, identity);
  await assertOfflineMessage(page, 'upgrade-fixture', 201);
  assert.deepEqual(await readPhantom(page), PHANTOM);
  const after = await readStorage(page);
  for(const [store, count] of Object.entries(before.stores)) {
    assert.ok((after.stores[store] ?? 0) >= count, `${store} lost rows: ${count} -> ${after.stores[store]}`);
  }
  assert.equal(after.local['upgrade-fixture'], 'preserved');
  for(const script of await serviceWorkerScripts(page)) {
    assert.ok(!oldScripts.includes(script), `old service worker survived: ${script}`);
  }
  await desktop.close();

  // The bootstrap runs once: the next launch goes straight to the app.
  desktop = await launch(newEntry);
  page = await desktop.firstWindow();
  assert.equal(new URL(page.url()).pathname, '/index.html');
  await assertSignedIn(page);
  await identityFingerprint(page, identity);
  await desktop.close();

  // Someone on Preview before the upgrade is still on it after.
  const previewProfile = join(dir, 'preview-profile');
  desktop = await launch(writeEntry('old-preview.cjs', oldMain, OLD_BLOCK, previewProfile));
  page = await desktop.firstWindow();
  await page.locator(bootSplash).waitFor({state: 'hidden', timeout: 45000});
  const previewIdentity = await createDisposableIdentity(page);
  await page.evaluate((key) => localStorage.setItem(key, 'preview'), CHANNEL_KEY);
  await desktop.close();
  desktop = await launch(writeEntry('new-preview.cjs', newMain, NEW_BLOCK, previewProfile));
  page = await desktop.firstWindow();
  await page.waitForURL((url) => url.pathname === '/preview/index.html', {timeout: 60000});
  await assertSignedIn(page);
  await identityFingerprint(page, previewIdentity);
  console.log(`Upgrade passed: ${Object.keys(before.stores).length} stores, identity ${identity.npub.slice(0, 12)}…, phantom and message kept`);
} finally {
  if(desktop) await desktop.close().catch(() => {});
  rmSync(dir, {recursive: true, force: true});
}
