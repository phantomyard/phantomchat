/**
 * Tests for relay pool failover — publish with one relay down,
 * recovery respects Tor mode, relay state events
 */

import '../setup';

// ─── Hoisted mock state ────────────────────────────────────────────

interface MockMsg {
  id: string;
  from: string;
  content: string;
  timestamp: number;
}

const {mockRelayInstances, MockNostrRelayClass} = vi.hoisted(() => {
  // Use a global instances array shared with nostr-relay-pool.test.ts.
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
    mode: 'websocket' | 'http-polling' = 'websocket';
    torFetchFn: ((url: string) => Promise<string>) | null = null;
    latencyMs: number = -1;
    sentRawEvents: any[] = [];

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

    getState(): string {
      return this.connectionState;
    }

    getPublicKey(): string {
      return 'mock-pubkey';
    }

    sendRawEvent(event: any): void {
      this.sentRawEvents.push(event);
    }

    setTorMode(fetchFn: (url: string) => Promise<string>): void {
      this.mode = 'http-polling';
      this.torFetchFn = fetchFn;
    }

    setDirectMode(): void {
      this.mode = 'websocket';
      this.torFetchFn = null;
    }

    getMode(): string {
      return this.mode;
    }

    async measureLatency(): Promise<number> {
      return this.latencyMs;
    }

    getLatency(): number {
      return this.latencyMs;
    }

    // Compatibility methods used by nostr-relay-pool.test.ts.
    // When isolate:false, both files mock @lib/nostra/nostr-relay
    // and whichever mock wins must support both test suites.
    simulateMessage(msg: MockMsg): void {
      if(this.messageHandler) {
        this.messageHandler(msg);
      }
    }

    simulateDisconnect(): void {
      this.connected = false;
      this.connectionState = 'disconnected';
    }
  }

  return {
    mockRelayInstances: instances,
    MockNostrRelayClass: MockRelay
  };
});

vi.mock('@lib/nostra/nostr-relay', () => ({
  NostrRelay: MockNostrRelayClass
}));

vi.mock('@lib/nostra/identity', () => ({
  loadIdentity: vi.fn().mockResolvedValue({
    ownId: 'test-own-id',
    publicKey: 'dGVzdC1wdWJsaWMta2V5',
    privateKey: 'dGVzdC1wcml2YXRlLWtleQ=='
  })
}));

// Mock rootScope
const dispatchedEvents: Array<{name: string; data: any}> = [];
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn((name: string, data: any) => {
      dispatchedEvents.push({name, data});
    })
  }
}));

// Mock nip65
vi.mock('@lib/nostra/nip65', () => ({
  buildNip65Event: vi.fn().mockReturnValue({
    kind: 10002,
    tags: [],
    content: '',
    id: 'mock-nip65-id',
    sig: 'mock-sig'
  })
}));

