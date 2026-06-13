/**
 * Legacy shim for code expecting the Phase 2a sender-only reactions store.
 *
 * Phase 2b.1 replaces the in-memory Map with a read-through facade over
 * `nostraReactionsStore` (IDB-backed). Callers use `addReaction()` and
 * `getReactions()` as before; internally:
 *  - addReaction triggers nostraReactionsPublish.publish (relay + store)
 *  - getReactions reads from the store synchronously via a local cache
 *
 * The sync cache is needed because `bubbles.ts` calls `getReactions()`
 * during render and can't await an IDB transaction. We warm the cache on
 * every store mutation via the `nostra_reactions_changed` rootScope event.
 */
import rootScope from '@lib/rootScope';
import {nostraReactionsStore} from './nostra-reactions-store';
import {nostraReactionsPublish} from './nostra-reactions-publish';

type Key = string; // `${peerId}:${mid}`

const key = (peerId: number, mid: number): Key => `${peerId}:${mid}`;

class NostraReactionsLocal {
  /** Sync cache for render-time access. Hydrated from store + updated on events. */
  private cache: Map<Key, Set<string>> = new Map();

  constructor() {
    rootScope.addEventListener('nostra_reactions_changed', async({peerId, mid}) => {
      if(!peerId || !mid) return;
      await this.refreshCache(peerId as number, mid);
    });
  }

  async addReaction(peerId: number, mid: number, emoji: string, context?: {targetEventId: string; targetAuthor: string}): Promise<void> {
    if(!context) {
      // No relay context provided (legacy callers); update cache only.
      const k = key(peerId, mid);
      let set = this.cache.get(k);
      if(!set) {set = new Set(); this.cache.set(k, set);}
      set.add(emoji);
      return;
    }
    await nostraReactionsPublish.publish({
      targetEventId: context.targetEventId,
      targetMid: mid,
      targetPeerId: peerId,
      targetAuthor: context.targetAuthor,
      emoji
    });
  }

  /**
   * Sync read from the in-memory cache. Fast but may lag by one dispatch
   * if called from a `nostra_reactions_changed` listener registered before
   * the cache-warmer. Prefer {@link getReactionsFresh} in event handlers.
   */
  getReactions(peerId: number, mid: number): string[] {
    const set = this.cache.get(key(peerId, mid));
    return set ? Array.from(set) : [];
  }

  /**
   * Fresh read directly from the store, bypassing the cache race.
   *
   * The cache-warmer listener in this shim and the render listener in
   * bubbles.ts both subscribe to `nostra_reactions_changed`. Since the
   * render listener is registered first (bubbles mounts before the shim is
   * lazy-imported), it historically read a stale cache on multi-emoji
   * bursts and left one emoji un-rendered (FIND-bbf8efa8). Callers that
   * need the post-commit snapshot should use this method instead.
   */
  async getReactionsFresh(peerId: number, mid: number): Promise<string[]> {
    await this.refreshCache(peerId, mid);
    return this.getReactions(peerId, mid);
  }

  clear(): void {
    this.cache.clear();
  }

  private async refreshCache(peerId: number, mid: number): Promise<void> {
    // Load all reactions for the target and project into cache.
    const rows = await nostraReactionsStore.getAll();
    const matching = rows.filter((r) => r.targetPeerId === peerId && r.targetMid === mid);
    const set = new Set<string>(matching.map((r) => r.emoji));
    this.cache.set(key(peerId, mid), set);
  }
}

export const nostraReactionsLocal = new NostraReactionsLocal();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsLocal = nostraReactionsLocal;
}
