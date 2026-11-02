// @ts-nocheck
/**
 * Local Chromium regression for an empty session's synthetic creation row.
 * Start Vite, then run with FUZZ_APP_URL pointing at the isolated dev server:
 * pnpm exec tsx src/tests/e2e/e2e-empty-session.ts
 * Uses disposable identities, real IndexedDB/worker rendering and a local relay.
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
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 2000});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  try {
    await A.page.waitForFunction(() => window.__phantomchatGroupAPI && window.appImManager, undefined, {timeout: 60000});
    const id = await A.page.evaluate(async(other) =>
      window.__phantomchatGroupAPI.createGroup('New session', [other], undefined, {kind: 'session'}), B.pubkeyHex);
    const peer = await A.page.evaluate(async(id) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().get(id)).peerId;
    }, id);
    const open = async() => {
      await A.page.waitForFunction(() => window.appImManager && window.__phantomchatGroupAPI);
      // After a reload the Sessions folder must load its dialogs before a
      // direct setPeer can ask the Worker for this synthetic chat's pFlags.
      const sessions = A.page.locator('.folders-sidebar__folder-item').filter({hasText: 'Sessions'}).first();
      if(await sessions.isVisible()) await sessions.click();
      const deadline = Date.now() + 30000;
      let ready = false;
      while(Date.now() < deadline) {
        ready = await A.page.evaluate(async(peerId) => {
          const chat = await window.rootScope.managers.appChatsManager.getChat(Math.abs(peerId));
          return !!chat?.pFlags;
        }, peer);
        if(ready) break;
        await A.page.waitForTimeout(250);
      }
      assert.ok(ready, 'session chat loaded into the real Worker');
      await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), peer);
      await A.page.locator('.chat-input [contenteditable="true"]').first().waitFor({state: 'visible'});
      await A.page.waitForTimeout(1500);
    };
    const assertEmpty = async(label) => {
      const rows = await A.page.locator('.bubbles .bubble:not(.date):not(.is-date):not(.empty-bubble-placeholder)').evaluateAll(
        (nodes) => nodes.filter((n) => n.getClientRects().length).map((n) => ({text: n.textContent, class: n.className})));
      assert.equal(rows.length, 0, label + ': ' + JSON.stringify(rows));
      console.log('PASS', label);
    };
    await open();
    await assertEmpty('fresh session has no sender/timestamp bubble');
    await A.page.screenshot({path: process.env.PHANTOMBOT_SCRATCH + '/empty-session-fixed.png'});
    await A.page.reload({waitUntil: 'load'});
    await open();
    await assertEmpty('reloaded session has no sender/timestamp bubble');
    const prompt = 'first real prompt';
    const input = A.page.locator('.chat-input [contenteditable="true"]').first();
    await input.fill(prompt);
    await input.press('Enter');
    await A.page.locator('.bubbles .bubble.is-out').filter({hasText: prompt}).first().waitFor({state: 'visible', timeout: 15000});
    console.log('PASS first real prompt renders');
    await A.page.reload({waitUntil: 'load'});
    await open();
    await A.page.locator('.bubbles .bubble.is-out').filter({hasText: prompt}).first().waitFor({state: 'visible', timeout: 15000});
    const empty = await A.page.locator('.bubbles .bubble.is-message-empty').count();
    assert.equal(empty, 0);
    console.log('PASS real prompt survives reload without phantom empty bubble');
  } catch(err) {
    console.error(A.consoleLog.slice(-25).join('\n'));
    throw err;
  } finally {await teardown();}
}
main().then(() => process.exit(0)).catch((err) => {console.error(err); process.exit(1);});
