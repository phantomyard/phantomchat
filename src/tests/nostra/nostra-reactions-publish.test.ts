// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

// Stub virtualPeersDB.getPubkey so tests can drive the peerId→pubkey lookup
// without touching IDB. Each test can mutate `peerIdToPubkey` inline.
const peerIdToPubkey = new Map<number, string | null>();
vi.mock('@lib/nostra/virtual-peers-db', () => ({
  getPubkey: async (peerId: number) => peerIdToPubkey.get(peerId) ?? null
}));

describe('nostra-reactions-publish', () => {
  let publishMod: any;
  let storeMod: any;
  let mockChatAPI: any;
  let publishedEvents: any[];

  afterEach(async () => {
    await storeMod?.nostraReactionsStore?.destroy?.();
  });

  beforeEach(async () => {
    peerIdToPubkey.clear();
    vi.resetModules();
    await new Promise<void>((resolve, reject) => {
      const req = (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
    publishedEvents = [];
    mockChatAPI = {
      publishEvent: vi.fn(async (unsigned: any) => {
        const signed = {...unsigned, id: `fakeid-${publishedEvents.length}`, pubkey: 'ownpk'};
        publishedEvents.push(signed);
        return signed;
      }),
      ownId: 'ownpk'
    };
    storeMod = await import('@lib/nostra/nostra-reactions-store');
    publishMod = await import('@lib/nostra/nostra-reactions-publish');
    publishMod.setChatAPI(mockChatAPI);
    await storeMod.nostraReactionsStore.init();
  });

  it('publish() emits kind-7 with e/p tags + emoji content', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX',
      targetMid: 42,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk',
      emoji: '👍'
    });
    expect(mockChatAPI.publishEvent).toHaveBeenCalledTimes(1);
    const call = mockChatAPI.publishEvent.mock.calls[0][0];
    expect(call.kind).toBe(7);
    expect(call.content).toBe('👍');
    const tagKeys = call.tags.map((t: any[]) => t[0]);
    expect(tagKeys).toContain('e');
    expect(tagKeys).toContain('p');
    const eTag = call.tags.find((t: any[]) => t[0] === 'e');
    expect(eTag[1]).toBe('evtX');
    const pTag = call.tags.find((t: any[]) => t[0] === 'p');
    expect(pTag[1]).toBe('peerpk');
  });

  it('publish() persists row with reactionEventId from published event', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX',
      targetMid: 42,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk',
      emoji: '👍'
    });
    const rows = await storeMod.nostraReactionsStore.getByTarget('evtX');
    expect(rows).toHaveLength(1);
    expect(rows[0].reactionEventId).toBe('fakeid-0');
    expect(rows[0].fromPubkey).toBe('ownpk');
  });

  it('unpublish() emits kind-5 delete referencing the reaction event id', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX', targetMid: 42, targetPeerId: 1e16,
      targetAuthor: 'peerpk', emoji: '👍'
    });
    await publishMod.nostraReactionsPublish.unpublish('fakeid-0');
    expect(mockChatAPI.publishEvent).toHaveBeenCalledTimes(2);
    const call = mockChatAPI.publishEvent.mock.calls[1][0];
    expect(call.kind).toBe(5);
    const eTag = call.tags.find((t: any[]) => t[0] === 'e');
    expect(eTag[1]).toBe('fakeid-0');
    // Self-echo requires the kind-5 delete to pass our `#p: [ownPubkey]`
    // subscription filter, so it must tag our own pubkey.
    const pTag5 = call.tags.find((t: any[]) => t[0] === 'p');
    expect(pTag5[1]).toBe('ownpk');
  });

  it('unpublish() removes the row from the store', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX', targetMid: 42, targetPeerId: 1e16,
      targetAuthor: 'peerpk', emoji: '👍'
    });
    await publishMod.nostraReactionsPublish.unpublish('fakeid-0');
    const rows = await storeMod.nostraReactionsStore.getByTarget('evtX');
    expect(rows).toHaveLength(0);
  });

  // Regression for FIND-4e18d35d (bilateral propagation of reactions on
  // OWN messages). When targetAuthor === ownId, the kind-7 must also carry
  // the conversation peer's pubkey as an additional `p` tag so the peer's
  // `#p: [peerPk]` subscription delivers it.
  it('publish() adds peer pubkey as extra p-tag when reacting to own message', async () => {
    peerIdToPubkey.set(1e16, 'peerpk');

    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'ownMsgId',
      targetMid: 10,
      targetPeerId: 1e16,
      targetAuthor: 'ownpk', // reacting to own message
      emoji: '😂'
    });
    const call = mockChatAPI.publishEvent.mock.calls[0][0];
    const pTags = call.tags.filter((t: any[]) => t[0] === 'p').map((t: any[]) => t[1]);
    expect(pTags).toContain('ownpk');
    expect(pTags).toContain('peerpk');
  });

  it('publish() does not duplicate p-tag when targetAuthor === peer', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = (globalThis as any).indexedDB.deleteDatabase('nostra-virtual-peers');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
    peerIdToPubkey.set(1e16, 'peerpk');

    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'peerMsgId',
      targetMid: 11,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk', // reacting to peer's message (NIP-25 canonical)
      emoji: '👍'
    });
    const call = mockChatAPI.publishEvent.mock.calls[0][0];
    const pTags = call.tags.filter((t: any[]) => t[0] === 'p').map((t: any[]) => t[1]);
    expect(pTags).toEqual(['peerpk']); // exactly one, no duplicate
  });

  it('unpublish() tags peer pubkey too when reaction targeted own message', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = (globalThis as any).indexedDB.deleteDatabase('nostra-virtual-peers');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
    peerIdToPubkey.set(1e16, 'peerpk');

    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'ownMsgId', targetMid: 10, targetPeerId: 1e16,
      targetAuthor: 'ownpk', emoji: '😂'
    });
    await publishMod.nostraReactionsPublish.unpublish('fakeid-0');
    const deleteCall = mockChatAPI.publishEvent.mock.calls[1][0];
    expect(deleteCall.kind).toBe(5);
    const pTags = deleteCall.tags.filter((t: any[]) => t[0] === 'p').map((t: any[]) => t[1]);
    expect(pTags).toContain('ownpk');
    expect(pTags).toContain('peerpk');
  });
});
