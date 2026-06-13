/**
 * Tests for Nostra.chat offline queue module
 */

import '../setup';
import type {PublishResult} from '@lib/nostra/nostr-relay-pool';

// Dynamic import to get a fresh OfflineQueue after clearing IndexedDB.
// Under isolate:false, relay-failover.test.ts calls vi.resetModules()
// which resets the offline-queue module's _dbPromise singleton. When
// this file runs next, a new OfflineQueue would restore stale data
// from IndexedDB. Using dynamic import ensures we get a fresh module
// each time.
let OfflineQueue: typeof import('@lib/nostra/offline-queue').OfflineQueue;
let createOfflineQueue: typeof import('@lib/nostra/offline-queue').createOfflineQueue;
type QueuedMessage = import('@lib/nostra/offline-queue').QueuedMessage;

beforeAll(async() => {
  const mod = await import('@lib/nostra/offline-queue');
  OfflineQueue = mod.OfflineQueue;
  createOfflineQueue = mod.createOfflineQueue;
});

// ==================== Mock Classes ====================

/**
 * Mock NostrRelayPool for testing
 */
class MockRelayPool {
  private _connected = false;
  private _publicKey = 'mock-pubkey-abc123';
  publishCalls: Array<{recipientPubkey: string; plaintext: string}> = [];
  publishShouldFail = false;

  isConnected(): boolean {
    return this._connected;
  }

  getPublicKey(): string {
    return this._publicKey;
  }

  async publish(recipientPubkey: string, plaintext: string): Promise<PublishResult> {
    this.publishCalls.push({recipientPubkey, plaintext});

    if(this.publishShouldFail) {
      return {
        successes: [],
        failures: [{url: 'wss://relay.test', error: 'mock failure'}]
      };
    }

    return {
      successes: [`event-${Date.now()}-${this.publishCalls.length}`],
      failures: []
    };
  }

  // Helpers
  simulateConnect(): void {
    this._connected = true;
  }

  simulateDisconnect(): void {
    this._connected = false;
  }
}

// ==================== Tests ====================

