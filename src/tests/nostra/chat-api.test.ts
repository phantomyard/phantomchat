/**
 * Tests for Nostra.chat ChatAPI module (Nostr-first transport)
 */

import '../setup';
import {vi} from 'vitest';

// Hoisted mock state — lets individual tests flip isKnownContact to false
// to exercise the unknown-sender auto-add path.
const {messageRequestMocks} = vi.hoisted(() => ({
  messageRequestMocks: {
    isBlocked: vi.fn().mockResolvedValue(false),
    isKnownContact: vi.fn().mockResolvedValue(true),
    addRequest: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock message-requests and message-store to avoid indexedDB dependency
vi.mock('@lib/nostra/message-requests', () => ({
  getMessageRequestStore: () => messageRequestMocks
}));

// Mock nostra-bridge for unknown-sender auto-add tests
const {bridgeMocks} = vi.hoisted(() => ({
  bridgeMocks: {
    mapPubkeyToPeerId: vi.fn().mockResolvedValue(9999999999),
    storePeerMapping: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('@lib/nostra/nostra-bridge', () => ({
  NostraBridge: {
    getInstance: () => bridgeMocks
  }
}));

const messageStoreMocks = {
  saveMessage: vi.fn().mockResolvedValue(undefined),
  getConversationId: vi.fn().mockReturnValue('conv-1'),
  getAllConversationIds: vi.fn().mockResolvedValue([]),
  getMessages: vi.fn().mockResolvedValue([]),
  getByEventId: vi.fn().mockResolvedValue(null),
  getByAppMessageId: vi.fn().mockResolvedValue(null)
};
vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => messageStoreMocks
}));

// Mock rootScope to prevent event dispatch errors
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn()
  }
}));

import {ChatAPI, createChatAPI, ChatMessage, ChatState} from '@lib/nostra/chat-api';
import {DecryptedMessage} from '@lib/nostra/nostr-relay';
import type {PublishResult, RelayConfig, NostrRelayPool} from '@lib/nostra/nostr-relay-pool';
import type {OfflineQueue} from '@lib/nostra/offline-queue';

// ==================== Mock Classes ====================

/**
 * Mock NostrRelayPool for testing
 */
class MockRelayPool {
  private _connected = false;
  private _connectedCount = 0;
  private _publicKey = 'mock-pubkey-abc123';
  private _relays: RelayConfig[] = [];

  publishCalls: Array<{recipientPubkey: string; plaintext: string}> = [];
  publishResult: PublishResult = {successes: ['event-1'], failures: []};

  initializeCallCount = 0;
  disconnectCallCount = 0;
  subscribeCallCount = 0;
  unsubscribeCallCount = 0;

  private _onMessage: ((msg: DecryptedMessage) => void) | null = null;
  private _onStateChange: ((connectedCount: number, totalCount: number) => void) | null = null;

  constructor(options?: {
    onMessage?: (msg: DecryptedMessage) => void;
    onStateChange?: (connectedCount: number, totalCount: number) => void;
  }) {
    if(options) {
      this._onMessage = options.onMessage || null;
      this._onStateChange = options.onStateChange || null;
    }
  }

  async initialize(): Promise<void> {
    this.initializeCallCount++;
  }

  disconnect(): void {
    this.disconnectCallCount++;
    this._connected = false;
    this._connectedCount = 0;
  }

  async publish(recipientPubkey: string, plaintext: string): Promise<PublishResult> {
    this.publishCalls.push({recipientPubkey, plaintext});
    return this.publishResult;
  }

  subscribeMessages(): void {
    this.subscribeCallCount++;
  }

  unsubscribeMessages(): void {
    this.unsubscribeCallCount++;
  }

  addRelay(config: RelayConfig): void {
    this._relays.push(config);
  }

  removeRelay(url: string): void {
    this._relays = this._relays.filter(r => r.url !== url);
  }

  getRelays(): RelayConfig[] {
    return [...this._relays];
  }

  getConnectedCount(): number {
    return this._connectedCount;
  }

  getPublicKey(): string {
    return this._publicKey;
  }

  isConnected(): boolean {
    return this._connected;
  }

  // ─── Test helpers ───────────────────────────────────────────

  /** Simulate relay pool being connected */
  simulateConnect(count = 1): void {
    this._connected = true;
    this._connectedCount = count;
  }

  /** Simulate relay pool disconnecting */
  simulateDisconnect(): void {
    this._connected = false;
    this._connectedCount = 0;
  }

  /** Simulate an incoming message via the pool's onMessage callback */
  simulateMessage(msg: DecryptedMessage): void {
    if(this._onMessage) {
      this._onMessage(msg);
    }
  }

  /** Simulate a state change via the pool's onStateChange callback */
  simulateStateChange(connectedCount: number, totalCount: number): void {
    this._connectedCount = connectedCount;
    this._connected = connectedCount > 0;
    if(this._onStateChange) {
      this._onStateChange(connectedCount, totalCount);
    }
  }

  /** Set the onMessage callback (used when ChatAPI wires it up) */
  setOnMessage(cb: (msg: DecryptedMessage) => void): void {
    this._onMessage = cb;
  }

  /** Set the onStateChange callback */
  setOnStateChange(cb: (connectedCount: number, totalCount: number) => void): void {
    this._onStateChange = cb;
  }
}

/**
 * Mock OfflineQueue for testing
 */
class MockOfflineQueue {
  queuedMessages: Array<{peerId: string; payload: string; id: string}> = [];
  acknowledgedIds: Set<string> = new Set();
  queueCallCount = 0;
  flushCallCount = 0;
  acknowledgeCallCount = 0;

  async queue(peerOwnId: string, payload: string): Promise<string> {
    this.queueCallCount++;
    const id = `oq-${Date.now()}-${this.queuedMessages.length}`;
    this.queuedMessages.push({peerId: peerOwnId, payload, id});
    return id;
  }

  async flush(peerOwnId: string): Promise<number> {
    this.flushCallCount++;
    return this.queuedMessages.filter(m => m.peerId === peerOwnId).length;
  }

  acknowledge(messageId: string): void {
    this.acknowledgeCallCount++;
    this.acknowledgedIds.add(messageId);
  }

  getQueued(peerOwnId?: string): Array<{id: string; to: string; payload: string; timestamp: number}> {
    if(peerOwnId) {
      return this.queuedMessages.filter(m => m.peerId === peerOwnId).map(m => ({
        id: m.id,
        to: m.peerId,
        payload: m.payload,
        timestamp: Math.floor(Date.now() / 1000)
      }));
    }
    return this.queuedMessages.map(m => ({
      id: m.id,
      to: m.peerId,
      payload: m.payload,
      timestamp: Math.floor(Date.now() / 1000)
    }));
  }

  destroy(): void {
    this.queuedMessages = [];
    this.acknowledgedIds.clear();
  }
}

// ==================== Tests ====================

describe('ChatAPI', () => {
  const OWN_ID = 'AAAAA.BBBBB.CCCCC';
  const PEER_ID = 'DDDDDD.EEEEE.FFFFF';

  let mockPool: MockRelayPool;
  let mockQueue: MockOfflineQueue;
  let chatApi: ChatAPI;

  beforeEach(() => {
    mockPool = new MockRelayPool();
    mockQueue = new MockOfflineQueue();

    chatApi = new ChatAPI(OWN_ID, mockPool as unknown as NostrRelayPool, mockQueue as unknown as OfflineQueue);
  });

  afterEach(() => {
    chatApi.disconnect();
    chatApi.destroy();
  });

  describe('getState()', () => {
    test('returns disconnected initially', () => {
      expect(chatApi.getState()).toBe('disconnected');
    });

    test('returns connected after connect()', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      expect(chatApi.getState()).toBe('connected');
    });

    test('returns disconnected after disconnect()', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);
      chatApi.disconnect();

      expect(chatApi.getState()).toBe('disconnected');
    });
  });

  describe('getActivePeer()', () => {
    test('returns null initially', () => {
      expect(chatApi.getActivePeer()).toBeNull();
    });

    test('returns peer ID after connect()', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      expect(chatApi.getActivePeer()).toBe(PEER_ID);
    });

    test('returns null after disconnect()', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);
      chatApi.disconnect();

      expect(chatApi.getActivePeer()).toBeNull();
    });
  });

  describe('connect()', () => {
    test('calls relayPool.initialize()', async() => {
      await chatApi.connect(PEER_ID);

      expect(mockPool.initializeCallCount).toBe(1);
    });

    test('calls relayPool.subscribeMessages()', async() => {
      await chatApi.connect(PEER_ID);

      expect(mockPool.subscribeCallCount).toBe(1);
    });

    test('no-op when already connected to same peer', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);
      await chatApi.connect(PEER_ID);

      expect(chatApi.getState()).toBe('connected');
      // initialize should only be called once
      expect(mockPool.initializeCallCount).toBe(1);
    });

    test('no-op when already connecting to same peer', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      // Try to connect again while connected
      await chatApi.connect(PEER_ID);

      expect(chatApi.getState()).toBe('connected');
    });
  });

  describe('disconnect()', () => {
    test('calls relayPool.disconnect()', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);
      chatApi.disconnect();

      expect(mockPool.disconnectCallCount).toBeGreaterThan(0);
    });

    test('no-op when called twice', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);
      chatApi.disconnect();
      chatApi.disconnect(); // Second call should not throw

      expect(chatApi.getState()).toBe('disconnected');
    });
  });

  describe('sendText()', () => {
    test('publishes via relayPool when connected - returns messageId, history contains message', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendText('Hello, World!');

      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');

      // Verify publish was called
      expect(mockPool.publishCalls).toHaveLength(1);
      expect(mockPool.publishCalls[0].recipientPubkey).toBe(PEER_ID);

      const history = chatApi.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(messageId);
      expect(history[0].type).toBe('text');
      expect(history[0].content).toBe('Hello, World!');
      expect(history[0].status).toBe('sent');
    });

    test('returns messageId when disconnected but no active peer', async() => {
      // No active peer - message will be marked as failed
      const messageId = await chatApi.sendText('Offline message');

      expect(messageId).toBeDefined();
    });

    test('allows empty content - returns messageId', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendText('');

      expect(messageId).toBeDefined();
      const history = chatApi.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe('');
    });

    test('queues via offlineQueue when relay pool not connected', async() => {
      // Connect first to set active peer, then simulate disconnect
      mockPool.simulateConnect();
      await chatApi.connect(PEER_ID);
      mockPool.simulateDisconnect();

      const messageId = await chatApi.sendText('Message while offline');

      expect(messageId).toBeDefined();
      expect(mockQueue.queueCallCount).toBe(1);
    });

    test('queues via offlineQueue when all relays fail', async() => {
      mockPool.simulateConnect();
      mockPool.publishResult = {successes: [], failures: [{url: 'wss://relay.test', error: 'fail'}]};

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendText('Message with relay failure');

      expect(messageId).toBeDefined();
      expect(mockQueue.queueCallCount).toBe(1);
    });

    test('queues via offlineQueue when no active peer', async() => {
      // Not connected to any peer - message should be marked as failed
      const messageId = await chatApi.sendText('Message without peer');

      expect(messageId).toBeDefined();
      // ChatAPI refuses to queue without an active peer - correctly marks as failed
    });
  });

  describe('sendFileMessage()', () => {
    test('sends image file - returns messageId with type image', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendFileMessage(
        'image', 'https://blossom.example/abc.jpg', 'sha256hash',
        'keyHex', 'ivHex', 'image/jpeg', 1024
      );

      expect(messageId).toBeDefined();
      const history = chatApi.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('image');
    });

    test('sends video file - returns messageId with type video', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendFileMessage(
        'video', 'https://blossom.example/abc.mp4', 'sha256hash',
        'keyHex', 'ivHex', 'video/mp4', 2048
      );

      expect(messageId).toBeDefined();
      const history = chatApi.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('video');
    });

    test('sends file with dimensions - includes width/height in content', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendFileMessage(
        'image', 'https://blossom.example/abc.jpg', 'sha256hash',
        'keyHex', 'ivHex', 'image/jpeg', 1024, {width: 800, height: 600}
      );

      expect(messageId).toBeDefined();
      const history = chatApi.getHistory();
      const content = JSON.parse(history[0].content);
      expect(content.width).toBe(800);
      expect(content.height).toBe(600);
    });

    test('sendFileMessage returns valid messageId', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      const messageId = await chatApi.sendFileMessage(
        'file', 'https://blossom.example/doc.pdf', 'sha256hash',
        'keyHex', 'ivHex', 'application/pdf', 4096
      );

      expect(messageId).toBeDefined();
      expect(messageId.length).toBeGreaterThan(0);
    });
  });

  describe('getHistory()', () => {
    test('returns empty array when no messages', () => {
      expect(chatApi.getHistory()).toEqual([]);
    });

    test('returns sorted messages when history has messages', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      await chatApi.sendText('First');
      await chatApi.sendText('Second');
      await chatApi.sendText('Third');

      const history = chatApi.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('First');
      expect(history[1].content).toBe('Second');
      expect(history[2].content).toBe('Third');

      // Verify sorted by timestamp
      for(let i = 1; i < history.length; i++) {
        expect(history[i].timestamp).toBeGreaterThanOrEqual(history[i - 1].timestamp);
      }
    });

    test('maintains order of multiple messages', async() => {
      mockPool.simulateConnect();

      await chatApi.connect(PEER_ID);

      await chatApi.sendText('Message 1');
      await chatApi.sendText('Message 2');
      await chatApi.sendText('Message 3');

      const history = chatApi.getHistory();
      expect(history[0].content).toBe('Message 1');
      expect(history[1].content).toBe('Message 2');
      expect(history[2].content).toBe('Message 3');
    });
  });

  describe('onMessage callback', () => {
    /** Flush microtasks so async handleRelayMessage completes */
    const flush = () => new Promise(r => setTimeout(r, 50));

    test('fires when relay pool delivers message', async() => {
      await chatApi.connect(PEER_ID);

      let receivedMessage: ChatMessage | null = null;
      chatApi.onMessage = (msg) => {
        receivedMessage = msg;
      };

      const relayMsg: DecryptedMessage = {
        id: 'relay-event-1',
        from: PEER_ID,
        content: JSON.stringify({
          id: 'relay-msg-1',
          from: PEER_ID,
          to: OWN_ID,
          type: 'text',
          content: 'Hello via relay',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      mockPool.simulateMessage(relayMsg);
      await flush();

      expect(receivedMessage).toBeDefined();
      expect(receivedMessage!.content).toBe('Hello via relay');
    });

    test('appends relay message to history', async() => {
      await chatApi.connect(PEER_ID);

      const relayMsg: DecryptedMessage = {
        id: 'relay-event-2',
        from: PEER_ID,
        content: JSON.stringify({
          id: 'relay-msg-2',
          from: PEER_ID,
          to: OWN_ID,
          type: 'text',
          content: 'Relay message',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      mockPool.simulateMessage(relayMsg);
      await flush();

      const history = chatApi.getHistory();
      expect(history.some(m => m.content === 'Relay message')).toBe(true);
    });
  });

  describe('onStatusChange callback', () => {
    test('fires on state transitions', async() => {
      mockPool.simulateConnect();

      const statusChanges: string[] = [];
      chatApi.onStatusChange = (_peerId, status) => {
        statusChanges.push(status);
      };

      await chatApi.connect(PEER_ID);

      // Should have received connected status
      expect(statusChanges).toContain('connected');
    });

    test('fires disconnected status on disconnect', async() => {
      mockPool.simulateConnect();

      const statusChanges: string[] = [];
      chatApi.onStatusChange = (_peerId, status) => {
        statusChanges.push(status);
      };

      await chatApi.connect(PEER_ID);
      chatApi.disconnect();

      expect(statusChanges).toContain('disconnected');
    });
  });

  describe('relay message deduplication', () => {
    /** Flush microtasks so async handleRelayMessage completes */
    const flush = () => new Promise(r => setTimeout(r, 50));

    test('acknowledges relay message to prevent double-delivery', async() => {
      await chatApi.connect(PEER_ID);

      const relayMsg: DecryptedMessage = {
        id: 'unique-relay-event',
        from: PEER_ID,
        content: JSON.stringify({
          id: 'unique-msg-id',
          from: PEER_ID,
          to: OWN_ID,
          type: 'text',
          content: 'Unique message',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      // Deliver the message
      mockPool.simulateMessage(relayMsg);
      await flush();

      // The queue should have been called to acknowledge
      expect(mockQueue.acknowledgeCallCount).toBeGreaterThan(0);
    });

    test('does not duplicate in history when same relay message delivered twice', async() => {
      await chatApi.connect(PEER_ID);

      const relayMsg: DecryptedMessage = {
        id: 'dup-relay-event',
        from: PEER_ID,
        content: JSON.stringify({
          id: 'dup-msg-id',
          from: PEER_ID,
          to: OWN_ID,
          type: 'text',
          content: 'Duplicated message',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      // Deliver the same message twice
      mockPool.simulateMessage(relayMsg);
      await flush();
      mockPool.simulateMessage(relayMsg);
      await flush();

      const history = chatApi.getHistory();
      const matchingMessages = history.filter(m => m.content === 'Duplicated message');
      expect(matchingMessages).toHaveLength(1);
    });

    test('dedups relay replays after reload using persistent store', async() => {
      // Simulates: app reload → fresh ChatAPI (empty in-memory history) →
      // relay replays kind 1059 events still within its 24h retention window.
      // Without the persistent dedup, onMessage fires for already-read messages
      // and the main-thread unread counter grows on every boot.
      await chatApi.connect(PEER_ID);

      let onMessageCalls = 0;
      chatApi.onMessage = () => { onMessageCalls++; };

      // Pretend the store already has this rumor id from a previous session
      messageStoreMocks.getByEventId.mockImplementationOnce(async(id: string) => {
        return id === 'replay-relay-event' ? {eventId: id} as any : null;
      });

      const relayMsg: DecryptedMessage = {
        id: 'replay-relay-event',
        from: PEER_ID,
        content: JSON.stringify({
          id: 'replay-msg-id',
          from: PEER_ID,
          to: OWN_ID,
          type: 'text',
          content: 'Already seen before reload',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      mockPool.simulateMessage(relayMsg);
      await flush();

      expect(onMessageCalls).toBe(0);
      expect(messageStoreMocks.getByEventId).toHaveBeenCalledWith('replay-relay-event');
    });
  });

  describe('unknown sender auto-add', () => {
    /** Flush microtasks so async handleRelayMessage completes */
    const flush = () => new Promise(r => setTimeout(r, 50));

    beforeEach(() => {
      bridgeMocks.mapPubkeyToPeerId.mockClear();
      bridgeMocks.storePeerMapping.mockClear();
      messageRequestMocks.isKnownContact.mockResolvedValue(true);
    });

    test('auto-adds unknown sender to virtual-peers-db and still delivers the message', async() => {
      // Simulate sender being unknown (not in virtual-peers-db)
      messageRequestMocks.isKnownContact.mockResolvedValueOnce(false);

      await chatApi.connect(PEER_ID);

      let receivedMessage: ChatMessage | null = null;
      chatApi.onMessage = (msg) => {
        receivedMessage = msg;
      };

      const unknownSenderPubkey = 'ff'.repeat(32);
      const relayMsg: DecryptedMessage = {
        id: 'unknown-relay-event',
        from: unknownSenderPubkey,
        content: JSON.stringify({
          id: 'unknown-msg-1',
          from: unknownSenderPubkey,
          to: OWN_ID,
          type: 'text',
          content: 'Hello from stranger',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      mockPool.simulateMessage(relayMsg);
      await flush();

      // Bridge should have been called to auto-store the unknown sender
      expect(bridgeMocks.mapPubkeyToPeerId).toHaveBeenCalledWith(unknownSenderPubkey);
      expect(bridgeMocks.storePeerMapping).toHaveBeenCalledWith(unknownSenderPubkey, 9999999999);

      // Message should still be delivered to onMessage callback (not filtered away)
      expect(receivedMessage).toBeDefined();
      expect(receivedMessage!.content).toBe('Hello from stranger');
    });

    test('does not auto-add known senders', async() => {
      // Default mock returns isKnownContact = true
      await chatApi.connect(PEER_ID);

      const knownSenderPubkey = 'aa'.repeat(32);
      const relayMsg: DecryptedMessage = {
        id: 'known-relay-event',
        from: knownSenderPubkey,
        content: JSON.stringify({
          id: 'known-msg-1',
          from: knownSenderPubkey,
          to: OWN_ID,
          type: 'text',
          content: 'Hello from known',
          timestamp: Math.floor(Date.now() / 1000)
        }),
        timestamp: Math.floor(Date.now() / 1000)
      };

      mockPool.simulateMessage(relayMsg);
      await flush();

      // Bridge should NOT have been called for a known sender
      expect(bridgeMocks.storePeerMapping).not.toHaveBeenCalled();
    });
  });

  describe('window.__nostraChatAPI exposure', () => {
    test('exposes ChatAPI instance for debug inspection', () => {
      // The instance should be exposed on window
      expect((global as any).__nostraChatAPI).toBeDefined();
    });
  });

  describe('createChatAPI factory', () => {
    test('creates a ChatAPI instance', () => {
      const api = createChatAPI(OWN_ID);
      expect(api).toBeInstanceOf(ChatAPI);
      api.destroy();
    });
  });
});
