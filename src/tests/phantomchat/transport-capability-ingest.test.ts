// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {
  CapabilityIngestor,
  parseCapabilityAdvert,
  isAdvertFresh,
  applyCapabilityAdvert,
  CAPABILITY_KIND,
  CAPABILITY_D_TAG,
  CAPABILITY_TTL_MS
} from '@lib/phantomchat/transport/capability-ingest';
import {PeerCapabilityRegistry} from '@lib/phantomchat/transport/capability';
import {TransportSelector} from '@lib/phantomchat/transport/transport-selector';

const PEER = 'a'.repeat(64);
const PEER2 = 'b'.repeat(64);
const NOW = 1_700_000_000_000; // fixed ms clock
const FRESH_TS = Math.floor(NOW / 1000) - 60; // 1 min old, in seconds

// Build the exact advert phantombot `src/p2p/capability.ts` publishes:
// kind 30078, d-tag 'phantomchat-p2p', JSON content. `queryLatestEvent` never
// returns `pubkey` (we query BY author), so it's absent here too.
function makeAdvert(caps = {localWs: true, localWsPort: 47100, webrtc: true, dht: false}, createdAt = FRESH_TS) {
  return {
    kind: CAPABILITY_KIND,
    created_at: createdAt,
    tags: [['d', CAPABILITY_D_TAG]],
    content: JSON.stringify(caps)
  };
}

// A ChatAPI stub whose queryLatestEvent returns a per-author advert map.
function makeChatAPI(advertByAuthor: Record<string, any> = {}) {
  return {
    queryLatestEvent: vi.fn(async(filter) => {
      const author = filter.authors?.[0];
      return advertByAuthor[author] ?? null;
    })
  };
}

// A kind-1059 gift-wrap addressed to `recipient` — the shape TransportSelector
// ships as ['EVENT', wrap].
function makeWrap(recipient = PEER) {
  return {
    id: 'wrap-recipient',
    kind: 1059,
    pubkey: 'e'.repeat(64),
    created_at: 1,
    content: 'ciphertext',
    tags: [['p', recipient]],
    sig: 'f'.repeat(128)
  };
}

describe('parseCapabilityAdvert (wire-format parity with phantombot)', () => {
  it('parses a well-formed advert and coerces every field', () => {
    const out = parseCapabilityAdvert(makeAdvert({localWs: true, localWsPort: 47100, webrtc: true, dht: false}));
    expect(out).toEqual({
      caps: {localWs: true, localWsPort: 47100, webrtc: true, dht: false},
      createdAt: FRESH_TS
    });
  });

  it('defaults a missing/invalid port to 0 and missing flags to false', () => {
    const out = parseCapabilityAdvert(makeAdvert({webrtc: true}));
    expect(out.caps).toEqual({localWs: false, localWsPort: 0, webrtc: true, dht: false});
  });

  it('rejects the wrong kind', () => {
    expect(parseCapabilityAdvert({...makeAdvert(), kind: 30000})).toBeNull();
  });

  it('rejects a missing d-tag', () => {
    expect(parseCapabilityAdvert({...makeAdvert(), tags: [['d', 'something-else']]})).toBeNull();
    expect(parseCapabilityAdvert({...makeAdvert(), tags: []})).toBeNull();
  });

  it('rejects malformed JSON content without throwing', () => {
    expect(parseCapabilityAdvert({...makeAdvert(), content: 'not json {'})).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parseCapabilityAdvert(null)).toBeNull();
    expect(parseCapabilityAdvert(undefined)).toBeNull();
  });
});

