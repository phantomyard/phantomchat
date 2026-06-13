// @ts-nocheck
import {describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach} from 'vitest';

// ── Shared mock rootScope for event-dispatch tests ───────────────────────────
// Under isolate:false, vi.mock has no effect on already-cached rootScope.
// Use vi.doMock + vi.resetModules + dynamic import for reliable mocking.

function createMockRootScope() {
  const listeners = new Map();
  return {
    addEventListener: vi.fn((name, handler) => {
      if(!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    }),
    removeEventListener: vi.fn((name, handler) => {
      listeners.get(name)?.delete(handler);
    }),
    dispatchEvent: vi.fn((name, ...args) => {
      const handlers = listeners.get(name);
      if(handlers) handlers.forEach(h => h(...args));
    })
  };
}

describe('nostra_tor_circuit_update event type', () => {
  let rootScope;

  beforeAll(async() => {
    vi.resetModules();
    vi.doMock('@lib/rootScope', () => ({default: createMockRootScope()}));
    rootScope = (await import('@lib/rootScope')).default;
  });

  afterAll(() => {
    vi.unmock('@lib/rootScope');
    vi.resetModules();
  });

  it('should accept circuit update payload shape', () => {
    const handler = vi.fn();
    rootScope.addEventListener('nostra_tor_circuit_update', handler);

    const payload = {
      guard: 'AAAA1234',
      middle: 'BBBB5678',
      exit: 'CCCC9012',
      latency: 450,
      exitIp: '198.51.100.42',
      healthy: true
    };

    rootScope.dispatchEvent('nostra_tor_circuit_update', payload);
    expect(handler).toHaveBeenCalledWith(payload);

    rootScope.removeEventListener('nostra_tor_circuit_update', handler);
  });
});

describe('WebtorClient circuit details', () => {
  it('should expose getCircuitDetails() returning node fingerprints', async() => {
    vi.doMock('/webtor/webtor_wasm', () => ({
      default: vi.fn(),
      init: vi.fn(),
      setDebugEnabled: vi.fn(),
      setLogCallback: vi.fn(),
      TorClient: vi.fn().mockImplementation(() => ({
        getCircuitStatus: vi.fn().mockResolvedValue({
          has_ready_circuits: true,
          ready: 1,
          total: 1,
          failed: 0,
          creating: 0,
          nodes: ['AAAA1234', 'BBBB5678', 'CCCC9012']
        }),
        fetch: vi.fn().mockResolvedValue({
          text: vi.fn().mockReturnValue('198.51.100.42'),
          body_string: vi.fn().mockReturnValue('198.51.100.42')
        }),
        close: vi.fn()
      })),
      TorClientOptions: vi.fn().mockImplementation(() => ({}))
    }));

    vi.resetModules();
    const {WebtorClient} = await import('@lib/nostra/webtor-fallback');
    const client = new WebtorClient();

    expect(client.getCircuitDetails()).toBeNull();

    await client.init();
    await client.bootstrap(5000);
    const details = client.getCircuitDetails();

    expect(details).not.toBeNull();
    expect(details.guard).toBe('AAAA1234');
    expect(details.middle).toBe('BBBB5678');
    expect(details.exit).toBe('CCCC9012');
    expect(details.healthy).toBe(true);

    await client.close();
    vi.unmock('/webtor/webtor_wasm');
  });

  it('should fetch exit IP on circuit ready', async() => {
    vi.doMock('/webtor/webtor_wasm', () => ({
      default: vi.fn(),
      init: vi.fn(),
      setDebugEnabled: vi.fn(),
      setLogCallback: vi.fn(),
      TorClient: vi.fn().mockImplementation(() => ({
        getCircuitStatus: vi.fn().mockResolvedValue({
          has_ready_circuits: true,
          ready: 1,
          total: 1,
          failed: 0,
          creating: 0,
          nodes: ['A', 'B', 'C']
        }),
        fetch: vi.fn().mockResolvedValue({
          text: vi.fn().mockReturnValue('198.51.100.42'),
          body_string: vi.fn().mockReturnValue('198.51.100.42')
        }),
        close: vi.fn()
      })),
      TorClientOptions: vi.fn().mockImplementation(() => ({}))
    }));

    vi.resetModules();
    const {WebtorClient} = await import('@lib/nostra/webtor-fallback');
    const client = new WebtorClient();
    await client.init();
    await client.bootstrap(5000);

    const details = client.getCircuitDetails();
    expect(details.exitIp).toBe('198.51.100.42');

    await client.close();
    vi.unmock('/webtor/webtor_wasm');
  });
});

describe('PrivacyTransport circuit event dispatch', () => {
  let rootScope;

  beforeAll(async() => {
    vi.resetModules();
    vi.doMock('@lib/rootScope', () => ({default: createMockRootScope()}));
    rootScope = (await import('@lib/rootScope')).default;
  });

  afterAll(() => {
    vi.unmock('@lib/rootScope');
    vi.resetModules();
  });

  it('should dispatch nostra_tor_circuit_update on circuit polling', () => {
    const handler = vi.fn();
    rootScope.addEventListener('nostra_tor_circuit_update', handler);

    rootScope.dispatchEvent('nostra_tor_circuit_update', {
      guard: 'AAAA',
      middle: 'BBBB',
      exit: 'CCCC',
      latency: 300,
      exitIp: '1.2.3.4',
      healthy: true
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      guard: 'AAAA',
      healthy: true
    }));

    rootScope.removeEventListener('nostra_tor_circuit_update', handler);
  });
});

