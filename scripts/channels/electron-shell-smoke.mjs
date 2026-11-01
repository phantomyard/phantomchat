// Release gate for the thin desktop shell, run on every native runner against
// the real Stable site: first launch, app:// origin, CSP, desktop bridge, the
// update check's version file, offline relaunch, and first launch with no network.
import {_electron} from 'playwright';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';

mkdirSync('.channel-build', {recursive: true});
const dir = mkdtempSync(resolve('.channel-build/shell-'));
const profile = join(dir, 'profile');

function writeEntry(name, blockNetwork, userData = profile) {
  const entry = join(dir, name);
  const block = blockNetwork ?
    "session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: /^https?:|^wss?:/.test(details.url)}));" :
    '';
  writeFileSync(entry, `const {app, session} = require('electron');
app.setPath('userData', ${JSON.stringify(userData)});
app.setPath('sessionData', ${JSON.stringify(userData)});
app.whenReady().then(() => {${block}});
require(${JSON.stringify(resolve('electron/dist/main.cjs'))});
`);
  return entry;
}

async function launch(entry) {
  const desktop = await _electron.launch({args: ['--no-sandbox', entry], timeout: 60000});
  return {desktop, page: await desktop.firstWindow()};
}

const bootSplash = '#phantomchat-boot-splash';
let running;
try {
  running = await launch(writeEntry('online.cjs', false));
  let {page} = running;
  await page.waitForURL((url) => url.href.startsWith('app://localhost/index.html'), {timeout: 60000});
  await page.locator(bootSplash).waitFor({state: 'hidden', timeout: 120000});
  assert.equal(await page.evaluate(() => location.origin), 'app://localhost');
  assert.equal(typeof await page.evaluate(() => window.phantomchatDesktop.getVersion()), 'string');
  assert.equal(await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__cspProbe = true';
    document.head.append(script);
    return window.__cspProbe === true;
  }), false, 'CSP must block injected inline script');
  const version = await page.evaluate(async() => (await (await fetch('version', {cache: 'no-cache'})).text()).trim());
  assert.match(version, /^\d+\.\d+\.\d+/, `version file must be readable, got ${JSON.stringify(version)}`);
  await running.desktop.close();

  running = await launch(writeEntry('offline.cjs', true));
  page = running.page;
  await page.waitForURL((url) => url.href.startsWith('app://localhost/index.html'), {timeout: 60000});
  await page.locator(bootSplash).waitFor({state: 'hidden', timeout: 120000});
  await running.desktop.close();

  running = await launch(writeEntry('first-offline.cjs', true, join(dir, 'fresh')));
  page = running.page;
  await page.waitForURL((url) => url.pathname === '/__shell/splash.html', {timeout: 60000});
  await page.getByRole('heading', {name: 'No connection'}).waitFor({timeout: 90000});
  await page.getByRole('button', {name: 'Try again'}).waitFor();
  console.log(`Desktop shell passed against the live site (version ${version}), online and offline`);
} finally {
  if(running) await running.desktop.close().catch(() => {});
  rmSync(dir, {recursive: true, force: true});
}
