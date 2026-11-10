// @ts-nocheck
/**
 * Tests for phantomchat-cleanup.ts error paths.
 *
 * Validates:
 *   - cleanup never opens a DB (no force-close at v999999, #480/#481)
 *   - deleteDB: indexedDB.deleteDatabase throw + req.onerror
 *   - deleteDB: onblocked waits for success; a delete that stays blocked times out
 *   - clearPhantomChatData({keepSeed: true}) filters out PhantomChat.chat / phantomchat_identity
 *   - clearPhantomChatData({keepSeed: false}) wipes everything
 *   - per-key localStorage.removeItem throw is swallowed (loop continues)
 *   - store destroy() rejection is swallowed
 */

import '../setup';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// Mock peer-profile-cache so module import does not touch real state
vi.mock('@lib/phantomchat/peer-profile-cache', () => ({
  clearPeerProfileCache: vi.fn()
}));

// Mock the four store modules used by clearPhantomChatData. The cleanup imports
// them dynamically; stub each to return a destroy()-capable instance.
const makeDestroyable = (ok = true) => ({
  destroy: vi.fn().mockImplementation(() => ok ?
    Promise.resolve() :
    Promise.reject(new Error('destroy failed')))
});

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: vi.fn(() => makeDestroyable())
}));
vi.mock('@lib/phantomchat/message-requests', () => ({
  getMessageRequestStore: vi.fn(() => makeDestroyable())
}));
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  getVirtualPeersDB: vi.fn(() => makeDestroyable())
}));
vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: vi.fn(() => makeDestroyable())
}));

// ─── IDB + LS shims ───────────────────────────────────────────────────

type Req = {
  result?: any;
  transaction?: {abort: () => void};
  onupgradeneeded?: () => void;
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
};

function makeReq(overrides: Partial<Req> = {}): Req {
  const r: Req = {transaction: {abort: vi.fn()}, ...overrides};
  return r;
}

function microtick() { return new Promise((r) => setTimeout(r, 0)); }

