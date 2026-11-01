// @ts-nocheck
/**
 * Local Chromium regression: group menu pin/unpin and read/unread persist
 * through the real MessagePort and IndexedDB paths.
 * Start Vite separately, then run:
 * FUZZ_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-group-menu-flags.ts
 * Uses disposable identities and its own in-process relay; no Docker required.
 * CHROMIUM_PATH overrides the browser when Playwright's pinned build is absent.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {WebSocketServer} from 'ws';
import {chromium} from 'playwright';
import {matchFilters} from 'nostr-tools';
import {bootHarness} from '../fuzz/harness';
import {LocalRelay} from './helpers/local-relay';

// An isolated NIP-01 relay avoids Docker permissions and shared test containers.
let relayServer: WebSocketServer;
LocalRelay.prototype.start = async function() {
  relayServer = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise<void>((resolve) => relayServer.once('listening', resolve));
  this.url = `ws://127.0.0.1:${relayServer.address().port}`;
  const events = new Map();
  const subscriptions = new Map();
  relayServer.on('connection', (socket) => {
    subscriptions.set(socket, new Map());
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (raw) => {
      const [kind, id, ...rest] = JSON.parse(String(raw));
      const send = (s, msg) => s.readyState === 1 && s.send(JSON.stringify(msg));
      if(kind === 'EVENT') {
        const event = id;
        events.set(event.id, event);
        send(socket, ['OK', event.id, true, '']);
        for(const [client, subs] of subscriptions) {
          for(const [sub, filters] of subs) {
            if(matchFilters(filters, event)) send(client, ['EVENT', sub, event]);
          }
        }
      } else if(kind === 'REQ') {
        subscriptions.get(socket).set(id, rest);
        for(const event of events.values()) {
          if(matchFilters(rest, event)) send(socket, ['EVENT', id, event]);
        }
        send(socket, ['EOSE', id]);
      } else if(kind === 'CLOSE') subscriptions.get(socket).delete(id);
    });
  });
};
LocalRelay.prototype.stop = async function() {
  for(const client of relayServer.clients) client.terminate();
  await new Promise<void>((resolve) => relayServer.close(() => resolve()));
};

// Keep onboarding independent of public profile/asset services. The actual
// messaging transport is the local relay above; all app assets come from Vite.
const launch = chromium.launch.bind(chromium);
chromium.launch = async(options) => {
  const browser = await launch({...options, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async(contextOptions) => {
    const context = await newContext(contextOptions);
    context.on('page', (page) => {
      page.on('domcontentloaded', () => console.log('browser DOM loaded'));
      page.on('pageerror', (error) => console.error('browser pageerror:', error.message));
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    return context;
  };
  return browser;
};

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 1500});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const config = JSON.parse(readFileSync('scripts/channels/config.json', 'utf8'));
  const oldStore = execFileSync('git', ['show', config.stableRef + ':src/lib/phantomchat/group-store.ts'], {encoding: 'utf8'});
  const oldCode = ts.transpileModule(oldStore, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
  await A.page.route('**/__stable-group-store.mjs', (route) =>
    route.fulfill({contentType: 'application/javascript', body: oldCode}));
  try {
    await A.page.waitForFunction(() => window.__phantomchatGroupAPI && window.rootScope?.managers);
    const groupId = await A.page.evaluate(async(other) =>
      window.__phantomchatGroupAPI.createGroup('Group menu regression', [other]), B.pubkeyHex);
    await A.page.waitForTimeout(1500);
    await A.page.reload({waitUntil: 'domcontentloaded'});
    await A.page.waitForFunction(() => window.__phantomchatGroupAPI && window.rootScope?.managers);
    await A.page.waitForTimeout(3000);
    const peer = await A.page.evaluate(async(id) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().get(id)).peerId;
    }, groupId);
    const flags = () => A.page.evaluate(async(peerId) => {
      const storage = window.rootScope.managers.dialogsStorage;
      const dialog = await storage.getDialogOnly(peerId);
      return {pinned: !!dialog?.pFlags?.pinned, unread: !!dialog?.pFlags?.unread_mark,
        count: dialog?.unread_count, order: await storage.getPinnedOrders(3)};
    }, peer);
    await A.page.evaluate((peerId) => window.__phantomchatGroupAPI.setGroupPinnedByPeerId(peerId, true), peer);
    let state = await flags();
    assert.equal(state.pinned, true);
    assert.ok(state.order.includes(peer), 'pin persisted in the real Worker order');
    await A.page.evaluate((peerId) => window.__phantomchatGroupAPI.setGroupPinnedByPeerId(peerId, false), peer);
    state = await flags();
    assert.equal(state.pinned, false);
    assert.ok(!state.order.includes(peer), 'unpin removed the Worker order entry');
    console.log('PASS: real MessagePort pin/unpin');

    await A.page.evaluate((peerId) => window.__phantomchatGroupAPI.setGroupUnreadMarkByPeerId(peerId, true), peer);
    assert.equal((await flags()).unread, true);
    await A.page.evaluate((peerId) => window.__phantomchatGroupAPI.setGroupUnreadMarkByPeerId(peerId, false), peer);
    assert.equal((await flags()).unread, false);
    // Exercise the exact context-menu handler with counted unread and no dot.
    await A.page.evaluate(async(peerId) => {
      const {default: Menu} = await import('/src/components/dialogsContextMenu.ts');
      const menu = new Menu(window.rootScope.managers);
      menu.peerId = peerId;
      menu.dialog = {_: 'dialog', peerId, unread_count: 3, pFlags: {}};
      window.__menuCalls = [];
      menu.toggleGroupUnread = (value) => window.__menuCalls.push(value);
      menu.onUnreadClick();
    }, peer);
    assert.deepEqual(await A.page.evaluate(() => window.__menuCalls), [false],
      'Mark as read must clear counted unread instead of setting a new dot');
    console.log('PASS: counted-unread menu action chooses read');
    // Stored preferences must survive the full getDialogs rebuild.
    await A.page.evaluate(async(peerId) => {
      await window.__phantomchatGroupAPI.setGroupPinnedByPeerId(peerId, true);
      await window.__phantomchatGroupAPI.setGroupUnreadMarkByPeerId(peerId, true);
    }, peer);
    await A.page.reload({waitUntil: 'domcontentloaded'});
    await A.page.waitForFunction(() => window.__phantomchatGroupAPI && window.rootScope?.managers);
    await A.page.waitForTimeout(3000);
    state = await flags();
    assert.equal(state.pinned, true);
    assert.equal(state.unread, true);
    assert.ok(state.order.includes(peer));
    console.log('PASS: pin and unread mark survive reload');
    const reopened = await A.page.evaluate(async(id) => {
      const {GroupStore} = await import('/__stable-group-store.mjs');
      const old = new GroupStore();
      await old.updateInfo(id, {name: 'Renamed by pinned Stable'});
      const row = await old.get(id);
      await old.recordDeletedGroup('compatibility-tombstone', 12345);
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      const current = getGroupStore();
      const preview = await current.get(id);
      return {old: {pin: row.pinnedAt, mark: row.unreadMarkAt, peer: row.peerId},
        preview: {pin: preview.pinnedAt, mark: preview.unreadMarkAt, peer: preview.peerId},
        name: preview.name, tombstone: await current.listDeletedGroups()};
    }, groupId);
    assert.deepEqual(reopened.old, reopened.preview);
    assert.ok(reopened.preview.pin > 0 && reopened.preview.mark > 0);
    assert.equal(reopened.name, 'Renamed by pinned Stable');
    assert.ok(reopened.tombstone.some((row) => row.groupId === 'compatibility-tombstone'));
    console.log('PASS: pinned Stable reopens Preview data, renames without dropping flags, and writes readable durable tombstones');
  } finally {
    await teardown();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
