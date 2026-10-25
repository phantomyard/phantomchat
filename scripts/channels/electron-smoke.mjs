import {_electron} from 'playwright';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';
import {createDisposableIdentity, identityFingerprint, writeOfflineMessage, assertOfflineMessage} from './runtime-identity.mjs';

mkdirSync('.channel-build', {recursive: true});
const dir = mkdtempSync(resolve('.channel-build/electron-'));
const entry = join(dir, 'entry.cjs');
writeFileSync(entry, `const {app, session} = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.setPath('sessionData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: /^https?:|^wss?:/.test(details.url)})));
require(${JSON.stringify(resolve('electron/dist/main.cjs'))});
`);
let desktop;
try {
  desktop = await _electron.launch({args: ['--no-sandbox', entry], timeout: 60000});
  const page = await desktop.firstWindow();
  await page.getByRole('combobox', {name: 'Release channel'}).waitFor({timeout: 60000});
  await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
  const identity = await createDisposableIdentity(page);
  await writeOfflineMessage(page, 'channel-fixture-stable', 101);
  await page.evaluate(() => localStorage.setItem('channel-native-fixture', 'preserved'));
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('combobox', {name: 'Release channel'}).selectOption('preview');
  await page.waitForURL('app://localhost/preview/index.html?channel=preview');
  await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
  await identityFingerprint(page, identity);
  await assertOfflineMessage(page, 'channel-fixture-stable', 101);
  await writeOfflineMessage(page, 'channel-fixture-preview', 102);
  assert.equal(await page.evaluate(() => localStorage.getItem('channel-native-fixture')), 'preserved');
  await page.getByRole('combobox', {name: 'Release channel'}).selectOption('stable');
  await page.waitForURL('app://localhost/index.html?channel=stable');
  await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
  await identityFingerprint(page, identity);
  await assertOfflineMessage(page, 'channel-fixture-stable', 101);
  await assertOfflineMessage(page, 'channel-fixture-preview', 102);
  assert.equal(await page.evaluate(() => localStorage.getItem('channel-native-fixture')), 'preserved');
  console.log('Electron app:// same-profile Stable → Preview → Stable passed');
} finally {
  if(desktop) await desktop.close();
  rmSync(dir, {recursive: true, force: true});
}
