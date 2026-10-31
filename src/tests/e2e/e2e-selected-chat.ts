// @ts-nocheck
/**
 * Local Chromium regression: selected DMs/groups stay read across arrivals.
 * Start Vite separately, then run:
 * FUZZ_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-selected-chat.ts
 * Uses disposable identities and its own in-process relay; no Docker required.
 */
import assert from 'node:assert/strict';
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
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async(contextOptions) => {
    const context = await newContext(contextOptions);
    context.on('page', (page) => {
      // The harness's fixed load deadline can wait on unrelated late assets;
      // onboarding below still waits for and clicks the real auth controls.
      const goto = page.goto.bind(page);
      const reload = page.reload.bind(page);
      page.goto = (url, opts) => goto(url, {...opts, waitUntil: 'domcontentloaded', timeout: 120000});
      page.reload = (opts) => reload({...opts, waitUntil: 'domcontentloaded', timeout: 120000});
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
  const ready = async(page) => page.waitForFunction(() =>
    window.appImManager?.setPeer && window.__phantomchatChatAPI && window.__phantomchatGroupAPI,
  undefined, {timeout: 60000});
  await Promise.all([ready(A.page), ready(B.page)]);
  const select = async(pid) => {
    await ready(A.page);
    await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), pid);
    await A.page.waitForTimeout(700);
  };
  const snapshot = async(convId) => A.page.evaluate(async(id) => {
    const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
    const store = getMessageStore();
    return {unread: await store.countUnread(id, window.__phantomchatOwnPubkey), cursor: await store.getReadCursor(id)};
  }, convId);
  const until = async(label, predicate, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while(Date.now() < deadline) {
      if(await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const expectUnread = async(convId, expected) => until(
    `unread ${expected} for ${convId}`, async() => (await snapshot(convId)).unread === expected
  );
  const arrive = async(text) => until(`arrival of ${text}`, () => A.page.evaluate(async(content) => {
    const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
    const rows = await getMessageStore().getMessages(window.__selectedTestConv, 100);
    return rows.some((row) => row.content === content);
  }, text));
  const assertUI = async(pid) => {
    assert.equal(await A.page.locator('.chatlist-chat .dialog-online-dot').count(), 0);
    await until('composer unread cleared', () => A.page.evaluate(() =>
      window.appImManager.chat.input.goDownUnreadBadge?.textContent === ''
    ));
    const rows = A.page.locator(`.chatlist-chat[data-peer-id="${pid}"]`);
    assert.ok(await rows.count(), 'selected chat has list rows');
    for(const row of await rows.all()) {
      for(const badge of await row.locator('.dialog-subtitle-badge-unread, .avatar-badge').all()) {
        assert.equal(await badge.isVisible(), false, 'selected unread badge hidden');
      }
    }
  };
  try {
    const dmConv = [A.pubkeyHex, B.pubkeyHex].sort().join(':');
    await A.page.evaluate((id) => { window.__selectedTestConv = id; }, dmConv);
    await select(0);
    const sendDM = async(text) => B.page.evaluate(async({peer, content}) => {
      await window.__phantomchatChatAPI.connect(peer);
      await window.__phantomchatChatAPI.sendText(content);
    }, {peer: A.pubkeyHex, content: text});
    await sendDM('selected-dm-closed');
    await arrive('selected-dm-closed');
    await expectUnread(dmConv, 1);
    await select(A.remotePeerId);
    await expectUnread(dmConv, 0);
    await sendDM('selected-dm-open');
    await arrive('selected-dm-open');
    await expectUnread(dmConv, 0);
    await assertUI(A.remotePeerId);
    console.log('PASS DM select + live arrival + durable cursor', await snapshot(dmConv));
    await select(0);
    await sendDM('selected-dm-left');
    await arrive('selected-dm-left');
    await expectUnread(dmConv, 1);
    await select(A.remotePeerId);
    await expectUnread(dmConv, 0);
    await A.page.reload({waitUntil: 'load'});
    await ready(A.page);
    await expectUnread(dmConv, 0);
    console.log('PASS DM deselect + reopen + reload');

    const group = await B.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Selected read regression', [other]);
    }, A.pubkeyHex);
    await until('group control arrival', () => A.page.evaluate(async(gid) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return !!await getGroupStore().get(gid);
    }, group));
    const groupPeer = await A.page.evaluate(async(gid) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().get(gid)).peerId;
    }, group);
    const groupConv = `group:${group}`;
    await A.page.evaluate((id) => { window.__selectedTestConv = id; }, groupConv);
    const sendGroup = async(text) => B.page.evaluate(async({gid, content}) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      await getGroupAPI().sendMessage(gid, content);
    }, {gid: group, content: text});
    await select(0);
    await sendGroup('selected-group-closed');
    await arrive('selected-group-closed');
    // The Chats space deliberately excludes groups; inspect the Groups list.
    await A.page.evaluate(() => window.appDialogsManager.setFilterIdAndChangeTab(3));
    await until('group row mounted', () => A.page.locator(`.chatlist-chat[data-peer-id="${groupPeer}"]`).count());
    await select(groupPeer);
    await expectUnread(groupConv, 0);
    await sendGroup('selected-group-open');
    await arrive('selected-group-open');
    await expectUnread(groupConv, 0);
    await assertUI(groupPeer);
    // Compact list/mobile layout must hide the avatar counter too.
    await A.page.setViewportSize({width: 390, height: 844});
    await assertUI(groupPeer);
    console.log('PASS group select + live arrival + mobile', await snapshot(groupConv));
    await select(0);
    await sendGroup('selected-group-left');
    await arrive('selected-group-left');
    await expectUnread(groupConv, 1);
    assert.equal(await A.page.evaluate(() => +window.appImManager.chat.peerId), groupPeer,
      'mobile Back retains the cached peer');
    const inactiveRows = A.page.locator(`.chatlist-chat[data-peer-id="${groupPeer}"]`);
    for(const row of await inactiveRows.all()) {
      assert.equal(await row.evaluate((el) => el.classList.contains('active')), false);
    }
    console.log('PASS group mobile Back restores unread');
    await select(groupPeer);
    await expectUnread(groupConv, 0);
    await assertUI(groupPeer);
    await sendGroup('selected-group-mobile-reopened');
    await arrive('selected-group-mobile-reopened');
    await expectUnread(groupConv, 0);
    await assertUI(groupPeer);
    console.log('PASS group mobile re-entry clears and holds read');
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-45).join('\n'));
    console.error('USER B console', B.consoleLog.slice(-25).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
