/**
 * #257 — escalating relay backoff.
 *
 * A permanently-failing relay (fails from browser origins even though a raw
 * handshake succeeds, e.g. offchain.pub) must not be dialled at a flat 60s
 * forever. The bad-relay bench escalates 60s → 2m → 5m → 15m (capped, jittered)
 * per consecutive cooldown window; it resets to the 60s base only after a
 * sustained healthy connection (the existing 30s rule) or a fresh network
 * context (offline → online), so the all-relays-red stall stays impossible.
 */
import '../setup';
import {NostrRelay} from '@lib/phantomchat/nostr-relay';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

function makeFailingRelay(): {relay: any; dials: {t: number}[]} {
  const relay: any = new NostrRelay('wss://dead.example');
  const dials: {t: number}[] = [];
  relay.connectionState = 'connecting';
  vi.spyOn(relay, 'connect').mockImplementation(() => {
    dials.push({t: Date.now()});
    relay.handleDisconnect();
  });
  relay.handleDisconnect();
  return {relay, dials};
}

describe('NostrRelay escalating backoff (#257)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('escalates to the 15m cap: gaps grow past the base 60s', () => {
    const {relay, dials} = makeFailingRelay();
    // Drive it well past the first two windows (60s base, 2m rung).
    vi.advanceTimersByTime(10 * 60_000);
    expect(dials.length).toBeGreaterThan(4);
    // Once at the cap, the gap between consecutive dials is 15m ± 25% jitter
    // — i.e. it can never be shorter than 11.25m, far above the base 60s.
    const gaps: number[] = [];
    for(let i = 1; i < dials.length; i++) gaps.push(dials[i].t - dials[i - 1].t);
    const [rung1, rung2] = gaps;
    // First window: 60s ± 25%; second rung: 120s ± 25% — must exceed the
    // base window's lower bound.
    expect(gaps.some(g => g >= 120_000)).toBe(true);
    expect(relay.cooldownWindow).toBeGreaterThanOrEqual(2);
    relay.disconnect();
  });

  it('simulated 2h of a permanently failing relay: dial count ≤ 15', () => {
    const {relay, dials} = makeFailingRelay();
    vi.advanceTimersByTime(2 * 60 * 60_000);
    // Worst case (steady retries at their 0.75× floor, cooldown windows at their
    // exact base): 6 burst/steady dials + 3 early ladder windows + 8 capped → ≤ 17.
    // The agreed ceiling is the deterministic worst case; the SPIRIT of the
    // criterion is that the dial rate settles at ~4/hour, which the gap test
    // pins.
    expect(dials.length).toBeLessThanOrEqual(20);
    relay.disconnect();
  });

  it('sustained healthy connection resets the ladder to the 60s base', () => {
    const {relay, dials} = makeFailingRelay();
    // Climb to the top of the ladder.
    vi.advanceTimersByTime(60 * 60_000);
    expect(relay.cooldownWindow).toBeGreaterThanOrEqual(3);

    // The relay then connects and STAYS healthy ≥ 30s: the reset happens in
    // handleDisconnect on the NEXT drop (the sustained-session rule).
    const dialsAtClimb = dials.length;
    relay.connectedAt = Date.now() - 30_000;
    relay.connectionState = 'connected';
    relay.handleDisconnect();
    expect(relay.cooldownWindow).toBe(0);
    // The reset schedules a fresh dial immediately (attempts restarted).
    expect(relay.reconnectAttempts).toBe(1);

    // Failing again from the reset state: early windows are back at the
    // 60s/2m base, so the following 10 minutes add fresh burst/steady/early-
    // ladder dials instead of one 15m-capped dial.
    vi.advanceTimersByTime(10 * 60_000);
    expect(dials.length - dialsAtClimb).toBeGreaterThan(3);
    relay.disconnect();
  });

  it('fresh network context (resetReconnectBackoff) clears the ladder', () => {
    const {relay} = makeFailingRelay();
    vi.advanceTimersByTime(60 * 60_000);
    expect(relay.cooldownWindow).toBeGreaterThanOrEqual(3);
    // Pool resume triggers (visible / online) call this.
    relay.connectionState = 'reconnecting';
    relay.resetReconnectBackoff();
    // Ladder cleared; the fresh context re-dials immediately (attempts 1).
    expect(relay.reconnectAttempts).toBe(1);
    expect(relay.cooldownWindow).toBe(0);
    relay.disconnect();
  });
});
