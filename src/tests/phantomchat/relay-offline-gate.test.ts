/**
 * Offline-aware retry gate (dial-storm fix).
 *
 * Field symptom: a hard network outage produced 300+ failed relay dials per
 * minute (all 7 relays redialed in lockstep), and the return of connectivity
 * stacked a fresh all-relay dial wave on every 'online' flap. The gate makes
 * `navigator.onLine === false` suspend all pool supervision and per-relay burst
 * retries behind ONE slow probe (30s), and coalesces 'online' flap clusters
 * into a single debounced redial wave.
 *
 * Drives the pool's supervisor and a bare relay retry loop directly with stub
 * instances + fake timers so the test is deterministic without real sockets.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import '../setup';
import {NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';
import {createNostrRelay} from '@lib/phantomchat/nostr-relay';

function setOnLine(value: boolean): void {
  vi.stubGlobal('navigator', {onLine: value});
}

function stubInstance() {
  let state = 'disconnected';
  return {
    getState: () => state,
    _set: (s: string) => { state = s; },
    disconnect: vi.fn(() => { state = 'disconnected'; }),
    initialize: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(() => { state = 'connected'; }),
    resetReconnectBackoff: vi.fn(),
    pendingSubscribe: false
  };
}

// Minimal WebSocket mock: counts dials, never opens on its own.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static count = 0;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.count++;
  }

  send(): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('offline gate: pool supervision', () => {
  let pool: any;

  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(false);
    pool = new NostrRelayPool({
      relays: [{url: 'wss://gate-a', read: true, write: true}],
      onMessage: () => {}
    });
  });

  afterEach(() => {
    pool.disconnect();
    vi.useRealTimers();
    // setOnLine / MockWebSocket stub globals via vi.stubGlobal — restore the
    // real ones so a --no-isolate run or a future file merge cannot leak them.
    vi.unstubAllGlobals();
  });

  it('dials nothing while offline and parks on the slow probe', async() => {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url: 'wss://gate-a', read: true, write: true}, instance});

    await pool.superviseConnections();

    expect(instance.connect).not.toHaveBeenCalled();
    expect(instance.initialize).not.toHaveBeenCalled();
    expect(pool.offlineProbeTimer).not.toBeNull();

    // Repeated sweeps during the outage stay silent (single-flight probe).
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await pool.superviseConnections();
    expect(instance.connect).not.toHaveBeenCalled();
  });

  it('the slow probe runs one recovery wave when the network returns without an online event', async() => {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url: 'wss://gate-a', read: true, write: true}, instance});

    await pool.superviseConnections();
    expect(instance.connect).not.toHaveBeenCalled();

    // Quiet return: onLine flips true but no 'online' event fires.
    setOnLine(true);
    await vi.advanceTimersByTimeAsync(30_000);

    // The probe fires at 30s and routes recovery through the same debounced
    // wave as 'online' — nothing dials until the wave settles.
    expect(instance.resetReconnectBackoff).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(instance.resetReconnectBackoff).toHaveBeenCalledTimes(1);
    expect(instance.connect).toHaveBeenCalledTimes(1);

    // The probe does not re-arm once recovery has run.
    expect(pool.offlineProbeTimer).toBeNull();
  });

  it('probe recovery and a late online event inside the debounce window fire ONE wave', async() => {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url: 'wss://gate-a', read: true, write: true}, instance});

    await pool.superviseConnections();
    expect(pool.offlineProbeTimer).not.toBeNull();

    // Network returns silently; the probe runs recovery at 30s...
    setOnLine(true);
    await vi.advanceTimersByTimeAsync(30_000);

    // ...and the late 'online' event lands inside the debounce window.
    pool.onOnline();
    await vi.advanceTimersByTimeAsync(60_000);

    // The two triggers coalesce: exactly one wave, no double-fire.
    expect(instance.resetReconnectBackoff).toHaveBeenCalledTimes(1);
    expect(instance.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnect() clears the offline probe and wave timers', async() => {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url: 'wss://gate-a', read: true, write: true}, instance});

    await pool.superviseConnections();
    expect(pool.offlineProbeTimer).not.toBeNull();
    pool.onOnline(); // schedules a wave
    expect(pool.onlineWaveTimer).not.toBeNull();

    pool.disconnect();
    expect(pool.offlineProbeTimer).toBeNull();
    expect(pool.onlineWaveTimer).toBeNull();
  });

  it('coalesces a cluster of online flaps into a single redial wave', async() => {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url: 'wss://gate-a', read: true, write: true}, instance});

    setOnLine(true);
    pool.onOnline();
    await vi.advanceTimersByTimeAsync(2_000);
    pool.onOnline();
    pool.onOnline();

    // Nothing dials until the debounce settles 5s after the LAST flap.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(instance.resetReconnectBackoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.resetReconnectBackoff).toHaveBeenCalledTimes(1);

    // Exactly one wave: no stacked follow-ups from late timers or the probe.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instance.resetReconnectBackoff).toHaveBeenCalledTimes(1);
  });
});

describe('offline gate: per-relay retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.count = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connect() while offline defers the dial and redials on the probe', async() => {
    setOnLine(false);
    const relay = createNostrRelay('wss://gate-b');

    relay.connect();

    expect(MockWebSocket.count).toBe(0);
    expect(relay.getState()).toBe('reconnecting');

    setOnLine(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWebSocket.count).toBe(1);
  });

  it('a drop mid-outage skips the burst entirely and parks on the probe', async() => {
    setOnLine(true);
    const relay = createNostrRelay('wss://gate-c');
    relay.connect();
    expect(MockWebSocket.count).toBe(1);

    // Outage begins, then the socket dies.
    setOnLine(false);
    const ws = (relay as any).ws as MockWebSocket;
    ws.close();

    // The normal burst would have re-dialed at 1s, 2s, 4s: none may fire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWebSocket.count).toBe(1);

    setOnLine(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWebSocket.count).toBe(2);
  });
});
