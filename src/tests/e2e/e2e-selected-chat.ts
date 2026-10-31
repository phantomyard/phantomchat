// @ts-nocheck
/** Local Chromium regression: selected DMs/groups stay read across arrivals. */
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
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

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 1500});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const select = async(pid) => {
    await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), pid);
    await A.page.waitForTimeout(700);
  };
  const snapshot = async(convId) => A.page.evaluate(async(id) => {
    const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
    const store = getMessageStore();
    return {unread: await store.countUnread(id, window.__phantomchatOwnPubkey), cursor: await store.getReadCursor(id)};
  }, convId);
  const expectUnread = async(convId, expected) => {
    await A.page.waitForFunction(async({id, count}) => {
      const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
      return await getMessageStore().countUnread(id, window.__phantomchatOwnPubkey) === count;
    }, {id: convId, count: expected}, {timeout: 20000});
  };
  const arrive = async(text) => {
    await A.page.waitForFunction(async(content) => {
      const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
      const rows = await getMessageStore().getMessages(window.__selectedTestConv, 100);
      return rows.some((row) => row.content === content);
    }, text, {timeout: 20000});
  };
  const assertUI = async(pid) => {
    assert.equal(await A.page.locator('.chatlist-chat .dialog-online-dot').count(), 0);
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
      await window.__phantomchatChatAPI.sendText(peer, content);
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
    await A.page.waitForFunction(() => window.appImManager && window.__phantomchatGroupAPI, {timeout: 30000});
    await expectUnread(dmConv, 0);
    console.log('PASS DM deselect + reopen + reload');

    const group = await B.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Selected read regression', [other]);
    }, A.pubkeyHex);
    await A.page.waitForFunction(async(gid) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return !!await getGroupStore().get(gid);
    }, group, {timeout: 20000});
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
    console.log('PASS group deselect restores unread');
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-45).join('\n'));
    console.error('USER B console', B.consoleLog.slice(-25).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
