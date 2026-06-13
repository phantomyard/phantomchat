// @ts-nocheck
/**
 * Tests for nostra-cleanup.ts error paths.
 *
 * Validates:
 *   - forceCloseDB: synchronous indexedDB.open throw AND req.onerror firing
 *   - deleteDB: indexedDB.deleteDatabase throw + req.onerror / onblocked
 *   - clearNostraData({keepSeed: true}) filters out Nostra.chat / nostra_identity
 *   - clearNostraData({keepSeed: false}) wipes everything
 *   - per-key localStorage.removeItem throw is swallowed (loop continues)
 *   - store destroy() rejection is swallowed
 */

import '../setup';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// Mock peer-profile-cache so module import does not touch real state
vi.mock('@lib/nostra/peer-profile-cache', () => ({
  clearPeerProfileCache: vi.fn()
}));

// Mock the four store modules used by clearNostraData. The cleanup imports
// them dynamically; stub each to return a destroy()-capable instance.
const makeDestroyable = (ok = true) => ({
  destroy: vi.fn().mockImplementation(() => ok ?
    Promise.resolve() :
    Promise.reject(new Error('destroy failed')))
});

vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: vi.fn(() => makeDestroyable())
}));
vi.mock('@lib/nostra/message-requests', () => ({
  getMessageRequestStore: vi.fn(() => makeDestroyable())
}));
vi.mock('@lib/nostra/virtual-peers-db', () => ({
  getVirtualPeersDB: vi.fn(() => makeDestroyable())
}));
vi.mock('@lib/nostra/group-store', () => ({
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

describe('nostra-cleanup — error paths', () => {
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
      nostra_identity: 'seed-keep',
      'nostra-relay-config': 'relays',
      'nostra-last-seen-timestamp': '0',
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

  it('forceCloseDB: indexedDB.open throwing synchronously is swallowed + resolves', async() => {
    // Every open call throws. deleteDatabase resolves ok so we can observe
    // the overall flow completes.
    openMock.mockImplementation(() => { throw new Error('boom'); });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    const failed = await clearAllNostraData();

    // Open throws but delete still runs and succeeds → no failures
    expect(failed).toEqual([]);
  });

  it('forceCloseDB: req.onerror path resolves (does not reject)', async() => {
    openMock.mockImplementation(() => {
      const req = makeReq();
      // Fire onerror asynchronously
      queueMicrotask(() => req.onerror?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    await expect(clearAllNostraData()).resolves.toEqual([]);
  });

  it('forceCloseDB: req.onblocked path resolves', async() => {
    openMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onblocked?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    await expect(clearAllNostraData()).resolves.toEqual([]);
  });

  it('deleteDB: deleteDatabase throwing synchronously reports failure (name in returned list)', async() => {
    // open succeeds (so force-close phase is a no-op)
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => { throw new Error('idb-locked'); });

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    const failed = await clearAllNostraData();

    // Every DB failed to delete → every DB name present in the result
    expect(failed.length).toBeGreaterThan(0);
    expect(failed).toContain('nostra-messages');
    expect(failed).toContain('Nostra.chat');
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

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    const failed = await clearAllNostraData();

    expect(failed).toContain('nostra-messages');
    expect(failed).toContain('NostraPool');
  });

  it('deleteDB: req.onblocked also returns false', async() => {
    openMock.mockImplementation(() => {
      const req = makeReq({result: {close: vi.fn()}});
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    deleteMock.mockImplementation(() => {
      const req = makeReq();
      queueMicrotask(() => req.onblocked?.());
      return req;
    });

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    const failed = await clearAllNostraData();

    expect(failed).toContain('nostra-messages');
  });

  it('clearAllExceptSeed: omits Nostra.chat from delete list and nostra_identity from LS removal', async() => {
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

    const {clearAllExceptSeed} = await import('@lib/nostra/nostra-cleanup');
    await clearAllExceptSeed();

    // Seed DB not deleted
    expect(deleted).not.toContain('Nostra.chat');
    // Everything else is deleted
    expect(deleted).toContain('nostra-messages');
    expect(deleted).toContain('NostraPool');
    // Seed LS key not removed
    expect(removeItemMock).not.toHaveBeenCalledWith('nostra_identity');
    // Other nostra keys are removed
    expect(removeItemMock).toHaveBeenCalledWith('nostra-relay-config');
  });

  it('clearAllNostraData: wipes everything including seed', async() => {
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

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    await clearAllNostraData();

    expect(deleted).toContain('Nostra.chat');
    expect(removeItemMock).toHaveBeenCalledWith('nostra_identity');
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

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    await expect(clearAllNostraData()).resolves.toEqual([]);

    // All LS keys were attempted despite the first throw
    expect(calls).toBeGreaterThan(1);
  });

  it('store destroy() rejection is swallowed via Promise.allSettled', async() => {
    // Override message-store to a destroy() that rejects
    vi.doMock('@lib/nostra/message-store', () => ({
      getMessageStore: vi.fn(() => makeDestroyable(false))
    }));
    // Also need to re-stub the others so imports still resolve
    vi.doMock('@lib/nostra/message-requests', () => ({
      getMessageRequestStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/nostra/virtual-peers-db', () => ({
      getVirtualPeersDB: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/nostra/group-store', () => ({
      getGroupStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/nostra/peer-profile-cache', () => ({
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

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    await expect(clearAllNostraData()).resolves.toEqual([]);
  });

  it('store import() throwing is swallowed (dynamic import failure)', async() => {
    // Make one dynamic import reject entirely — cleanup must still proceed
    vi.doMock('@lib/nostra/message-store', () => {
      throw new Error('module failed to load');
    });
    vi.doMock('@lib/nostra/message-requests', () => ({
      getMessageRequestStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/nostra/virtual-peers-db', () => ({
      getVirtualPeersDB: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/nostra/group-store', () => ({
      getGroupStore: vi.fn(() => makeDestroyable())
    }));
    vi.doMock('@lib/nostra/peer-profile-cache', () => ({
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

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
    await expect(clearAllNostraData()).resolves.toEqual([]);
  });
});
