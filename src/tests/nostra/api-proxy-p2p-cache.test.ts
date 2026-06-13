/**
 * Tests for apiManagerProxy.ts — P2P message cache logic
 *
 * Tests the core logic of injectP2PMessage and getMessageFromStorage
 * for P2P virtual peers (peerId >= 1e15).
 *
 * We replicate the cache logic as standalone functions to avoid
 * instantiating the full ApiManagerProxy class.
 */

import '../setup';

// --- Replicate core data structures and logic ---

const MESSAGE_ID_OFFSET = 0x100000000;

function isLegacyMessageId(messageId: number): boolean {
  return typeof messageId === 'number' && messageId < MESSAGE_ID_OFFSET;
}

type MessagesStorageKey = string;

/**
 * Minimal replica of the P2P cache and mirrors.messages storage
 * from ApiManagerProxy (lines 1026-1057).
 */
class P2PMessageCache {
  private p2pMessageCache = new Map<string, Map<number, any>>();
  private mirrorsMessages: Record<string, Record<number, any>> = {};
  private globalStorageKey = '0_history';

  injectP2PMessage(storageKey: string, mid: number, message: any): void {
    if(!this.p2pMessageCache.has(storageKey)) {
      this.p2pMessageCache.set(storageKey, new Map());
    }
    this.p2pMessageCache.get(storageKey)!.set(mid, message);

    if(!this.mirrorsMessages[storageKey]) {
      this.mirrorsMessages[storageKey] = {};
    }
    this.mirrorsMessages[storageKey][mid] = message;
  }

  getMessageFromStorage(key: MessagesStorageKey, mid: number): any {
    // Legacy message ID redirect — skip for P2P peers (peerId >= 1e15)
    const peerIdFromKey = parseInt(key);
    if(key.endsWith('history') && isLegacyMessageId(mid) && !(peerIdFromKey >= 1e15)) {
      key = this.globalStorageKey;
    }

    const cache = this.mirrorsMessages[key];
    if(cache?.[mid]) return cache[mid];

    // Check P2P message cache
    return this.p2pMessageCache.get(key)?.get(mid);
  }

  /** Expose internal cache for assertions */
  getRawP2PCache() {
    return this.p2pMessageCache;
  }
}

// --- Helper to create a fake message ---

function makeMessage(mid: number, text: string, fromId?: number): any {
  return {
    _: 'message',
    mid,
    message: text,
    from_id: fromId ? {_: 'peerUser', user_id: fromId} : undefined,
    date: Math.floor(Date.now() / 1000)
  };
}

const P2P_PEER_ID = 1e15 + 42;
const NORMAL_PEER_ID = 12345;

// --- injectP2PMessage tests ---

describe('injectP2PMessage', () => {
  let cache: P2PMessageCache;

  beforeEach(() => {
    cache = new P2PMessageCache();
  });

  test('stores message in p2pMessageCache', () => {
    const storageKey = `${P2P_PEER_ID}_history`;
    const msg = makeMessage(1, 'hello');

    cache.injectP2PMessage(storageKey, 1, msg);

    const raw = cache.getRawP2PCache();
    expect(raw.has(storageKey)).toBe(true);
    expect(raw.get(storageKey)!.get(1)).toBe(msg);
  });

  test('stores message in mirrors.messages', () => {
    const storageKey = `${P2P_PEER_ID}_history`;
    const msg = makeMessage(1, 'hello');

    cache.injectP2PMessage(storageKey, 1, msg);

    const retrieved = cache.getMessageFromStorage(storageKey, 1);
    expect(retrieved).toBe(msg);
  });

  test('handles multiple messages in same storage key', () => {
    const storageKey = `${P2P_PEER_ID}_history`;
    const msg1 = makeMessage(1, 'first');
    const msg2 = makeMessage(2, 'second');
    const msg3 = makeMessage(3, 'third');

    cache.injectP2PMessage(storageKey, 1, msg1);
    cache.injectP2PMessage(storageKey, 2, msg2);
    cache.injectP2PMessage(storageKey, 3, msg3);

    expect(cache.getMessageFromStorage(storageKey, 1)).toBe(msg1);
    expect(cache.getMessageFromStorage(storageKey, 2)).toBe(msg2);
    expect(cache.getMessageFromStorage(storageKey, 3)).toBe(msg3);
  });

  test('handles messages from different P2P peers', () => {
    const key1 = `${P2P_PEER_ID}_history`;
    const key2 = `${P2P_PEER_ID + 1}_history`;
    const msg1 = makeMessage(1, 'peer1 msg');
    const msg2 = makeMessage(1, 'peer2 msg');

    cache.injectP2PMessage(key1, 1, msg1);
    cache.injectP2PMessage(key2, 1, msg2);

    expect(cache.getMessageFromStorage(key1, 1)).toBe(msg1);
    expect(cache.getMessageFromStorage(key2, 1)).toBe(msg2);
  });

  test('overwrites existing message with same mid', () => {
    const storageKey = `${P2P_PEER_ID}_history`;
    const original = makeMessage(1, 'original');
    const updated = makeMessage(1, 'updated');

    cache.injectP2PMessage(storageKey, 1, original);
    cache.injectP2PMessage(storageKey, 1, updated);

    expect(cache.getMessageFromStorage(storageKey, 1)).toBe(updated);
  });
});

