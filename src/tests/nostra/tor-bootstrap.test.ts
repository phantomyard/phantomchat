/**
 * Tests for Tor bootstrap behavior — fire-and-forget, non-blocking,
 * app remains interactive during bootstrap
 */

import '../setup';

// Mock rootScope to prevent MTProtoMessagePort.getInstance() crash
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

// ─── Mock helpers ─────────────────────────────────────────────────

function createMockPool() {
  return {
    torMode: false,
    directMode: false,

    setTorMode(_fetchFn: (url: string) => Promise<string>): void {
      this.torMode = true;
    },

    setDirectMode(): void {
      this.directMode = true;
      this.torMode = false;
    },

    isConnected(): boolean {
      return true;
    },

    async publish(): Promise<{successes: string[]; failures: any[]}> {
      return {successes: ['event-id-1'], failures: []};
    },

    async initialize(): Promise<void> {},
    disconnect(): void {},
    subscribeMessages(): void {}
  };
}

function createMockQueue() {
  return {
    messages: [] as any[],

    async queue(to: string, payload: string): Promise<string> {
      this.messages.push({to, payload});
      return `queue-${Date.now()}`;
    },

    async flush(): Promise<number> {
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

let PrivacyTransport: any;

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent: vi.fn()
    }
  }));

  const mod = await import('@lib/nostra/privacy-transport');
  PrivacyTransport = mod.PrivacyTransport;
});

afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.restoreAllMocks();
});

describe('Tor Bootstrap Behavior — smoke', () => {
  it('bootstrap is fire-and-forget — constructor returns immediately', () => {
    const pool = createMockPool();
    const queue = createMockQueue();
    const webtor = createMockWebtorClient();

    const startTime = performance.now();
    const t = new PrivacyTransport(pool as any, queue as any, webtor as any);
    const elapsed = performance.now() - startTime;

    // Constructor must complete in < 100ms (well under 3s requirement)
    expect(elapsed).toBeLessThan(100);
    t.disconnect();
  });
});

// ── Reusable mock helpers for mode-dispatched bootstrap tests ──────
function makeMockPool() {
  return {
    setDirectMode: vi.fn(),
    setTorMode: vi.fn(),
    publish: vi.fn().mockResolvedValue({successes: [], failures: []}),
    initialize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn()
  };
}
function makeMockWebtor(opts: {bootstrapFails: boolean}) {
  return {
    bootstrap: async() => {
      if(opts.bootstrapFails) throw new Error('mock bootstrap failure');
    },
    isReady: () => !opts.bootstrapFails,
    fetch: async() => new Response(''),
    close: async() => {},
    getCircuitDetails: () => ({guard: '', middle: '', exit: ''})
  };
}

describe('PrivacyTransport — mode-dispatched bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('mode=only: sets runtime booting, does not call setDirectMode', async() => {
    localStorage.setItem('nostra-tor-mode', 'only');
    const pool = makeMockPool();
    const mockWebtor = makeMockWebtor({bootstrapFails: true});
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    const {OfflineQueue} = await import('@lib/nostra/offline-queue');
    const t = new PrivacyTransport(pool as any, new OfflineQueue(pool as any), mockWebtor as any);
    await t.bootstrap();
    expect(t.getRuntimeState()).toBe('booting');
    expect(pool.setDirectMode).not.toHaveBeenCalled();
  });

  it('mode=when-available: sets runtime direct-active immediately', async() => {
    localStorage.setItem('nostra-tor-mode', 'when-available');
    const pool = makeMockPool();
    const mockWebtor = makeMockWebtor({bootstrapFails: true});
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    const {OfflineQueue} = await import('@lib/nostra/offline-queue');
    const t = new PrivacyTransport(pool as any, new OfflineQueue(pool as any), mockWebtor as any);
    await t.bootstrap();
    expect(pool.setDirectMode).toHaveBeenCalledTimes(1);
    expect(t.getRuntimeState()).toBe('direct-active');
  });

  it('mode=off: direct-active, never starts the retry loop', async() => {
    localStorage.setItem('nostra-tor-mode', 'off');
    const pool = makeMockPool();
    const mockWebtor = makeMockWebtor({bootstrapFails: false});
    const bootstrapSpy = vi.spyOn(mockWebtor, 'bootstrap');
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    const {OfflineQueue} = await import('@lib/nostra/offline-queue');
    const t = new PrivacyTransport(pool as any, new OfflineQueue(pool as any), mockWebtor as any);
    await t.bootstrap();
    expect(t.getRuntimeState()).toBe('direct-active');
    // Bootstrap should never be called when mode is off.
    await new Promise((r) => setTimeout(r, 50));
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  it('setMode(off) while running in only-mode stops the loop and switches to direct', async() => {
    localStorage.setItem('nostra-tor-mode', 'only');
    const pool = makeMockPool();
    const mockWebtor = makeMockWebtor({bootstrapFails: true});
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    const {OfflineQueue} = await import('@lib/nostra/offline-queue');
    const t = new PrivacyTransport(pool as any, new OfflineQueue(pool as any), mockWebtor as any);
    await t.bootstrap();
    expect(t.getRuntimeState()).toBe('booting');
    await t.setMode('off');
    expect(t.getRuntimeState()).toBe('direct-active');
    expect(localStorage.getItem('nostra-tor-mode')).toBe('off');
  });
});

describe('PrivacyTransport — hot-swap in when-available mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem('nostra-tor-mode', 'when-available');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('upgrades direct-active → tor-active when bootstrap eventually succeeds', async() => {
    let bootstrapCalls = 0;
    const mockWebtor = {
      bootstrap: async(): Promise<void> => {
        bootstrapCalls++;
        if(bootstrapCalls <= 2) throw new Error('simulated fail');
      },
      isReady: () => bootstrapCalls > 2,
      fetch: async() => new Response(''),
      close: async(): Promise<void> => {},
      getCircuitDetails: (): null => null
    };
    const pool = makeMockPool();
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    const {OfflineQueue} = await import('@lib/nostra/offline-queue');
    const t = new PrivacyTransport(pool as any, new OfflineQueue(pool as any), mockWebtor as any);
    await t.bootstrap();
    expect(t.getRuntimeState()).toBe('direct-active');
    // Walk the ladder: attempt 1 immediate, then 5s, then 10s to reach success
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // By now attempt 3 has succeeded; runtime should be tor-active.
    expect(pool.setTorMode).toHaveBeenCalledTimes(1);
    expect(t.getRuntimeState()).toBe('tor-active');
  });

  it('downgrades tor-active → direct-active when liveness probe fails twice in a row', async() => {
    let ready = true;
    const mockWebtor = {
      bootstrap: async(): Promise<void> => {},
      isReady: () => ready,
      fetch: async() => new Response(''),
      close: async(): Promise<void> => {},
      getCircuitDetails: (): null => null
    };
    const pool = makeMockPool();
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    const {OfflineQueue} = await import('@lib/nostra/offline-queue');
    const t = new PrivacyTransport(pool as any, new OfflineQueue(pool as any), mockWebtor as any);
    await t.bootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.getRuntimeState()).toBe('tor-active');
    // Simulate tunnel death
    ready = false;
    // First probe at 30s — notice once
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.getRuntimeState()).toBe('tor-active');
    // Second probe at 60s — downgrade
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool.setDirectMode).toHaveBeenCalled();
    expect(t.getRuntimeState()).toBe('direct-active');
  });
});
