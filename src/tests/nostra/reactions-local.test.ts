// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostraReactionsLocal (shim over nostraReactionsStore)', () => {
  let local: any;
  let store: any;

  beforeEach(async() => {
    vi.resetModules();
    await new Promise<void>((resolve) => {
      const req = (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    const storeMod = await import('@lib/nostra/nostra-reactions-store');
    store = storeMod.nostraReactionsStore;
    await store.init();
    const localMod = await import('@lib/nostra/nostra-reactions-local');
    local = localMod.nostraReactionsLocal;
  });

  afterEach(async() => {
    await store?.destroy?.();
  });

  it('getReactions returns cached emoji set for peerId/mid', async() => {
    await store.add({
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '👍', reactionEventId: 'r1', createdAt: 1
    });
    // Simulate the event that would normally fire on store add
    const rootScope = (await import('@lib/rootScope')).default;
    rootScope.dispatchEventSingle('nostra_reactions_changed', {peerId: 1e16, mid: 1});
    await new Promise((r) => setTimeout(r, 10));
    expect(local.getReactions(1e16, 1)).toEqual(['👍']);
  });

  it('addReaction without context updates local cache only (legacy path)', async() => {
    await local.addReaction(1e16, 2, '❤️');
    expect(local.getReactions(1e16, 2)).toEqual(['❤️']);
  });
});
