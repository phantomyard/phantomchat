// @ts-nocheck
/** Isolated two-device session sync, using a test identity and in-memory relay.
 * Run against a dev server: APP_URL=http://127.0.0.1:8189 pnpm exec tsx src/tests/e2e/e2e-session-sync.ts
 * No real accounts, relay configuration or production services are touched.
 */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {chromium, _electron as electron} from 'playwright';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
const require = createRequire(import.meta.url);
const {WebSocketServer} = createRequire(require.resolve('jsdom'))('ws');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8189';
async function waitForAsync(page, predicate, arg, options = {}) {
  const until = Date.now() + (options.timeout ?? 30_000);
  while(Date.now() < until) {
    if(await page.evaluate(predicate, arg)) return;
    await page.waitForTimeout(200);
  }
  throw new Error('Async browser predicate did not settle');
}
async function main() {
const events = new Map();
const subscriptions = new Map();
const relay = new WebSocketServer({host: '127.0.0.1', port: 0});
await new Promise((resolve) => relay.once('listening', resolve));
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
function matches(event, filter) {
  if(filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if(filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if(filter.since && event.created_at < filter.since) return false;
  if(filter.until && event.created_at > filter.until) return false;
  return Object.entries(filter).every(([key, values]) => !key.startsWith('#') || event.tags.some((t) => t[0] === key.slice(1) && values.includes(t[1])));
}
relay.on('connection', (socket) => {
  const subs = new Map();
  subscriptions.set(socket, subs);
  socket.on('close', () => subscriptions.delete(socket));
  socket.on('message', (data) => {
    const [op, id, ...args] = JSON.parse(data.toString());
    if(op === 'EVENT') {
      const event = id;
      if(event.kind >= 30000 && event.kind < 40000) {
        const tag = event.tags.find((t) => t[0] === 'd')?.[1];
        for(const [oldId, old] of events) {
          if(old.kind === event.kind && old.pubkey === event.pubkey && old.tags.find((t) => t[0] === 'd')?.[1] === tag) {
            if(old.created_at > event.created_at) return socket.send(JSON.stringify(['OK', event.id, false, 'older event']));
            events.delete(oldId);
          }
        }
      }
      const known = events.has(event.id);
      events.set(event.id, event);
      socket.send(JSON.stringify(['OK', event.id, true, '']));
      if(!known) for(const [client, filters] of subscriptions) for(const [sub, fs] of filters) {
        if(fs.some((f) => matches(event, f))) client.send(JSON.stringify(['EVENT', sub, event]));
      }
    } else if(op === 'REQ') {
      subs.set(id, args);
      const sent = new Set();
      for(const filter of args) {
        const found = [...events.values()].filter((e) => matches(e, filter)).sort((a, b) => b.created_at - a.created_at).slice(0, filter.limit ?? Infinity);
        for(const event of found) if(!sent.has(event.id)) {
          sent.add(event.id); socket.send(JSON.stringify(['EVENT', id, event]));
        }
      }
      socket.send(JSON.stringify(['EOSE', id]));
    } else if(op === 'CLOSE') subs.delete(id);
  });
});
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
const pages = [];
let desktop;
const errors = [];
async function device(label) {
  let ctx;
  let desktopPage;
  if(label === 'B' && process.env.E2E_ELECTRON) {
    const config = join(process.env.PHANTOMBOT_SCRATCH, `electron-sync-profile-${Date.now()}-${process.pid}`);
    mkdirSync(config, {recursive: true});
    desktop = await electron.launch({
      args: ['--no-sandbox', `--user-data-dir=${config}`, 'electron/dist/main.cjs'],
      env: {...process.env, VITE_DEV_SERVER_URL: APP_URL, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(config, 'cache')},
      timeout: 60000
    });
    ctx = desktop.context();
    desktopPage = await desktop.firstWindow();
  } else {
    ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  }
  await ctx.addInitScript((url) => {
    window.__phantomchatTestRelays = [{url, read: true, write: true}];
    localStorage.setItem('phantomchat-relay-config', JSON.stringify([{url, read: true, write: true}]));
  }, relayUrl);
  await ctx.route('**/relays.json', (route) => route.fulfill({json: {relays: [relayUrl]}}));
  // Keep the scenario hermetic, including discovery and uploads.
  await ctx.route(/^https:\/\//, (route) => route.abort());
  const page = desktopPage || await ctx.newPage();
  pages.push(page);
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  page.on('console', (msg) => { if(msg.type() === 'error') errors.push(`${label}: ${msg.text()}`); if(/PhantomChatOnboardingIntegration|GroupAPI|groups-sync|contacts-groups-sync|NostrRelayPool.*connected/.test(msg.text())) console.log(label, msg.text()); });
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.evaluate(async() => {
    const {importFromNsec} = await import('/src/lib/phantomchat/nostr-identity.ts');
    const {generateBrowserScopedKey, encryptKeys, saveBrowserKey, saveEncryptedIdentity} = await import('/src/lib/phantomchat/key-storage.ts');
    const identity = importFromNsec('12'.repeat(32));
    const key = await generateBrowserScopedKey();
    const {iv, ciphertext} = await encryptKeys({seed: '', nsec: identity.nsec}, key);
    await saveBrowserKey(key);
    await saveEncryptedIdentity({id: 'current', npub: identity.npub, displayName: 'Session sync test', protectionType: 'none', iv, encryptedKeys: ciphertext, createdAt: Date.now()});
  });
  await page.reload({waitUntil: 'load'});
  await page.waitForFunction(() => window.__phantomchatChatAPI && window.appImManager?.managers, undefined, {timeout: 60000});
  await waitForAsync(page, async() => {
    const {getGroupsSyncStatus} = await import('/src/lib/phantomchat/session-sync-state.ts');
    return window.__phantomchatDeviceSync && getGroupsSyncStatus() === 'ready';
  }, undefined, {timeout: 60000});
  console.log(`${label} ready`);
  return {ctx, page};
}
try {
  const a = await device('A');
  const b = await device('B');
  await a.page.waitForTimeout(1000);
  const groupId = await a.page.evaluate(async() => {
    const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
    return getGroupAPI().createGroup('Sync test session', [], undefined, {kind: 'session'});
  });
  await waitForAsync(b.page, async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    return !!(await getGroupStore().get(id));
  }, groupId, {timeout: 30000});
  console.log('new session arrived via group nudge', groupId);
  console.log('groups now', await b.page.evaluate(async() => { const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts'); return {groups: await getGroupStore().getAll(), deleted: await getGroupStore().listDeletedGroups()}; }));
  const peerId = await b.page.evaluate(async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    return (await getGroupStore().get(id)).peerId;
  }, groupId);
  await b.page.evaluate(async(id) => window.appImManager.setInnerPeer({peerId: id}), peerId);
  await waitForAsync(b.page, async(id) => {
    const {getChatSyncStatus} = await import('/src/lib/phantomchat/session-sync-state.ts');
    return getChatSyncStatus(id) === 'ready';
  }, peerId, {timeout: 30000});
  console.log('selected session catch-up checked');
  const input = b.page.locator('.chat-input:not(.hide) .input-message-input[contenteditable="true"]').last();
  await input.fill('Keep this draft while catching up');
  await b.page.evaluate(async(id) => {
    const {setChatSyncStatus} = await import('/src/lib/phantomchat/session-sync-state.ts');
    setChatSyncStatus(id, 'syncing');
  }, peerId);
  await input.press('Enter');
  assert.match(await input.innerText(), /Keep this draft/);
  assert.match(await b.page.locator('.chat-input:not(.hide) > .session-sync-status').last().innerText(), /Syncing messages/);
  const mediaBlocked = await b.page.evaluate(async(id) => {
    try {
      await window.__phantomchatMTProtoServer.handleMethod('messages.sendMedia', {peer: {_: 'inputPeerChat', chat_id: Math.abs(id)}});
      return false;
    } catch(error) { return error.message; }
  }, peerId);
  assert.match(mediaBlocked, /Sync messages before sending/);
  console.log('stale Enter/media blocked; draft preserved');
  await a.page.evaluate(async(id) => {
    const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
    await getGroupAPI().archiveGroup(id);
  }, groupId);
  await waitForAsync(b.page, async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    return !!(await getGroupStore().get(id))?.archivedAt;
  }, groupId, {timeout: 30000});
  console.log('archive reached running sibling');
  await b.ctx.setOffline(true);
  await a.page.evaluate(async(id) => {
    const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
    await getGroupAPI().deleteGroup(id);
  }, groupId);
  await a.page.waitForTimeout(5000);
  await b.ctx.setOffline(false);
  await waitForAsync(b.page, async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    return !(await getGroupStore().get(id));
  }, groupId, {timeout: 30000});
  console.log('offline sibling learned durable delete on reconnect');
  if(process.env.SYNC_SCREENSHOT) await b.page.screenshot({path: process.env.SYNC_SCREENSHOT});
  assert.equal(errors.filter((e) => /Cannot access .* before initialization|session-sync.*TypeError/.test(e)).length, 0, errors.join('\n'));
  console.log('PASS two-device sync, selected-session readiness, stale send guards, archive/delete, reconnect');
} catch(error) {
  console.error(error);
  console.error(errors.slice(-30).join('\n'));
  for(let i = 0; i < pages.length; i++) await pages[i].screenshot({path: `${process.env.PHANTOMBOT_SCRATCH || '/tmp'}/sync-failure-${i}.png`}).catch(() => {});
  process.exitCode = 1;
} finally {
  if(desktop) await desktop.close();
  await browser.close();
  for(const socket of relay.clients) socket.terminate();
  await new Promise((resolve) => relay.close(resolve));
}

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