describe('Relay Pool Failover', () => {
  let pool: any;
  let DEFAULT_RELAYS: any[];
  const messages: MockMsg[] = [];

  beforeEach(async() => {
    vi.resetModules();

    // Re-register mocks after resetModules
    vi.doMock('@lib/nostra/nostr-relay', () => ({
      NostrRelay: MockNostrRelayClass
    }));
    vi.doMock('@lib/nostra/identity', () => ({
      loadIdentity: vi.fn().mockResolvedValue({
        ownId: 'test-own-id',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        privateKey: 'dGVzdC1wcml2YXRlLWtleQ=='
      })
    }));
    vi.doMock('@lib/rootScope', () => ({
      default: {
        dispatchEvent: vi.fn((name: string, data: any) => {
          dispatchedEvents.push({name, data});
        })
      }
    }));
    vi.doMock('@lib/nostra/nip65', () => ({
      buildNip65Event: vi.fn().mockReturnValue({
        kind: 10002, tags: [], content: '', id: 'mock-nip65-id', sig: 'mock-sig'
      })
    }));

    mockRelayInstances.length = 0;
    messages.length = 0;
    dispatchedEvents.length = 0;

    const mod = await import('@lib/nostra/nostr-relay-pool');
    DEFAULT_RELAYS = mod.DEFAULT_RELAYS;
    pool = new mod.NostrRelayPool({
      relays: [...DEFAULT_RELAYS],
      onMessage: (msg: any) => messages.push(msg as MockMsg)
    });
  });

  afterEach(() => {
    pool.disconnect();
  });

  describe('DEFAULT_RELAYS', () => {
    it('should have 5 default relays', () => {
      expect(DEFAULT_RELAYS).toHaveLength(5);
      expect(DEFAULT_RELAYS.map(r => r.url)).toContain('wss://relay.damus.io');
    });
  });

  describe('publish with failures', () => {
    it('publishes to all write relays and collects successes/failures', async() => {
      await pool.initialize();

      const result = await pool.publish('recipient-pubkey', 'test message');

      // All 5 default relays are write-enabled
      const totalResults = result.successes.length + result.failures.length;
      expect(totalResults).toBe(5);
    });

    it('with one relay disconnected, publish succeeds via remaining relays', async() => {
      await pool.initialize();

      // Disconnect one relay
      mockRelayInstances[0].connected = false;
      mockRelayInstances[0].connectionState = 'disconnected';

      const result = await pool.publish('recipient-pubkey', 'test message');

      // 4 succeed, 1 fails
      expect(result.successes.length).toBe(4);
      expect(result.failures.length).toBe(1);
    });
  });

  describe('Tor mode and recovery', () => {
    it('pool setTorMode calls setTorMode on all relay instances', async() => {
      await pool.initialize();

      const mockFetch = vi.fn().mockResolvedValue('[]');
      pool.setTorMode(mockFetch);

      for(const instance of mockRelayInstances) {
        expect(instance.mode).toBe('http-polling');
      }
    });

    it('pool setDirectMode calls setDirectMode on all relay instances', async() => {
      await pool.initialize();

      const mockFetch = vi.fn().mockResolvedValue('[]');
      pool.setTorMode(mockFetch);
      pool.setDirectMode();

      for(const instance of mockRelayInstances) {
        expect(instance.mode).toBe('websocket');
      }
    });

    it('pool recovery skips reconnection when in Tor mode and Tor not ready', async() => {
      await pool.initialize();

      // Set Tor mode
      const mockFetch = vi.fn().mockResolvedValue('[]');
      pool.setTorMode(mockFetch);

      // Disconnect one relay
      mockRelayInstances[0].connected = false;
      mockRelayInstances[0].connectionState = 'disconnected';

      // Clear torFetchFn to simulate Tor not ready
      pool.clearTorFetchFn();

      // Trigger recovery manually
      (pool as any).recoverFailedRelays();

      // Recovery should NOT reconnect the relay (Tor mode but no fetchFn)
      expect(mockRelayInstances[0].initialized).toBe(true); // from initial connect
      // The relay should still be disconnected
      expect(mockRelayInstances[0].connectionState).toBe('disconnected');
    });
  });

  describe('relay state events', () => {
    it('emits nostra_relay_state events on state change', async() => {
      await pool.initialize();

      const relayStateEvents = dispatchedEvents.filter(e => e.name === 'nostra_relay_state');
      // Should have dispatched state events during connectAll
      expect(relayStateEvents.length).toBeGreaterThan(0);
    });

    it('emits nostra_relay_list_changed on addRelay', async() => {
      await pool.initialize();
      dispatchedEvents.length = 0;

      pool.addRelay({url: 'wss://new.relay', read: true, write: true});

      const listEvents = dispatchedEvents.filter(e => e.name === 'nostra_relay_list_changed');
      expect(listEvents.length).toBeGreaterThan(0);
    });

    it('emits nostra_relay_list_changed on removeRelay', async() => {
      await pool.initialize();
      dispatchedEvents.length = 0;

      pool.removeRelay('wss://relay.damus.io');

      const listEvents = dispatchedEvents.filter(e => e.name === 'nostra_relay_list_changed');
      expect(listEvents.length).toBeGreaterThan(0);
    });
  });

  describe('enable/disable relay', () => {
    it('disableRelay prevents publish to that relay', async() => {
      await pool.initialize();

      pool.disableRelay('wss://relay.damus.io');

      const states = pool.getRelayStates();
      const damusState = states.find((s: any) => s.url === 'wss://relay.damus.io');
      expect(damusState?.enabled).toBe(false);

      const result = await pool.publish('recipient-pubkey', 'test message');
      // Only 4 write relays now (1 disabled)
      const totalResults = result.successes.length + result.failures.length;
      expect(totalResults).toBe(4);
    });

    it('enableRelay re-enables publish to that relay', async() => {
      await pool.initialize();

      pool.disableRelay('wss://relay.damus.io');
      pool.enableRelay('wss://relay.damus.io');

      const result = await pool.publish('recipient-pubkey', 'test message');
      const totalResults = result.successes.length + result.failures.length;
      expect(totalResults).toBe(5);
    });
  });

  describe('getRelayStates', () => {
    it('returns aggregate state for all relays', async() => {
      await pool.initialize();

      const states = pool.getRelayStates();

      expect(states).toHaveLength(5);
      for(const state of states) {
        expect(state).toHaveProperty('url');
        expect(state).toHaveProperty('connected');
        expect(state).toHaveProperty('latencyMs');
        expect(state).toHaveProperty('read');
        expect(state).toHaveProperty('write');
        expect(state).toHaveProperty('enabled');
      }
    });
  });
});
