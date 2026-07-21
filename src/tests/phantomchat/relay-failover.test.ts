/**
 * Tests for relay pool failover — publish with one relay down,
 * recovery, relay state events
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

    resetReconnectBackoff(): void {}

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

    async measureLatency(): Promise<number> {
      return this.latencyMs;
    }

    getLatency(): number {
      return this.latencyMs;
    }

    // Compatibility methods used by nostr-relay-pool.test.ts.
    // When isolate:false, both files mock @lib/phantomchat/nostr-relay
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

vi.mock('@lib/phantomchat/nostr-relay', () => ({
  NostrRelay: MockNostrRelayClass
}));

vi.mock('@lib/phantomchat/identity', () => ({
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
vi.mock('@lib/phantomchat/nip65', () => ({
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
    vi.doMock('@lib/phantomchat/nostr-relay', () => ({
      NostrRelay: MockNostrRelayClass
    }));
    vi.doMock('@lib/phantomchat/identity', () => ({
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
    vi.doMock('@lib/phantomchat/nip65', () => ({
      buildNip65Event: vi.fn().mockReturnValue({
        kind: 10002, tags: [], content: '', id: 'mock-nip65-id', sig: 'mock-sig'
      })
    }));

    mockRelayInstances.length = 0;
    messages.length = 0;
    dispatchedEvents.length = 0;

    const mod = await import('@lib/phantomchat/nostr-relay-pool');
    DEFAULT_RELAYS = mod.DEFAULT_RELAYS;
    pool = new mod.NostrRelayPool({
      relays: [...DEFAULT_RELAYS],
      // This suite asserts publish fan-out across ALL write relays, so keep
      // every relay in the active set (the default caps live sockets at 3).
      maxActiveRelays: DEFAULT_RELAYS.length,
      onMessage: (msg: any) => messages.push(msg as MockMsg)
    });
  });

  afterEach(() => {
    pool.disconnect();
  });

  describe('DEFAULT_RELAYS', () => {
    it('ships a non-empty, write-enabled default relay set', () => {
      expect(DEFAULT_RELAYS.length).toBeGreaterThan(0);
      for(const relay of DEFAULT_RELAYS) {
        expect(relay.url).toMatch(/^wss:\/\//);
        expect(relay.write).toBe(true);
      }
    });
  });

  describe('publish with failures', () => {
    it('publishes to all write relays and collects successes/failures', async() => {
      await pool.initialize();

      const result = await pool.publish('recipient-pubkey', 'test message');

      // Every default relay is write-enabled
      const totalResults = result.successes.length + result.failures.length;
      expect(totalResults).toBe(DEFAULT_RELAYS.length);
    });

    it('with one relay disconnected, publish succeeds via remaining relays', async() => {
      await pool.initialize();

      // Disconnect one relay
      mockRelayInstances[0].connected = false;
      mockRelayInstances[0].connectionState = 'disconnected';

      const result = await pool.publish('recipient-pubkey', 'test message');

      // All but the downed relay succeed
      expect(result.successes.length).toBe(DEFAULT_RELAYS.length - 1);
      expect(result.failures.length).toBe(1);
    });
  });

  describe('relay state events', () => {
    it('emits phantomchat_relay_state events on state change', async() => {
      await pool.initialize();
      // State events are debounced (200ms) — wait for the flush
      await new Promise(r => setTimeout(r, 300));

      const relayStateEvents = dispatchedEvents.filter(e => e.name === 'phantomchat_relay_state');
      // Should have dispatched state events during connectAll
      expect(relayStateEvents.length).toBeGreaterThan(0);
    });

    it('emits phantomchat_relay_list_changed on addRelay', async() => {
      await pool.initialize();
      dispatchedEvents.length = 0;

      pool.addRelay({url: 'wss://new.relay', read: true, write: true});

      const listEvents = dispatchedEvents.filter(e => e.name === 'phantomchat_relay_list_changed');
      expect(listEvents.length).toBeGreaterThan(0);
    });

    it('emits phantomchat_relay_list_changed on removeRelay', async() => {
      await pool.initialize();
      dispatchedEvents.length = 0;

      pool.removeRelay(DEFAULT_RELAYS[0].url);

      const listEvents = dispatchedEvents.filter(e => e.name === 'phantomchat_relay_list_changed');
      expect(listEvents.length).toBeGreaterThan(0);
    });
  });

  describe('enable/disable relay', () => {
    it('disableRelay prevents publish to that relay', async() => {
      await pool.initialize();

      const target = DEFAULT_RELAYS[0].url;
      pool.disableRelay(target);

      const states = pool.getRelayStates();
      const targetState = states.find((s: any) => s.url === target);
      expect(targetState?.enabled).toBe(false);

      const result = await pool.publish('recipient-pubkey', 'test message');
      // One fewer write relay now (1 disabled)
      const totalResults = result.successes.length + result.failures.length;
      expect(totalResults).toBe(DEFAULT_RELAYS.length - 1);
    });

    it('enableRelay re-enables publish to that relay', async() => {
      await pool.initialize();

      const target = DEFAULT_RELAYS[0].url;
      pool.disableRelay(target);
      pool.enableRelay(target);

      const result = await pool.publish('recipient-pubkey', 'test message');
      const totalResults = result.successes.length + result.failures.length;
      expect(totalResults).toBe(DEFAULT_RELAYS.length);
    });
  });

  describe('getRelayStates', () => {
    it('returns aggregate state for all relays', async() => {
      await pool.initialize();

      const states = pool.getRelayStates();

      expect(states).toHaveLength(DEFAULT_RELAYS.length);
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
