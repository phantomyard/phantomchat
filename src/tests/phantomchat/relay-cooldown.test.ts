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

  it('recovery sweep skips a cooled-down relay, then revives it after the cooldown', () => {
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
