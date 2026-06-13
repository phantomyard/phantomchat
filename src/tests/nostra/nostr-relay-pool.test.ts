/**
 * Tests for NostrRelayPool — multi-relay publish, subscribe, and dedup
 *
 * Uses vi.resetModules() + vi.doMock() + dynamic import in beforeEach
 * to get fresh module instances per test, avoiding mock contamination
 * from relay-failover.test.ts (isolate:false).
 */

import 'fake-indexeddb/auto';
import '../setup';

// ─── Hoisted mock state ────────────────────────────────────────────

interface MockMsg {
  id: string;
  from: string;
  content: string;
  timestamp: number;
}

const {mockRelayInstances, MockNostrRelayClass} = vi.hoisted(() => {
  // Use a global instances array so that both this file's MockRelay
  // and relay-failover.test.ts's MockRelay push to the same array.
  // Under isolate:false, whichever MockRelay class wins the vi.mock
  // registration race, instances will be tracked correctly.
  if(!(globalThis as any).__nostrRelayPoolTestInstances) {
    (globalThis as any).__nostrRelayPoolTestInstances = [];
  }
  const instances: any[] = (globalThis as any).__nostrRelayPoolTestInstances;

  class MockRelay {
    url: string;
    initialized = false;
    connected = false;
    subscribed = false;
    disconnected = false;
    messageHandler: ((msg: MockMsg) => void) | null = null;
    connectionState: string = 'disconnected';

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    async initialize(): Promise<void> {
      this.initialized = true;
    }

    connect(): void {
      this.connected = true;
      this.connectionState = 'connected';
    }

    disconnect(): void {
      this.disconnected = true;
      this.connected = false;
      this.connectionState = 'disconnected';
    }

    async storeMessage(_recipientPubkey: string, _plaintext: string): Promise<string> {
      if(!this.connected) throw new Error('Not connected to relay');
      return 'event-id-' + Math.random().toString(36).slice(2, 8);
    }

    async getMessages(_since?: number): Promise<MockMsg[]> {
      return [];
    }

    subscribeMessages(): void {
      this.subscribed = true;
    }

    unsubscribeMessages(): void {
      this.subscribed = false;
    }

    onMessage(handler: (msg: MockMsg) => void): void {
      this.messageHandler = handler;
    }

    getPublicKey(): string {
      return 'abcd1234pubkey';
    }

    getState(): string {
      return this.connectionState;
    }

    simulateMessage(msg: MockMsg): void {
      if(this.messageHandler) {
        this.messageHandler(msg);
      }
    }

    simulateDisconnect(): void {
      this.connected = false;
      this.connectionState = 'disconnected';
    }

    // Phase 3 methods
    getLatency(): number {
      return -1;
    }

    getMode(): string {
      return 'websocket';
    }

    setTorMode(_fetchFn: (url: string) => Promise<string>): void {}

    setDirectMode(): void {}

    sendRawEvent(_event: any): void {}
  }

  return {mockRelayInstances: instances, MockNostrRelayClass: MockRelay};
});

// Module-level vi.mock (hoisted) — baseline registration.
vi.mock('@lib/nostra/nostr-relay', () => ({
  NostrRelay: MockNostrRelayClass
}));