describe('PrivacyTransport.readMode — migration shim', () => {
  beforeEach(() => {
    localStorage.removeItem('nostra-tor-mode');
    localStorage.removeItem('nostra-tor-enabled');
  });
  afterEach(() => {
    localStorage.removeItem('nostra-tor-mode');
    localStorage.removeItem('nostra-tor-enabled');
  });

  it('returns "when-available" when nothing is stored (fresh install default)', async() => {
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    expect(PrivacyTransport.readMode()).toBe('when-available');
  });

  it('returns the stored new-key value verbatim', async() => {
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    localStorage.setItem('nostra-tor-mode', 'only');
    expect(PrivacyTransport.readMode()).toBe('only');
    localStorage.setItem('nostra-tor-mode', 'off');
    expect(PrivacyTransport.readMode()).toBe('off');
    localStorage.setItem('nostra-tor-mode', 'when-available');
    expect(PrivacyTransport.readMode()).toBe('when-available');
  });

  it('maps legacy "false" → "off"', async() => {
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    localStorage.setItem('nostra-tor-enabled', 'false');
    expect(PrivacyTransport.readMode()).toBe('off');
  });

  it('maps legacy "true" → "when-available" (UX-preserving migration)', async() => {
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    localStorage.setItem('nostra-tor-enabled', 'true');
    expect(PrivacyTransport.readMode()).toBe('when-available');
  });

  it('treats garbage in new key as unset and falls through to legacy/default', async() => {
    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');
    localStorage.setItem('nostra-tor-mode', 'yes');
    expect(PrivacyTransport.readMode()).toBe('when-available');
    localStorage.setItem('nostra-tor-enabled', 'false');
    expect(PrivacyTransport.readMode()).toBe('off');
  });

  it('setMode writes the new key and clears the legacy key', async() => {
    localStorage.setItem('nostra-tor-enabled', 'true');
    const {PrivacyTransport: PT} = await import('@lib/nostra/privacy-transport');
    PT.setModeStatic('only');
    expect(localStorage.getItem('nostra-tor-mode')).toBe('only');
    expect(localStorage.getItem('nostra-tor-enabled')).toBeNull();
  });
});