describe('isAdvertFresh (created_at TTL)', () => {
  it('accepts an advert within the TTL', () => {
    expect(isAdvertFresh(FRESH_TS, NOW, CAPABILITY_TTL_MS)).toBe(true);
  });

  it('rejects an advert older than the TTL', () => {
    const oldTs = Math.floor((NOW - CAPABILITY_TTL_MS - 1000) / 1000);
    expect(isAdvertFresh(oldTs, NOW, CAPABILITY_TTL_MS)).toBe(false);
  });

  it('treats a future-dated advert (clock skew) as fresh', () => {
    const futureTs = Math.floor(NOW / 1000) + 3600;
    expect(isAdvertFresh(futureTs, NOW, CAPABILITY_TTL_MS)).toBe(true);
  });

  it('rejects a zero/negative timestamp', () => {
    expect(isAdvertFresh(0, NOW, CAPABILITY_TTL_MS)).toBe(false);
    expect(isAdvertFresh(-1, NOW, CAPABILITY_TTL_MS)).toBe(false);
  });
});

describe('applyCapabilityAdvert (feeds or evicts the registry)', () => {
  it('sets a fresh, capable advert', () => {
    const reg = new PeerCapabilityRegistry();
    const caps = applyCapabilityAdvert(reg, PEER, makeAdvert(), NOW);
    expect(caps).toEqual({localWs: true, localWsPort: 47100, webrtc: true, dht: false});
    expect(reg.has(PEER)).toBe(true);
  });

  it('clears the peer on a stale advert', () => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PEER, {webrtc: true});
    const staleTs = Math.floor((NOW - CAPABILITY_TTL_MS - 1000) / 1000);
    const caps = applyCapabilityAdvert(reg, PEER, makeAdvert({webrtc: true}, staleTs), NOW);
    expect(caps).toBeNull();
    expect(reg.has(PEER)).toBe(false);
  });

  it('clears the peer on an all-false advert', () => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PEER, {webrtc: true});
    applyCapabilityAdvert(reg, PEER, makeAdvert({localWs: false, webrtc: false, dht: false}), NOW);
    expect(reg.has(PEER)).toBe(false);
  });

  it('clears the peer on a missing advert', () => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PEER, {webrtc: true});
    applyCapabilityAdvert(reg, PEER, null, NOW);
    expect(reg.has(PEER)).toBe(false);
  });
});

describe('CapabilityIngestor.refreshPeer', () => {
  it('populates the registry for a peer that advertised', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({[PEER]: makeAdvert()});
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [PEER], now: () => NOW});

    const caps = await ing.refreshPeer(PEER);
    expect(caps).toEqual({localWs: true, localWsPort: 47100, webrtc: true, dht: false});
    expect(reg.has(PEER)).toBe(true);
    // Queried the right filter: kind 30078, our d-tag, that author.
    expect(api.queryLatestEvent).toHaveBeenCalledWith(
      expect.objectContaining({'kinds': [CAPABILITY_KIND], '#d': [CAPABILITY_D_TAG], 'authors': [PEER]})
    );
  });

  it('leaves the gate closed for a peer that never advertised', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({}); // no advert for anyone
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [PEER], now: () => NOW});

    const caps = await ing.refreshPeer(PEER);
    expect(caps).toBeNull();
    expect(reg.has(PEER)).toBe(false);
  });

  it('no-ops on a malformed pubkey', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI();
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [], now: () => NOW});
    expect(await ing.refreshPeer('not-a-pubkey')).toBeNull();
    expect(api.queryLatestEvent).not.toHaveBeenCalled();
  });

  it('no-ops when ChatAPI is not attached yet', async() => {
    const reg = new PeerCapabilityRegistry();
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => null, getContacts: () => [PEER], now: () => NOW});
    expect(await ing.refreshPeer(PEER)).toBeNull();
    expect(reg.has(PEER)).toBe(false);
  });

  it('keeps the existing entry when the query throws (transient relay error)', async() => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PEER, {webrtc: true});
    const api = {queryLatestEvent: vi.fn(async() => {
      throw new Error('relay down');
    })};
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [PEER], now: () => NOW});
    await ing.refreshPeer(PEER);
    expect(reg.has(PEER)).toBe(true); // not evicted by a transient failure
  });
});