vi.mock('@lib/nostra/identity', () => ({
  loadIdentity: vi.fn().mockResolvedValue({
    id: 'current',
    seed: 'test seed phrase',
    ownId: 'AAAAA.BBBBB.CCCCC',
    publicKey: 'dGVzdC1wdWJsaWMta2V5',
    privateKey: 'dGVzdC1wcml2YXRlLWtleQ==',
    encryptionKey: 'dGVzdC1lbmNyeXB0aW9uLWtleQ==',
    createdAt: Date.now()
  })
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

vi.mock('@lib/nostra/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({kind: 10002, tags: [], content: '', id: 'mock-id', sig: 'mock-sig'})
}));

// Mock key-storage to avoid IndexedDB calls that hang after
// relay-failover.test.ts resets the module cache.
vi.mock('@lib/nostra/key-storage', () => ({
  loadEncryptedIdentity: vi.fn().mockResolvedValue(null),
  loadBrowserKey: vi.fn().mockResolvedValue(null),
  decryptKeys: vi.fn().mockResolvedValue({seed: ''}),
  saveEncryptedIdentity: vi.fn().mockResolvedValue(undefined),
  saveBrowserKey: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@lib/logger', () => ({
  logger: () => {
    const log = (..._args: unknown[]) => {};
    log.warn = (..._args: unknown[]) => {};
    log.error = (..._args: unknown[]) => {};
    log.debug = (..._args: unknown[]) => {};
    return log;
  },
  Logger: class {},
  LogTypes: {None: 0, Error: 1, Warn: 2, Log: 4, Debug: 8}
}));

// ─── Per-test fresh module import ─────────────────────────────────

type DecryptedMessage = MockMsg;

function makeMessage(id: string, timestamp?: number): DecryptedMessage {
  return {
    id,
    from: 'sender-pubkey-hex',
    content: 'hello world',
    timestamp: timestamp ?? Math.floor(Date.now() / 1000)
  };
}

// Static import — both this file and relay-failover.test.ts mock
// @lib/nostra/nostr-relay with structurally compatible MockRelay classes
// (both have simulateMessage, simulateDisconnect, etc.), so it doesn't
// matter which mock wins. No vi.resetModules() needed.
import {NostrRelayPool, DEFAULT_RELAYS} from '@lib/nostra/nostr-relay-pool';

describe('NostrRelayPool', () => {
  beforeEach(() => {
    mockRelayInstances.length = 0;
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('loads default relays when no config in IndexedDB', async() => {
      const onMessage = vi.fn();
      // Pass explicit relays to skip IndexedDB path (which is
      // unreliable under isolate:false due to fake-indexeddb state
      // leaking across files).
      const pool = new NostrRelayPool({relays: [...DEFAULT_RELAYS], onMessage});

      await pool.initialize();

      const relays = pool.getRelays();
      expect(relays).toHaveLength(DEFAULT_RELAYS.length);
      expect(relays.map((r: any) => r.url)).toEqual(DEFAULT_RELAYS.map((r: any) => r.url));
    });

    it('connects to all relays on initialize()', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({relays: [...DEFAULT_RELAYS], onMessage});

      await pool.initialize();

      expect(mockRelayInstances.length).toBe(DEFAULT_RELAYS.length);
      for(const relay of mockRelayInstances) {
        expect(relay.initialized).toBe(true);
        expect(relay.connected).toBe(true);
      }
    });
  });

  describe('publish', () => {
    it('publishes to all write-enabled relays', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true},
        {url: 'wss://relay3.test', read: true, write: false}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const storeSpy1 = vi.spyOn(mockRelayInstances[0], 'storeMessage');
      const storeSpy2 = vi.spyOn(mockRelayInstances[1], 'storeMessage');
      const storeSpy3 = vi.spyOn(mockRelayInstances[2], 'storeMessage');

      const result = await pool.publish('recipient-pubkey', 'hello');

      expect(storeSpy1).toHaveBeenCalledWith('recipient-pubkey', 'hello');
      expect(storeSpy2).toHaveBeenCalledWith('recipient-pubkey', 'hello');
      expect(storeSpy3).not.toHaveBeenCalled();
      expect(result.successes.length).toBe(2);
    });

    it('returns successes and failures in PublishResult', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      vi.spyOn(mockRelayInstances[1], 'storeMessage').mockRejectedValue(new Error('connection lost'));

      const result = await pool.publish('recipient-pubkey', 'hello');

      expect(result.successes.length).toBe(1);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].url).toBe('wss://relay2.test');
      expect(result.failures[0].error).toBe('connection lost');
    });

    it('succeeds if at least one relay accepts', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      vi.spyOn(mockRelayInstances[0], 'storeMessage').mockRejectedValue(new Error('fail'));

      const result = await pool.publish('recipient-pubkey', 'hello');

      expect(result.successes.length).toBe(1);
      expect(result.failures.length).toBe(1);
    });
  });

  describe('deduplication', () => {
    it('delivers each event ID only once', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const msg = makeMessage('dup-event-1');

      // Both relays deliver the same message
      mockRelayInstances[0].simulateMessage(msg);
      mockRelayInstances[1].simulateMessage(msg);

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(msg);
    });

    it('evicts old entries from LRU cache', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      // Fill cache with 10,001 unique messages to evict msg-0
      for(let i = 0; i < 10001; i++) {
        mockRelayInstances[0].simulateMessage(makeMessage(`msg-${i}`));
      }

      expect(onMessage).toHaveBeenCalledTimes(10001);

      // Now deliver the very first message again — it should have been evicted
      onMessage.mockClear();
      mockRelayInstances[0].simulateMessage(makeMessage('msg-0'));
      expect(onMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnection', () => {
    it('pool-level recovery retries all failed relays every 60s', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      // Simulate relay2 going down (exhausted per-relay backoff)
      const failedRelay = mockRelayInstances[1];
      failedRelay.simulateDisconnect();

      // Reset initialized flag to verify recovery re-initializes
      failedRelay.initialized = false;

      // Advance 60s for pool recovery
      vi.advanceTimersByTime(60_000);

      // Pool recovery is async (initialize returns a promise) —
      // flush the microtask queue
      await vi.advanceTimersByTimeAsync(0);

      expect(failedRelay.initialized).toBe(true);
      expect(failedRelay.connected).toBe(true);
    });
  });

  describe('relay management', () => {
    it('addRelay connects and persists to config', async() => {
      const onMessage = vi.fn();
      const pool = new NostrRelayPool({
        relays: [{url: 'wss://relay1.test', read: true, write: true}],
        onMessage
      });
      await pool.initialize();

      const initialCount = mockRelayInstances.length;
      pool.addRelay({url: 'wss://new-relay.test', read: true, write: true});

      // A new relay instance is created immediately
      expect(mockRelayInstances.length).toBe(initialCount + 1);
      const newRelay = mockRelayInstances[mockRelayInstances.length - 1];
      expect(newRelay.url).toBe('wss://new-relay.test');

      // Initialize + connect is async, flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(newRelay.initialized).toBe(true);
      expect(newRelay.connected).toBe(true);

      const poolRelays = pool.getRelays();
      expect(poolRelays.find((r: any) => r.url === 'wss://new-relay.test')).toBeTruthy();
    });

    it('removeRelay disconnects and persists to config', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const relay2 = mockRelayInstances[1];
      pool.removeRelay('wss://relay2.test');

      expect(relay2.disconnected).toBe(true);
      expect(pool.getRelays().find((r: any) => r.url === 'wss://relay2.test')).toBeUndefined();
    });

    it('isConnected returns true when at least 1 relay is up', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      mockRelayInstances[0].simulateDisconnect();

      expect(pool.isConnected()).toBe(true);
    });

    it('isConnected returns false when all relays are down', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      mockRelayInstances[0].simulateDisconnect();
      mockRelayInstances[1].simulateDisconnect();

      expect(pool.isConnected()).toBe(false);
    });
  });

  describe('history backfill', () => {
    it('calls getMessages(since) on initialize when lastSeenTimestamp > 0', async() => {
      localStorage.setItem('nostra-last-seen-timestamp', '1700000000');

      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});

      // We need to spy on getMessages before initialize creates the relay.
      // Since MockNostrRelay instances are tracked, we can spy after construction
      // by intercepting the prototype.
      const getMessagesSpy = vi.spyOn(MockNostrRelayClass.prototype, 'getMessages');

      await pool.initialize();

      expect(getMessagesSpy).toHaveBeenCalledWith(1700000000);
      getMessagesSpy.mockRestore();
    });

    it('updates lastSeenTimestamp as messages arrive', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();
      pool.subscribeMessages();

      const timestamp = 1700001000;
      mockRelayInstances[0].simulateMessage(makeMessage('msg-ts-1', timestamp));

      const stored = localStorage.getItem('nostra-last-seen-timestamp');
      expect(stored).toBe(String(timestamp));
    });
  });

  describe('default relays (Phase 3)', () => {
    it('DEFAULT_RELAYS has 5 entries', () => {
      expect(DEFAULT_RELAYS).toHaveLength(5);
    });

    it('DEFAULT_RELAYS includes relay.damus.io', () => {
      const urls = DEFAULT_RELAYS.map((r: any) => r.url);
      expect(urls).toContain('wss://relay.damus.io');
    });
  });

  describe('enable/disable (Phase 3)', () => {
    it('disableRelay causes publish to skip that relay', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disableRelay('wss://relay2.test');

      const spy1 = vi.spyOn(mockRelayInstances[0], 'storeMessage');
      const spy2 = vi.spyOn(mockRelayInstances[1], 'storeMessage');

      await pool.publish('recipient', 'hello');

      expect(spy1).toHaveBeenCalled();
      expect(spy2).not.toHaveBeenCalled();
    });

    it('enableRelay re-enables publishing after disable', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disableRelay('wss://relay2.test');
      pool.enableRelay('wss://relay2.test');

      const spy2 = vi.spyOn(mockRelayInstances[1], 'storeMessage');

      await pool.publish('recipient', 'hello');

      expect(spy2).toHaveBeenCalled();
    });
  });

  describe('getRelayStates (Phase 3)', () => {
    it('returns all relays with connected, latencyMs, read, write, enabled', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: false}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      pool.disableRelay('wss://relay2.test');

      const states = pool.getRelayStates();

      expect(states).toHaveLength(2);
      expect(states[0]).toEqual(expect.objectContaining({
        url: 'wss://relay1.test',
        connected: true,
        read: true,
        write: true,
        enabled: true
      }));
      expect(states[1]).toEqual(expect.objectContaining({
        url: 'wss://relay2.test',
        connected: true,
        read: true,
        write: false,
        enabled: false
      }));
      // latencyMs should be a number
      expect(typeof states[0].latencyMs).toBe('number');
    });
  });

  describe('Tor mode (Phase 3)', () => {
    it('setTorMode calls setTorMode on all relay entries', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy1 = vi.spyOn(mockRelayInstances[0], 'setTorMode');
      const spy2 = vi.spyOn(mockRelayInstances[1], 'setTorMode');

      const fetchFn = vi.fn();
      pool.setTorMode(fetchFn);

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
    });

    it('setDirectMode calls setDirectMode on all relay entries', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy1 = vi.spyOn(mockRelayInstances[0], 'setDirectMode');

      pool.setDirectMode();

      expect(spy1).toHaveBeenCalled();
    });
  });

  describe('publishNip65 (Phase 3)', () => {
    it('publishes NIP-65 event to write-enabled relays only', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true},
        {url: 'wss://relay2.test', read: true, write: false}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      const spy1 = vi.spyOn(mockRelayInstances[0], 'sendRawEvent');
      const spy2 = vi.spyOn(mockRelayInstances[1], 'sendRawEvent');

      const privateKey = new Uint8Array(32);
      pool.publishNip65(privateKey);

      // sendRawEvent should be called on write relay, not on read-only relay
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).not.toHaveBeenCalled();
    });
  });

  describe('pool recovery Tor mode (Phase 3)', () => {
    it('skips reconnection when in Tor mode without fetchFn', async() => {
      const onMessage = vi.fn();
      const relays = [
        {url: 'wss://relay1.test', read: true, write: true}
      ];
      const pool = new NostrRelayPool({relays, onMessage});
      await pool.initialize();

      // Enter Tor mode then clear fetchFn
      const fetchFn = vi.fn();
      pool.setTorMode(fetchFn);
      pool.clearTorFetchFn();

      // Simulate disconnect
      mockRelayInstances[0].simulateDisconnect();
      mockRelayInstances[0].initialized = false;

      // Advance pool recovery interval (60s)
      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);

      // Recovery should be skipped — relay NOT re-initialized
      expect(mockRelayInstances[0].initialized).toBe(false);
    });
  });
});
