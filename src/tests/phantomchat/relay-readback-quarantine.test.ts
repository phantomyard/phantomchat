/**
 * Read-back-driven WRITE quarantine (issue #359).
 *
 * THE BUG. The pool already had health machinery — flap detection, cooldowns,
 * a bench cap, a liveness floor — but all of it is driven by CONNECTION
 * failures. Jeroen's 4 bad relays connect perfectly and ACK every publish with
 * OK:true, then silently drop the event. They are completely invisible to the
 * flap machinery, so we published to them on every message, forever.
 *
 * #130 added read-back verification, which detects exactly this and warns. It
 * was diagnostic only — the pool had zero references to it. This wires that
 * existing signal into a decision, reusing the pool rather than duplicating it.
 *
 * What these tests pin:
 *   1. Consecutive read-back failures quarantine a relay from WRITES.
 *   2. Quarantine never disconnects — the socket and read subscription stay,
 *      which is what makes promotion free (warm spare).
 *   3. A single confirmed store clears the streak (blip immunity) and releases
 *      an active quarantine early.
 *   4. The floor of 3 is a hard constraint that outranks quarantine.
 *   5. Ranking is deterministic and pure, matching phantombot's, so the two
 *      ends converge on the same subset instead of drifting to disjoint sets.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import '../setup';
import {NostrRelayPool} from '@lib/phantomchat/nostr-relay-pool';
import {
  MIN_WRITE_RELAYS,
  READBACK_QUARANTINE_BASE_MS,
  READBACK_QUARANTINE_MAX_MS,
  READBACK_STRIKE_THRESHOLD,
  emptyReadBackHealth,
  quarantineSpanMs,
  rankRelays,
  relayScore,
  selectWriteTargets,
  type ReadBackHealth
} from '@lib/phantomchat/relay-ranking';

function stubInstance() {
  let state = 'connected';
  return {
    getState: () => state,
    _set: (s: string) => { state = s; },
    disconnect: vi.fn(() => { state = 'disconnected'; }),
    initialize: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(() => { state = 'connected'; }),
    resetReconnectBackoff: vi.fn(),
    publishRawEvent: vi.fn(),
    pendingSubscribe: false,
    onReadBackResult: null as null | ((url: string, ok: boolean) => void)
  };
}

const SEVEN = [
  'wss://r1', 'wss://r2', 'wss://r3', 'wss://r4', 'wss://r5', 'wss://r6', 'wss://r7'
];

describe('read-back write quarantine', () => {
  let pool: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Fixed jitter so spans are deterministic in these tests.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    pool = new NostrRelayPool({
      relays: SEVEN.map(url => ({url, read: true, write: true})),
      onMessage: () => {}
    });
    pool.relayEntries = SEVEN.map(url => ({
      config: {url, read: true, write: true},
      instance: stubInstance()
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function drop(url: string, times = READBACK_STRIKE_THRESHOLD) {
    for(let i = 0; i < times; i++) pool.recordReadBackResult(url, false);
  }

  it('does not quarantine before the strike threshold', () => {
    drop('wss://r1', READBACK_STRIKE_THRESHOLD - 1);
    expect(pool.isWriteQuarantined('wss://r1')).toBe(false);
  });

  it('quarantines a relay that ACKs but never stores', () => {
    drop('wss://r1');
    expect(pool.isWriteQuarantined('wss://r1')).toBe(true);
    const urls = pool.writeEntries().map((e: any) => e.config.url);
    expect(urls).not.toContain('wss://r1');
  });

  it('NEVER disconnects a write-quarantined relay (it stays a warm spare)', () => {
    drop('wss://r1');
    const entry = pool.relayEntries.find((e: any) => e.config.url === 'wss://r1');
    // The whole point: reads keep flowing and the socket stays open, so
    // promoting it back later costs nothing.
    expect(entry.instance.disconnect).not.toHaveBeenCalled();
    expect(entry.instance.getState()).toBe('connected');
  });

  it('one confirmed store clears the streak — a blip is not a quarantine', () => {
    drop('wss://r1', READBACK_STRIKE_THRESHOLD - 1);
    pool.recordReadBackResult('wss://r1', true);
    drop('wss://r1', READBACK_STRIKE_THRESHOLD - 1);
    expect(pool.isWriteQuarantined('wss://r1')).toBe(false);
  });

  it('a confirmed store while quarantined releases it early', () => {
    drop('wss://r1');
    expect(pool.isWriteQuarantined('wss://r1')).toBe(true);
    pool.recordReadBackResult('wss://r1', true);
    expect(pool.isWriteQuarantined('wss://r1')).toBe(false);
  });

  it('quarantine expires lazily — no timer needed', () => {
    drop('wss://r1');
    expect(pool.isWriteQuarantined('wss://r1', READBACK_QUARANTINE_BASE_MS - 1)).toBe(true);
    expect(pool.isWriteQuarantined('wss://r1', READBACK_QUARANTINE_BASE_MS + 1)).toBe(false);
  });

  it('repeat offences back off exponentially', () => {
    drop('wss://r1');
    const first = pool.getReadBackHealth().get('wss://r1')!.quarantinedUntil;
    expect(first).toBe(READBACK_QUARANTINE_BASE_MS); // jitter mocked to 1.0

    vi.setSystemTime(first + 1);
    drop('wss://r1');
    const second = pool.getReadBackHealth().get('wss://r1')!.quarantinedUntil;
    expect(second - (first + 1)).toBe(READBACK_QUARANTINE_BASE_MS * 2);
  });

  it('holds the floor of 3 even when every relay is bad', () => {
    for(const url of SEVEN) drop(url);
    const urls = pool.writeEntries().map((e: any) => e.config.url);
    expect(urls.length).toBe(MIN_WRITE_RELAYS);
  });

  it('promotes quarantined relays back to fill the floor', () => {
    for(const url of SEVEN.slice(0, 5)) drop(url);
    const urls = pool.writeEntries().map((e: any) => e.config.url);
    expect(urls.length).toBe(MIN_WRITE_RELAYS);
    expect(urls).toContain('wss://r6');
    expect(urls).toContain('wss://r7');
  });

  it('leaves the healthy set alone when it is already above the floor', () => {
    drop('wss://r1');
    const urls = pool.writeEntries().map((e: any) => e.config.url).sort();
    expect(urls).toEqual(['wss://r2', 'wss://r3', 'wss://r4', 'wss://r5', 'wss://r6', 'wss://r7']);
  });

  it('never trims when at or below the floor to begin with', () => {
    pool.relayEntries = SEVEN.slice(0, 3).map(url => ({
      config: {url, read: true, write: true},
      instance: stubInstance()
    }));
    for(const url of SEVEN.slice(0, 3)) drop(url);
    expect(pool.writeEntries().length).toBe(3);
  });

  it('respects user-disabled relays independently of quarantine', () => {
    pool.enabled.set('wss://r7', false);
    const urls = pool.writeEntries().map((e: any) => e.config.url);
    expect(urls).not.toContain('wss://r7');
  });

  it('wires the relay read-back hook through createRelayEntry', () => {
    const entry = pool.createRelayEntry({url: 'wss://hooked', read: true, write: true});
    expect(typeof entry.instance.onReadBackResult).toBe('function');
    entry.instance.onReadBackResult('wss://hooked', false);
    expect(pool.getReadBackHealth().get('wss://hooked')!.dropped).toBe(1);
  });
});

describe('deterministic ranking (must match phantombot exactly)', () => {
  it('is a pure total order — same observations, same result', () => {
    const health = new Map<string, ReadBackHealth>([
      ['wss://r1', {...emptyReadBackHealth(), confirmed: 10}],
      ['wss://r2', {...emptyReadBackHealth(), confirmed: 5, dropped: 5}]
    ]);
    expect(rankRelays(SEVEN, health)).toEqual(rankRelays([...SEVEN].reverse(), health));
  });

  it('breaks ties by url, so a fresh client picks the same relays as everyone', () => {
    expect(rankRelays(SEVEN, new Map())).toEqual([...SEVEN].sort());
  });

  it('scores an unobserved relay optimistically at 1', () => {
    expect(relayScore(undefined)).toBe(1);
    expect(relayScore(emptyReadBackHealth())).toBe(1);
  });

  it('ranks a dropping relay below a confirming one', () => {
    const health = new Map<string, ReadBackHealth>([
      ['wss://r1', {...emptyReadBackHealth(), dropped: 10}],
      ['wss://r7', {...emptyReadBackHealth(), confirmed: 10}]
    ]);
    const ranked = rankRelays(SEVEN, health);
    expect(ranked.indexOf('wss://r7')).toBeLessThan(ranked.indexOf('wss://r1'));
    expect(ranked[ranked.length - 1]).toBe('wss://r1');
  });

  it('penalises a currently-striking relay against an equal lifetime ratio', () => {
    const clean = {...emptyReadBackHealth(), confirmed: 10};
    expect(relayScore({...clean, strikes: 3})).toBeLessThan(relayScore(clean));
  });

  it('caps the exponential backoff', () => {
    expect(quarantineSpanMs(0)).toBe(READBACK_QUARANTINE_BASE_MS);
    expect(quarantineSpanMs(1)).toBe(READBACK_QUARANTINE_BASE_MS * 2);
    expect(quarantineSpanMs(99)).toBe(READBACK_QUARANTINE_MAX_MS);
  });

  it('selectWriteTargets holds the floor and prefers the least-bad promotion', () => {
    const health = new Map<string, ReadBackHealth>();
    // r1..r5 quarantined; r1 has a good lifetime ratio, the rest never stored.
    for(const url of SEVEN.slice(0, 5)) {
      health.set(url, {...emptyReadBackHealth(), dropped: 20, quarantinedUntil: 10_000});
    }
    health.set('wss://r1', {
      ...emptyReadBackHealth(), confirmed: 100, dropped: 5, quarantinedUntil: 10_000
    });
    const targets = selectWriteTargets(SEVEN, health, 0);
    expect(targets.length).toBe(MIN_WRITE_RELAYS);
    expect(targets).toContain('wss://r6');
    expect(targets).toContain('wss://r7');
    expect(targets).toContain('wss://r1'); // best of the quarantined
  });
});
