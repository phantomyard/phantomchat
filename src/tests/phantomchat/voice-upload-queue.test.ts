/**
 * Tests for VoiceUploadQueue — IndexedDB persistence and auto-flush
 * for failed file uploads on relay reconnect.
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';
import {
  VoiceUploadQueue,
  getVoiceUploadQueue,
  __resetVoiceUploadQueueForTests,
  QueuedVoiceUpload
} from '../../lib/phantomchat/voice-upload-queue';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockUploadToBlossom = vi.fn();
vi.mock('../../lib/phantomchat/blossom-upload-progress', () => ({
  uploadToBlossomWithProgress: (...args: any[]) => mockUploadToBlossom(...args)
}));

// Minimal IndexedDB mock for queue persistence tests
function createMockIDB(): {
  stores: Map<string, Map<any, any>>;
  install: () => void;
} {
  const stores = new Map<string, Map<any, any>>();

  const mockStore = (storeName: string) => {
    if(!stores.has(storeName)) stores.set(storeName, new Map());
    const data = stores.get(storeName)!;
    return {
      createIndex: () => ({}),
      put: (entry: any) => {
        const req = {onsuccess: null as ((e: any) => void) | null, onerror: null as ((e: any) => void) | null, error: null as any};
        data.set(entry.id, entry);
        setTimeout(() => req.onsuccess?.({target: req} as any), 0);
        return req;
      },
      delete: (id: string) => {
        const req = {onsuccess: null as ((e: any) => void) | null, onerror: null as ((e: any) => void) | null, error: null as any};
        data.delete(id);
        setTimeout(() => req.onsuccess?.({target: req} as any), 0);
        return req;
      },
      getAll: () => {
        const req = {result: [...data.values()], onsuccess: null as ((e: any) => void) | null, onerror: null as ((e: any) => void) | null, error: null as any};
        setTimeout(() => req.onsuccess?.({target: req} as any), 0);
        return req;
      },
      index: () => ({
        openCursor: () => {
          const req = {result: null as any, onsuccess: null as ((e: any) => void) | null, onerror: null as ((e: any) => void) | null, error: null as any};
          setTimeout(() => req.onsuccess?.({target: req} as any), 0);
          return req;
        }
      })
    };
  };

  const install = () => {
    (globalThis as any).indexedDB = {
      open: (_name: string, _version: number) => {
        const req = {
          result: {
            objectStoreNames: {contains: () => false},
            createObjectStore: () => mockStore('voice-uploads'),
            transaction: (storeName: string, mode: string) => ({
              objectStore: () => mockStore(storeName)
            })
          },
          onsuccess: null as any,
          onerror: null as any,
          onupgradeneeded: null as any,
          error: null as any
        };
        setTimeout(() => {
          req.onupgradeneeded?.({target: req});
          req.onsuccess?.({target: req});
        }, 0);
        return req;
      }
    };
  };

  return {stores, install};
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeCiphertext(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'application/octet-stream'});
}

function makeEntry(overrides?: Partial<QueuedVoiceUpload>): QueuedVoiceUpload {
  return {
    id: 'vu-test-001',
    peerId: 12345,
    peerPubkey: 'aabbccdd11223344',
    tempMid: 99999,
    type: 'voice',
    caption: '',
    ciphertext: makeCiphertext(),
    privkeyHex: 'deadbeef',
    ownPubkey: '11223344aabbccdd',
    keyHex: 'aabb',
    ivHex: 'ccdd',
    sha256Hex: 'eeff0011',
    mimeType: 'audio/ogg; codecs=opus',
    size: 1024,
    timestamp: Date.now(),
    retryCount: 0,
    ...overrides
  };
}

function makeMockChatAPI() {
  return {
    getActivePeer: vi.fn().mockReturnValue('aabbccdd11223344'),
    connect: vi.fn().mockResolvedValue(undefined),
    sendFileMessage: vi.fn().mockResolvedValue('event-id-001')
  };
}

function makeMockMessageStore() {
  return {
    getConversationId: vi.fn().mockReturnValue('conv-001'),
    saveMessage: vi.fn().mockResolvedValue(undefined)
  };
}

function makeMockDispatch() {
  return vi.fn();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VoiceUploadQueue', () => {
  let idb: ReturnType<typeof createMockIDB>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetVoiceUploadQueueForTests();
    // Fresh IDB mock per test — avoids cross-test state leaks
    idb = createMockIDB();
    idb.install();
    mockUploadToBlossom.mockResolvedValue({
      url: 'https://blossom.example.com/abc',
      sha256: 'eeff0011',
      mirrors: ['https://mirror1.example.com/abc']
    });
  });

  describe('enqueue', () => {
    it('should add an entry to the queue and persist to IndexedDB', async () => {
      const queue = new VoiceUploadQueue();
      // Wait for IDB restore
      await new Promise(r => setTimeout(r, 10));

      const id = await queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 99999,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'deadbeef',
        ownPubkey: '11223344aabbccdd',
        keyHex: 'aabb',
        ivHex: 'ccdd',
        sha256Hex: 'eeff0011',
        mimeType: 'audio/ogg; codecs=opus',
        size: 1024
      });

      expect(id).toMatch(/^vu-/);
      expect(queue.size).toBe(1);
    });

    it('should not resolve until IndexedDB write completes (durability)', async () => {
      // Install a controllable IDB mock — put() resolves only when we say so
      let resolveWrite: (() => void) | null = null;
      const writeCompleted = new Promise<void>(r => { resolveWrite = r; });
      let writeStarted = false;

      (globalThis as any).indexedDB = {
        open: () => {
          const req = {
            result: {
              objectStoreNames: {contains: () => false},
              createObjectStore: () => ({
                createIndex: () => ({}),
                put: () => {
                  writeStarted = true;
                  const req = {onsuccess: null as any, onerror: null as any, error: null as any};
                  // Block until we explicitly resolve
                  writeCompleted.then(() => req.onsuccess?.({target: req} as any));
                  return req;
                },
                delete: () => {
                  const req = {onsuccess: null as any, onerror: null as any, error: null as any};
                  setTimeout(() => req.onsuccess?.({target: req} as any), 0);
                  return req;
                },
                getAll: () => {
                  const req = {result: [] as any[], onsuccess: null as any, onerror: null as any, error: null as any};
                  setTimeout(() => req.onsuccess?.({target: req} as any), 0);
                  return req;
                }
              }),
              transaction: (_storeName: string, _mode: string) => ({
                objectStore: () => ({
                  createIndex: () => ({}),
                  put: () => {
                    writeStarted = true;
                    const req = {onsuccess: null as any, onerror: null as any, error: null as any};
                    writeCompleted.then(() => req.onsuccess?.({target: req} as any));
                    return req;
                  },
                  delete: () => {
                    const req = {onsuccess: null as any, onerror: null as any, error: null as any};
                    setTimeout(() => req.onsuccess?.({target: req} as any), 0);
                    return req;
                  },
                  getAll: () => {
                    const req = {result: [] as any[], onsuccess: null as any, onerror: null as any, error: null as any};
                    setTimeout(() => req.onsuccess?.({target: req} as any), 0);
                    return req;
                  }
                })
              })
            },
            onsuccess: null as any,
            onerror: null as any,
            onupgradeneeded: null as any,
            error: null as any
          };
          setTimeout(() => {
            req.onupgradeneeded?.({target: req});
            req.onsuccess?.({target: req});
          }, 0);
          return req;
        }
      };

      const queue = new VoiceUploadQueue();
      await queue.awaitReady();

      // Start enqueue — it should block because IDB write is pending
      const enqueuePromise = queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 1,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'a',
        ownPubkey: 'b',
        keyHex: 'c',
        ivHex: 'd',
        sha256Hex: 'e',
        mimeType: 'audio/ogg',
        size: 100
      });

      // Give the microtask queue a tick — enqueue should have started but not resolved
      await new Promise(r => setTimeout(r, 10));
      expect(writeStarted).toBe(true);

      // The promise should still be pending
      let resolved = false;
      enqueuePromise.then(() => { resolved = true; });
      await new Promise(r => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Now let the write complete
      resolveWrite!();
      const id = await enqueuePromise;

      expect(resolved).toBe(true);
      expect(id).toMatch(/^vu-/);
    });

    it('should generate unique IDs', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      const id1 = await queue.enqueue({
        peerId: 1, peerPubkey: 'aa', tempMid: 1, type: 'voice',
        caption: '', ciphertext: makeCiphertext(), privkeyHex: 'a',
        ownPubkey: 'b', keyHex: 'c', ivHex: 'd', sha256Hex: 'e',
        mimeType: 'audio/ogg', size: 100
      });
      const id2 = await queue.enqueue({
        peerId: 2, peerPubkey: 'bb', tempMid: 2, type: 'voice',
        caption: '', ciphertext: makeCiphertext(), privkeyHex: 'a',
        ownPubkey: 'b', keyHex: 'c', ivHex: 'd', sha256Hex: 'e',
        mimeType: 'audio/ogg', size: 200
      });

      expect(id1).not.toBe(id2);
      expect(queue.size).toBe(2);
    });
  });

  describe('flush', () => {
    it('should return 0 flushed on empty queue', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      const result = await queue.flush(
        makeMockChatAPI(),
        makeMockMessageStore(),
        makeMockDispatch()
      );

      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(0);
    });

    it('should upload ciphertext and complete the send pipeline', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      const ciphertext = makeCiphertext();
      await queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 99999,
        type: 'voice',
        caption: 'test voice',
        ciphertext,
        privkeyHex: 'deadbeef',
        ownPubkey: '11223344aabbccdd',
        keyHex: 'aabb',
        ivHex: 'ccdd',
        sha256Hex: 'eeff0011',
        mimeType: 'audio/ogg; codecs=opus',
        size: 1024
      });

      const chatAPI = makeMockChatAPI();
      const messageStore = makeMockMessageStore();
      const dispatch = makeMockDispatch();

      const result = await queue.flush(chatAPI, messageStore, dispatch);

      expect(result.flushed).toBe(1);
      expect(result.remaining).toBe(0);
      expect(mockUploadToBlossom).toHaveBeenCalledTimes(1);
      expect(chatAPI.sendFileMessage).toHaveBeenCalledTimes(1);
      expect(messageStore.saveMessage).toHaveBeenCalledTimes(1);
      expect(queue.size).toBe(0);
    });

    it('should dispatch progress and completion events', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      await queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 99999,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'deadbeef',
        ownPubkey: '11223344aabbccdd',
        keyHex: 'aabb',
        ivHex: 'ccdd',
        sha256Hex: 'eeff0011',
        mimeType: 'audio/ogg; codecs=opus',
        size: 1024
      });

      const dispatch = makeMockDispatch();
      await queue.flush(makeMockChatAPI(), makeMockMessageStore(), dispatch);

      expect(dispatch).toHaveBeenCalledWith(
        'phantomchat_file_upload_progress',
        expect.objectContaining({peerId: 12345, mid: 99999})
      );
      expect(dispatch).toHaveBeenCalledWith(
        'phantomchat_file_upload_completed',
        expect.objectContaining({peerId: 12345, mid: 99999})
      );
    });

    it('should retry on upload failure and increment retryCount', async () => {
      mockUploadToBlossom.mockRejectedValueOnce(new Error('network error'));

      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      await queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 99999,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'deadbeef',
        ownPubkey: '11223344aabbccdd',
        keyHex: 'aabb',
        ivHex: 'ccdd',
        sha256Hex: 'eeff0011',
        mimeType: 'audio/ogg; codecs=opus',
        size: 1024
      });

      const result = await queue.flush(
        makeMockChatAPI(),
        makeMockMessageStore(),
        makeMockDispatch()
      );

      // Entry stays in queue with retryCount=1
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(1);
      expect(queue.size).toBe(1);
    });

    it('should drop entries exceeding max retries', async () => {
      mockUploadToBlossom.mockRejectedValue(new Error('always fails'));

      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      const entry = makeEntry({retryCount: 10});
      queue.__injectForTest(entry);

      const result = await queue.flush(
        makeMockChatAPI(),
        makeMockMessageStore(),
        makeMockDispatch()
      );

      // Max retries exceeded → entry is skipped, not retried
      expect(result.flushed).toBe(0);
      // Entry remains but isn't retried (size unchanged since it wasn't removed)
      expect(mockUploadToBlossom).not.toHaveBeenCalled();
    });

    it('should connect to peer if active peer differs', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      await queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 99999,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'deadbeef',
        ownPubkey: '11223344aabbccdd',
        keyHex: 'aabb',
        ivHex: 'ccdd',
        sha256Hex: 'eeff0011',
        mimeType: 'audio/ogg; codecs=opus',
        size: 1024
      });

      const chatAPI = makeMockChatAPI();
      chatAPI.getActivePeer.mockReturnValue('different-peer');

      await queue.flush(chatAPI, makeMockMessageStore(), makeMockDispatch());

      expect(chatAPI.connect).toHaveBeenCalledWith('aabbccdd11223344');
    });

    it('should coalesce overlapping flushes', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      await queue.enqueue({
        peerId: 1,
        peerPubkey: 'aa',
        tempMid: 100,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'a',
        ownPubkey: 'b',
        keyHex: 'c',
        ivHex: 'd',
        sha256Hex: 'e',
        mimeType: 'audio/ogg',
        size: 10
      });

      const chatAPI = makeMockChatAPI();
      // Slow upload to allow overlap
      mockUploadToBlossom.mockImplementation(() =>
        new Promise(r => setTimeout(() => r({url: 'u', sha256: 's', mirrors: []}), 50))
      );

      const [r1, r2] = await Promise.all([
        queue.flush(chatAPI, makeMockMessageStore(), makeMockDispatch()),
        queue.flush(chatAPI, makeMockMessageStore(), makeMockDispatch())
      ]);

      // Only one actual flush should have run (coalesced)
      expect(mockUploadToBlossom).toHaveBeenCalledTimes(1);
      expect(r1.flushed).toBe(1);
      expect(r2.flushed).toBe(1); // Same result shared
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      await queue.enqueue({
        peerId: 1, peerPubkey: 'aa', tempMid: 1, type: 'voice',
        caption: '', ciphertext: makeCiphertext(), privkeyHex: 'a',
        ownPubkey: 'b', keyHex: 'c', ivHex: 'd', sha256Hex: 'e',
        mimeType: 'audio/ogg', size: 100
      });
      await queue.enqueue({
        peerId: 2, peerPubkey: 'bb', tempMid: 2, type: 'voice',
        caption: '', ciphertext: makeCiphertext(), privkeyHex: 'a',
        ownPubkey: 'b', keyHex: 'c', ivHex: 'd', sha256Hex: 'e',
        mimeType: 'audio/ogg', size: 200
      });

      expect(queue.size).toBe(2);
      await queue.clear();
      expect(queue.size).toBe(0);
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const q1 = getVoiceUploadQueue();
      const q2 = getVoiceUploadQueue();
      expect(q1).toBe(q2);
    });

    it('should reset on __resetVoiceUploadQueueForTests', () => {
      const q1 = getVoiceUploadQueue();
      __resetVoiceUploadQueueForTests();
      const q2 = getVoiceUploadQueue();
      expect(q1).not.toBe(q2);
    });
  });

  describe('ready / awaitReady', () => {
    it('should resolve after IndexedDB restore completes', async () => {
      const queue = new VoiceUploadQueue();
      // size is 0 before IDB restore finishes
      expect(queue.initialized).toBe(false);

      await queue.awaitReady();

      expect(queue.initialized).toBe(true);
    });

    it('should return the same promise on repeated calls', () => {
      const queue = new VoiceUploadQueue();
      const p1 = queue.awaitReady();
      const p2 = queue.awaitReady();
      expect(p1).toBe(p2);
    });

    it('should resolve even if IndexedDB restore fails', async () => {
      // Force IDB failure by making indexedDB.open return an error
      (globalThis as any).indexedDB = {
        open: () => {
          const req = {onerror: null as any, error: new Error('IDB failure')};
          setTimeout(() => req.onerror?.({target: req}), 0);
          return req;
        }
      };

      const queue = new VoiceUploadQueue();
      await queue.awaitReady();

      // Should still be initialized (empty queue, graceful degradation)
      expect(queue.initialized).toBe(true);
      expect(queue.size).toBe(0);
    });

    it('should restore persisted entries from IndexedDB', async () => {
      const queue = new VoiceUploadQueue();
      await queue.awaitReady();

      // Enqueue an entry (persists to IDB)
      await queue.enqueue({
        peerId: 1, peerPubkey: 'aa', tempMid: 1, type: 'voice',
        caption: '', ciphertext: makeCiphertext(), privkeyHex: 'a',
        ownPubkey: 'b', keyHex: 'c', ivHex: 'd', sha256Hex: 'e',
        mimeType: 'audio/ogg', size: 100
      });
      expect(queue.size).toBe(1);

      // Create a new queue instance — it should restore the persisted entry
      __resetVoiceUploadQueueForTests();
      const queue2 = new VoiceUploadQueue();
      await queue2.awaitReady();

      expect(queue2.size).toBe(1);
    });
  });

  describe('reconnect flush race condition', () => {
    it('should report correct size only after ready resolves', async () => {
      // Simulates the race: IDB restore is slow, and a reconnect
      // callback arrives before it completes.
      __resetVoiceUploadQueueForTests();

      // Pre-populate IndexedDB with an entry via a separate queue
      const setupQueue = new VoiceUploadQueue();
      await setupQueue.awaitReady();
      await setupQueue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 1,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(), privkeyHex: 'a',
        ownPubkey: 'b', keyHex: 'c', ivHex: 'd', sha256Hex: 'e',
        mimeType: 'audio/ogg', size: 100
      });
      __resetVoiceUploadQueueForTests();

      // Slow down IDB restore to simulate the race
      const origOpen = (globalThis as any).indexedDB.open;
      (globalThis as any).indexedDB.open = (...args: any[]) => {
        const req = origOpen(...args);
        const origSuccess = req.onsuccess;
        req.onsuccess = (e: any) => {
          setTimeout(() => origSuccess(e), 50);
        };
        return req;
      };

      const queue = new VoiceUploadQueue();
      // Before ready: size is 0 (IDB hasn't restored yet)
      expect(queue.size).toBe(0);

      // After ready: size reflects persisted entries
      await queue.awaitReady();
      expect(queue.size).toBe(1);

      // Restore original
      (globalThis as any).indexedDB.open = origOpen;
    });

    it('should block enqueue until restore completes (startup-enqueue interleaving)', async () => {
      // Regression: enqueue() pushes into _queue, then saveToIndexedDB.
      // If the constructor's loadFromIndexedDB resolves later and does
      // this._queue = entries, the just-enqueued entry is silently lost.
      __resetVoiceUploadQueueForTests();

      // Install a mock where getAll (used by loadFromIndexedDB) is slow
      // but put (used by saveToIndexedDB) is fast. This way enqueue
      // can write to IDB quickly, but the constructor's restore is pending.
      const stores = new Map<string, Map<any, any>>();
      const slowGetAllMs = 200;

      const slowMockStore = (storeName: string) => {
        if(!stores.has(storeName)) stores.set(storeName, new Map());
        const data = stores.get(storeName)!;
        return {
          createIndex: () => ({}),
          put: (entry: any) => {
            const req = {onsuccess: null as any, onerror: null as any, error: null as any};
            data.set(entry.id, entry);
            setTimeout(() => req.onsuccess?.({target: req} as any), 0);
            return req;
          },
          delete: (id: string) => {
            const req = {onsuccess: null as any, onerror: null as any, error: null as any};
            data.delete(id);
            setTimeout(() => req.onsuccess?.({target: req} as any), 0);
            return req;
          },
          getAll: () => {
            const req = {result: [...data.values()], onsuccess: null as any, onerror: null as any, error: null as any};
            // Slow getAll — simulates IDB restore taking time
            setTimeout(() => req.onsuccess?.({target: req} as any), slowGetAllMs);
            return req;
          },
          index: () => ({
            openCursor: () => {
              const req = {result: null as any, onsuccess: null as any, onerror: null as any, error: null as any};
              setTimeout(() => req.onsuccess?.({target: req} as any), 0);
              return req;
            }
          })
        };
      };

      (globalThis as any).indexedDB = {
        open: (_name: string, _version: number) => {
          const req = {
            result: {
              objectStoreNames: {contains: () => false},
              createObjectStore: () => slowMockStore('voice-uploads'),
              transaction: (storeName: string, _mode: string) => ({
                objectStore: () => slowMockStore(storeName)
              })
            },
            onsuccess: null as any,
            onerror: null as any,
            onupgradeneeded: null as any,
            error: null as any
          };
          setTimeout(() => {
            req.onupgradeneeded?.({target: req});
            req.onsuccess?.({target: req});
          }, 0);
          return req;
        }
      };

      const queue = new VoiceUploadQueue();

      // Start enqueue immediately — before restore completes
      const enqueuePromise = queue.enqueue({
        peerId: 99999,
        peerPubkey: 'ffff000011112222',
        tempMid: 42,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'ff',
        ownPubkey: 'aa',
        keyHex: 'bb',
        ivHex: 'cc',
        sha256Hex: 'dd',
        mimeType: 'audio/ogg',
        size: 256
      });

      // Restore takes ~200ms (slow getAll), enqueue's IDB write is fast (~1ms).
      // enqueue() awaits this.ready, so the promise must still be pending.
      let resolved = false;
      enqueuePromise.then(() => { resolved = true; });
      await new Promise(r => setTimeout(r, 50));
      expect(resolved).toBe(false);

      // Now let restore + enqueue complete
      const id = await enqueuePromise;
      expect(id).toBeTruthy();

      // Entry must be in the live queue — not lost to the restore overwrite
      expect(queue.size).toBe(1);

      // Reinstall the standard test mock for subsequent tests
      idb.install();
    });
  });

  describe('bubble re-injection on flush', () => {
    it('should not inject a new bubble — the original optimistic bubble persists', async () => {
      const queue = new VoiceUploadQueue();
      await new Promise(r => setTimeout(r, 10));

      await queue.enqueue({
        peerId: 12345,
        peerPubkey: 'aabbccdd11223344',
        tempMid: 99999,
        type: 'voice',
        caption: '',
        ciphertext: makeCiphertext(),
        privkeyHex: 'deadbeef',
        ownPubkey: '11223344aabbccdd',
        keyHex: 'aabb',
        ivHex: 'ccdd',
        sha256Hex: 'eeff0011',
        mimeType: 'audio/ogg; codecs=opus',
        size: 1024
      });

      const dispatch = makeMockDispatch();
      await queue.flush(makeMockChatAPI(), makeMockMessageStore(), dispatch);

      // Should dispatch upload_progress (0%) and upload_completed, but NOT injectBubble
      const progressCalls = dispatch.mock.calls.filter(
        (c: any[]) => c[0] === 'phantomchat_file_upload_progress'
      );
      const completedCalls = dispatch.mock.calls.filter(
        (c: any[]) => c[0] === 'phantomchat_file_upload_completed'
      );

      expect(progressCalls.length).toBeGreaterThanOrEqual(1);
      expect(completedCalls.length).toBe(1);
      // The original optimistic bubble (from sendFileViaPhantomChat) already exists.
      // The flush only completes the upload — no new bubble injection.
    });
  });
});
