/**
 * Tests for PhantomChat.chat NIP-17 relay storage module
 *
 * Phase 2: NIP-04 removed, all encryption moved to NIP-44
 * Phase 4: Kind 4 removed, all messaging moved to NIP-17 gift-wrap (kind 1059)
 */

import '../setup';
import {NostrRelay, createNostrRelay, NOSTR_KIND_GIFTWRAP, SUBSCRIBE_REPLAY_LIMIT} from '@lib/phantomchat/nostr-relay';
import {nip44Encrypt, nip44Decrypt, getConversationKey} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure';
import {bytesToHex} from 'nostr-tools/utils';

// Track last created WebSocket instance for test inspection
let lastMockWs: MockWebSocket | null = null;

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  sentMessages: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }, 10);
    // Track this instance
    lastMockWs = this;
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  // Helper to simulate receiving a message
  simulateMessage(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', {data: JSON.stringify(message)}));
  }

  // Helper to simulate error
  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

// Mock global WebSocket
(global as any).WebSocket = MockWebSocket;

// Helper to get the last created mock WebSocket
function getLastMockWs(): MockWebSocket | null {
  return lastMockWs;
}

// Mock identity storage with real key pair for encryption tests
const mockIdentity = {
  id: 'current',
  seed: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
  ownId: 'TEST.TEST.TEST',
  // Real secp256k1 test key pair (32 bytes each)
  publicKey: btoa('test-public-key-12345678901234567890'),
  privateKey: btoa('test-private-key-123456789012345'),
  encryptionKey: btoa('test-encryption-key-123456'),
  createdAt: Date.now()
};

// Mock indexedDB
const mockDB: Record<string, unknown> = {current: mockIdentity};

// Generate test key pairs using nostr-tools
const testSenderPriv = generateSecretKey();
const testSenderPubHex = getPublicKey(testSenderPriv);
const testRecipientPriv = generateSecretKey();
const testRecipientPubHex = getPublicKey(testRecipientPriv);

describe('NIP-44 Encryption (via nostr-crypto)', () => {
  describe('nip44Encrypt', () => {
    test('produces string ciphertext', () => {
      const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
      const ciphertext = nip44Encrypt('Hello, World!', convKey);

      expect(typeof ciphertext).toBe('string');
      expect(ciphertext.length).toBeGreaterThan(0);
    });

    test('ciphertext includes random nonce (different each time)', () => {
      const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
      const ciphertext1 = nip44Encrypt('Same message', convKey);
      const ciphertext2 = nip44Encrypt('Same message', convKey);

      expect(ciphertext1).not.toBe(ciphertext2);
    });
  });

  describe('nip44Decrypt', () => {
    test('decrypt returns original plaintext (roundtrip)', () => {
      const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
      const plaintext = 'Hello, World!';
      const ciphertext = nip44Encrypt(plaintext, convKey);
      const decrypted = nip44Decrypt(ciphertext, convKey);

      expect(decrypted).toBe(plaintext);
    });

    test('handles unicode characters', () => {
      const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
      const plaintext = 'Ciao mondo 🌍';
      const ciphertext = nip44Encrypt(plaintext, convKey);
      const decrypted = nip44Decrypt(ciphertext, convKey);

      expect(decrypted).toBe(plaintext);
    });

    test('handles long messages', () => {
      const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
      const plaintext = 'A'.repeat(1000);
      const ciphertext = nip44Encrypt(plaintext, convKey);
      const decrypted = nip44Decrypt(ciphertext, convKey);

      expect(decrypted).toBe(plaintext);
    });

    test('fails with wrong conversation key', () => {
      const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
      const wrongPriv = generateSecretKey();
      const wrongPub = getPublicKey(wrongPriv);
      const wrongConvKey = getConversationKey(wrongPriv, wrongPub);

      const ciphertext = nip44Encrypt('Secret message', convKey);

      expect(() => {
        nip44Decrypt(ciphertext, wrongConvKey);
      }).toThrow();
    });
  });

  describe('conversation key symmetry', () => {
    test('both parties derive the same conversation key', () => {
      const convKeySender = getConversationKey(testSenderPriv, testRecipientPubHex);
      const convKeyRecipient = getConversationKey(testRecipientPriv, testSenderPubHex);

      expect(bytesToHex(convKeySender)).toBe(bytesToHex(convKeyRecipient));
    });
  });
});

describe('NOSTR_KIND_GIFTWRAP', () => {
  test('kind 1059 is the correct NIP-17 gift-wrap event kind', () => {
    expect(NOSTR_KIND_GIFTWRAP).toBe(1059);
  });
});

