/**
 * Perf (Phase 2 — receive-path caching): the in-memory status cache in
 * MessageRequestStore. isBlocked / isKnownContact run on every incoming
 * message; the request status is owned entirely by this store's mutations, so
 * it is cached in memory and updated on add/accept/reject. These tests use the
 * REAL store against fake-indexeddb and verify the cache reflects mutations
 * correctly (block enforcement must never go stale), and that isKnownContact
 * trusts only a committed contact mapping — never the bridge pubkeyCache,
 * which holds every pubkey ever hashed (strangers included).
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// Control the bridge fast path explicitly per test.
const hasPeerMapping = vi.fn().mockReturnValue(false);
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {getInstance: () => ({hasPeerMapping})}
}));

// The committed-mapping check, controlled per test. Default: no mapping, so
// isKnownContact falls through to the cached request-status check.
const hasStoredMapping = vi.fn().mockResolvedValue(false);
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  hasStoredMapping: (pk: string) => hasStoredMapping(pk)
}));

import {MessageRequestStore} from '@lib/phantomchat/message-requests';

const PK = (n: string) => 'a'.repeat(63) + n; // unique-ish 64-char pubkeys

describe('MessageRequestStore status cache', () => {
  let store: MessageRequestStore;

  beforeEach(() => {
    hasPeerMapping.mockReturnValue(false);
    hasStoredMapping.mockResolvedValue(false);
    store = new MessageRequestStore();
  });

  afterEach(async() => {
    await store.destroy().catch(() => {});
  });

  it('rejectRequest blocks (cache reflects it without a stale read)', async() => {
    const pk = PK('1');
    expect(await store.isBlocked(pk)).toBe(false); // no row → cached 'none'
    await store.rejectRequest(pk);
    expect(await store.isBlocked(pk)).toBe(true); // cache updated to 'rejected'
  });

  it('acceptRequest unblocks and marks known', async() => {
    const pk = PK('2');
    await store.rejectRequest(pk);
    expect(await store.isBlocked(pk)).toBe(true);
    await store.acceptRequest(pk);
    expect(await store.isBlocked(pk)).toBe(false);
    expect(await store.isKnownContact(pk)).toBe(true); // cached 'accepted'
  });

  it('addRequest caches pending (not blocked, not known)', async() => {
    const pk = PK('3');
    await store.addRequest(pk, 'hi', 123);
    expect(await store.isBlocked(pk)).toBe(false);
    expect(await store.isKnownContact(pk)).toBe(false); // pending ≠ accepted
  });

  it('isKnownContact ignores the bridge pubkeyCache (strangers live there too)', async() => {
    const pk = PK('4');
    hasPeerMapping.mockReturnValue(true); // hashed once — NOT a contact
    expect(await store.isKnownContact(pk)).toBe(false);
  });

  it('isKnownContact is true for a committed contact mapping', async() => {
    const pk = PK('7');
    hasStoredMapping.mockResolvedValue(true);
    expect(await store.isKnownContact(pk)).toBe(true);
    expect(hasStoredMapping).toHaveBeenCalledWith(pk);
  });

  it('a cold unknown pubkey is not blocked and not known', async() => {
    const pk = PK('5');
    expect(await store.isBlocked(pk)).toBe(false);
    expect(await store.isKnownContact(pk)).toBe(false);
  });

  // Regression (review #29): the cross-tab listener must be live on the READ
  // path, not just after a local mutation — otherwise a read-only tab caches
  // 'none' and never hears another tab block the sender, serving a stale
  // not-blocked. A reader that only ever read must still get the block update.
  it('a read-only store still receives a cross-tab block update', async() => {
    if(typeof BroadcastChannel === 'undefined') return; // env without BroadcastChannel
    const pk = PK('6');
    const reader = new MessageRequestStore(); // only ever reads
    const writer = new MessageRequestStore();
    try {
      expect(await reader.isBlocked(pk)).toBe(false); // cold → caches 'none' + activates listener
      await writer.rejectRequest(pk); // another tab blocks → broadcasts
      await new Promise((r) => setTimeout(r, 30)); // let the channel message deliver
      expect(await reader.isBlocked(pk)).toBe(true); // cache updated cross-tab, not stale
    } finally {
      await reader.destroy().catch(() => {});
      await writer.destroy().catch(() => {});
    }
  });
});
