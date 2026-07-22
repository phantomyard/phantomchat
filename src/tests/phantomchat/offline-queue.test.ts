/**
 * Tests for PhantomChat.chat offline queue module
 */

import '../setup';
import type {PublishResult} from '@lib/phantomchat/nostr-relay-pool';

// The end-to-end re-key test drives a real DeliveryTracker, whose markSent/
// handleReceipt dispatch `phantomchat_delivery_update` through rootScope — the
// real rootScope forwards to MTProtoMessagePort, which isn't initialised here
// and throws an unhandled rejection. Stub it (same as delivery-tracker.test).
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
}));

// Dynamic import to get a fresh OfflineQueue after clearing IndexedDB.
// Under isolate:false, relay-failover.test.ts calls vi.resetModules()
// which resets the offline-queue module's _dbPromise singleton. When
// this file runs next, a new OfflineQueue would restore stale data
// from IndexedDB. Using dynamic import ensures we get a fresh module
// each time.
let OfflineQueue: typeof import('@lib/phantomchat/offline-queue').OfflineQueue;
let createOfflineQueue: typeof import('@lib/phantomchat/offline-queue').createOfflineQueue;
type QueuedMessage = import('@lib/phantomchat/offline-queue').QueuedMessage;

beforeAll(async() => {
  const mod = await import('@lib/phantomchat/offline-queue');
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

  lastRumorId = '';

  rewrapCalls: Array<{recipientPubkey: string; rumorId: string}> = [];

  async rewrapAndPublish(_recipientPubkey: string, rumor: any): Promise<PublishResult> {
    this.publishCalls.push({recipientPubkey: _recipientPubkey, plaintext: `rewrap:${rumor.id}`});
    this.rewrapCalls.push({recipientPubkey: _recipientPubkey, rumorId: rumor.id});
    return {
      successes: [`rewrap-${Date.now()}-${this.publishCalls.length}`],
      failures: [],
      rumorId: rumor.id,
      rumor,
      wraps: [{
        id: `rewrap-${Date.now()}-${this.publishCalls.length}`,
        kind: 1059,
        pubkey: 'x',
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'mock',
        sig: 'mock'
      }]
    };
  }

  async publish(recipientPubkey: string, plaintext: string): Promise<PublishResult> {
    this.publishCalls.push({recipientPubkey, plaintext});

    if(this.publishShouldFail) {
      return {
        successes: [],
        failures: [{url: 'wss://relay.test', error: 'mock failure'}]
      };
    }

    // 64-hex rumor id, mirroring the real wrap. This is what a flush hands back
    // so the sender can migrate its row/tracker off the app message id.
    this.lastRumorId = this.publishCalls.length.toString(16).padStart(64, '0');
    return {
      successes: [`event-${Date.now()}-${this.publishCalls.length}`],
      failures: [],
      rumorId: this.lastRumorId,
      rumor: {kind: 14, content: plaintext, pubkey: 'x', created_at: 0, tags: [], id: this.lastRumorId} as any
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
        const req = indexedDB.open('phantomchat-offline-queue', 1);
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

  describe('re-key on flush (NIP-17 offline send → canonical rumor id)', () => {
    const PEER = 'BBBBBB.CCCCCC.DDDDDD';

    test('queue() persists the app message id on the item', async() => {
      await queue.queue(PEER, 'offline text', 'chat-123-0');
      const items = queue.getQueued(PEER) as QueuedMessage[];
      expect(items).toHaveLength(1);
      expect(items[0].appMessageId).toBe('chat-123-0');
    });

    test('flush() emits the flushed rumor id + app message id to the onFlushed handler', async() => {
      const flushedEvents: any[] = [];
      queue.setOnFlushed((info: any) => flushedEvents.push(info));

      await queue.queue(PEER, 'offline text', 'chat-123-0');
      mockRelayPool.simulateConnect();
      await queue.flush(PEER);

      expect(flushedEvents).toHaveLength(1);
      expect(flushedEvents[0].appMessageId).toBe('chat-123-0');
      expect(flushedEvents[0].to).toBe(PEER);
      expect(flushedEvents[0].rumorId).toBe(mockRelayPool.lastRumorId);
      expect(flushedEvents[0].rumorId).toMatch(/^[0-9a-f]{64}$/);
      expect(flushedEvents[0].rumor).toBeDefined();
    });

    test('end-to-end: a receipt for the FLUSHED rumor id marks the offline-queued message delivered', async() => {
      // Replicate ChatAPI's wiring: on flush, migrate the delivery tracker from
      // the app message id onto the canonical rumor id, then markSent. This is
      // what makes the receiver's receipt (which references the rumor id) flip
      // the bubble to delivered. Pre-fix, the tracker stayed keyed by the app id
      // and the receipt never matched.
      const {DeliveryTracker} = await import('@lib/phantomchat/delivery-tracker');
      const tracker = new DeliveryTracker({
        privateKey: new Uint8Array(32).fill(7),
        publicKey: 'f'.repeat(64),
        publishFn: async() => {}
      });

      const APP_ID = 'chat-999-0';
      tracker.markSending(APP_ID); // ChatAPI marks sending at send time

      queue.setOnFlushed((info: any) => {
        if(!info.appMessageId || !info.rumorId) return;
        tracker.rekey(info.appMessageId, info.rumorId);
        tracker.markSent(info.rumorId);
      });

      // Send while offline → queued under the app id.
      await queue.queue(PEER, 'offline text', APP_ID);
      expect(tracker.getState(APP_ID)?.state).toBe('sending');

      // Reconnect → flush → re-key onto the rumor id.
      mockRelayPool.simulateConnect();
      await queue.flush(PEER);
      const rumorId = mockRelayPool.lastRumorId;

      // Old app-id key no longer tracks; the rumor id is now 'sent'.
      expect(tracker.getState(APP_ID)).toBeUndefined();
      expect(tracker.getState(rumorId)?.state).toBe('sent');

      // The receiver's delivery receipt references the FLUSHED rumor id.
      tracker.handleReceipt({
        kind: 14,
        content: '',
        pubkey: 'sender',
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', rumorId], ['receipt-type', 'delivery']],
        id: 'receipt-flush-1'
      });

      expect(tracker.getState(rumorId)?.state).toBe('delivered');
    });

    test('race-safety: a receipt fired while the store migration is still pending still marks delivered', async() => {
      // Locks the ordering contract ChatAPI.handleQueueFlushed follows: the
      // delivery tracker is re-keyed SYNCHRONOUSLY (before the awaited, possibly
      // slow IndexedDB row migration). A delivery receipt for the rumor id can
      // arrive the instant flush returns; if arming waited on the store await it
      // would be dropped. (kaieriksen review.)
      const {DeliveryTracker} = await import('@lib/phantomchat/delivery-tracker');
      const tracker = new DeliveryTracker({
        privateKey: new Uint8Array(32).fill(7),
        publicKey: 'f'.repeat(64),
        publishFn: async() => {}
      });

      const APP_ID = 'chat-race-0';
      tracker.markSending(APP_ID);

      let resolveStore: () => void = () => {};
      const storeMigration = new Promise<void>((r) => {resolveStore = r;});
      let storeSettled = false;
      void storeMigration.then(() => {storeSettled = true;});

      // Mirror the FIXED ordering: tracker work first, THEN await the (here
      // artificially slow) store migration.
      queue.setOnFlushed(async(info: any) => {
        if(!info.appMessageId || !info.rumorId) return;
        tracker.rekey(info.appMessageId, info.rumorId);
        tracker.markSent(info.rumorId);
        await storeMigration;
      });

      await queue.queue(PEER, 'offline text', APP_ID);
      mockRelayPool.simulateConnect();
      await queue.flush(PEER);
      const rumorId = mockRelayPool.lastRumorId;

      // Store migration has NOT resolved yet — but the tracker is already armed.
      expect(storeSettled).toBe(false);
      expect(tracker.getState(rumorId)?.state).toBe('sent');

      tracker.handleReceipt({
        kind: 14,
        content: '',
        pubkey: 'sender',
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', rumorId], ['receipt-type', 'delivery']],
        id: 'receipt-race-1'
      });
      expect(tracker.getState(rumorId)?.state).toBe('delivered');

      resolveStore();
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

    test('coalesces overlapping flushes into a single run', async() => {
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 1');
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 2');
      mockRelayPool.simulateConnect();

      // Slow publish so the first flush is still in flight when the others land
      const originalPublish = mockRelayPool.publish.bind(mockRelayPool);
      mockRelayPool.publish = async(recipientPubkey: string, plaintext: string): Promise<PublishResult> => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPublish(recipientPubkey, plaintext);
      };

      // Reconnect flap storms fire flush repeatedly — concurrent callers must
      // share ONE run, not stack three re-wrap/re-publish passes.
      const [a, b, c] = await Promise.all([
        queue.flush('BBBBBB.CCCCCC.DDDDDD'),
        queue.flush('BBBBBB.CCCCCC.DDDDDD'),
        queue.flush('BBBBBB.CCCCCC.DDDDDD')
      ]);

      expect(mockRelayPool.publishCalls).toHaveLength(2);
      expect(a).toBe(2);
      expect(b).toBe(2);
      expect(c).toBe(2);

      // After the run completes, a later flush starts fresh (no stale latch).
      // Queue while DISCONNECTED — queue() optimistically publishes when the
      // pool is up, which would confound the count.
      mockRelayPool.simulateDisconnect();
      await queue.queue('BBBBBB.CCCCCC.DDDDDD', 'message 3');
      mockRelayPool.simulateConnect();
      const flushed = await queue.flush('BBBBBB.CCCCCC.DDDDDD');
      expect(flushed).toBe(1);
      expect(mockRelayPool.publishCalls).toHaveLength(3);
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

  describe('stable rumor id across flush retries (GitHub issue #84)', () => {
    const PEER = 'stable.rumor.peer';

    test('does not acknowledge or delete on rewrap with zero relay successes', async() => {
      // Queue offline, publish() returns rumor but no successes (ghost ack).
      mockRelayPool.publish = async(): Promise<PublishResult> => ({
        successes: [],
        failures: [{url: 'wss://relay.test', error: 'ghost'}],
        rumorId: 'r'.repeat(64),
        rumor: {kind: 14, content: 'hello ghost', pubkey: 'x', created_at: 0, tags: [], id: 'r'.repeat(64)} as any
      });
      await queue.queue(PEER, 'hello ghost');

      // First flush captures the rumor; retry rewrap has zero successes → stays
      mockRelayPool.simulateConnect();
      mockRelayPool.rewrapAndPublish = vi.fn(async(): Promise<PublishResult> => ({
        successes: [],
        failures: [{url: 'wss://relay.test', error: 'still offline'}],
        rumorId: 'r'.repeat(64),
        rumor: {kind: 14, content: 'hello ghost', pubkey: 'x', created_at: 0, tags: [], id: 'r'.repeat(64)} as any,
        wraps: [{id: 'rewrap-0', kind: 1059, pubkey: 'x', created_at: 0, tags: [], content: 'mock', sig: 'mock'} as any]
      }));

      await queue.flush(PEER);

      const items = queue.getQueued(PEER);
      expect(items).toHaveLength(1); // Still queued
      expect(items[0].rumorId).toBe('r'.repeat(64));
    });

    test('flush() re-wraps the same rumor on retry, producing a stable rumor id', async() => {
      // Queue offline
      await queue.queue(PEER, 'hello ghost');
      mockRelayPool.simulateConnect();

      // First flush: publish() returns a rumor but no successes (ghost ack).
      // The rumor should be captured and stored on the queue item.
      mockRelayPool.publish = async(): Promise<PublishResult> => ({
        successes: [],
        failures: [{url: 'wss://relay.test', error: 'ghost'}],
        rumorId: 'r'.repeat(64),
        rumor: {kind: 14, content: 'hello ghost', pubkey: 'x', created_at: 0, tags: [], id: 'r'.repeat(64)} as any
      });
      await queue.flush(PEER);

      // The item should now have the rumor persisted
      let items = queue.getQueued(PEER);
      expect(items).toHaveLength(1);
      expect(items[0].rumorId).toBe('r'.repeat(64));
      expect(items[0].rumor).toBeDefined();

      // Second flush: should call rewrapAndPublish with the SAME rumor id
      mockRelayPool.rewrapAndPublish = vi.fn(async(_recipientPubkey: string, rumor: any): Promise<PublishResult> => ({
        successes: ['rewrap-1'],
        failures: [],
        rumorId: rumor.id,
        rumor,
        wraps: [{id: 'rewrap-1', kind: 1059, pubkey: 'x', created_at: 0, tags: [], content: 'mock', sig: 'mock'}]
      }));

      await queue.flush(PEER);

      expect(mockRelayPool.rewrapAndPublish).toHaveBeenCalledTimes(1);
      expect(mockRelayPool.rewrapAndPublish).toHaveBeenCalledWith(
        PEER,
        expect.objectContaining({id: 'r'.repeat(64)})
      );
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