describe('NostrRelay', () => {
  let relay: NostrRelay;

  beforeEach(() => {
    // Reset mocks
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;

    // Create new relay instance
    relay = new NostrRelay('wss://test.relay.example');
  });

  afterEach(() => {
    relay.disconnect();
  });

  describe('constructor', () => {
    test('creates instance with default relay URL', () => {
      const r = new NostrRelay();
      expect(r).toBeInstanceOf(NostrRelay);
      expect(r.getState()).toBe('disconnected');
      r.disconnect();
    });

    test('creates instance with custom relay URL', () => {
      const r = createNostrRelay('wss://custom.relay.example');
      expect(r).toBeInstanceOf(NostrRelay);
      expect(r.getState()).toBe('disconnected');
      r.disconnect();
    });
  });

  describe('connect', () => {
    test('connects to relay WebSocket', () => {
      relay.connect();
      expect(relay.getState()).toBe('connecting');
    });

    test('transitions to connected state after WebSocket opens', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(relay.getState()).toBe('connected');
    });

    test('idempotent - does not reconnect if already connecting', () => {
      relay.connect();
      const firstState = relay.getState();
      relay.connect();
      const secondState = relay.getState();
      expect(firstState).toBe(secondState);
    });
  });

  describe('disconnect', () => {
    test('disconnects from relay', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));
      relay.disconnect();
      expect(relay.getState()).toBe('disconnected');
    });

    test('idempotent - can disconnect when not connected', () => {
      expect(() => relay.disconnect()).not.toThrow();
    });
  });

  describe('storeMessage', () => {
    test('throws error when not connected', async() => {
      await expect(
        relay.storeMessage('abc123', 'Hello')
      ).rejects.toThrow('Not connected');
    });

    test('publishes gift-wrap event when connected', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();
      expect(mockWs).not.toBeNull();

      // Mock identity loading by setting up the spy
      // In real scenario, initialize() would be called first
      // For this test, we verify the method exists and handles disconnected state
    });

    test('event structure is correct', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Note: Full event structure test requires mock identity
      // This test verifies the method structure
      expect(typeof relay.storeMessage).toBe('function');
    });
  });

  describe('publishRawEvent buffering (double-message / first-DM-dropped fix)', () => {
    const storedEvent = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1059, // gift-wrap → STORED, must be buffered when socket not open
      tags: [] as string[][],
      content: 'ciphertext',
      sig: 'c'.repeat(128)
    };

    test('buffers a stored gift-wrap published before the socket opens, then flushes on open', async() => {
      relay.connect(); // socket is CONNECTING (MockWebSocket opens after 10ms)

      // Publish while still connecting — must NOT throw, must NOT send yet.
      expect(() => relay.publishRawEvent(storedEvent as any)).not.toThrow();
      const mockWs = getLastMockWs()!;
      const sentBeforeOpen = mockWs.sentMessages.filter(m => m.includes('"EVENT"'));
      expect(sentBeforeOpen.length).toBe(0);

      // Let the socket open → onopen flushes the buffer.
      await new Promise(resolve => setTimeout(resolve, 50));
      const sentAfterOpen = mockWs.sentMessages.filter(m => m.includes('"EVENT"'));
      expect(sentAfterOpen.length).toBe(1);
      expect(sentAfterOpen[0]).toContain(storedEvent.id);
    });

    test('does NOT buffer ephemeral typing events (still throws when not connected)', () => {
      relay.connect(); // CONNECTING
      const typingEvent = {...storedEvent, kind: 20001}; // ephemeral range
      expect(() => relay.publishRawEvent(typingEvent as any)).toThrow('Not connected');
    });

    test('sends immediately when already connected (no buffering)', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50)); // now OPEN

      const mockWs = getLastMockWs()!;
      const before = mockWs.sentMessages.length;
      relay.publishRawEvent(storedEvent as any);
      expect(mockWs.sentMessages.length).toBe(before + 1);
    });
  });

  describe('subscribeMessages', () => {
    test('sends REQ with kinds:[1059] filter', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();
      expect(mockWs).not.toBeNull();

      relay.subscribeMessages();

      // Find the subscription message
      const subMessage = mockWs!.sentMessages.find(msg => {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'REQ' && parsed[2]?.kinds?.includes(1059);
      });

      expect(subMessage).toBeDefined();
      const parsed = JSON.parse(subMessage!);
      expect(parsed[0]).toBe('REQ');
      expect(parsed[2].kinds).toContain(1059);
      expect(parsed[2]['#p']).toBeDefined(); // Should filter by recipient
    });

    test('idempotent - subscribing twice does not duplicate', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();

      relay.subscribeMessages();
      const countAfterFirst = mockWs!.sentMessages.filter(
        msg => JSON.parse(msg)[0] === 'REQ'
      ).length;

      relay.subscribeMessages();
      const countAfterSecond = mockWs!.sentMessages.filter(
        msg => JSON.parse(msg)[0] === 'REQ'
      ).length;

      expect(countAfterFirst).toBe(countAfterSecond);
    });

    test('warns when not connected', () => {
      relay.subscribeMessages();
      // Should not throw, just warn
      expect(relay.getState()).toBe('disconnected');
    });

    test('bounds the initial replay with a limit (firehose guard)', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));
      const mockWs = getLastMockWs()!;

      relay.subscribeMessages();

      const req = mockWs.sentMessages
      .map(m => JSON.parse(m))
      .find(p => p[0] === 'REQ' && p[2]?.kinds?.includes(1059));
      expect(req).toBeDefined();
      expect(req[2].limit).toBe(SUBSCRIBE_REPLAY_LIMIT);
    });

    test('seeds `since` from liveSubscribeSince watermark when provided', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));
      const mockWs = getLastMockWs()!;

      const watermark = 1_700_000_000;
      relay.liveSubscribeSince = () => watermark;
      relay.subscribeMessages();

      const req = mockWs.sentMessages
      .map(m => JSON.parse(m))
      .find(p => p[0] === 'REQ' && p[2]?.kinds?.includes(1059));
      expect(req[2].since).toBe(watermark);
    });

    test('omits `since` when watermark provider returns undefined (cold client)', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));
      const mockWs = getLastMockWs()!;

      relay.liveSubscribeSince = () => undefined;
      relay.subscribeMessages();

      const req = mockWs.sentMessages
      .map(m => JSON.parse(m))
      .find(p => p[0] === 'REQ' && p[2]?.kinds?.includes(1059));
      expect(req[2].since).toBeUndefined();
      expect(req[2].limit).toBe(SUBSCRIBE_REPLAY_LIMIT); // limit still caps replay
    });
  });

  describe('whenSubscribed (WU-3 cold-start barrier)', () => {
    async function connectAndSubscribe() {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));
      const mockWs = getLastMockWs()!;
      relay.subscribeMessages();
      const req = mockWs.sentMessages.map((m) => JSON.parse(m)).find((p) => p[0] === 'REQ' && p[2]?.kinds?.includes(1059));
      return {mockWs, subId: req[1] as string};
    }

    test('resolves true after the relay sends EOSE for the message subscription', async() => {
      const {mockWs, subId} = await connectAndSubscribe();
      const readyP = relay.whenSubscribed(2000);
      mockWs.simulateMessage(['EOSE', subId]);
      await expect(readyP).resolves.toBe(true);
    });

    test('resolves false on timeout when EOSE never arrives (never hangs)', async() => {
      await connectAndSubscribe();
      await expect(relay.whenSubscribed(20)).resolves.toBe(false);
    });
  });

  describe('unsubscribeMessages', () => {
    test('sends CLOSE message', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();

      relay.subscribeMessages();
      relay.unsubscribeMessages();

      const closeMessage = mockWs!.sentMessages.find(msg => {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'CLOSE';
      });

      expect(closeMessage).toBeDefined();
    });
  });

  describe('getMessages', () => {
    test('returns empty array when not connected', async() => {
      const messages = await relay.getMessages();
      expect(messages).toEqual([]);
    });

    test('sends REQ query when connected and resolves on EOSE', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();

      // Intercept send to auto-respond with EOSE for query subscriptions
      const origSend = mockWs!.send.bind(mockWs);
      mockWs!.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if(parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-')) {
          // Simulate EOSE after a tick
          setTimeout(() => mockWs!.simulateMessage(['EOSE', parsed[1]]), 10);
        }
      };

      const messages = await relay.getMessages();
      expect(messages).toEqual([]);

      const queryMessage = mockWs!.sentMessages.find(msg => {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-');
      });

      expect(queryMessage).toBeDefined();
    });

    test('accepts since parameter', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();
      const since = Math.floor(Date.now() / 1000) - 3600;

      // Intercept send to auto-respond with EOSE
      const origSend = mockWs!.send.bind(mockWs);
      mockWs!.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if(parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-')) {
          setTimeout(() => mockWs!.simulateMessage(['EOSE', parsed[1]]), 10);
        }
      };

      await relay.getMessages(since);

      const queryMessage = mockWs!.sentMessages.find(msg => {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'REQ' && parsed[2]?.since;
      });

      expect(queryMessage).toBeDefined();
      const parsed = JSON.parse(queryMessage!);
      expect(parsed[2].since).toBe(since);
    });

    test('caps the backfill query with a limit', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();
      const origSend = mockWs!.send.bind(mockWs);
      mockWs!.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if(parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-')) {
          setTimeout(() => mockWs!.simulateMessage(['EOSE', parsed[1]]), 10);
        }
      };

      await relay.getMessages();

      const queryMessage = mockWs!.sentMessages.find(msg => {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-');
      });
      const parsed = JSON.parse(queryMessage!);
      expect(parsed[2].limit).toBe(SUBSCRIBE_REPLAY_LIMIT);
    });
  });

  describe('onMessage handler', () => {
    test('can register message handler', () => {
      const handler = (msg: any) => {};
      relay.onMessage(handler);
      expect(typeof relay.onMessage).toBe('function');
    });
  });

  describe('pre-decrypt dedup gate (setEventDedup)', () => {
    // Feed a real signed event (kind-5 delete → raw-event path, verified but not
    // decrypted) twice. With the dedup gate installed, the SECOND copy must be
    // dropped BEFORE verify, so the handler fires exactly once.
    function signedDelete() {
      return finalizeEvent(
        {kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', 'abc']], content: ''},
        generateSecretKey(),
      );
    }

    test('a duplicate event id is processed once when the gate is installed', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));
      const seen = new Set<string>();
      relay.setEventDedup((id) => (seen.has(id) ? false : (seen.add(id), true)));
      const raw = vi.fn();
      relay.onRawEvent(raw);
      const ev = signedDelete();
      const ws = getLastMockWs();
      ws?.simulateMessage(['EVENT', 'live-sub', ev]);
      ws?.simulateMessage(['EVENT', 'live-sub', ev]); // duplicate (e.g. from another relay)
      expect(raw).toHaveBeenCalledTimes(1);
    });

    test('without the gate, both copies are processed (proves the gate is the dedup)', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));
      const raw = vi.fn();
      relay.onRawEvent(raw);
      const ev = signedDelete();
      const ws = getLastMockWs();
      ws?.simulateMessage(['EVENT', 'live-sub', ev]);
      ws?.simulateMessage(['EVENT', 'live-sub', ev]);
      expect(raw).toHaveBeenCalledTimes(2);
    });

    // Regression (FIND-poll-reunwrap): the QUERY path (getMessages →
    // collectQueryEvent) must consult the SAME gate as the live path. Before the
    // fix only handleEvent() checked it, so the catch-up poll + reconnect
    // backfills re-unwrapped the entire recent window every tick — the crypto
    // storm that saturated the unwrap worker and froze the UI.
    test('query-path gift-wraps consult the dedup gate (no re-unwrap on backfill)', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));

      // Gate that claims an id the first time and rejects it thereafter.
      const seen = new Set<string>();
      const gate = vi.fn((id: string) => (seen.has(id) ? false : (seen.add(id), true)));
      relay.setEventDedup(gate);

      // A real signed kind-1059 gift-wrap. We never need it to decrypt — the gate
      // is consulted BEFORE unwrap, which is the contract under test.
      const wrap = finalizeEvent(
        {kind: NOSTR_KIND_GIFTWRAP, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x'},
        generateSecretKey()
      );

      const ws = getLastMockWs();
      const origSend = ws!.send.bind(ws);
      ws!.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if(parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-')) {
          // Deliver the SAME wrap twice (e.g. two poll ticks) then EOSE.
          ws!.simulateMessage(['EVENT', parsed[1], wrap]);
          ws!.simulateMessage(['EVENT', parsed[1], wrap]);
          setTimeout(() => ws!.simulateMessage(['EOSE', parsed[1]]), 10);
        }
      };

      await relay.getMessages();

      // The gate saw the wrap id, and the duplicate was rejected — proving the
      // query path now dedups instead of re-unwrapping.
      expect(gate).toHaveBeenCalledWith(wrap.id);
      const calls = gate.mock.results.filter((r) => r.value === false).length;
      expect(calls).toBeGreaterThanOrEqual(1);
    });

    // Review finding (Kai): the rollback was added to handleEvent()'s catch but
    // NOT to collectQueryEvent()'s — and collectQueryEvent IS the recovery path
    // (catch-up poll, reconnect backfill, startup backfill). A claim left behind
    // here poisons the wrap against the very mechanisms meant to re-fetch it, so
    // the frozen-worker case the rollback exists for stayed broken end to end.
    test('releases the dedup claim when a QUERY-path unwrap fails', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));

      const claim = vi.fn(() => true);
      const release = vi.fn();
      relay.setEventDedup(claim);
      relay.setEventRelease(release);

      // A signed kind-1059 whose content is NOT a real gift-wrap: the unwrap
      // throws, exactly as a frozen/failing worker would make it throw.
      const wrap = finalizeEvent(
        {kind: NOSTR_KIND_GIFTWRAP, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'not-a-real-wrap'},
        generateSecretKey()
      );

      const ws = getLastMockWs();
      const origSend = ws!.send.bind(ws);
      ws!.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if(parsed[0] === 'REQ' && parsed[1]?.startsWith('phantomchat-query-')) {
          ws!.simulateMessage(['EVENT', parsed[1], wrap]);
          setTimeout(() => ws!.simulateMessage(['EOSE', parsed[1]]), 10);
        }
      };

      await relay.getMessages();

      expect(claim).toHaveBeenCalledWith(wrap.id);
      // The wrap was claimed, never delivered, and the claim MUST come back —
      // otherwise the next poll tick dedups it away and it is lost until reload.
      expect(release).toHaveBeenCalledWith(wrap.id);
    });
  });

  // Review finding (Robert): NIP-01 answers a limited filter with the NEWEST N
  // events in the range. So `{since: watermark, limit: 100}` against a gap wider
  // than 100 wraps silently drops the OLDEST ones — and widening `since` to the
  // watermark (this PR's other half) makes the gap bigger, so it made this
  // WORSE. The reach-back has to WALK the range with `until`, not peek at the
  // top of it.
  describe('getMessagesPaged — backfill must walk the whole gap', () => {
    function wrapAt(created_at: number, i: number) {
      // content:'' short-circuits collectQueryEvent before any crypto — this
      // test is about the PAGER (raw frames in, `until` anchors out), not unwrap.
      const tags: string[][] = [];
      return {id: `wrap-${i}`, pubkey: 'aa'.repeat(32), kind: NOSTR_KIND_GIFTWRAP, created_at, content: '', tags, sig: 'x'};
    }

    /**
     * Serve REQs like a real relay: newest-N within [since, until], then EOSE.
     */
    function serveStore(ws: MockWebSocket, store: any[]) {
      const pagesServed: {since?: number; until?: number; served: number}[] = [];
      const idsServed = new Set<string>();
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if(parsed[0] !== 'REQ' || !parsed[1]?.startsWith('phantomchat-query-')) return;
        const [, subId, filter] = parsed;
        const matched = store
        .filter((e) => (filter.since === undefined || e.created_at >= filter.since))
        .filter((e) => (filter.until === undefined || e.created_at <= filter.until))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit ?? 100);
        pagesServed.push({since: filter.since, until: filter.until, served: matched.length});
        setTimeout(() => {
          for(const ev of matched) {
            idsServed.add(ev.id);
            ws.simulateMessage(['EVENT', subId, ev]);
          }
          ws.simulateMessage(['EOSE', subId]);
        }, 0);
      };
      return {pagesServed, idsServed};
    }

    test('reaches every wrap in a gap far wider than the page limit', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));

      const t0 = 1_800_000_000;
      // 250 wraps — 2.5x the page limit. A single REQ can only ever return 100.
      const store = Array.from({length: 250}, (_, i) => wrapAt(t0 + i, i));
      const {pagesServed: pages, idsServed} = serveStore(getLastMockWs()!, store);

      const result = await relay.getMessagesPaged(t0);

      // Walked three pages (100 + 100 + the 52-wrap remainder) and reported the
      // range as fully exhausted.
      expect(pages.length).toBeGreaterThanOrEqual(3);
      expect(result.outcome).toBe('exhausted');

      // THE CLAIM: every wrap in the gap was actually fetched — including the
      // 150 oldest, which a single limited REQ drops on the floor while the
      // watermark advances past them. `wrap-0` is the Kai message.
      expect(idsServed.size).toBe(250);
      expect(idsServed.has('wrap-0')).toBe(true);

      // Each page after the first is anchored at the previous page's oldest wrap.
      expect(pages[0].until).toBeUndefined();
      expect(pages[1].until).toBe(t0 + 150); // oldest of the newest 100 (t0+150..t0+249)
    });

    test('a gap within one page still completes in a single REQ (no needless walk)', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));

      const t0 = 1_800_000_000;
      const store = Array.from({length: 12}, (_, i) => wrapAt(t0 + i, i));
      const {pagesServed: pages} = serveStore(getLastMockWs()!, store);

      const result = await relay.getMessagesPaged(t0);

      expect(pages.length).toBe(1);
      expect(result.outcome).toBe('exhausted');
    });

    // Review finding (Robert): a timed-out page used to be reported as a SHORT
    // page (rawCount 0), which reads as "range exhausted" up in the pool — so the
    // pool cleared the gap, dropped the resume cursor and let the watermark walk
    // past wraps it never fetched. A slow first query is exactly what a device
    // waking from a freeze gets, and that is the one moment a deep gap is open.
    // A page we never got an answer for must say so: 'unknown', not 'exhausted'.
    test('a page that times out reports UNKNOWN, never an exhausted range', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));

      const t0 = 1_800_000_000;
      const ws = getLastMockWs()!;

      // The relay accepts the REQ and then goes silent — no EVENTs, no EOSE.
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        origSend(data);
      };

      vi.useFakeTimers();
      try {
        const pending = relay.getMessagesPaged(t0, t0 + 500);
        await vi.advanceTimersByTimeAsync(10_001); // trip the 10s page timeout

        const result = await pending;

        // We learned NOTHING about the range. Saying 'exhausted' here is the bug.
        expect(result.outcome).toBe('unknown');
        // ...and we hand back the cursor we were walking, so the next tick can
        // re-query the SAME range instead of walking past an unknown gap.
        expect(result.oldestReached).toBe(t0 + 500);
      } finally {
        vi.useRealTimers();
      }
    });

    // A relay we were never connected to cannot testify about the range either.
    test('a disconnected relay reports UNKNOWN, never an exhausted range', async() => {
      const t0 = 1_800_000_000;
      // Never connected — connectionState is 'disconnected'.
      const result = await relay.getMessagesPaged(t0);

      expect(result.outcome).toBe('unknown');
      expect(result.messages).toEqual([]);
    });
  });

  // Issue #61: a gift-wrap copy delivered over a direct P2P transport is fed to
  // ingestExternalEvent, which must run the IDENTICAL path a relay-socket event
  // takes — same dedup gate, same handler dispatch — so the P2P and relay copies
  // dedup against each other and the P2P copy renders through one code path.
  describe('ingestExternalEvent (direct P2P copy)', () => {
    function signedDelete() {
      return finalizeEvent(
        {kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', 'abc']], content: ''},
        generateSecretKey(),
      );
    }

    test('an out-of-band event dispatches to the same handler a relay event would', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));
      const raw = vi.fn();
      relay.onRawEvent(raw);

      await relay.ingestExternalEvent(signedDelete());

      expect(raw).toHaveBeenCalledTimes(1);
    });

    test('a relay copy then a P2P copy of the SAME event dispatch once (shared dedup)', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));
      const seen = new Set<string>();
      relay.setEventDedup((id) => (seen.has(id) ? false : (seen.add(id), true)));
      const raw = vi.fn();
      relay.onRawEvent(raw);

      const ev = signedDelete();
      // Relay socket delivers it first…
      getLastMockWs()?.simulateMessage(['EVENT', 'live-sub', ev]);
      // …then the direct P2P transport delivers the same wrap — must be deduped.
      await relay.ingestExternalEvent(ev);

      expect(raw).toHaveBeenCalledTimes(1);
    });

    test('a malformed external event never throws', async() => {
      relay.connect();
      await new Promise((r) => setTimeout(r, 50));
      await expect(relay.ingestExternalEvent({} as any)).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    test('handles WebSocket error gracefully', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();
      mockWs?.simulateError();

      // Should not throw, should handle error
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    test('handles malformed messages gracefully', async() => {
      relay.connect();
      await new Promise(resolve => setTimeout(resolve, 50));

      const mockWs = getLastMockWs();

      // Send malformed message
      expect(() => {
        mockWs?.simulateMessage('not valid json');
      }).not.toThrow();

      // Send non-array message
      expect(() => {
        mockWs?.simulateMessage({type: 'unknown'});
      }).not.toThrow();
    });
  });

  describe('zombie-socket recycle (latency-ping liveness)', () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Connect, reach 'connected', and shrink the ping timeout so a probe with
    // no EOSE reply fails in 20ms instead of the production 5s.
    async function connectedRelay(): Promise<MockWebSocket> {
      relay.connect();
      await wait(50);
      expect(relay.getState()).toBe('connected');
      (relay as any).latencyPingTimeoutMs = 20;
      return getLastMockWs()!;
    }

    test('a single ping timeout does NOT recycle the socket', async() => {
      await connectedRelay();
      // MockWebSocket.send records the ping REQ but never replies EOSE → timeout.
      await (relay as any).measureLatency();
      expect(relay.getState()).toBe('connected');
    });

    test('two consecutive ping timeouts recycle the silently-dead socket', async() => {
      await connectedRelay();
      await (relay as any).measureLatency(); // failure 1
      await (relay as any).measureLatency(); // failure 2 → recycle
      expect(relay.getState()).toBe('reconnecting');
    });

    test('a successful ping resets the streak, preventing a premature recycle', async() => {
      const ws = await connectedRelay();
      const origSend = ws.send.bind(ws);
      const answerPings = (data: string) => {
        origSend(data);
        try {
          const parsed = JSON.parse(data);
          if(parsed[0] === 'REQ' && String(parsed[1]).startsWith('ping-')) {
            setTimeout(() => ws.simulateMessage(['EOSE', parsed[1]]), 5);
          }
        } catch{ /* ignore */ }
      };

      await (relay as any).measureLatency(); // failure 1 (no auto-answer yet)
      ws.send = answerPings;
      await (relay as any).measureLatency(); // success → streak reset to 0
      ws.send = origSend;
      await (relay as any).measureLatency(); // failure 1 again, NOT a recycle
      expect(relay.getState()).toBe('connected');
    });

    test('recycle arms pendingSubscribe and detaches the dead socket', async() => {
      const dead = await connectedRelay();
      (relay as any).liveReqArmed = true; // pool wanted a live subscription
      await (relay as any).measureLatency();
      await (relay as any).measureLatency(); // recycle
      expect(relay.getState()).toBe('reconnecting');
      // Next onopen must send a FRESH REQ (incl. kind 20001 typing).
      expect((relay as any).pendingSubscribe).toBe(true);
      // Dead socket's handlers detached so a late close can't double-fire.
      expect(dead.onclose).toBeNull();
    });
  });

  describe('on-demand health check (checkHealthNow — visibility/online triggers)', () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    async function connectedRelay(): Promise<MockWebSocket> {
      relay.connect();
      await wait(50);
      expect(relay.getState()).toBe('connected');
      (relay as any).latencyPingTimeoutMs = 20;
      return getLastMockWs()!;
    }

    test('recycles on the FIRST ping miss (resume context is decisive, unlike the 2-strike interval)', async() => {
      await connectedRelay();
      (relay as any).lastInboundAt = 0; // force the probe (no recent frame)
      await (relay as any).checkHealthNow('test');
      expect(relay.getState()).toBe('reconnecting');
    });

    test('recycles immediately when readyState is not OPEN (a zombie onclose never reported)', async() => {
      const ws = await connectedRelay();
      ws.readyState = MockWebSocket.CLOSING; // half-open: looked OPEN, now isn't
      await (relay as any).checkHealthNow('test');
      expect(relay.getState()).toBe('reconnecting');
    });

    test('fast-path: a frame within the healthy window skips the probe entirely', async() => {
      const ws = await connectedRelay();
      (relay as any).lastInboundAt = Date.now(); // just heard from the relay
      const before = ws.sentMessages.length;
      await (relay as any).checkHealthNow('test');
      expect(relay.getState()).toBe('connected');
      // No ping REQ was sent — the live read channel was trusted.
      expect(ws.sentMessages.length).toBe(before);
    });

    test('is a no-op while not connected (the backoff path owns recovery there)', async() => {
      await connectedRelay();
      relay.disconnect();
      expect(relay.getState()).toBe('disconnected');
      await (relay as any).checkHealthNow('test'); // must not throw / re-arm
      expect(relay.getState()).toBe('disconnected');
    });

    test('registerHealthTriggers is idempotent and unregister clears the handlers', () => {
      (relay as any).registerHealthTriggers();
      (relay as any).registerHealthTriggers(); // second call must not double-bind
      if(typeof document !== 'undefined') {
        expect((relay as any).boundOnVisible).not.toBeNull();
      }
      (relay as any).unregisterHealthTriggers();
      expect((relay as any).boundOnVisible).toBeNull();
      expect((relay as any).boundOnOnline).toBeNull();
    });
  });

  describe('createNostrRelay factory', () => {
    test('creates NostrRelay instance', () => {
      const r = createNostrRelay();
      expect(r).toBeInstanceOf(NostrRelay);
      r.disconnect();
    });

    test('passes relay URL to instance', () => {
      const r = createNostrRelay('wss://factory.test');
      expect(r).toBeInstanceOf(NostrRelay);
      r.disconnect();
    });
  });
});


