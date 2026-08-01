// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('phantomchatReactionsLocal (shim over phantomchatReactionsStore)', () => {
  let local: any;
  let store: any;

  beforeEach(async() => {
    vi.resetModules();
    await new Promise<void>((resolve) => {
      const req = (globalThis as any).indexedDB.deleteDatabase('phantomchat-reactions');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    const storeMod = await import('@lib/phantomchat/phantomchat-reactions-store');
    store = storeMod.phantomchatReactionsStore;
    await store.init();
    const localMod = await import('@lib/phantomchat/phantomchat-reactions-local');
    local = localMod.phantomchatReactionsLocal;
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
    rootScope.dispatchEventSingle('phantomchat_reactions_changed', {peerId: 1e16, mid: 1});
    await new Promise((r) => setTimeout(r, 10));
    expect(local.getReactions(1e16, 1)).toEqual(['👍']);
  });

  it('addReaction without context updates local cache only (legacy path)', async() => {
    await local.addReaction(1e16, 2, '❤️');
    expect(local.getReactions(1e16, 2)).toEqual(['❤️']);
  });

  // Models the reload/re-open hydration path (bubbles.hydratePhantomChatReactions):
  // a reaction persisted in a prior session sits in IDB, but no live
  // phantomchat_reactions_changed event fires on reload, so the sync cache is
  // cold. getReactionsFresh must read it back from the store so the badge can
  // be re-rendered on initial bubble construction.
  it('getReactionsFresh rehydrates a cold cache from the persisted store (reload path)', async() => {
    await store.add({
      targetEventId: 'evt-reload', targetMid: 7, targetPeerId: 1e16,
      fromPubkey: 'pub-reload', emoji: '❤️', reactionEventId: 'r-reload', createdAt: 1
    });
    // No 'phantomchat_reactions_changed' dispatch — the cache is cold, exactly
    // as after a fresh page load.
    expect(local.getReactions(1e16, 7)).toEqual([]);
    // Fresh read pulls the persisted row back into the cache.
    expect(await local.getReactionsFresh(1e16, 7)).toEqual(['❤️']);
    // And the warmed cache now serves the sync render-time read.
    expect(local.getReactions(1e16, 7)).toEqual(['❤️']);
  });
});
