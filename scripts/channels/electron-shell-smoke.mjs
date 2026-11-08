// Release gate for the thin desktop shell, run on every native runner against
// the real Stable site: first launch, app:// origin, CSP, desktop bridge, the
// update check's version file, offline relaunch, and first launch with no network.
import {_electron} from 'playwright';
import {cpSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {removeScratch, stopElectron} from './smoke-cleanup.mjs';
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

// Electron's stdout/stderr per launch, printed only when the smoke fails, so a
// hang leaves evidence instead of a bare timeout.
const output = [];

function dumpDiagnostics() {
  console.error('--- Electron output ---\n' + output.join(''));
  const ps = process.platform === 'win32' ?
    spawnSync('tasklist', ['/v'], {encoding: 'utf8'}) :
    spawnSync('ps', ['-ef'], {encoding: 'utf8'});
  console.error('--- Processes ---\n' + (ps.stdout || ps.error?.message || ''));
}

async function launch(entry) {
  const desktop = await _electron.launch({args: ['--no-sandbox', entry], timeout: 60000});
  const tag = entry.split(/[\\/]/).pop();
  for(const stream of ['stdout', 'stderr']) {
    desktop.process()[stream]?.on('data', (chunk) => output.push(`[${tag} ${stream}] ${chunk}`));
  }
  // The launch timeout covers the spawn + CDP handshake only: waiting for the
  // first BrowserWindow is a separate call with its own 30s default, which a
  // cold arm64 runner exceeds while the app is still healthy (run 42471929672).
  return {desktop, page: await desktop.firstWindow({timeout: 120000})};
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
  await stopElectron(running.desktop);

  // The offline relaunch gets its own profile seeded with only the cached web
  // files, so it still proves the app boots from frontend-cache with no network,
  // without inheriting anything the first instance left in its profile (locks,
  // crashpad, Chromium state). On windows-11-arm reusing the profile hung with
  // no window for 120s (runs 42471929672, 42475757699, 42480529526).
  const offlineProfile = join(dir, 'offline');
  cpSync(join(profile, 'frontend-cache'), join(offlineProfile, 'frontend-cache'), {recursive: true});
  running = await launch(writeEntry('offline.cjs', true, offlineProfile));
  page = running.page;
  await page.waitForURL((url) => url.href.startsWith('app://localhost/index.html'), {timeout: 60000});
  await page.locator(bootSplash).waitFor({state: 'hidden', timeout: 120000});
  await stopElectron(running.desktop);

  running = await launch(writeEntry('first-offline.cjs', true, join(dir, 'fresh')));
  page = running.page;
  await page.waitForURL((url) => url.pathname === '/__shell/splash.html', {timeout: 60000});
  await page.getByRole('heading', {name: 'No connection'}).waitFor({timeout: 90000});
  await page.getByRole('button', {name: 'Try again'}).waitFor();
  console.log(`Desktop shell passed against the live site (version ${version}), online and offline`);
} catch(err) {
  dumpDiagnostics();
  throw err;
} finally {
  if(running) await stopElectron(running.desktop).catch(() => {});
  removeScratch(dir);
}
