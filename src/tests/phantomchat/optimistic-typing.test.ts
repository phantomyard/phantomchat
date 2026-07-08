/**
 * Tests for the optimistic typing indicator (optimistic-typing.ts).
 *
 * When the user sends a message, the manager immediately dispatches a typing
 * update for the peer and keeps it alive for up to 10 seconds (refreshing at
 * 5s to beat the 6s native auto-expiry). When a reply arrives (stop is
 * called), the indicator is cleared and timers are cancelled.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {optimisticTyping} from '@lib/phantomchat/optimistic-typing';
import {setReadReceiptsEnabledSetting} from '@lib/phantomchat/read-receipts-setting';

const PEER_PUBKEY = 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344';
const PEER_ID = 1234567890123456;

describe('OptimisticTyping', () => {
  let dispatches: {peerId: number; isStop: boolean}[];
  let resolver: any;
  let dispatcher: any;

  beforeEach(() => {
    vi.useFakeTimers();
    setReadReceiptsEnabledSetting(true);
    dispatches = [];
    resolver = vi.fn().mockResolvedValue(PEER_ID);
    dispatcher = vi.fn().mockImplementation((peerId: number, isStop: boolean) => {
      dispatches.push({peerId, isStop});
    });
    optimisticTyping.setPeerResolver(resolver);
    optimisticTyping.setTypingDispatcher(dispatcher);
  });

  afterEach(() => {
    // Clean up any active timers.
    optimisticTyping.stop(PEER_PUBKEY);
    vi.useRealTimers();
  });

  it('fires typing immediately on start', async() => {
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual({peerId: PEER_ID, isStop: false});
  });

  it('re-fires typing at 5s to keep the 6s native auto-expiry alive', async() => {
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(1); // t=0

    vi.advanceTimersByTime(5_000);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toEqual({peerId: PEER_ID, isStop: false});
  });

  it('hard-stops at 10s and clears the indicator', async() => {
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    expect(dispatches).toHaveLength(2); // refresh

    vi.advanceTimersByTime(5_000); // total 10s
    expect(dispatches).toHaveLength(3);
    expect(dispatches[2]).toEqual({peerId: PEER_ID, isStop: true});

    // No more dispatches after hard stop.
    vi.advanceTimersByTime(5_000);
    expect(dispatches).toHaveLength(3);
  });

  it('stop() clears the indicator immediately and cancels timers', async() => {
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(1);

    optimisticTyping.stop(PEER_PUBKEY);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toEqual({peerId: PEER_ID, isStop: true});

    // No more dispatches after stop.
    vi.advanceTimersByTime(10_000);
    expect(dispatches).toHaveLength(2);
  });

  it('stop() on a non-active peer is a safe no-op', () => {
    optimisticTyping.stop('unknown-pubkey');
    expect(dispatches).toHaveLength(0);
  });

  it('start() while already active resets the timer (no stacking)', async() => {
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(1);

    // Advance 3s, then restart.
    vi.advanceTimersByTime(3_000);
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(2); // stop(silent) + start

    // At 5s after the SECOND start (8s total), the refresh fires.
    vi.advanceTimersByTime(5_000);
    expect(dispatches).toHaveLength(3);
    expect(dispatches[2]).toEqual({peerId: PEER_ID, isStop: false});

    // At 10s after the second start, hard stop fires.
    vi.advanceTimersByTime(5_000);
    expect(dispatches.some(d => d.isStop === true)).toBe(true);
  });

  it('isActive() reports the correct state', async() => {
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);
    await optimisticTyping.start(PEER_PUBKEY);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(true);
    optimisticTyping.stop(PEER_PUBKEY);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);
  });

  it('isActive() is false after the 10s hard stop', async() => {
    await optimisticTyping.start(PEER_PUBKEY);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);
  });

  it('gracefully handles resolver failure (no dispatch, no throw)', async() => {
    resolver.mockRejectedValue(new Error('bridge not ready'));
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(0);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);
  });

  it('overlapping async start() calls do not orphan timers', async() => {
    // Make the resolver resolve on the next tick so both starts overlap.
    let resolveA!: () => void;
    let resolveB!: () => void;
    let callCount = 0;
    resolver.mockImplementation(() => {
      callCount++;
      return new Promise<number>((resolve) => {
        if(callCount === 1) resolveA = () => resolve(PEER_ID);
        else resolveB = () => resolve(PEER_ID);
      });
    });

    // Fire both starts — neither resolves yet.
    const p1 = optimisticTyping.start(PEER_PUBKEY);
    const p2 = optimisticTyping.start(PEER_PUBKEY);

    // Both are awaiting the resolver. Only one active entry should exist.
    // Resolve the second start first (simulating rapid sends).
    resolveB();
    await p2;

    // Second start dispatched typing. First start hasn't resolved yet.
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual({peerId: PEER_ID, isStop: false});
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(true);

    // Now resolve the first (older) start — it should abort, not dispatch.
    resolveA();
    await p1;

    expect(dispatches).toHaveLength(1); // No extra dispatch from the stale call

    // Verify only one set of timers is active — advance to 10s, expect:
    // dispatch 1: typing at t=0, dispatch 2: refresh at t=5s, dispatch 3: stop at t=10s.
    vi.advanceTimersByTime(10_000);
    expect(dispatches).toHaveLength(3);
    expect(dispatches[2]).toEqual({peerId: PEER_ID, isStop: true});
  });

  it('stop() during an unresolved start() prevents the stale start from dispatching', async() => {
    // Scenario: start() begins awaiting resolver, then stop() fires (reply
    // arrives) before the resolver resolves. The stale start() must abort,
    // NOT re-enable typing after stop() already cleared it.
    let resolveStart!: () => void;
    resolver.mockImplementation(() => new Promise<number>((resolve) => {
      resolveStart = () => resolve(PEER_ID);
    }));

    // Fire start — it's now awaiting the resolver.
    const p = optimisticTyping.start(PEER_PUBKEY);

    // No dispatches yet (resolver pending).
    expect(dispatches).toHaveLength(0);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);

    // stop() fires while start() is still awaiting. There's no active entry
    // yet, so no cancel dispatch — but generation is bumped.
    optimisticTyping.stop(PEER_PUBKEY);
    expect(dispatches).toHaveLength(0);

    // Now resolve the resolver — the stale start() should see the generation
    // mismatch and abort WITHOUT dispatching typing.
    resolveStart();
    await p;

    expect(dispatches).toHaveLength(0);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);

    // No timers should be running.
    vi.advanceTimersByTime(15_000);
    expect(dispatches).toHaveLength(0);
  });

  it('is disabled when read-receipts / typing privacy toggle is off', async() => {
    setReadReceiptsEnabledSetting(false);
    await optimisticTyping.start(PEER_PUBKEY);
    expect(dispatches).toHaveLength(0);
    expect(optimisticTyping.isActive(PEER_PUBKEY)).toBe(false);

    vi.advanceTimersByTime(15_000);
    expect(dispatches).toHaveLength(0);
  });
});
