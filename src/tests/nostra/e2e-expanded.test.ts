/**
 * Tests for bubble rendering P2P requestHistory intercept logic
 *
 * From src/components/chat/bubbles.ts around line 9087:
 * When peerId >= 1e15 and cache has messages, return cached mids sorted ascending.
 * When peerId >= 1e15 and cache is empty, fall through to Worker.
 * When peerId < 1e15, always fall through to Worker (not P2P).
 *
 * We replicate the intercept logic as a standalone function and test it.
 */

import '../setup';

const VIRTUAL_PEER_BASE = 1e15;

interface HistoryResult {
  cached: boolean;
  result: Promise<{
    history: number[];
    count: number;
    isEnd: {both: boolean; bottom: boolean; top: boolean};
  }>;
}

/**
 * Replicate the P2P requestHistory intercept from bubbles.ts (lines 9090-9106).
 * Returns a HistoryResult if P2P cache hit, or null to signal "fall through to Worker".
 */
function p2pHistoryIntercept(
  peerId: number,
  p2pMessageCache: Map<string, Map<number, any>>
): HistoryResult | null {
  const rawPeerId = Number(peerId);
  if(rawPeerId >= VIRTUAL_PEER_BASE) {
    const storageKey = `${rawPeerId}_history`;
    const cache = p2pMessageCache.get(storageKey);
    if(cache && cache.size > 0) {
      const mids = Array.from(cache.keys()).sort((a: number, b: number) => a - b);
      return {
        cached: true,
        result: Promise.resolve({
          history: mids,
          count: mids.length,
          isEnd: {both: true, bottom: true, top: true}
        })
      };
    }
  }
  return null; // fall through to Worker
}

// --- Helpers ---

function makeCache(peerId: number, mids: number[]): Map<string, Map<number, any>> {
  const outerMap = new Map<string, Map<number, any>>();
  const innerMap = new Map<number, any>();
  for(const mid of mids) {
    innerMap.set(mid, {_: 'message', mid, message: `msg-${mid}`});
  }
  outerMap.set(`${peerId}_history`, innerMap);
  return outerMap;
}

const P2P_PEER = VIRTUAL_PEER_BASE + 42;
const NORMAL_PEER = 12345;

// --- P2P peer with cached messages ---

describe('P2P requestHistory intercept — cache hit', () => {
  test('returns cached mids sorted ascending', async() => {
    const cache = makeCache(P2P_PEER, [5, 1, 3, 2, 4]);
    const result = p2pHistoryIntercept(P2P_PEER, cache);

    expect(result).not.toBeNull();
    expect(result!.cached).toBe(true);

    const resolved = await result!.result;
    expect(resolved.history).toEqual([1, 2, 3, 4, 5]);
    expect(resolved.count).toBe(5);
  });

  test('returns isEnd with all flags true', async() => {
    const cache = makeCache(P2P_PEER, [1, 2]);
    const result = p2pHistoryIntercept(P2P_PEER, cache);
    const resolved = await result!.result;

    expect(resolved.isEnd).toEqual({both: true, bottom: true, top: true});
  });

  test('works with a single message', async() => {
    const cache = makeCache(P2P_PEER, [42]);
    const result = p2pHistoryIntercept(P2P_PEER, cache);

    expect(result).not.toBeNull();
    const resolved = await result!.result;
    expect(resolved.history).toEqual([42]);
    expect(resolved.count).toBe(1);
  });

  test('returns messages for peer at exactly VIRTUAL_PEER_BASE', async() => {
    const cache = makeCache(VIRTUAL_PEER_BASE, [10, 20]);
    const result = p2pHistoryIntercept(VIRTUAL_PEER_BASE, cache);

    expect(result).not.toBeNull();
    const resolved = await result!.result;
    expect(resolved.history).toEqual([10, 20]);
  });
});

// --- P2P peer with empty cache ---

describe('P2P requestHistory intercept — cache miss', () => {
  test('falls through when cache is empty map', () => {
    const outerMap = new Map<string, Map<number, any>>();
    outerMap.set(`${P2P_PEER}_history`, new Map());
    const result = p2pHistoryIntercept(P2P_PEER, outerMap);

    expect(result).toBeNull();
  });

  test('falls through when storage key does not exist in cache', () => {
    const emptyCache = new Map<string, Map<number, any>>();
    const result = p2pHistoryIntercept(P2P_PEER, emptyCache);

    expect(result).toBeNull();
  });

  test('falls through when cache has messages for a different peer', () => {
    const otherPeer = VIRTUAL_PEER_BASE + 99;
    const cache = makeCache(otherPeer, [1, 2, 3]);
    const result = p2pHistoryIntercept(P2P_PEER, cache);

    expect(result).toBeNull();
  });
});

// --- Normal (non-P2P) peer ---

describe('P2P requestHistory intercept — non-P2P peer', () => {
  test('falls through for normal peerId below VIRTUAL_PEER_BASE', () => {
    const cache = makeCache(NORMAL_PEER, [1, 2, 3]);
    const result = p2pHistoryIntercept(NORMAL_PEER, cache);

    expect(result).toBeNull();
  });

  test('falls through for peerId of 0', () => {
    const result = p2pHistoryIntercept(0, new Map());
    expect(result).toBeNull();
  });

  test('falls through for negative peerId', () => {
    const result = p2pHistoryIntercept(-12345, new Map());
    expect(result).toBeNull();
  });

  test('falls through for peerId just below VIRTUAL_PEER_BASE', () => {
    const result = p2pHistoryIntercept(VIRTUAL_PEER_BASE - 1, new Map());
    expect(result).toBeNull();
  });
});

// --- Sorting correctness ---

describe('P2P requestHistory intercept — sort order', () => {
  test('mids are sorted numerically, not lexicographically', async() => {
    // Lexicographic sort would give [1, 10, 100, 2, 20, 3]
    const cache = makeCache(P2P_PEER, [100, 3, 20, 1, 10, 2]);
    const result = p2pHistoryIntercept(P2P_PEER, cache);

    const resolved = await result!.result;
    expect(resolved.history).toEqual([1, 2, 3, 10, 20, 100]);
  });

  test('already sorted mids remain sorted', async() => {
    const cache = makeCache(P2P_PEER, [1, 2, 3, 4, 5]);
    const result = p2pHistoryIntercept(P2P_PEER, cache);

    const resolved = await result!.result;
    expect(resolved.history).toEqual([1, 2, 3, 4, 5]);
  });
});