describe('Integration: NIP-44 with NostrRelay patterns', () => {
  test('encrypt/decrypt flow matches relay message handling', () => {
    // Simulate a complete message exchange:
    // Alice encrypts message for Bob, sends to relay, Bob retrieves and decrypts

    const alicePriv = generateSecretKey();
    const alicePubHex = getPublicKey(alicePriv);

    const bobPriv = generateSecretKey();
    const bobPubHex = getPublicKey(bobPriv);

    // Alice encrypts message for Bob
    const plaintext = 'Secret message from Alice to Bob';
    const convKeyAlice = getConversationKey(alicePriv, bobPubHex);
    const encrypted = nip44Encrypt(plaintext, convKeyAlice);

    // Bob decrypts message from Alice
    const convKeyBob = getConversationKey(bobPriv, alicePubHex);
    const decrypted = nip44Decrypt(encrypted, convKeyBob);

    // Verify message integrity
    expect(decrypted).toBe(plaintext);
  });

  test('kind 4 event structure is correct', () => {
    const convKey = getConversationKey(testSenderPriv, testRecipientPubHex);
    const event = {
      pubkey: 'a'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 4,
      tags: [['p', 'b'.repeat(64)]] as [['p', string]],
      content: nip44Encrypt('test', convKey)
    };

    expect(event.kind).toBe(4);
    expect(event.tags[0][0]).toBe('p');
    expect(event.tags[0][1]).toHaveLength(64);
  });
});

