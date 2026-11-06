// @ts-nocheck
/**
 * Sessions `+` in a real browser (owner 2026-11-06), wide window:
 *   1. no contacts   -> the New Contact pane opens; saving it opens a session
 *                       with that contact;
 *   2. one contact   -> the session opens directly, no picker;
 *   3. the picker    -> picking the contact whose 1:1 chat is OPEN creates a
 *                       session instead of opening its Edit pane.
 * Start Vite, then: FUZZ_APP_URL=http://localhost:8080 pnpm exec tsx src/tests/e2e/e2e-sessions-plus.ts
 */
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {chromium} from 'playwright';
import {matchFilters} from 'nostr-tools';
import {bootHarness, createUser} from '../fuzz/harness';
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

async function openSessionsFolder(page) {
  const sessions = page.locator('.folders-sidebar__folder-item').filter({hasText: 'Sessions'}).first();
  await sessions.click();
  await page.waitForFunction(() => window.appDialogsManager?.filterId !== undefined);
  await page.waitForTimeout(800);
}

async function pressPlus(page) {
  await page.locator('#new-menu').click();
}

/** The open chat is a session with exactly `pubkey` as the other member. */
async function waitForSessionWith(page, pubkey, label) {
  const deadline = Date.now() + 20000;
  let last;
  while(Date.now() < deadline) {
    last = await page.evaluate(async(pk) => {
      const peerId = window.appImManager?.chat?.peerId;
      if(!peerId) return {peerId};
      const {isSessionPeer} = await import('/src/lib/phantomchat/group-types.ts');
      if(!isSessionPeer(+peerId)) return {peerId, session: false};
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      const groups = await getGroupStore().getAll();
      const g = groups.find((x) => x.peerId === +peerId || x.peerId === -Math.abs(+peerId) || Math.abs(x.peerId) === Math.abs(+peerId));
      return {peerId, session: true, members: g?.members};
    }, pubkey);
    if(last?.session && last.members?.includes(pubkey)) {
      console.log('PASS', label);
      return;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(label + ': no session with the contact; last=' + JSON.stringify(last));
}

async function editPaneOpen(page) {
  return page.locator('#column-right .edit-contact-container, #column-right .sidebar-slider-item.edit-peer-container').evaluateAll(
    (nodes) => nodes.some((n) => n.getClientRects().length > 0));
}

async function main() {
  const {ctx, browser, relay, teardown} = await bootHarness({consoleBufferMax: 2000});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  let C;
  try {
    // 1. A fresh install with no contacts.
    C = await createUser(browser, 'userC', 'Carol-Fresh', relay, {});
    await C.page.waitForFunction(() => window.appImManager && window.__phantomchatGroupAPI, undefined, {timeout: 60000});
    await openSessionsFolder(C.page);
    await pressPlus(C.page);
    await C.page.locator('[data-testid="add-contact-npub"]').waitFor({state: 'visible', timeout: 10000});
    assert.equal(await C.page.locator('#contacts-container:visible').count(), 0, 'no empty picker behind the New Contact pane');
    console.log('PASS no contacts: + opens the New Contact pane');
    await C.page.locator('[data-testid="add-contact-kind-human"]').click().catch(() => {});
    await C.page.locator('[data-testid="add-contact-npub"]').fill(A.npub);
    await C.page.locator('[data-testid="add-contact-name"]').fill('Alice');
    await C.page.locator('[data-testid="add-contact-submit"]').click();
    await waitForSessionWith(C.page, A.pubkeyHex, 'no contacts: the saved contact opens a new session');

    // 2. Exactly one contact (A knows only B).
    await A.page.waitForFunction(() => window.appImManager && window.__phantomchatGroupAPI, undefined, {timeout: 60000});
    await openSessionsFolder(A.page);
    await pressPlus(A.page);
    await waitForSessionWith(A.page, B.pubkeyHex, 'one contact: + opens the session directly');
    assert.equal(await A.page.locator('#contacts-container:visible').count(), 0, 'picker skipped');
    console.log('PASS one contact: no picker');

    // 3. Two contacts, B's 1:1 chat open beside the list; pick B.
    await A.page.evaluate(async(pk) => {
      const {addP2PContact} = await import('/src/lib/phantomchat/add-p2p-contact.ts');
      await addP2PContact({pubkey: pk, nickname: 'Carol', source: 'e2e'});
    }, C.pubkeyHex);
    await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), A.remotePeerId);
    await A.page.waitForFunction((peerId) => +window.appImManager.chat?.peerId === +peerId, A.remotePeerId, {timeout: 15000});
    await A.page.waitForTimeout(1000);
    await openSessionsFolder(A.page);
    await pressPlus(A.page);
    const row = A.page.locator(`#contacts-container [data-peer-id="${A.remotePeerId}"]`).first();
    await row.waitFor({state: 'visible', timeout: 15000});
    await A.page.screenshot({path: (process.env.PHANTOMBOT_SCRATCH || '/tmp') + '/sessions-plus-picker.png'});
    await row.click();
    await waitForSessionWith(A.page, B.pubkeyHex, 'picker: picking the open chat\'s contact creates a session');
    assert.equal(await editPaneOpen(A.page), false, 'no Edit pane');
    console.log('PASS picker: no Edit pane');
    await A.page.screenshot({path: (process.env.PHANTOMBOT_SCRATCH || '/tmp') + '/sessions-plus-after-pick.png'});
  } catch(err) {
    console.error(A.consoleLog.slice(-25).join('\n'));
    throw err;
  } finally {
    await C?.context.close().catch(() => {});
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((err) => {console.error(err); process.exit(1);});