describe('OfflineQueue', () => {
  let mockRelayPool: MockRelayPool;
  let queue: any;

  beforeEach(async() => {
    // Clear the offline-queue IndexedDB object store to prevent stale
    // data leaking across test files. Under isolate:false,
    // relay-failover.test.ts calls vi.resetModules() which resets the
    // offline-queue module's _dbPromise singleton. When this file runs
    // next, loadFromIndexedDB() may find leftover data.
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('nostra-offline-queue', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = (e) => {
          const d = (e.target as IDBOpenDBRequest).result;
          if(!d.objectStoreNames.contains('messages')) {
            d.createObjectStore('messages', {keyPath: 'id'});
          }
        };
      });
      if(db.objectStoreNames.contains('messages')) {
        await new Promise<void>((resolve) => {
          const tx = db.transaction('messages', 'readwrite');
          tx.objectStore('messages').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      }
      db.close();
    } catch(_) {
      // ignore — DB may not exist yet
    }
    mockRelayPool = new MockRelayPool();
    queue = new OfflineQueue(mockRelayPool as any);
  });

  afterEach(() => {
    queue.destroy();
  });

  describe('queue()', () => {
    test('stores a message locally and returns a message ID', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';
      const payload = 'Hello, World!';

      const messageId = await queue.queue(peerId, payload);

      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');
      expect(messageId.length).toBeGreaterThan(0);

      // Message should be in the queue
      const queued = queue.getQueued(peerId);
      expect(queued).toHaveLength(1);
      expect(queued[0].id).toBe(messageId);
      expect(queued[0].payload).toBe(payload);
      expect(queued[0].to).toBe(peerId);
    });

    test('calls relayPool.publish() when pool is connected', async() => {
      mockRelayPool.simulateConnect();

      const peerId = 'BBBBBB.CCCCCC.DDDDDD';
      const payload = 'Test message';

      await queue.queue(peerId, payload);

      expect(mockRelayPool.publishCalls).toHaveLength(1);
      expect(mockRelayPool.publishCalls[0].recipientPubkey).toBe(peerId);
      expect(mockRelayPool.publishCalls[0].plaintext).toBe(payload);
    });

    test('does not throw when relay pool is not connected', async() => {
      mockRelayPool.simulateDisconnect();

      const peerId = 'BBBBBB.CCCCCC.DDDDDD';
      const payload = 'Test message';

      // Should not throw — stores locally only
      await expect(queue.queue(peerId, payload)).resolves.toBeDefined();
      expect(mockRelayPool.publishCalls).toHaveLength(0);

      // But message should still be queued locally
      const queued = queue.getQueued(peerId);
      expect(queued).toHaveLength(1);
    });

    test('generates unique message IDs for each queued message', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';

      const id1 = await queue.queue(peerId, 'message 1');
      const id2 = await queue.queue(peerId, 'message 2');
      const id3 = await queue.queue(peerId, 'message 3');

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id3).not.toBe(id1);
    });

    test('stores relay event ID in queued message after successful publish', async() => {
      mockRelayPool.simulateConnect();

      const peerId = 'BBBBBB.CCCCCC.DDDDDD';
      const payload = 'Test with relay';

      await queue.queue(peerId, payload);

      const queued = queue.getQueued(peerId);
      expect(queued).toHaveLength(1);
      expect(queued[0].relayEventId).toBeDefined();
      expect(queued[0].relayEventId).toContain('event-');
    });
  });

  describe('flush()', () => {
    test('calls relayPool.publish() for each queued message', async() => {
      // Queue while disconnected
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 1');
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 2');
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 3');

      expect(mockRelayPool.publishCalls).toHaveLength(0);

      // Connect and flush
      mockRelayPool.simulateConnect();
      const flushed = await queue.flush('BBBBBB.CCCCCC.DDDDDD');

      expect(flushed).toBe(3);
      expect(mockRelayPool.publishCalls).toHaveLength(3);

      // Verify message content
      for(let i = 0; i < 3; i++) {
        expect(mockRelayPool.publishCalls[i].plaintext).toBe(`message ${i + 1}`);
        expect(mockRelayPool.publishCalls[i].recipientPubkey).toBe('BBBBBB.CCCCCC.DDDDDD');
      }
    });

    test('clears queue after successful flush', async() => {
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 1');

      mockRelayPool.simulateConnect();
      await queue.flush('BBBBBB.CCCCCC.DDDDDD');

      const remaining = queue.getQueued('BBBBBB.CCCCCC.DDDDDD');
      expect(remaining).toHaveLength(0);
    });

    test('returns 0 when relay pool is not connected', async() => {
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 1');

      // Pool is disconnected
      const flushed = await queue.flush('BBBBBB.CCCCCC.DDDDDD');

      expect(flushed).toBe(0);
      expect(mockRelayPool.publishCalls).toHaveLength(0);
    });

    test('returns 0 when no messages are queued for peer', async() => {
      mockRelayPool.simulateConnect();

      const flushed = await queue.flush('BBBBBB.CCCCCC.DDDDDD');

      expect(flushed).toBe(0);
    });

    test('stops flushing when relayPool.publish() fails', async() => {
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 1');
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 2');
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 3');

      mockRelayPool.simulateConnect();

      // Make publish fail after first call
      let callCount = 0;
      const originalPublish = mockRelayPool.publish.bind(mockRelayPool);
      mockRelayPool.publish = async(recipientPubkey: string, plaintext: string): Promise<PublishResult> => {
        callCount++;
        if(callCount > 1) {
          return {successes: [], failures: [{url: 'wss://relay.test', error: 'fail'}]};
        }
        return originalPublish(recipientPubkey, plaintext);
      };

      const flushed = await queue.flush('BBBBBB.CCCCCC.DDDDDD');

      expect(flushed).toBe(1);

      // Remaining messages should still be in queue
      const remaining = queue.getQueued('BBBBBB.CCCCCC.DDDDDD');
      expect(remaining).toHaveLength(2);
    });
  });

  describe('getQueued()', () => {
    test('returns messages for a specific peer', async() => {
      const peer1 = 'PEER1.PEER2.PEER3';
      const peer2 = 'PEER4.PEER5.PEER6';

      await queue.queue(peer1, 'message for peer 1');
      await queue.queue(peer1, 'second for peer 1');
      await queue.queue(peer2, 'message for peer 2');

      const peer1Messages = queue.getQueued(peer1);
      const peer2Messages = queue.getQueued(peer2);

      expect(peer1Messages).toHaveLength(2);
      expect(peer1Messages[0].payload).toBe('message for peer 1');
      expect(peer1Messages[1].payload).toBe('second for peer 1');

      expect(peer2Messages).toHaveLength(1);
      expect(peer2Messages[0].payload).toBe('message for peer 2');
    });

    test('with no argument returns all queued messages', async() => {
      const peer1 = 'PEER1.PEER2.PEER3';
      const peer2 = 'PEER4.PEER5.PEER6';

      await queue.queue(peer1, 'message 1');
      await queue.queue(peer1, 'message 2');
      await queue.queue(peer2, 'message 3');

      const all = queue.getQueued();

      expect(all).toHaveLength(3);
    });

    test('returns empty array for unknown peer', async() => {
      const unknown = 'UNKNOWN.XXXXX.YYYYY';
      const queued = queue.getQueued(unknown);

      expect(queued).toEqual([]);
    });

    test('does not return acknowledged messages', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';

      const id1 = await queue.queue(peerId, 'message 1');
      await queue.queue(peerId, 'message 2');

      // Acknowledge the first message
      queue.acknowledge(id1);

      const queued = queue.getQueued(peerId);

      expect(queued).toHaveLength(1);
      expect(queued[0].payload).toBe('message 2');
    });
  });

  describe('acknowledge()', () => {
    test('marks a relay message as acknowledged', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';

      const id1 = await queue.queue(peerId, 'message 1');
      const id2 = await queue.queue(peerId, 'message 2');

      queue.acknowledge(id1);

      // getQueued should filter out acknowledged messages
      const queued = queue.getQueued(peerId);
      expect(queued).toHaveLength(1);
      expect(queued[0].id).toBe(id2);
    });

    test('is idempotent — acknowledging twice does not throw', () => {
      const messageId = 'oq-123-0';
      expect(() => queue.acknowledge(messageId)).not.toThrow();
      expect(() => queue.acknowledge(messageId)).not.toThrow();
    });
  });

  describe('queue persists across multiple calls', () => {
    test('messages accumulate in queue across multiple queue() calls', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';

      await queue.queue(peerId, 'message 1');
      const afterFirst = queue.getQueued(peerId);
      expect(afterFirst).toHaveLength(1);

      await queue.queue(peerId, 'message 2');
      const afterSecond = queue.getQueued(peerId);
      expect(afterSecond).toHaveLength(2);

      await queue.queue(peerId, 'message 3');
      const afterThird = queue.getQueued(peerId);
      expect(afterThird).toHaveLength(3);
    });

    test('acknowledge removes individual messages without affecting others', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';

      const id1 = await queue.queue(peerId, 'message 1');
      await queue.queue(peerId, 'message 2');
      await queue.queue(peerId, 'message 3');

      queue.acknowledge(id1);

      const remaining = queue.getQueued(peerId);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((m: any) => m.payload)).toEqual(['message 2', 'message 3']);
    });
  });

  describe('flush() with empty queue returns 0', () => {
    test('flush returns 0 when called on empty queue', async() => {
      mockRelayPool.simulateConnect();

      const flushed = await queue.flush('BBBBBB.CCCCCC.DDDDDD');

      expect(flushed).toBe(0);
      expect(mockRelayPool.publishCalls).toHaveLength(0);
    });
  });

  describe('destroy()', () => {
    test('clears internal state', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';
      await queue.queue(peerId, 'message 1');

      expect(queue.getQueued(peerId)).toHaveLength(1);

      queue.destroy();

      // After destroy, state should be cleared
      expect(queue.getQueued(peerId)).toHaveLength(0);
    });
  });
});

describe('createOfflineQueue factory', () => {
  test('creates an OfflineQueue instance', () => {
    const mockRelayPool = {
      isConnected: (): boolean => false,
      getPublicKey: (): string => 'mock-pubkey',
      publish: async(): Promise<PublishResult> => ({successes: [], failures: []})
    };

    const q = createOfflineQueue(mockRelayPool as any);
    expect(q).toBeInstanceOf(OfflineQueue);
    q.destroy();
  });
});
