/**
 * Relay flap cooldown (#2). A relay that keeps dropping shortly after it
 * connects gets an exponential cooldown: the pool stops its self-reconnect
 * (disconnect) and the recovery sweep skips it until the cooldown expires.
 * Healthy relays (long-lived sessions) are never penalised.
 *
 * Drives the pool's flap logic directly with stub entries + fake timers so the
 * test is deterministic and doesn't depend on real sockets.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import '../setup';
import {NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';

function stubInstance() {
  let state = 'disconnected';
  return {
    getState: () => state,
    _set: (s: string) => { state = s; },
    disconnect: vi.fn(() => { state = 'disconnected'; }),
    initialize: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(() => { state = 'connected'; }),
    pendingSubscribe: false
  };
}

describe('relay flap cooldown', () => {
  let pool: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pool = new NostrRelayPool({
      relays: [{url: 'wss://flap', read: true, write: true}],
      onMessage: () => {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function addRelay(url: string) {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url, read: true, write: true}, instance});
    return instance;
  }

  // Simulate "connect, then drop after `connectedForMs`".
  function flap(url: string, instance: ReturnType<typeof stubInstance>, connectedForMs: number) {
    instance._set('connected');
    pool.trackRelayHealth(url, 'connected');
    vi.advanceTimersByTime(connectedForMs);
    instance._set('reconnecting');
    pool.trackRelayHealth(url, 'reconnecting');
  }

  it('cools down a relay after 3 quick flaps and stops its self-reconnect', () => {
    const url = 'wss://flap';
    const instance = addRelay(url);

    flap(url, instance, 1_000); // flap 1
    flap(url, instance, 1_000); // flap 2
    expect(instance.disconnect).not.toHaveBeenCalled();

    flap(url, instance, 1_000); // flap 3 -> threshold

    const health = pool.relayHealth.get(url);
    expect(health.flaps).toBe(3);
    expect(health.cooldownUntil).toBeGreaterThan(Date.now());
    // first cooldown is the 60s base
    expect(health.cooldownUntil - Date.now()).toBe(60_000);
    // self-reconnect was stopped
    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does NOT penalise a healthy long-lived session', () => {
    const url = 'wss://flap';
    const instance = addRelay(url);

    flap(url, instance, 1_000); // flap 1
    flap(url, instance, 1_000); // flap 2
    flap(url, instance, 45_000); // healthy session -> resets the streak

    const health = pool.relayHealth.get(url);
    expect(health.flaps).toBe(0);
    expect(health.cooldownUntil).toBe(0);
    expect(instance.disconnect).not.toHaveBeenCalled();
  });

  it('recovery sweep skips a cooled-down relay (while another stays active), then revives it', () => {
    // A healthy relay holds a live slot so the pool is never fully benched —
    // that keeps the liveness floor from firing so we can observe the pure
    // cooldown-skip behaviour on the flapping relay.
    const healthy = addRelay('wss://healthy');
    healthy._set('connected');
    pool.activeUrls.add('wss://healthy');

    const url = 'wss://flap';
    const instance = addRelay(url);

    flap(url, instance, 1_000);
    flap(url, instance, 1_000);
    flap(url, instance, 1_000); // cooled down, instance now 'disconnected'

    instance.initialize.mockClear();

    // While cooling down, the recovery sweep must NOT retry it.
    pool.recoverFailedRelays();
    expect(instance.initialize).not.toHaveBeenCalled();

    // After the cooldown expires, the next sweep revives it.
    vi.setSystemTime(pool.relayHealth.get(url).cooldownUntil + 1);
    pool.recoverFailedRelays();
    expect(instance.initialize).toHaveBeenCalledTimes(1);
  });

  it('liveness floor: revives the last benched relay even during its cooldown (never deadlocks)', () => {
    const url = 'wss://flap';
    const instance = addRelay(url);

    flap(url, instance, 1_000);
    flap(url, instance, 1_000);
    flap(url, instance, 1_000); // benched; the pool now has ZERO active relays

    instance.initialize.mockClear();

    // No relay is active — the liveness floor force-revives one despite the
    // cooldown so the pool can never sit disconnected forever. This is the fix
    // for the mobile "reconnecting forever" deadlock.
    expect(pool.relayHealth.get(url).cooldownUntil).toBeGreaterThan(Date.now());
    pool.recoverFailedRelays();
    expect(instance.initialize).toHaveBeenCalledTimes(1);
  });

  it('escalates the cooldown exponentially on continued flapping', () => {
    const url = 'wss://flap';
    const instance = addRelay(url);

    flap(url, instance, 1_000);
    flap(url, instance, 1_000);
    flap(url, instance, 1_000); // flaps=3 -> 60s
    let health = pool.relayHealth.get(url);
    expect(health.cooldownUntil - Date.now()).toBe(60_000);

    flap(url, instance, 1_000); // flaps=4 -> 120s
    health = pool.relayHealth.get(url);
    expect(health.cooldownUntil - Date.now()).toBe(120_000);
  });
});

describe('network-event detection (correlated drops)', () => {
  let pool: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pool = new NostrRelayPool({
      relays: [],
      onMessage: () => {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function addRelay(url: string) {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url, read: true, write: true}, instance});
    return instance;
  }

  function flap(url: string, instance: ReturnType<typeof stubInstance>, connectedForMs: number) {
    instance._set('connected');
    pool.trackRelayHealth(url, 'connected');
    vi.advanceTimersByTime(connectedForMs);
    instance._set('reconnecting');
    pool.trackRelayHealth(url, 'reconnecting');
  }

  it('does not count flaps when 3+ DISTINCT relays drop inside the window (network blip)', () => {
    const a = addRelay('wss://a');
    const b = addRelay('wss://b');
    const c = addRelay('wss://c');

    // All three connect, then the device network blips: all three drop within
    // the same few seconds. The third distinct relay's drop must be recognised
    // as a network event — no flap, no bench.
    flap('wss://a', a, 1_000); // drop 1 (distinct: a) — counts as a flap
    flap('wss://b', b, 1_000); // drop 2 (distinct: a,b) — counts as a flap
    flap('wss://c', c, 1_000); // drop 3 (distinct: a,b,c) — network event

    expect(pool.relayHealth.get('wss://a').flaps).toBe(1);
    expect(pool.relayHealth.get('wss://b').flaps).toBe(1);
    expect(pool.relayHealth.get('wss://c').flaps).toBe(0); // suppressed
    expect(pool.relayHealth.get('wss://c').cooldownUntil).toBe(0);
    expect(c.disconnect).not.toHaveBeenCalled();
  });

  it('still benches ONE relay flapping alone, even rapidly (not a network event)', () => {
    const instance = addRelay('wss://lonely');

    // 3 quick flaps from the SAME relay — distinct-url count never reaches the
    // threshold, so flap accounting applies unchanged.
    flap('wss://lonely', instance, 1_000);
    flap('wss://lonely', instance, 1_000);
    flap('wss://lonely', instance, 1_000);

    const health = pool.relayHealth.get('wss://lonely');
    expect(health.flaps).toBe(3);
    expect(health.cooldownUntil - Date.now()).toBe(60_000);
    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });

  it('drops outside the window are not correlated', () => {
    const a = addRelay('wss://a');
    const b = addRelay('wss://b');
    const c = addRelay('wss://c');

    flap('wss://a', a, 1_000);
    flap('wss://b', b, 1_000);
    vi.advanceTimersByTime(11_000); // window (10s) expires
    flap('wss://c', c, 1_000); // only 1 distinct url in-window — a real flap

    expect(pool.relayHealth.get('wss://c').flaps).toBe(1);
  });
});

describe('resume triggers reset relay cooldowns', () => {
  let pool: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pool = new NostrRelayPool({
      relays: [],
      onMessage: () => {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function addRelay(url: string) {
    const instance = stubInstance();
    pool.relayEntries.push({config: {url, read: true, write: true}, instance});
    return instance;
  }

  function flap(url: string, instance: ReturnType<typeof stubInstance>, connectedForMs: number) {
    instance._set('connected');
    pool.trackRelayHealth(url, 'connected');
    vi.advanceTimersByTime(connectedForMs);
    instance._set('reconnecting');
    pool.trackRelayHealth(url, 'reconnecting');
  }

  it('clears cooldowns + flap streaks and re-dials benched relays immediately', () => {
    const url = 'wss://flap';
    const instance = addRelay(url);
    pool.activeUrls.add(url);

    flap(url, instance, 1_000);
    flap(url, instance, 1_000);
    flap(url, instance, 1_000); // benched: cooldown set, dropped from active
    expect(pool.relayHealth.get(url).cooldownUntil).toBeGreaterThan(Date.now());
    expect(pool.activeUrls.has(url)).toBe(false);

    instance.initialize.mockClear();

    // App foregrounds / network returns — a fresh context. The cooldown was
    // earned on the PREVIOUS network and must not be served out here.
    pool.resetRelayCooldowns();

    const health = pool.relayHealth.get(url);
    expect(health.cooldownUntil).toBe(0);
    expect(health.flaps).toBe(0);
    expect(health.failedConnects).toBe(0);
    // Re-supervised NOW, not at the next recovery sweep: promoted back to
    // active and re-dialed immediately.
    expect(pool.activeUrls.has(url)).toBe(true);
    expect(instance.initialize).toHaveBeenCalledTimes(1);
  });

  it('is wired into the online resume trigger', () => {
    const spy = vi.spyOn(pool, 'resetRelayCooldowns');
    pool.onOnline();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('catch-up poll is sequential', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queries connected read relays one at a time, in order', async () => {
    vi.useRealTimers(); // the poll awaits real micro-delays per relay
    const pool: any = new NostrRelayPool({relays: [], onMessage: () => {}});
    pool.isSubscribedFlag = true;

    const events: string[] = [];
    const mkRelay = (name: string) => ({
      getState: () => 'connected',
      getMessagesPaged: async() => {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${name}:end`);
        return {messages: [] as any[], outcome: 'exhausted'};
      }
    });
    for(const name of ['a', 'b', 'c']) {
      pool.relayEntries.push({
        config: {url: `wss://${name}`, read: true, write: true},
        instance: mkRelay(name)
      });
    }

    await pool.backfillRecent();

    // A parallel fan-out would interleave (a:start, b:start, c:start, ...).
    expect(events).toEqual([
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end'
    ]);
  });

  it('a slow relay does not skip the ones after it, and a failure does not stop the walk', async () => {
    vi.useRealTimers();
    const pool: any = new NostrRelayPool({relays: [], onMessage: () => {}});
    pool.isSubscribedFlag = true;

    const queried: string[] = [];
    const mkRelay = (name: string, fail = false) => ({
      getState: () => 'connected',
      getMessagesPaged: async() => {
        queried.push(name);
        if(fail) throw new Error('relay down');
        return {messages: [] as any[], outcome: 'exhausted'};
      }
    });
    pool.relayEntries.push(
      {config: {url: 'wss://a', read: true, write: true}, instance: mkRelay('a')},
      {config: {url: 'wss://b', read: true, write: true}, instance: mkRelay('b', true)},
      {config: {url: 'wss://c', read: true, write: true}, instance: mkRelay('c')}
    );

    await pool.backfillRecent();
    expect(queried).toEqual(['a', 'b', 'c']);
  });
});
