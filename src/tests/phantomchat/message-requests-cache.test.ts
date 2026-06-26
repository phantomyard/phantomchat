/**
 * Perf (Phase 2 — receive-path caching): the in-memory status cache in
 * MessageRequestStore. isBlocked / isKnownContact run on every incoming
 * message; the request status is owned entirely by this store's mutations, so
 * it is cached in memory and updated on add/accept/reject. These tests use the
 * REAL store against fake-indexeddb and verify the cache reflects mutations
 * correctly (block enforcement must never go stale) and that the bridge
 * pubkeyCache fast-path short-circuits isKnownContact.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// Control the bridge fast path explicitly per test.
const hasPeerMapping = vi.fn().mockReturnValue(false);
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {getInstance: () => ({hasPeerMapping})}
}));

// Force the virtual-peers-db read to miss so isKnownContact falls through to
// the cached request-status check (the vpdb path is exercised elsewhere).
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  getDB: () => Promise.reject(new Error('no vpdb in this test'))
}));

import {MessageRequestStore} from '@lib/phantomchat/message-requests';

const PK = (n: string) => 'a'.repeat(63) + n; // unique-ish 64-char pubkeys

describe('MessageRequestStore status cache', () => {
  let store: MessageRequestStore;

  beforeEach(() => {
    hasPeerMapping.mockReturnValue(false);
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

  it('isKnownContact short-circuits on the bridge pubkeyCache fast path', async() => {
    const pk = PK('4');
    hasPeerMapping.mockReturnValue(true); // peer is mapped in memory
    // No request row, vpdb mocked to reject — yet known via the fast path.
    expect(await store.isKnownContact(pk)).toBe(true);
    expect(hasPeerMapping).toHaveBeenCalledWith(pk);
  });

  it('a cold unknown pubkey is not blocked and not known', async() => {
    const pk = PK('5');
    expect(await store.isBlocked(pk)).toBe(false);
    expect(await store.isKnownContact(pk)).toBe(false);
  });
});
