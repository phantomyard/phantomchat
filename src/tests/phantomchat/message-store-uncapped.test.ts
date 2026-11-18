/**
 * Local-first history: the message store keeps every message (no default cap)
 * and its per-dialog reads stay index-bounded however long a chat gets.
 *
 * Uses fake-indexeddb for real IDB behaviour without a browser.
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, vi} from 'vitest';
import {MessageStore, StoredMessage} from '@lib/phantomchat/message-store';

const OWN = 'aaaa'.repeat(16);
const PEER = 'bbbb'.repeat(16);
const BASE_TS = 1_700_000_000;

let n = 0;
const conv = () => `test-uncapped-${++n}-${Date.now()}`;

function msg(conversationId: string, i: number, opts: Partial<StoredMessage> = {}): StoredMessage {
  return {
    eventId: `evt-${conversationId}-${i}`,
    conversationId,
    senderPubkey: PEER,
    content: `m${i}`,
    type: 'text',
    timestamp: BASE_TS + i,
    deliveryState: 'delivered',
    mid: (BASE_TS + i) * 1_000_000,
    twebPeerId: 1_000_000_000_000_001,
    ...opts
  };
}

describe('MessageStore — uncapped local history', () => {
  it('a default store keeps more than the old 500-row cap', async() => {
    const store = new MessageStore();
    const c = conv();
    for(let i = 0; i < 620; i++) await store.saveMessage(msg(c, i));

    const all = await store.getMessages(c, 10_000);
    expect(all).toHaveLength(620);
    expect(all[all.length - 1].content).toBe('m0'); // the oldest is still on the device
    expect((await store.getMessages(c, 50)).length).toBe(50); // pages stay page-sized
  }, 30_000);

  it('countUnread counts only incoming rows above the read cursor', async() => {
    const store = new MessageStore();
    const c = conv();
    for(let i = 0; i < 600; i++) await store.saveMessage(msg(c, i));
    // Above the cursor: 5 incoming, 1 outgoing (flag), 1 outgoing (own key), 1 seed row.
    await store.setReadCursor(c, (BASE_TS + 599) * 1_000_000);
    for(let i = 600; i < 605; i++) await store.saveMessage(msg(c, i));
    await store.saveMessage(msg(c, 605, {isOutgoing: true}));
    await store.saveMessage(msg(c, 606, {senderPubkey: OWN}));
    await store.saveMessage(msg(c, 607, {eventId: `contact-init-${c}`}));

    const getMessages = vi.spyOn(store, 'getMessages');
    expect(await store.countUnread(c, OWN)).toBe(5);
    // Index walk above the cursor — never a whole-conversation read.
    expect(getMessages).not.toHaveBeenCalled();
  }, 30_000);

  it('countUnread is 0 at the newest row and counts everything with no cursor', async() => {
    const store = new MessageStore();
    const c = conv();
    for(let i = 0; i < 3; i++) await store.saveMessage(msg(c, i));
    expect(await store.countUnread(c, OWN)).toBe(3);
    await store.setReadCursor(c, (BASE_TS + 2) * 1_000_000);
    expect(await store.countUnread(c, OWN)).toBe(0);
  });

  it('getConversationDigest: full count, newest second, greatest eventId on a tie', async() => {
    const store = new MessageStore();
    const c = conv();
    for(let i = 0; i < 550; i++) await store.saveMessage(msg(c, i));
    const top = BASE_TS + 1000;
    await store.saveMessage(msg(c, 1000, {eventId: 'zz-tie', mid: top * 1_000_000 + 1}));
    await store.saveMessage(msg(c, 1000, {eventId: 'aa-tie', mid: top * 1_000_000 + 2}));
    // An unrelated conversation must not leak into the count.
    await store.saveMessage(msg(conv(), 5));

    expect(await store.getConversationDigest(c)).toEqual({count: 552, latestId: 'zz-tie', latestTimestamp: top});
  }, 30_000);

  it('getConversationDigest of an empty conversation', async() => {
    const store = new MessageStore();
    expect(await store.getConversationDigest(conv())).toEqual({count: 0, latestId: '', latestTimestamp: 0});
  });
});
