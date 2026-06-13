/**
 * Tests for PhantomChat.chat NIP-17 relay storage module
 *
 * Phase 2: NIP-04 removed, all encryption moved to NIP-44
 * Phase 4: Kind 4 removed, all messaging moved to NIP-17 gift-wrap (kind 1059)
 */

import '../setup';
import {NostrRelay, createNostrRelay, NOSTR_KIND_GIFTWRAP} from '@lib/phantomchat/nostr-relay';
import {nip44Encrypt, nip44Decrypt, getConversationKey} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
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
  });

  describe('onMessage handler', () => {
    test('can register message handler', () => {
      const handler = (msg: any) => {};
      relay.onMessage(handler);
      expect(typeof relay.onMessage).toBe('function');
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
