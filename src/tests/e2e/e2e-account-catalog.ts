// @ts-nocheck
/** Isolated two-device session sync, using a test identity and in-memory relay.
 * Run against a dev server: APP_URL=http://127.0.0.1:8189 pnpm exec tsx src/tests/e2e/e2e-session-sync.ts
 * No real accounts, relay configuration or production services are touched.
 */
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {transformSync} from 'esbuild';
import assert from 'node:assert/strict';
import {chromium, _electron as electron} from 'playwright';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
const require = createRequire(import.meta.url);
const {WebSocketServer} = createRequire(require.resolve('jsdom'))('ws');
const oldStoreSource = execFileSync('git', ['show', '0cb1be65473e3c4cf304caf48f728eb10d1632a6:src/lib/phantomchat/group-store.ts'], {encoding: 'utf8'})
  .replace("import {closeOnVersionChange} from './idb-close-on-versionchange';", 'function closeOnVersionChange(db) { db.onversionchange = () => db.close(); return db; }');
const oldStoreJS = transformSync(oldStoreSource, {loader: 'ts', format: 'esm'}).code;
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
let failGroupMetadata = false;
let failCatalog = false;
let failedMetadataQueries = 0;
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
      if(failCatalog && event.tags.some((t) => t[0] === 't' && t[1] === 'phantomchat.chat/catalog-v1')) return socket.send(JSON.stringify(['OK', event.id, false, 'offline fixture']));
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
      if(failCatalog && args.some((f) => f['#t']?.includes('phantomchat.chat/catalog-v1'))) {
        socket.send(JSON.stringify(['EVENT', id, {kind: 30078, pubkey: 'invalid', id: 'invalid', content: 'unreadable', tags: []}]));
        socket.send(JSON.stringify(['EOSE', id]));
        return;
      }
      if(failGroupMetadata && args.some((f) => f['#d']?.includes('phantomchat.chat/groups'))) {
        failedMetadataQueries++;
        const snapshot = [...events.values()].find((event) => event.kind === 30078 && event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'phantomchat.chat/groups'));
        assert.ok(snapshot, 'metadata fixture must exist before making it unreadable');
        socket.send(JSON.stringify(['EVENT', id, {...snapshot, content: 'unreadable snapshot'}]));
        socket.send(JSON.stringify(['EOSE', id]));
        return;
      }
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
  page.on('pageerror', (error) => { errors.push(`${label}: ${error.message}`); console.log(label, 'PAGE ERROR', error.message); });
  page.on('console', (msg) => { if(msg.type() === 'error') errors.push(`${label}: ${msg.text()}`); if(/PhantomChatOnboardingIntegration|GroupAPI|groups-sync|contacts-groups-sync|NostrRelayPool|session-sync|CrdtSync|ChatAPI.*query|sendGroupMessage|sendMessage|handleGroupOutgoing/.test(msg.text())) console.log(label, msg.text()); });
  await page.goto(APP_URL, {waitUntil: 'domcontentloaded', timeout: 90000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'domcontentloaded', timeout: 90000});
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
  await page.reload({waitUntil: 'domcontentloaded', timeout: 90000});
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
  async function folderList(page) {
    return page.evaluate(async() => Object.values(await window.appImManager.managers.filtersStorage.getFilters()).map((f) => ({id: f.id, catalogId: f.catalogId, title: f.title?.text, included: f.includePeerIds || []})).sort((a, b) => a.id - b.id));
  }
  async function createFolder(page, name) {
    return page.evaluate(async(name) => {
      const filter = {_: 'dialogFilter', id: 5, pFlags: {}, title: {_: 'textWithEntities', text: name, entities: []},
        include_peers: [], exclude_peers: [], pinned_peers: [], includePeerIds: [], excludePeerIds: [], pinnedPeerIds: []};
      await window.appImManager.managers.filtersStorage.createDialogFilter(filter);
    }, name);
  }
  async function hasFolder(page, name, expected = true) {
    await waitForAsync(page, async({name, expected}) => {
      const filters = Object.values(await window.appImManager.managers.filtersStorage.getFilters());
      return filters.some((f) => f.title?.text === name) === expected;
    }, {name, expected}, {timeout: 60000});
  }
  const ids = await a.page.evaluate(async() => {
    const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
    const api = getGroupAPI();
    return [await api.createGroup('Catalog Group', [], undefined, {kind: 'group'}), await api.createGroup('Catalog Session', [], undefined, {kind: 'session'})];
  });
  await waitForAsync(b.page, async(ids) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    const groups = await getGroupStore().getAll();
    return ids.every((id) => groups.some((g) => g.groupId === id));
  }, ids, {timeout: 60000});
  await createFolder(a.page, 'Shared folder');
  await hasFolder(b.page, 'Shared folder');
  console.log('PASS automatic folder arrival', await folderList(b.page));
  // Relay failure must leave both apps usable and preserve independent offline edits.
  failCatalog = true;
  await createFolder(a.page, 'Offline Desktop');
  await createFolder(b.page, 'Offline PWA');
  await a.page.waitForTimeout(5000);
  assert((await folderList(a.page)).some((f) => f.title === 'Offline Desktop'));
  assert((await folderList(b.page)).some((f) => f.title === 'Offline PWA'));
  failCatalog = false;
  for(const page of [a.page, b.page]) await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await hasFolder(a.page, 'Offline PWA');
  await hasFolder(b.page, 'Offline Desktop');
  console.log('PASS concurrent offline adds survive numeric-id collision');
  await a.page.evaluate(async(id) => {
    const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
    await getGroupAPI().archiveGroup(id);
  }, ids[1]);
  await waitForAsync(b.page, async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    const group = await getGroupStore().get(id);
    return !!group?.archivedAt && !!group?.catalogArchiveRevision;
  }, ids[1], {timeout: 60000});
  const stale = [...events.values()].filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'phantomchat.chat/catalog-v1'));
  await b.page.evaluate(async(id) => {
    const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
    await getGroupAPI().unarchiveGroup(id);
  }, ids[1]);
  await waitForAsync(a.page, async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    return (await getGroupStore().get(id))?.archivedAt === 0;
  }, ids[1], {timeout: 60000});
  console.log('PASS archive/unarchive catalog revision reaches running sibling');
  await a.page.evaluate(async() => {
    const fs = window.appImManager.managers.filtersStorage;
    const filter = Object.values(await fs.getFilters()).find((f) => f.title?.text === 'Shared folder');
    await fs.updateDialogFilter(filter, true);
  });
  await hasFolder(b.page, 'Shared folder', false);
  for(const event of stale) events.set('stale:' + event.id, event);
  for(const page of [a.page, b.page]) await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await a.page.waitForTimeout(18000);
  assert(!(await folderList(a.page)).some((f) => f.title === 'Shared folder'));
  assert(!(await folderList(b.page)).some((f) => f.title === 'Shared folder'));
  console.log('PASS stale relay replay cannot resurrect a deleted folder');
  const c = await device('C');
  await hasFolder(c.page, 'Offline Desktop'); await hasFolder(c.page, 'Offline PWA');
  await hasFolder(c.page, 'Shared folder', false);
  await waitForAsync(c.page, async(id) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    const group = await getGroupStore().get(id);
    return group?.kind === 'session' && group.archivedAt === 0;
  }, ids[1], {timeout: 60000});
  const normalized = (folders) => folders.map(({catalogId, title, included}) => ({catalogId, title, included})).sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(normalized(await folderList(a.page)), normalized(await folderList(c.page)));
  console.log('PASS fresh paired device restores matching folders and session class/archive state');
  await c.page.evaluate(async({source, id}) => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    const current = await getGroupStore().get(id);
    const legacy = await import('data:text/javascript;base64,' + btoa(source));
    const store = new legacy.GroupStore();
    const reopened = await store.get(id);
    if(JSON.stringify(reopened.catalogArchiveRevision) !== JSON.stringify(current.catalogArchiveRevision)) throw new Error('Old frontend lost catalog revision on read');
    await store.updateInfo(id, {description: 'Old frontend compatibility probe'});
    await store.destroy();
    const roundTrip = await getGroupStore().get(id);
    if(roundTrip.archivedAt !== 0 || JSON.stringify(roundTrip.catalogArchiveRevision) !== JSON.stringify(current.catalogArchiveRevision)) throw new Error('Old frontend rewrite lost archive placement or revision');
  }, {source: oldStoreJS, id: ids[1]});
  console.log('PASS deployed Stable group-store read/write and Preview reopening preserve catalog fields');
  assert.equal(errors.filter((e) => /account-catalog.*(TypeError|ReferenceError)|Cannot access/.test(e)).length, 0, errors.join('\n'));
  console.log('PASS catalog runtime acceptance', process.env.E2E_ELECTRON ? 'Linux Electron + PWA Chromium' : 'PWA Chromium');
} finally {
  await desktop?.close();
  await browser.close();
  for(const socket of subscriptions.keys()) socket.terminate();
  relay.close();
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
