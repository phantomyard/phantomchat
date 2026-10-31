// @ts-nocheck
/**
 * Local Chromium regression: a group row keeps the newest message as its preview
 * when the typing indicator clears.
 * Start Vite separately, then run:
 * FUZZ_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-group-preview-typing.ts
 * Uses disposable identities and its own in-process relay; no Docker required.
 * CHROMIUM_PATH overrides the browser when Playwright's pinned build is absent.
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
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 1500});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const ready = async(page) => page.waitForFunction(() =>
    window.appImManager?.setPeer && window.__phantomchatChatAPI && window.__phantomchatGroupAPI,
  undefined, {timeout: 60000});
  try {
    await Promise.all([ready(A.page), ready(B.page)]);
    const group = await B.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Preview regression', [other]);
    }, A.pubkeyHex);
    let groupPeer;
    const deadline = Date.now() + 30000;
    while(!groupPeer && Date.now() < deadline) {
      groupPeer = await A.page.evaluate(async(gid) => {
        const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
        return (await getGroupStore().get(gid))?.peerId;
      }, group).catch(() => undefined);
      if(!groupPeer) await A.page.waitForTimeout(500);
    }
    assert.ok(groupPeer, 'group reached user A');
    const send = async(page, text) => page.evaluate(async({gid, content}) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      await getGroupAPI().sendMessage(gid, content);
    }, {gid: group, content: text});
    const arrive = async(text) => {
      const limit = Date.now() + 30000;
      while(Date.now() < limit) {
        const found = await A.page.evaluate(async({gid, content}) => {
          const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
          const rows = await getMessageStore().getMessages(`group:${gid}`, 100);
          return rows.some((row) => row.content === content);
        }, {gid: group, content: text}).catch(() => false);
        if(found) return;
        await A.page.waitForTimeout(300);
      }
      throw new Error(`message never reached user A: ${text}`);
    };
    const typing = async(stop) => A.page.evaluate(({chatId, from, stop}) =>
      window.rootScope.managers.apiUpdatesManager.processLocalUpdate({
        _: 'updateChatUserTyping',
        chat_id: chatId,
        from_id: {_: 'peerUser', user_id: from},
        action: {_: stop ? 'sendMessageCancelAction' : 'sendMessageTypingAction'}
      }), {chatId: Math.abs(groupPeer), from: A.remotePeerId, stop});
    const state = async(label) => {
      const out = await A.page.evaluate(async(peerId) => {
        const row = document.querySelector(`.chatlist-chat[data-peer-id="${peerId}"]`);
        const dialog = await window.rootScope.managers.appMessagesManager.getDialogOnly(peerId);
        return {
          row: row?.querySelector('.dialog-subtitle .row-subtitle, .row-subtitle, .dialog-subtitle')?.textContent ?? null,
          top: dialog?.top_message,
          unread: dialog?.unread_count
        };
      }, groupPeer);
      console.log('STATE', label, JSON.stringify(out));
      return out;
    };
    const settle = () => A.page.waitForTimeout(1200);
    // A row loaded at boot is the production shape: the Worker holds its dialog
    // (only then does a typing stop repaint it), and it lives in the Groups folder.
    await send(A.page, 'pre-reload-own-message');
    await arrive('pre-reload-own-message');
    await A.page.reload({waitUntil: 'domcontentloaded'});
    await ready(A.page);
    await A.page.waitForTimeout(4000);
    await A.page.locator('[data-filter-id="3"]').first().click();
    await A.page.locator(`.chatlist-chat[data-peer-id="${groupPeer}"]`).first().waitFor({timeout: 30000});
    // The composer's path: Worker temp message, then VMT sendGroupMessage.
    await A.page.evaluate((peerId) => window.rootScope.managers.appMessagesManager.sendText({peerId, text: 'older-own-message'}), groupPeer);
    await arrive('older-own-message');
    await settle();
    const composer = (text) => A.page.evaluate(({peerId, text}) => window.rootScope.managers.appMessagesManager.sendText({peerId, text}), {peerId: groupPeer, text});
    const expectRow = async(label, text) => {
      const {row} = await state(label);
      assert.ok(row?.includes(text), `${label}: row must show ${text}, got ${JSON.stringify(row)}`);
    };
    await expectRow('own send, typing never started', 'older-own-message');

    // The chat-list row repaints from the Worker's dialog when typing clears, so
    // the Worker's top_message must name a message that still exists.
    await typing(false);
    await settle();
    await typing(true);
    await settle();
    await expectRow('typing cleared after own send', 'older-own-message');

    await send(B.page, 'newest-reply');
    await arrive('newest-reply');
    await settle();
    await typing(true);
    await settle();
    await expectRow('typing cleared after reply', 'newest-reply');

    await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), groupPeer);
    await settle();
    await composer('open-own-message');
    await arrive('open-own-message');
    await settle();
    await expectRow('own send with the chat open', 'open-own-message');
    await typing(false);
    await A.page.waitForTimeout(8000);
    await expectRow('typing expired with the chat open', 'open-own-message');
    if(process.env.SHOT) await A.page.screenshot({path: process.env.SHOT});
    console.log('PASS preview survives typing stop in closed and open chats');
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-30).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
