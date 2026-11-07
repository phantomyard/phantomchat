// @ts-nocheck
/**
 * Session wording in a real browser (owner 2026-11-06): a session's editor and
 * delete dialog say "Session", never "Group" (sessions share the group UI).
 * Start Vite, then: FUZZ_APP_URL=http://localhost:8080 pnpm exec tsx src/tests/e2e/e2e-session-wording.ts
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


const shot = (name) => (process.env.PHANTOMBOT_SCRATCH || '/tmp') + '/' + name;

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 2000});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  try {
    // A knows only B: + opens a session with B directly, A is its admin.
    await A.page.waitForFunction(() => window.appImManager && window.__phantomchatGroupAPI, undefined, {timeout: 60000});
    await openSessionsFolder(A.page);
    await pressPlus(A.page);
    await waitForSessionWith(A.page, B.pubkeyHex, 'session created');
    const peerId = await A.page.evaluate(() => +window.appImManager.chat.peerId);

    // Right panel: the editor's delete button.
    await A.page.evaluate(async(id) => {
      const {openPeerEditor} = await import('/src/components/peerActionsMenu.ts');
      await openPeerEditor(id);
    }, peerId);
    const del = A.page.locator('#column-right .phantomchat-group-edit-container button.danger').filter({hasText: /Delete/});
    await del.first().waitFor({state: 'visible', timeout: 15000});
    assert.match(await del.first().innerText(), /^\W*Delete Session\s*$/);
    await del.first().click();
    const confirm = A.page.locator('.popup').last();
    await confirm.waitFor({state: 'visible', timeout: 10000});
    const confirmText = await confirm.innerText();
    assert.match(confirmText, /Delete this session for everyone\?/);
    assert.doesNotMatch(confirmText, /group/i);
    await A.page.screenshot({path: shot('session-wording-editor.png')});
    console.log('PASS editor: Delete Session + session confirm');
    await A.page.keyboard.press('Escape');
    await confirm.waitFor({state: 'detached', timeout: 10000}).catch(() => {});

    // Chat-list delete dialog (the owner's screenshot).
    await A.page.evaluate(async(id) => {
      const {default: PopupDeleteDialog} = await import('/src/components/popups/deleteDialog.ts');
      new PopupDeleteDialog(id.toPeerId());
    }, peerId);
    const popup = A.page.locator('.popup-delete-chat');
    await popup.waitFor({state: 'visible', timeout: 10000});
    const text = await popup.innerText();
    assert.match(text, /Delete session/);
    assert.match(text, /delete and leave the session\?/);
    assert.match(text, /DELETE SESSION/i);
    assert.doesNotMatch(text, /group/i);
    await A.page.screenshot({path: shot('session-wording-dialog.png')});
    console.log('PASS delete dialog: session wording');
  } catch(err) {
    console.error(A.consoleLog.slice(-25).join('\n'));
    throw err;
  } finally {
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((err) => {console.error(err); process.exit(1);});