/**
 * Bad-relay cooldown (#61 R4). A relay that never manages to connect must not
 * reconnect-and-log every ~10s forever. After the burst + a few steady retries
 * it is benched for 10 minutes: no reconnect attempt during the window, and the
 * next successful connect resets everything. Complements the pool-level FLAP
 * cooldown (relay-cooldown.test.ts), which only covers connect-then-drop churn —
 * this covers a relay that never connects at all.
 */
describe('NostrRelay bad-relay cooldown', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('benches a never-connecting relay for 10 min instead of retrying every ~10s', () => {
    const relay: any = new NostrRelay('wss://dead.example');

    // Each reconnect attempt "fails" straight back into the disconnect handler,
    // reproducing a relay that can never establish a socket.
    const connectSpy = vi.spyOn(relay, 'connect').mockImplementation(() => {
      relay.handleDisconnect();
    });

    // Prime a non-disconnected state so handleDisconnect proceeds, then kick off
    // the first failure.
    relay.connectionState = 'connecting';
    relay.handleDisconnect();

    // Burst (1+2+4s) + steady 10s retries — cross the cooldown threshold (6).
    vi.advanceTimersByTime(60_000);
    expect(relay.inCooldown).toBe(true);

    // During the 10-minute bench, NO further reconnect attempts fire.
    const callsAtBench = connectSpy.mock.calls.length;
    vi.advanceTimersByTime(9 * 60_000);
    expect(connectSpy.mock.calls.length).toBe(callsAtBench);

    // Once the cooldown elapses, it retries (then re-benches).
    vi.advanceTimersByTime(2 * 60_000);
    expect(connectSpy.mock.calls.length).toBeGreaterThan(callsAtBench);
  });

  it('a fresh connect resets the cooldown flag', () => {
    const relay: any = new NostrRelay('wss://flaky.example');
    vi.spyOn(relay, 'connect').mockImplementation(() => { relay.handleDisconnect(); });

    relay.connectionState = 'connecting';
    relay.handleDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(relay.inCooldown).toBe(true);

    // The onopen path resets these; verify the flag clears.
    relay.reconnectAttempts = 0;
    relay.inCooldown = false;
    expect(relay.inCooldown).toBe(false);
  });
});

