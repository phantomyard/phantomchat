import {_electron} from 'playwright';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';
import {createDisposableIdentity, identityFingerprint, writeOfflineMessage, assertOfflineMessage, openChannelSettings} from './runtime-identity.mjs';

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
  await page.locator('#phantomchat-boot-splash').waitFor({state: 'hidden', timeout: 45000});
  const identity = await createDisposableIdentity(page);
  // Anchor the accent on a real colour: both comparisons below read the same
  // property, so an empty value would otherwise make the guard vacuous.
  const readAccent = async() => {
    const value = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim().toLowerCase());
    assert.match(value, /^#[0-9a-f]{6}$/, `--primary-color must resolve to a 6-digit hex colour, got ${JSON.stringify(value)}`);
    return value;
  };
  const stableAccent = await readAccent();
  await writeOfflineMessage(page, 'channel-fixture-stable', 101);
  await page.evaluate(() => localStorage.setItem('channel-native-fixture', 'preserved'));
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('account', '1'); history.replaceState(null, '', url); });
  await openChannelSettings(page);
  // One release-channel group drives both the app shell and installer ring.
  // Scope every lookup to the named group so a radio mounted anywhere else
  // cannot satisfy (or break) the count, and derive the click target from the
  // radio itself: the input is a zero-size, opacity-0 control (measured 0x0),
  // so `.check()` cannot click it — the Row label around it is the element a
  // user actually hits.
  const releaseChannel = page.getByRole('form', {name: 'Release channel', exact: true});
  const radioIn = (name) => releaseChannel.getByRole('radio', {name, exact: true});
  const channelRow = (name) => radioIn(name)
    .locator('xpath=ancestor::label[contains(concat(" ", normalize-space(@class), " "), " row ")][1]');
  assert.equal(await releaseChannel.getByRole('radio').count(), 2);
  assert.equal(await radioIn('Stable').isChecked(), true);
  await page.getByRole('button', {name: 'Check now', exact: true}).waitFor();
  assert.equal(await page.evaluate(async() => (await window.phantomchatDesktop.getUpdateState()).channel), 'stable');
  await channelRow('Preview').click();
  await page.waitForURL(url => url.pathname === '/preview/index.html' && url.searchParams.get('channel') === 'preview');
  assert.equal(new URL(page.url()).searchParams.get('account'), '1');
  await page.waitForFunction(async() => !!window.phantomchatChannels && !!window.phantomchatDesktop &&
    (await window.phantomchatDesktop.getUpdateState()).channel === window.phantomchatChannels.current);
  await identityFingerprint(page, identity);
  await assertOfflineMessage(page, 'channel-fixture-stable', 101);
  await writeOfflineMessage(page, 'channel-fixture-preview', 102);
  assert.equal(await readAccent(), stableAccent, 'Preview must render the original Stable accent');
  assert.equal(await page.evaluate(() => localStorage.getItem('channel-native-fixture')), 'preserved');
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('account', '1'); history.replaceState(null, '', url); });
  await openChannelSettings(page);
  await channelRow('Stable').click();
  await page.waitForURL(url => url.pathname === '/index.html' && url.searchParams.get('channel') === 'stable');
  assert.equal(new URL(page.url()).searchParams.get('account'), '1');
  await page.waitForFunction(async() => !!window.phantomchatChannels && !!window.phantomchatDesktop &&
    (await window.phantomchatDesktop.getUpdateState()).channel === window.phantomchatChannels.current);
  await identityFingerprint(page, identity);
  await assertOfflineMessage(page, 'channel-fixture-stable', 101);
  await assertOfflineMessage(page, 'channel-fixture-preview', 102);
  assert.equal(await readAccent(), stableAccent, 'Stable must retain its original saved stock palette');
  assert.equal(await page.evaluate(() => localStorage.getItem('channel-native-fixture')), 'preserved');
  console.log('Electron app:// same-profile Stable → Preview → Stable passed');
} finally {
  if(desktop) await desktop.close();
  rmSync(dir, {recursive: true, force: true});
}