// --- getMessageFromStorage tests ---

describe('getMessageFromStorage', () => {
  let cache: P2PMessageCache;

  beforeEach(() => {
    cache = new P2PMessageCache();
  });

  test('returns undefined for non-existent message', () => {
    const storageKey = `${P2P_PEER_ID}_history`;
    expect(cache.getMessageFromStorage(storageKey, 999)).toBeUndefined();
  });

  test('returns undefined for non-existent storage key', () => {
    expect(cache.getMessageFromStorage('nonexistent_history', 1)).toBeUndefined();
  });

  test('retrieves injected P2P message', () => {
    const storageKey = `${P2P_PEER_ID}_history`;
    const msg = makeMessage(42, 'test message');
    cache.injectP2PMessage(storageKey, 42, msg);

    const result = cache.getMessageFromStorage(storageKey, 42);
    expect(result).toBe(msg);
    expect(result.message).toBe('test message');
  });
});

// --- Legacy message ID redirect tests ---

describe('legacy message ID redirect for P2P peers', () => {
  let cache: P2PMessageCache;

  beforeEach(() => {
    cache = new P2PMessageCache();
  });

  test('P2P peer key does NOT redirect legacy mids to global storage', () => {
    const p2pKey = `${P2P_PEER_ID}_history`;
    const legacyMid = 100; // below MESSAGE_ID_OFFSET → "legacy"
    const msg = makeMessage(legacyMid, 'p2p legacy message');

    cache.injectP2PMessage(p2pKey, legacyMid, msg);

    // Should find the message under the P2P key, not redirect to global
    const result = cache.getMessageFromStorage(p2pKey, legacyMid);
    expect(result).toBe(msg);
  });

  test('normal peer key DOES redirect legacy mids to global storage', () => {
    const normalKey = `${NORMAL_PEER_ID}_history`;
    const legacyMid = 100;
    const msg = makeMessage(legacyMid, 'normal legacy message');

    // Inject under the normal peer key
    cache.injectP2PMessage(normalKey, legacyMid, msg);

    // When queried, legacy mid on a normal peer key should redirect to global "0_history"
    // The message was injected under normalKey, not global, so redirect means NOT found
    const result = cache.getMessageFromStorage(normalKey, legacyMid);
    expect(result).toBeUndefined();
  });

  test('non-legacy mids are never redirected regardless of peer type', () => {
    const normalKey = `${NORMAL_PEER_ID}_history`;
    const modernMid = MESSAGE_ID_OFFSET + 1;
    const msg = makeMessage(modernMid, 'modern message');

    cache.injectP2PMessage(normalKey, modernMid, msg);

    // Non-legacy mid should be found under original key, no redirect
    const result = cache.getMessageFromStorage(normalKey, modernMid);
    expect(result).toBe(msg);
  });

  test('P2P peers with legacy-range mids work correctly', () => {
    // P2P messages often use small mids (1, 2, 3...) which are in the legacy range
    const p2pKey = `${P2P_PEER_ID}_history`;
    const mids = [1, 2, 3, 50, 100];

    for(const mid of mids) {
      expect(isLegacyMessageId(mid)).toBe(true); // confirm they are "legacy"
      cache.injectP2PMessage(p2pKey, mid, makeMessage(mid, `msg-${mid}`));
    }

    // All should be retrievable under the P2P key despite being "legacy" range
    for(const mid of mids) {
      const result = cache.getMessageFromStorage(p2pKey, mid);
      expect(result).toBeDefined();
      expect(result.message).toBe(`msg-${mid}`);
    }
  });
});