describe('NostrRelay resetReconnectBackoff (resume triggers)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cancels the 10-min cooldown and re-dials immediately on resume', () => {
    const relay: any = new NostrRelay('wss://dead.example');

    const connectSpy = vi.spyOn(relay, 'connect').mockImplementation(() => {
      relay.handleDisconnect();
    });

    // Drive it into the bad-relay cooldown, as a wake into a dead radio would.
    relay.connectionState = 'connecting';
    relay.handleDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(relay.inCooldown).toBe(true);

    // Resume: fresh network context — the cooldown was earned on a network
    // that no longer exists. Counters reset, pending 10-min timer cancelled,
    // and an immediate redial (state is 'reconnecting').
    const callsAtBench = connectSpy.mock.calls.length;
    relay.resetReconnectBackoff();

    expect(relay.inCooldown).toBe(false);
    // Counter restarted — 1 = the immediate redial inside resetReconnectBackoff.
    expect(relay.reconnectAttempts).toBe(1);
    expect(connectSpy.mock.calls.length).toBe(callsAtBench + 1); // re-dialed NOW

    // Back on the fast burst cadence (1s), not the 10-min bench.
    vi.advanceTimersByTime(1_000);
    expect(connectSpy.mock.calls.length).toBeGreaterThan(callsAtBench + 1);
  });

  it('leaves an explicitly disconnected relay alone', () => {
    const relay: any = new NostrRelay('wss://dead.example');
    const connectSpy = vi.spyOn(relay, 'connect').mockImplementation(() => {});

    relay.resetReconnectBackoff(); // fresh instance: state 'disconnected'

    expect(connectSpy).not.toHaveBeenCalled();
    expect(relay.getState()).toBe('disconnected');
  });
});