describe('phantomchat-cleanup — error paths', () => {
  let openMock: any;
  let deleteMock: any;
  let removeItemMock: any;
  let lsStore: Record<string, string>;
  let origIDB: any;
  let origLS: any;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    lsStore = {
      phantomchat_identity: 'seed-keep',
      'phantomchat-relay-config': 'relays',
      'phantomchat-last-seen-timestamp': '0',
      'phantomchatVoiceMeta.v1': '{"doc":{"duration":9,"waveform":"AA==","t":1}}',
      'unrelated-key': 'should-stay'
    };

    openMock = vi.fn();
    deleteMock = vi.fn();
    removeItemMock = vi.fn((k: string) => { delete lsStore[k]; });

    origIDB = (globalThis as any).indexedDB;
    origLS = (globalThis as any).localStorage;

    vi.stubGlobal('indexedDB', {
      open: openMock,
      deleteDatabase: deleteMock
    });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => lsStore[k] ?? null,
      setItem: (k: string, v: string) => { lsStore[k] = v; },
      removeItem: removeItemMock,
      key: (i: number) => Object.keys(lsStore)[i] ?? null,
      get length() { return Object.keys(lsStore).length; },
      clear: () => { lsStore = {}; }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if(origIDB !== undefined) (globalThis as any).indexedDB = origIDB;
    if(origLS !== undefined) (globalThis as any).localStorage = origLS;
  });

  it('never opens a database (no force-close upgrade that can queue the deletes)', async() => {
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    await expect(clearAllPhantomChatData()).resolves.toEqual([]);
    // (loadIdentity may open PhantomChat.chat at its real version for the
    // push unsubscribe; what must never happen is an upgrade-style open.)
    expect(openMock.mock.calls.filter((c) => c[1] === 999999)).toEqual([]);
  });

  it('deleteDB: deleteDatabase throwing synchronously reports failure (name in returned list)', async() => {
    // open succeeds (so force-close phase is a no-op)
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => { throw new Error('idb-locked'); });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    const failed = await clearAllPhantomChatData();

    // Every DB failed to delete → every DB name present in the result
    expect(failed.length).toBeGreaterThan(0);
    expect(failed).toContain('phantomchat-messages');
    expect(failed).toContain('PhantomChat.chat');
  });

  it('deleteDB: req.onerror returns false — name listed as failed', async() => {
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onerror?.());
      return req;
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    const failed = await clearAllPhantomChatData();

    expect(failed).toContain('phantomchat-messages');
    expect(failed).toContain('PhantomChatPool');
  });

  it('deleteDB: onblocked is not final — a delete that then succeeds is not reported failed', async() => {
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => {
        req.onblocked?.();
        setTimeout(() => req.onsuccess?.(), 10);
      });
      return req;
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    await expect(clearAllPhantomChatData()).resolves.toEqual([]);
  });

  it('deleteDB: a delete that never settles times out and is reported failed', async() => {
    // Request never fires anything (the #480/#481 hang shape).
    deleteMock.mockImplementation(() => makeReq());

    const {clearAllPhantomChatData, DELETE_DB_TIMEOUT_MS} = await import('@lib/phantomchat/phantomchat-cleanup');
    const started = Date.now();
    const failed = await clearAllPhantomChatData();

    expect(failed).toContain('phantomchat-messages');
    expect(failed).toContain('PhantomChat.chat');
    expect(Date.now() - started).toBeGreaterThanOrEqual(DELETE_DB_TIMEOUT_MS - 50);
  }, 15000);

  it('clearAllExceptSeed: omits PhantomChat.chat from delete list and phantomchat_identity from LS removal', async() => {
    const deleted: string[] = [];
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation((name: string) => {
      deleted.push(name);
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllExceptSeed} = await import('@lib/phantomchat/phantomchat-cleanup');
    await clearAllExceptSeed();

    // Seed DB not deleted
    expect(deleted).not.toContain('PhantomChat.chat');
    // Everything else is deleted
    expect(deleted).toContain('phantomchat-messages');
    expect(deleted).toContain('PhantomChatPool');
    // Seed LS key not removed
    expect(removeItemMock).not.toHaveBeenCalledWith('phantomchat_identity');
    // Other phantomchat keys are removed
    expect(removeItemMock).toHaveBeenCalledWith('phantomchat-relay-config');
    // The voice-meta decode cache key is registered in centralized cleanup —
    // logout must not leave decoded voice metadata from the previous data
    // set on disk (Kai's review blocker on #178).
    expect(removeItemMock).toHaveBeenCalledWith('phantomchatVoiceMeta.v1');
    expect(lsStore['phantomchatVoiceMeta.v1']).toBeUndefined();
  });

  it('clearAllPhantomChatData: wipes everything including seed', async() => {
    const deleted: string[] = [];
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation((name: string) => {
      deleted.push(name);
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    await clearAllPhantomChatData();

    expect(deleted).toContain('PhantomChat.chat');
    expect(removeItemMock).toHaveBeenCalledWith('phantomchat_identity');
  });

  it('localStorage.removeItem throwing per-key is swallowed — loop continues', async() => {
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    // First removeItem throws, others succeed
    let calls = 0;
    removeItemMock.mockImplementation(() => {
      calls++;
      if(calls === 1) throw new Error('LS quota');
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    await expect(clearAllPhantomChatData()).resolves.toEqual([]);

    // All LS keys were attempted despite the first throw
    expect(calls).toBeGreaterThan(1);
  });

  it('store destroy() rejection is swallowed via Promise.allSettled', async() => {
    // Override message-store to a destroy() that rejects
    vi.doMock('@lib/phantomchat/message-store', () => ({
      getMessageStore: vi.fn(() => makeDestroyable(false))
    }));
    // Also need to re-stub the others so imports still resolve
    vi.doMock('@lib/phantomchat/message-requests', () => ({
      getMessageRequestStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/phantomchat/virtual-peers-db', () => ({
      getVirtualPeersDB: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/phantomchat/group-store', () => ({
      getGroupStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/phantomchat/peer-profile-cache', () => ({
      clearPeerProfileCache: vi.fn()
    }));

    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    await expect(clearAllPhantomChatData()).resolves.toEqual([]);
  });

  it('store import() throwing is swallowed (dynamic import failure)', async() => {
    // Make one dynamic import reject entirely — cleanup must still proceed
    vi.doMock('@lib/phantomchat/message-store', () => {
      throw new Error('module failed to load');
    });
    vi.doMock('@lib/phantomchat/message-requests', () => ({
      getMessageRequestStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/phantomchat/virtual-peers-db', () => ({
      getVirtualPeersDB: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/phantomchat/group-store', () => ({
      getGroupStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/phantomchat/peer-profile-cache', () => ({
      clearPeerProfileCache: vi.fn()
    }));

    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
    await expect(clearAllPhantomChatData()).resolves.toEqual([]);
  });
});