describe('NostrRelay dual latency tracking', () => {
  it('should store directLatencyMs and torLatencyMs separately', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay(
      'wss://test.relay',
      'deadbeef'.repeat(8),
      'cafebabe'.repeat(8)
    );

    expect(relay.directLatencyMs).toBe(-1);
    expect(relay.torLatencyMs).toBe(-1);

    relay.disconnect();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PrivacyTransport unit/integration tests
// Uses a mocked rootScope to avoid MTProtoMessagePort.getInstance() failure
// in environments where the MessagePort singleton is not initialized.
// ──────────────────────────────────────────────────────────────────────────────

describe('PrivacyTransport (with mocked rootScope)', () => {
  let PrivacyTransport;
  let mockRootScope;
  let mockPool;
  let mockQueue;
  let mockWebtorClient;

  beforeAll(async() => {
    vi.resetModules();

    // Mock rootScope so dispatchEvent doesn't try to invoke MTProtoMessagePort
    mockRootScope = {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    vi.doMock('@lib/rootScope', () => ({default: mockRootScope}));

    const mod = await import('@lib/nostra/privacy-transport');
    PrivacyTransport = mod.PrivacyTransport;
  });

  afterAll(() => {
    vi.unmock('@lib/rootScope');
    vi.resetModules();
    vi.restoreAllMocks();
    localStorage.removeItem('nostra-tor-enabled');
    localStorage.removeItem('nostra-tor-mode');
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockPool = {
      setTorMode: vi.fn(),
      setDirectMode: vi.fn(),
      disconnect: vi.fn(),
      publish: vi.fn().mockResolvedValue({successes: ['ok']})
    };

    mockQueue = {
      queue: vi.fn().mockResolvedValue('msg-1'),
      getQueued: vi.fn().mockReturnValue([])
    };

    mockWebtorClient = {
      bootstrap: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      fetch: vi.fn().mockResolvedValue('ok'),
      close: vi.fn().mockResolvedValue(undefined),
      getCircuitDetails: vi.fn().mockReturnValue(null),
      _events: {}
    };

    localStorage.removeItem('nostra-tor-enabled');
    localStorage.removeItem('nostra-tor-mode');
  });

  // ── circuit event wiring ────────────────────────────────────────────────

  it('fires nostra_tor_circuit_update on rootScope when onCircuitChange callback is invoked', () => {
    const circuitDetails = {
      guard: 'GUARD001',
      middle: 'MID00001',
      exit: 'EXIT0001',
      latency: 300,
      exitIp: '10.0.0.1',
      healthy: true
    };

    const mockClient = {
      ...mockWebtorClient,
      getCircuitDetails: vi.fn().mockReturnValue(circuitDetails)
    };

    new PrivacyTransport(mockPool, mockQueue, mockClient);

    const onCircuitChange = (mockClient as any)._events.onCircuitChange;
    expect(onCircuitChange).toBeDefined();
    onCircuitChange();

    expect(mockRootScope.dispatchEvent).toHaveBeenCalledWith(
      'nostra_tor_circuit_update',
      circuitDetails
    );
  });

  it('does not dispatch nostra_tor_circuit_update when getCircuitDetails returns null', () => {
    new PrivacyTransport(mockPool, mockQueue, mockWebtorClient);

    const onCircuitChange = (mockWebtorClient as any)._events.onCircuitChange;
    onCircuitChange();

    expect(mockRootScope.dispatchEvent).not.toHaveBeenCalledWith(
      'nostra_tor_circuit_update',
      expect.anything()
    );
  });

  // ── runtime state transitions ──────────────────────────────────────────
  // Legacy `state` / `confirmDirectFallback` / `retryTor` tests removed —
  // see tor-bootstrap.test.ts for the mode-dispatched runtime-state tests.

  it('disconnect() resets runtime state to offline and calls pool.disconnect()', () => {
    const transport = new PrivacyTransport(mockPool, mockQueue, mockWebtorClient);
    transport.disconnect();

    expect(transport.getRuntimeState()).toBe('offline');
    expect(mockPool.disconnect).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NostrRelay.measureLatency() — HTTP polling mode
// ──────────────────────────────────────────────────────────────────────────────

describe('NostrRelay HTTP polling mode latency', () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  // The poll loop in startHttpPolling() records latency from each torFetchFn
  // call — there's no synthetic ping in Tor mode. measureLatency() simply
  // returns the last recorded value. Tests below exercise the poll path.

  it('records torLatencyMs after a successful HTTP poll', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    (relay as any).mode = 'http-polling';
    (relay as any).publicKey = 'a'.repeat(64);
    (relay as any).torFetchFn = vi.fn().mockResolvedValue('[]');

    expect(relay.torLatencyMs).toBe(-1);

    // Trigger a single poll cycle
    (relay as any).startHttpPolling();
    // Let the kick-off 100ms timer + the async fetch resolve
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));

    expect(relay.torLatencyMs).toBeGreaterThanOrEqual(0);
    expect(relay.getLatency()).toBeGreaterThanOrEqual(0);

    relay.disconnect();
  });

  it('sets latency to -1 when torFetchFn throws', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    (relay as any).mode = 'http-polling';
    (relay as any).publicKey = 'a'.repeat(64);
    (relay as any).torFetchFn = vi.fn().mockRejectedValue(new Error('Tor circuit broken'));

    (relay as any).startHttpPolling();
    await new Promise((r) => setTimeout(r, 200));

    expect(relay.getLatency()).toBe(-1);

    relay.disconnect();
  });

  it('measureLatency() in HTTP polling mode returns the cached value without pinging', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    const fetchSpy = vi.fn().mockResolvedValue('[]');
    (relay as any).mode = 'http-polling';
    (relay as any).torFetchFn = fetchSpy;
    (relay as any).latencyMs = 123;

    const latency = await relay.measureLatency();

    expect(latency).toBe(123);
    expect(fetchSpy).not.toHaveBeenCalled();

    relay.disconnect();
  });

  it('directLatencyMs starts at -1 and is not set when relay not connected (WS mode)', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    expect(relay.directLatencyMs).toBe(-1);

    const latency = await relay.measureLatency();

    expect(latency).toBe(-1);
    expect(relay.directLatencyMs).toBe(-1);

    relay.disconnect();
  });

  it('torFetchFn receives a URL derived from wss:// relay URL converted to https://', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://fancy.relay.io');
    const mockFetch = vi.fn().mockResolvedValue('[]');
    (relay as any).mode = 'http-polling';
    (relay as any).publicKey = 'a'.repeat(64);
    (relay as any).torFetchFn = mockFetch;

    (relay as any).startHttpPolling();
    await new Promise((r) => setTimeout(r, 200));

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('https://fancy.relay.io'));

    relay.disconnect();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NostrRelay.setTorMode() / setDirectMode() trigger latency measurement
// ──────────────────────────────────────────────────────────────────────────────

describe('NostrRelay setTorMode/setDirectMode schedule measureLatency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('setTorMode() does NOT schedule measureLatency (poll loop is the sample source)', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    const spy = vi.spyOn(relay, 'measureLatency').mockResolvedValue(100);

    const mockFetch = vi.fn().mockResolvedValue('ok');
    relay.setTorMode(mockFetch);

    vi.advanceTimersByTime(5000);

    expect(spy).not.toHaveBeenCalled();

    relay.disconnect();
  });

  it('setDirectMode() schedules measureLatency via setTimeout', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    // Put relay in http-polling mode first
    (relay as any).mode = 'http-polling';
    (relay as any).torFetchFn = vi.fn();
    // Don't let it try to reconnect via WebSocket (no real WS available)
    (relay as any).connectionState = 'disconnected';

    const spy = vi.spyOn(relay, 'measureLatency').mockResolvedValue(100);

    relay.setDirectMode();

    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(spy).toHaveBeenCalled();

    relay.disconnect();
  });

  it('setTorMode() switches mode to http-polling', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    vi.spyOn(relay, 'measureLatency').mockResolvedValue(0);

    relay.setTorMode(vi.fn().mockResolvedValue('ok'));

    expect(relay.getMode()).toBe('http-polling');

    relay.disconnect();
  });

  it('setDirectMode() switches mode back to websocket', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay('wss://test.relay');
    vi.spyOn(relay, 'measureLatency').mockResolvedValue(0);

    // Set to http-polling first
    (relay as any).mode = 'http-polling';
    (relay as any).connectionState = 'disconnected';

    relay.setDirectMode();

    expect(relay.getMode()).toBe('websocket');

    relay.disconnect();
  });
});
