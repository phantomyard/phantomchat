// @ts-nocheck
/**
 * Regression for #480 (Delete Account hangs) and #481 (Reset Local Data hangs),
 * against a spec-compliant IndexedDB (fake-indexeddb), no IDB mocks.
 *
 * Shape of the bug: a PhantomChat store still held its connection open with no
 * `onversionchange` handler. The old cleanup "force-closed" it by opening the
 * DB at v999999: `onblocked` fired, but that open request stayed QUEUED, so the
 * deleteDatabase() queued behind it never settled and the overlay hung.
 */

import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi} from 'vitest';

vi.mock('@lib/phantomchat/peer-profile-cache', () => ({clearPeerProfileCache: vi.fn()}));
// Singleton destroy() is exercised elsewhere; here the connection stays open on
// purpose so the delete has to get past a live handle.
const noop = () => ({destroy: () => Promise.resolve()});
vi.mock('@lib/phantomchat/message-store', () => ({getMessageStore: noop}));
vi.mock('@lib/phantomchat/message-requests', () => ({getMessageRequestStore: noop}));
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({getVirtualPeersDB: noop}));
vi.mock('@lib/phantomchat/group-store', () => ({getGroupStore: noop}));

function dbExists(name: string): Promise<boolean> {
  return indexedDB.databases().then((dbs) => dbs.some((d) => d.name === name));
}

describe('phantomchat-cleanup against real IndexedDB semantics (#480/#481)', () => {
  it('wipes the reactions DB while the reactions store holds it open', async() => {
    const {phantomchatReactionsStore} = await import('@lib/phantomchat/phantomchat-reactions-store');
    await phantomchatReactionsStore.add({
      compoundKey: 'e|p|👍', targetEventId: 'e', fromPubkey: 'p', emoji: '👍', reactionEventId: 'r', createdAt: 1
    });
    expect(await dbExists('phantomchat-reactions')).toBe(true);

    const {clearAllExceptSeed} = await import('@lib/phantomchat/phantomchat-cleanup');
    const started = Date.now();
    const failed = await clearAllExceptSeed();

    expect(failed).not.toContain('phantomchat-reactions');
    expect(await dbExists('phantomchat-reactions')).toBe(false);
    // Settled promptly, not via the per-DB timeout.
    expect(Date.now() - started).toBeLessThan(2500);
  }, 15000);
});