describe('CapabilityIngestor.refreshAll', () => {
  it('refreshes and dedupes every contact', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({[PEER]: makeAdvert(), [PEER2]: makeAdvert({webrtc: true})});
    const ing = new CapabilityIngestor({
      registry: reg,
      getChatAPI: () => api,
      getContacts: () => [PEER, PEER, PEER2], // PEER duplicated on purpose
      now: () => NOW
    });

    await ing.refreshAll();
    expect(reg.has(PEER)).toBe(true);
    expect(reg.has(PEER2)).toBe(true);
    // PEER queried once despite the duplicate.
    const authorsQueried = api.queryLatestEvent.mock.calls.map((c) => c[0].authors[0]);
    expect(authorsQueried.filter((a) => a === PEER).length).toBe(1);
  });

  it('accepts an ASYNC contact source (the real bridge reads getAllMappings)', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({[PEER]: makeAdvert({webrtc: true})});
    // Mirror the bridge: contacts come from an async store (IndexedDB mapping).
    const ing = new CapabilityIngestor({
      registry: reg,
      getChatAPI: () => api,
      getContacts: async() => [PEER],
      now: () => NOW
    });

    await ing.refreshAll();
    expect(reg.has(PEER)).toBe(true);
  });

  it('a throwing contact source is swallowed — the poll no-ops, never rejects', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({[PEER]: makeAdvert({webrtc: true})});
    const ing = new CapabilityIngestor({
      registry: reg,
      getChatAPI: () => api,
      getContacts: async() => { throw new Error('mapping store not ready'); },
      now: () => NOW
    });

    await expect(ing.refreshAll()).resolves.toBeUndefined();
    expect(reg.has(PEER)).toBe(false);
  });
});

// The point of the whole PR: prove the gate opens AND stays shut end-to-end,
// through a REAL TransportSelector, not just the registry booleans.
describe('the #61 gate, end-to-end (ingestor → registry → TransportSelector)', () => {
  function makeSelector(reg: PeerCapabilityRegistry) {
    const mesh = {
      getStatus: vi.fn().mockReturnValue('connected'),
      send: vi.fn().mockReturnValue(true),
      connect: vi.fn().mockResolvedValue(undefined)
    };
    const local = {
      ensureConnected: vi.fn().mockResolvedValue(false), // force fall-through to webrtc tier
      send: vi.fn().mockReturnValue(true)
    };
    const selector = new TransportSelector({capability: reg, mesh, local});
    return {selector, mesh, local};
  }

  it('a peer that advertised → ladder ATTEMPTS P2P (webrtc), not relay', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({[PEER]: makeAdvert({webrtc: true})});
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [PEER], now: () => NOW});
    await ing.refreshPeer(PEER);

    const {selector, mesh} = makeSelector(reg);
    const result = await selector.tryDeliver(PEER, [makeWrap(PEER)]);

    expect(result).toEqual({tier: 'webrtc', delivered: true});
    expect(mesh.send).toHaveBeenCalledTimes(1);
  });

  it('a peer that never advertised → falls straight through to relay', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({}); // nothing advertised
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [PEER], now: () => NOW});
    await ing.refreshPeer(PEER);

    const {selector, mesh} = makeSelector(reg);
    const result = await selector.tryDeliver(PEER, [makeWrap(PEER)]);

    expect(result).toEqual({tier: 'relay', delivered: false});
    expect(mesh.send).not.toHaveBeenCalled();
  });
});

describe('CapabilityIngestor.start/stop (periodic refresh)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls immediately and then on the interval, and stop() halts it', async() => {
    const reg = new PeerCapabilityRegistry();
    const api = makeChatAPI({[PEER]: makeAdvert()});
    const ing = new CapabilityIngestor({registry: reg, getChatAPI: () => api, getContacts: () => [PEER], now: () => NOW});

    const stop = ing.start(1000);
    await vi.advanceTimersByTimeAsync(0); // flush the immediate refreshAll
    expect(api.queryLatestEvent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.queryLatestEvent).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.queryLatestEvent).toHaveBeenCalledTimes(2); // no more after stop
  });
});
