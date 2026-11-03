// @ts-nocheck
/**
 * Local Chromium regression (#412): a draft typed into a chat must survive
 * navigating away and back, including a brand-new chat with no messages yet
 * (the Code Mode "new prompt" case).
 *
 * Root cause: DialogsStorage.saveDialog did `dialog.draft = saveDraft(dialog.draft)`
 * and PhantomChat virtual dialogs never carry `draft`, so every dialog re-save
 * (syncDraft -> reloadConversation for a chat with no top_message, or any
 * chat-list refresh) silently deleted the stored draft while the stale
 * "Draft:" preview stayed on screen.
 *
 * Start Vite separately, then run:
 * FUZZ_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-draft-navigate-away.ts
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
    const makeGroup = async(title) => {
      const gid = await A.page.evaluate(async({title, other}) => {
        const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
        return getGroupAPI().createGroup(title, [other]);
      }, {title, other: B.pubkeyHex});
      let peerId;
      const deadline = Date.now() + 30000;
      while(!peerId && Date.now() < deadline) {
        peerId = await A.page.evaluate(async(g) => {
          const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
          return (await getGroupStore().get(g))?.peerId;
        }, gid).catch(() => undefined);
        if(!peerId) await A.page.waitForTimeout(300);
      }
      assert.ok(peerId, `group ${title} has a peer`);
      return {gid, peerId};
    };
    // Fresh chats with NO messages: no server top_message, the exact shape
    // that makes syncDraft call reloadConversation.
    const fresh = await makeGroup('Draft probe fresh');
    const other = await makeGroup('Draft probe other');
    // A chat with history covers the "normal chat" path.
    const busy = await makeGroup('Draft probe busy');
    await A.page.evaluate(async(gid) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      await getGroupAPI().sendMessage(gid, 'draft-probe-baseline');
    }, busy.gid);

    const open = async(peerId) => {
      await A.page.evaluate((p) => window.appImManager.setPeer({peerId: p}), peerId);
      await A.page.waitForFunction((p) => window.appImManager.chat?.peerId === p &&
        window.appImManager.chat?.input?.messageInput, peerId, {timeout: 15000});
      await A.page.waitForTimeout(800);
    };
    const inputText = () => A.page.evaluate(() => window.appImManager.chat.input.messageInput.textContent);
    const stored = (peerId) => A.page.evaluate((p) =>
      window.rootScope.managers.appDraftsManager.getDraft(p).then((d) => d?.message ?? null), peerId);

    const check = async(target, text) => {
      await open(target.peerId);
      const input = A.page.locator('.chat.active .input-message-input[contenteditable="true"]').first();
      await input.click();
      await A.page.keyboard.type(text);
      // Past the 2.5s debounce so saveDraft + syncDraft run before leaving.
      await A.page.waitForTimeout(3500);
      await open(other.peerId);
      // Give any reloadConversation / dialog re-save a chance to land.
      await A.page.waitForTimeout(3000);
      const afterLeave = await stored(target.peerId);
      // Any chat-list refresh re-saves dialogs, too.
      await A.page.evaluate(() => window.rootScope.managers.dialogsStorage.getDialogs({filterId: 0, limit: 50}).catch(() => {}));
      // Re-fetching this one dialog from the virtual server is what syncDraft
      // does for a chat without a server top_message; force it so the
      // assertion does not depend on that race.
      await A.page.evaluate((p) => window.rootScope.managers.appMessagesManager.reloadConversation(p).catch(() => {}), target.peerId);
      await A.page.waitForTimeout(1500);
      const afterRefresh = await stored(target.peerId);
      await open(target.peerId);
      const restored = await inputText();
      console.log('DRAFT', JSON.stringify({text, afterLeave, afterRefresh, restored}));
      assert.equal(afterLeave, text, `stored draft survives navigating away (${text})`);
      assert.equal(afterRefresh, text, `stored draft survives a dialog refresh (${text})`);
      assert.equal(restored?.trim(), text, `input shows the draft on return (${text})`);
    };

    await check(fresh, 'new prompt draft survives');
    await check(busy, 'busy chat draft survives');
    console.log('PASS drafts survive navigate-away on fresh and busy chats');
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-30).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
