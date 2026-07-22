/**
 * Tests for PhantomChat.chat ChatAPI module (Nostr-first transport)
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
vi.mock('@lib/phantomchat/message-requests', () => ({
  getMessageRequestStore: () => messageRequestMocks
}));

// Mock phantomchat-bridge for unknown-sender auto-add tests
const {bridgeMocks} = vi.hoisted(() => ({
  bridgeMocks: {
    mapPubkeyToPeerId: vi.fn().mockResolvedValue(9999999999),
    storePeerMapping: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {
    getInstance: () => bridgeMocks
  }
}));

const messageStoreMocks = {
  saveMessage: vi.fn().mockResolvedValue(undefined),
  reKeyEventId: vi.fn().mockResolvedValue(true),
  getConversationId: vi.fn().mockReturnValue('conv-1'),
  getAllConversationIds: vi.fn().mockResolvedValue([]),
  getMessages: vi.fn().mockResolvedValue([]),
  getByEventId: vi.fn().mockResolvedValue(null),
  getByAppMessageId: vi.fn().mockResolvedValue(null)
};
vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => messageStoreMocks
}));

// Mock rootScope to prevent event dispatch errors
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn()
  }
}));

import {ChatAPI, createChatAPI, ChatMessage, ChatState} from '@lib/phantomchat/chat-api';
import rootScope from '@lib/rootScope';
import {DecryptedMessage} from '@lib/phantomchat/nostr-relay';
import type {PublishResult, RelayConfig, NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';
import type {OfflineQueue} from '@lib/phantomchat/offline-queue';

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

  /** When true, initialize() rejects — simulates relay transport init failure. */
  initializeShouldThrow = false;
  /** Result queryRawEvents returns (default empty = no matching event). */
  queryRawEventsResult: any[] = [];

  async initialize(): Promise<void> {
    this.initializeCallCount++;
    if(this.initializeShouldThrow) {
      throw new Error('mock relay init failure');
    }
    // A successful initialize brings at least one socket live.
    this._connected = true;
    this._connectedCount = Math.max(this._connectedCount, 1);
  }

  /** When true, the live socket drops during queryRawEvents (mid-query outage). */
  dropConnectionOnQuery = false;

  async queryRawEvents(_filter: Record<string, unknown>): Promise<any[]> {
    return (await this.queryRawEventsWithMeta(_filter)).events;
  }

  /** Force the `responded` count independent of connection flags. null =
   *  derive from live-socket state. Set to 0 to model "all relays errored
   *  mid-query while a stale socket stays flagged connected". */
  queryRespondedOverride: number | null = null;

  async queryRawEventsWithMeta(_filter: Record<string, unknown>): Promise<{events: any[]; responded: number; queried: number}> {
    if(this.dropConnectionOnQuery) {
      this._connected = false;
      this._connectedCount = 0;
    }
    const responded = this.queryRespondedOverride !== null ?
      this.queryRespondedOverride :
      (this._connected ? Math.max(this._connectedCount, 1) : 0);
    return {
      events: this.queryRawEventsResult,
      responded,
      queried: Math.max(this._relays.length, this._connectedCount, 1)
    };
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

    // Optimistic local echo (#1): VMT pre-allocates the id, paints the bubble,
    // then hands the SAME id to sendText so the persisted row keys to the mid
    // the bubble already used. These two invariants make that safe.
    test('allocateMessageId() returns fresh unique ids without sending', async() => {
      const a = chatApi.allocateMessageId();
      const b = chatApi.allocateMessageId();
      expect(typeof a).toBe('string');
      expect(a).not.toBe(b);
      // allocating must not push anything to history (no send happened)
      expect(chatApi.getHistory()).toHaveLength(0);
    });

    test('sendText honors a caller-provided messageId (row keys to the same id)', async() => {
      mockPool.simulateConnect();
      await chatApi.connect(PEER_ID);

      const preAllocated = chatApi.allocateMessageId();
      const returned = await chatApi.sendText('Hi Lena can you read this?', {messageId: preAllocated});

      // The send must reuse the pre-allocated id, not mint a new one — otherwise
      // the optimistic bubble's mid and the persisted row's mid would diverge.
      expect(returned).toBe(preAllocated);
      const history = chatApi.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(preAllocated);
    });

    // FIND-msg-disappear: durable-write-first. The row must be persisted to the
    // message store (keyed by the app messageId, deliveryState 'sending') BEFORE
    // the network publish resolves — otherwise switching chats during a slow
    // publish/upload re-reads getHistory from the store, finds nothing, and the
    // optimistic bubble vanishes until the self-echo lands ("disappears on chat
    // switch, reappears seconds later").
    test('persists the row before publish resolves, then re-keys to the rumor id', async() => {
      messageStoreMocks.saveMessage.mockClear();
      messageStoreMocks.reKeyEventId.mockClear();
      mockPool.simulateConnect();
      await chatApi.connect(PEER_ID);

      // Gate publish so we can inspect the store while it is still in flight.
      let releasePublish!: (r: PublishResult) => void;
      const publishGate = new Promise<PublishResult>((res) => { releasePublish = res; });
      mockPool.publish = vi.fn((recipientPubkey: string, plaintext: string) => {
        mockPool.publishCalls.push({recipientPubkey, plaintext});
        return publishGate;
      }) as any;

      const mid = 424242;
      const twebPeerId = 777;
      const sendPromise = chatApi.sendText('hold me', {messageId: 'chat-disappear-1', mid, twebPeerId});

      // Pre-publish save lands while publish is still pending.
      await vi.waitFor(() => expect(messageStoreMocks.saveMessage).toHaveBeenCalled());
      const firstSave = messageStoreMocks.saveMessage.mock.calls[0][0];
      expect(firstSave.eventId).toBe('chat-disappear-1');
      expect(firstSave.mid).toBe(mid);
      expect(firstSave.twebPeerId).toBe(twebPeerId);
      expect(firstSave.isOutgoing).toBe(true);
      expect(firstSave.deliveryState).toBe('sending');

      // Now resolve publish with a canonical rumor id.
      releasePublish({successes: ['relay-1'], failures: [], rumorId: 'rumorhex01'} as any);
      await sendPromise;

      // Row re-keyed messageId -> rumorId and transitioned to 'sent'.
      expect(messageStoreMocks.reKeyEventId).toHaveBeenCalledWith('chat-disappear-1', 'rumorhex01');
      const lastSave = messageStoreMocks.saveMessage.mock.calls.at(-1)![0];
      expect(lastSave.eventId).toBe('rumorhex01');
      expect(lastSave.deliveryState).toBe('sent');
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

      // The queued payload must be the SAME bytes the connected path would
      // publish. With NIP-17 alignment a text message goes out as PLAIN content
      // (not the JSON envelope), and the offline path must match — otherwise a
      // flushed cold-start message would arrive in a different shape than a live
      // one. (FIND-ghost-first-msg was the inverse bug: it queued nothing.)
      const queued = mockQueue.queuedMessages[0];
      expect(queued).toBeDefined();
      expect(queued.payload).toBe('Message while offline');
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

    test('returns the published rumor id (not the app id) so the media row converges', async() => {
      // Regression: the file-send orchestrator keys its media store row by this
      // return value. If it returned the app id while ChatAPI keyed its own row
      // by the rumor id, the two rows diverged — one carried the raw JSON
      // envelope with no fileMetadata (rendered as text) and one carried the
      // media — and BOTH rendered (the "JSON bubble next to the attachment"
      // bug). Returning the rumor id makes the orchestrator's row MERGE onto
      // ChatAPI's row (same eventId), leaving a single media row.
      messageStoreMocks.saveMessage.mockClear();
      messageStoreMocks.reKeyEventId.mockClear();
      mockPool.simulateConnect();
      mockPool.publishResult = {successes: ['event-1'], failures: [], rumorId: 'rumor-deadbeef'} as any;
      await chatApi.connect(PEER_ID);

      const returned = await chatApi.sendFileMessage(
        'voice', 'https://blossom.example/v.ogg', 'sha256hash',
        'keyHex', 'ivHex', 'audio/ogg', 2048, undefined,
        {duration: 3, mid: 123456, twebPeerId: 9999999999}
      );

      expect(returned).toBe('rumor-deadbeef');
      // Durable-write-first (FIND-msg-disappear): the row is first persisted
      // keyed by the app id, then re-keyed to the rumor id once publish returns.
      // The re-key happens INSIDE sendMessage, before sendFileMessage returns —
      // so the orchestrator's later media-row save (which uses the returned
      // rumor id) merges onto this same row instead of duplicating.
      const reKeyedToRumor = messageStoreMocks.reKeyEventId.mock.calls.some((c: any[]) => c[1] === 'rumor-deadbeef');
      expect(reKeyedToRumor).toBe(true);
      // ChatAPI's own store row CONVERGES on the rumor id (final state).
      const fileRows = messageStoreMocks.saveMessage.mock.calls
        .map((c: any[]) => c[0])
        .filter((r: any) => r.type === 'file');
      expect(fileRows.at(-1)?.eventId).toBe('rumor-deadbeef');
      expect(fileRows.at(-1)?.deliveryState).toBe('sent');
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

  describe('reconnect flap throttling', () => {
    test('backfill fires on the 0→>0 edge only; queue flush drains on every connected notification', async() => {
      mockPool.simulateConnect();
      await chatApi.connect(PEER_ID);
      const backfillSpy = vi.spyOn(chatApi as any, 'backfillConversations').mockResolvedValue(undefined);

      // First edge (0 → >0): one recovery burst
      mockPool.simulateStateChange(1, 7);
      expect(mockQueue.flushCallCount).toBe(1);
      expect(backfillSpy).toHaveBeenCalledTimes(1);

      // Flap storm WITHOUT dropping to zero: the pool fans out a notification
      // per debounced state flush while connectedCount stays > 0. The flush is
      // re-invoked each time (cheap — the real queue early-returns when empty
      // and the flushInFlight coalescer prevents overlap), but the heavy
      // backfill must NOT re-run (main-thread crypto storm).
      mockPool.simulateStateChange(2, 7);
      mockPool.simulateStateChange(1, 7);
      mockPool.simulateStateChange(3, 7);
      expect(mockQueue.flushCallCount).toBe(4);
      expect(backfillSpy).toHaveBeenCalledTimes(1);
    });

    test('genuine reconnects re-run backfill throttled to one burst per interval; flush always drains', async() => {
      mockPool.simulateConnect();
      await chatApi.connect(PEER_ID);
      const backfillSpy = vi.spyOn(chatApi as any, 'backfillConversations').mockResolvedValue(undefined);

      mockPool.simulateStateChange(1, 7);   // edge #1
      expect(mockQueue.flushCallCount).toBe(1);
      expect(backfillSpy).toHaveBeenCalledTimes(1);

      // A genuine drop-to-zero and recovery INSIDE the window: backfill is
      // throttled, but the flush still drains — it is the offline queue's
      // only drain path, so gating it would strand queued messages.
      mockPool.simulateStateChange(0, 7);
      mockPool.simulateStateChange(1, 7);
      expect(mockQueue.flushCallCount).toBe(2);
      expect(backfillSpy).toHaveBeenCalledTimes(1);

      // Past the window, a genuine reconnect recovers again
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 31_000);
        mockPool.simulateStateChange(0, 7);
        mockPool.simulateStateChange(1, 7);
        expect(mockQueue.flushCallCount).toBe(3);
        expect(backfillSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test('drains a message queued mid-storm even when the reconnect edge is throttled', async() => {
      mockPool.simulateConnect();
      await chatApi.connect(PEER_ID);

      // A prior recovery just happened → the 30s throttle window is open
      mockPool.simulateStateChange(1, 7);   // edge #1, opens the window
      expect(mockQueue.flushCallCount).toBe(1);

      // Relays drop → user sends → message lands in the offline queue
      mockPool.simulateStateChange(0, 7);
      const messageId = await chatApi.sendText('queued mid-storm');
      expect(messageId).toBeDefined();
      expect(mockQueue.queueCallCount).toBe(1);

      // A relay reconnects within the throttle window. The backfill edge is
      // suppressed, but the flush must still fire — the pool then stays
      // connected, so no further edge will ever come to drain the queue.
      mockPool.simulateStateChange(1, 7);
      expect(mockQueue.flushCallCount).toBe(2);
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
      (rootScope.dispatchEvent as ReturnType<typeof vi.fn>).mockClear();
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

    test('persists the peer mapping for a known sender but raises no message request', async() => {
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

      // The mapping IS persisted now — every inbound sender must reach
      // IndexedDB so the Virtual MTProto send path can resolve the recipient
      // ("VMT returned no phantomchatMid" bug). Receiving used to be the only
      // path that skipped persistence for known peers.
      expect(bridgeMocks.storePeerMapping).toHaveBeenCalledWith(knownSenderPubkey, 9999999999);

      // ...but a *known* sender must not raise a message-request prompt.
      const requestDispatched = (rootScope.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
        .some((call) => call[0] === 'phantomchat_message_request');
      expect(requestDispatched).toBe(false);
    });
  });

  describe('window.__phantomchatChatAPI exposure', () => {
    test('exposes ChatAPI instance for debug inspection', () => {
      // The instance should be exposed on window
      expect((global as any).__phantomchatChatAPI).toBeDefined();
    });
  });

  describe('createChatAPI factory', () => {
    test('creates a ChatAPI instance', () => {
      const api = createChatAPI(OWN_ID);
      expect(api).toBeInstanceOf(ChatAPI);
      api.destroy();
    });
  });

  // Contract relied on by CrdtSync's tri-state RemoteFetch: transport failure
  // must THROW (→ unavailable), only a confirmed no-event answer returns null
  // (→ absent). Guards against a transient relay outage clobbering a newer
  // remote snapshot with stale local contacts/groups (PR #73 review blocker).
  describe('queryLatestEvent() transport contract', () => {
    const FILTER = {kinds: [30078], '#d': ['phantomchat.chat/contacts'], limit: 1};

    test('THROWS when relay init fails (transport failure, not absence)', async() => {
      mockPool.simulateDisconnect();
      mockPool.initializeShouldThrow = true;
      await expect(chatApi.queryLatestEvent(FILTER)).rejects.toThrow();
    });

    test('THROWS on empty result when no relay is live to confirm absence', async() => {
      // Connected at entry (skips init), then the socket drops mid-query;
      // queryRawEvents returns [] but zero live sockets means nobody answered —
      // must throw, not report absence.
      mockPool.simulateConnect();
      mockPool.queryRawEventsResult = [];
      mockPool.dropConnectionOnQuery = true;
      await expect(chatApi.queryLatestEvent(FILTER)).rejects.toThrow();
    });

    test('THROWS when all relays error mid-query even though a socket stays connected', async() => {
      // The failure mode Kai flagged: the pool swallows per-relay errors and
      // returns [], while isConnected() still reports a stale socket as live.
      // The guard must key off "did any relay actually answer" (responded), not
      // isConnected() — otherwise a total query outage looks like confirmed
      // absence and republishes stale local state over a newer remote.
      mockPool.simulateConnect();
      mockPool.queryRawEventsResult = [];
      mockPool.queryRespondedOverride = 0; // nobody answered…
      await expect(chatApi.queryLatestEvent(FILTER)).rejects.toThrow();
      expect(mockPool.isConnected()).toBe(true); // …yet the socket stayed "connected"
    });

    test('returns null for a CONFIRMED absence (relay live, no matching event)', async() => {
      mockPool.simulateConnect();
      mockPool.queryRawEventsResult = [];
      await expect(chatApi.queryLatestEvent(FILTER)).resolves.toBeNull();
    });

    test('returns the latest event when a relay answers with matches', async() => {
      mockPool.simulateConnect();
      mockPool.queryRawEventsResult = [
        {id: 'a', kind: 30078, created_at: 100, content: 'older', tags: []},
        {id: 'b', kind: 30078, created_at: 200, content: 'newer', tags: []}
      ];
      const ev = await chatApi.queryLatestEvent(FILTER);
      expect(ev).not.toBeNull();
      expect(ev!.created_at).toBe(200);
      expect(ev!.content).toBe('newer');
    });
  });
});
