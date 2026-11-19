/**
 * Sender gate: the hasStoredMapping positive cache must be evicted when a
 * contact is deleted mid-session.
 *
 * hasStoredMapping (virtual-peers-db) serves hits from an in-memory set so
 * the gate (chat-api-receive step 2b -> MessageRequestStore.isKnownContact)
 * does not pay an IndexedDB read per inbound DM. removeMapping must evict the
 * pubkey, or a deleted contact keeps answering "known" for the rest of the
 * session and its next message revives the chat until reload.
 *
 * REAL virtual-peers-db + REAL MessageRequestStore against fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, afterEach} from 'vitest';

const OWN_PUBKEY = 'd'.repeat(64);
const PEER = 'c'.repeat(64);
const PEER_ID = 1000000000000777;

let vpdb: typeof import('@lib/phantomchat/virtual-peers-db');
let MessageRequestStore: typeof import('@lib/phantomchat/message-requests').MessageRequestStore;

beforeAll(async() => {
  // storeMapping's tombstone guard reads the runtime own-pubkey global.
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.__phantomchatOwnPubkey = OWN_PUBKEY;
  vpdb = await import('@lib/phantomchat/virtual-peers-db');
  ({MessageRequestStore} = await import('@lib/phantomchat/message-requests'));
});

/** Delete the row straight from IndexedDB, bypassing removeMapping. */
async function deleteRowBehindTheCache(pubkey: string): Promise<void> {
  const db = await vpdb.getDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('mappings', 'readwrite');
    tx.objectStore('mappings').delete(pubkey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('hasStoredMapping positive cache', () => {
  let store: InstanceType<typeof MessageRequestStore>;

  beforeEach(() => {
    vpdb.resetStoredMappingCacheForTests();
    store = new MessageRequestStore();
  });

  afterEach(async() => {
    await vpdb.removeMapping(PEER).catch(() => {});
    await store.destroy().catch(() => {});
  });

  it('serves a committed mapping from memory (precondition: the cache is live)', async() => {
    expect(await vpdb.storeMapping(PEER, PEER_ID, 'Contact')).toBe(true);
    await deleteRowBehindTheCache(PEER);
    // Row is gone from IDB but the positive cache still answers — this is
    // exactly why removeMapping must evict.
    expect(await vpdb.hasStoredMapping(PEER)).toBe(true);
    vpdb.resetStoredMappingCacheForTests();
    expect(await vpdb.hasStoredMapping(PEER)).toBe(false);
  });

  it('mid-session delete: removeMapping evicts, so the contact is no longer known and its next message is gated', async() => {
    expect(await vpdb.storeMapping(PEER, PEER_ID, 'Contact')).toBe(true);
    // Warm the cache through the same path the gate uses.
    expect(await vpdb.hasStoredMapping(PEER)).toBe(true);
    expect(await store.isKnownContact(PEER)).toBe(true);

    await vpdb.removeMapping(PEER); // what deleteConversation does

    expect(await vpdb.hasStoredMapping(PEER)).toBe(false);
    // chat-api-receive step 2b drops (or boot-holds) when this is false.
    expect(await store.isKnownContact(PEER)).toBe(false);
  });

  it('a cache warmed by a read (not a write) is evicted too', async() => {
    expect(await vpdb.storeMapping(PEER, PEER_ID, 'Contact')).toBe(true);
    vpdb.resetStoredMappingCacheForTests();
    expect(await vpdb.hasStoredMapping(PEER)).toBe(true); // re-cached from IDB read
    await vpdb.removeMapping(PEER);
    expect(await vpdb.hasStoredMapping(PEER)).toBe(false);
    expect(await store.isKnownContact(PEER)).toBe(false);
  });
});
