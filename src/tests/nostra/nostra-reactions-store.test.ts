// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostra-reactions-store', () => {
  let store: any;
  beforeEach(async() => {
    vi.resetModules();
    // Fresh IDB per test.
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    const mod = await import('@lib/nostra/nostra-reactions-store');
    store = mod.nostraReactionsStore;
    await store.init();
  });

  afterEach(async() => {
    await store.destroy?.();
  });

  it('add + get roundtrips a reaction row', async() => {
    const row = {
      targetEventId: 'evt123',
      targetMid: 12345,
      targetPeerId: 1e16,
      fromPubkey: 'pubABC',
      emoji: '👍',
      reactionEventId: 'r1',
      createdAt: 1000
    };
    await store.add(row);
    const got = await store.getByTarget('evt123');
    expect(got).toHaveLength(1);
    expect(got[0].emoji).toBe('👍');
    expect(got[0].reactionEventId).toBe('r1');
  });

  it('dedupes on (targetEventId, fromPubkey, emoji) compound key', async() => {
    const row = {
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '👍', reactionEventId: 'r1', createdAt: 1
    };
    await store.add(row);
    await store.add({...row, reactionEventId: 'r2', createdAt: 2}); // same compound key
    const got = await store.getByTarget('evt1');
    expect(got).toHaveLength(1);
    expect(got[0].reactionEventId).toBe('r1'); // first-write-wins
  });

  it('keeps multi-emoji per user as distinct rows', async() => {
    const base = {
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', createdAt: 1
    };
    await store.add({...base, emoji: '👍', reactionEventId: 'r1'});
    await store.add({...base, emoji: '❤️', reactionEventId: 'r2'});
    const got = await store.getByTarget('evt1');
    expect(got.map((r: any) => r.emoji).sort()).toEqual(['❤️', '👍']);
  });

  it('removeByReactionEventId drops the matching row only', async() => {
    const base = {
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', createdAt: 1
    };
    await store.add({...base, emoji: '👍', reactionEventId: 'r1'});
    await store.add({...base, emoji: '❤️', reactionEventId: 'r2'});
    await store.removeByReactionEventId('r1');
    const got = await store.getByTarget('evt1');
    expect(got).toHaveLength(1);
    expect(got[0].emoji).toBe('❤️');
  });

  it('getByFromPubkey returns all rows for a pubkey', async() => {
    await store.add({
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '👍', reactionEventId: 'r1', createdAt: 1
    });
    await store.add({
      targetEventId: 'evt2', targetMid: 2, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '❤️', reactionEventId: 'r2', createdAt: 2
    });
    const got = await store.getByFromPubkey('pub1');
    expect(got).toHaveLength(2);
  });
});
