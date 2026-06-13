/**
 * Tests for PrivacyTransport — pool-wrapping Tor privacy layer
 */

import '../setup';

// Mock rootScope
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

// ─── Dynamic module loading ───────────────────────────────────────

let PrivacyTransport: any;
let rootScope: any;

beforeAll(async() => {
  // Re-register rootScope mock via doMock to override any contamination
  // from other files (e.g. message-requests.test.ts provides a real
  // function implementation instead of vi.fn() spy).
  vi.resetModules();

  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent: vi.fn()
    }
  }));

  const ptMod = await import('@lib/nostra/privacy-transport');
  PrivacyTransport = ptMod.PrivacyTransport;

  const rsMod = await import('@lib/rootScope');
  rootScope = rsMod.default;
});

// ─── Mock helpers (no vi.mock needed for injected deps) ─────────

function createMockPool() {
  return {
    torMode: false,
    directMode: false,
    connected: true,
    publishCalled: 0,
    lastRecipient: '',
    lastPayload: '',

    setTorMode(_fetchFn: (url: string) => Promise<string>): void {
      this.torMode = true;
      this.directMode = false;
    },

    setDirectMode(): void {
      this.directMode = true;
      this.torMode = false;
    },

    isConnected(): boolean {
      return this.connected;
    },

    async publish(recipientPubkey: string, plaintext: string): Promise<{successes: string[]; failures: any[]}> {
      this.publishCalled++;
      this.lastRecipient = recipientPubkey;
      this.lastPayload = plaintext;
      return {successes: ['event-id-1'], failures: []};
    },

    async initialize(): Promise<void> {},
    disconnect(): void {},
    subscribeMessages(): void {}
  };
}

function createMockQueue() {
  return {
    messages: [] as Array<{to: string; payload: string}>,
    flushed: false,

    async queue(to: string, payload: string): Promise<string> {
      this.messages.push({to, payload});
      return `queue-${Date.now()}`;
    },

    async flush(): Promise<number> {
      this.flushed = true;
      const count = this.messages.length;
      this.messages = [];
      return count;
    },

    getQueued(): any[] {
      return this.messages;
    },

    getQueueSize(): number {
      return this.messages.length;
    }
  };
}

function createMockWebtorClient(options: {shouldFail?: boolean} = {}) {
  let isReady = false;
  return {
    bootstrapCalled: false,

    async bootstrap(_timeoutMs?: number): Promise<void> {
      this.bootstrapCalled = true;
      if(options.shouldFail) {
        throw new Error('Tor bootstrap failed');
      }
      isReady = true;
    },

    isReady(): boolean {
      return isReady;
    },

    async fetch(_url: string): Promise<string> {
      return '[]';
    },

    async close(): Promise<void> {}
  };
}

describe('PrivacyTransport — mode-based lifecycle', () => {
  let transport: any;
  let pool: ReturnType<typeof createMockPool>;
  let queue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    vi.mocked(rootScope.dispatchEvent).mockClear();
    pool = createMockPool();
    queue = createMockQueue();
    localStorage.removeItem('nostra-tor-enabled');
    localStorage.removeItem('nostra-tor-mode');
  });

  afterEach(() => {
    transport?.disconnect();
    localStorage.removeItem('nostra-tor-enabled');
    localStorage.removeItem('nostra-tor-mode');
  });

  it('mode=off → runtime direct-active, pool goes direct immediately', async() => {
    localStorage.setItem('nostra-tor-mode', 'off');
    const webtor = createMockWebtorClient();
    transport = new PrivacyTransport(pool as any, queue as any, webtor as any);
    await transport.bootstrap();
    expect(transport.getRuntimeState()).toBe('direct-active');
    expect(pool.directMode).toBe(true);
  });

  it('mode=when-available → runtime direct-active, pool direct, upgrade loop armed', async() => {
    localStorage.setItem('nostra-tor-mode', 'when-available');
    const webtor = createMockWebtorClient({shouldFail: true});
    transport = new PrivacyTransport(pool as any, queue as any, webtor as any);
    await transport.bootstrap();
    expect(transport.getRuntimeState()).toBe('direct-active');
    expect(pool.directMode).toBe(true);
  });

  it('dispatches nostra_tor_state with RuntimeState values', async() => {
    localStorage.setItem('nostra-tor-mode', 'off');
    const webtor = createMockWebtorClient();
    transport = new PrivacyTransport(pool as any, queue as any, webtor as any);
    await transport.bootstrap();

    const calls = vi.mocked(rootScope.dispatchEvent).mock.calls;
    const torCalls = calls.filter(([name]: [string, ...unknown[]]) => name === 'nostra_tor_state');
    const states = torCalls.map(([, data]: [string, ...unknown[]]) => (data as any).state);
    expect(states).toContain('direct-active');
  });

  describe('send', () => {
    it('queues messages when runtime state is booting', async() => {
      localStorage.setItem('nostra-tor-mode', 'only');
      const webtor = createMockWebtorClient({shouldFail: true});
      transport = new PrivacyTransport(pool as any, queue as any, webtor as any);
      await transport.bootstrap();

      expect(transport.getRuntimeState()).toBe('booting');
      await transport.send('recipient-pubkey', 'test message');

      expect(queue.messages).toHaveLength(1);
      expect(queue.messages[0].to).toBe('recipient-pubkey');
      expect(pool.publishCalled).toBe(0);
    });

    it('sends via pool when in direct-active runtime state', async() => {
      localStorage.setItem('nostra-tor-mode', 'off');
      const webtor = createMockWebtorClient();
      transport = new PrivacyTransport(pool as any, queue as any, webtor as any);
      await transport.bootstrap();

      await transport.send('recipient-pubkey', 'test message');

      expect(pool.publishCalled).toBe(1);
      expect(pool.lastRecipient).toBe('recipient-pubkey');
    });
  });

  describe('disconnect', () => {
    it('cleans up resources and resets runtime state to offline', async() => {
      localStorage.setItem('nostra-tor-mode', 'off');
      const webtor = createMockWebtorClient();
      transport = new PrivacyTransport(pool as any, queue as any, webtor as any);
      await transport.bootstrap();

      transport.disconnect();

      expect(transport.getRuntimeState()).toBe('offline');
    });
  });
});
