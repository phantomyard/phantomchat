/**
 * Tests for the send-button-click typing experiment (send-typing-experiment.ts).
 *
 * The experiment fires a purely-local typing update for the peer the instant
 * SEND is clicked, keeps it alive for up to 10s (refreshing at 5s to beat the
 * ~6s native auto-expiry), and clears it immediately when a reply arrives
 * (stop is called) or when the 10s hard-stop fires.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {sendTypingExperiment} from '@lib/phantomchat/send-typing-experiment';

const PEER_ID = 1234567890123456;

describe('SendTypingExperiment', () => {
  let dispatches: {peerId: number; isStop: boolean}[];
  let dispatcher: any;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatches = [];
    dispatcher = vi.fn().mockImplementation((peerId: number, isStop: boolean) => {
      dispatches.push({peerId, isStop});
    });
    sendTypingExperiment.setDispatcher(dispatcher);
  });

  afterEach(() => {
    sendTypingExperiment.stop(PEER_ID);
    vi.useRealTimers();
  });

  it('fires typing immediately on start', () => {
    sendTypingExperiment.start(PEER_ID);
    expect(dispatches).toEqual([{peerId: PEER_ID, isStop: false}]);
    expect(sendTypingExperiment.isActive(PEER_ID)).toBe(true);
  });

  it('re-fires typing at 5s to keep the native auto-expiry alive', () => {
    sendTypingExperiment.start(PEER_ID);
    expect(dispatches).toHaveLength(1); // t=0

    vi.advanceTimersByTime(5_000);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toEqual({peerId: PEER_ID, isStop: false});
  });

  it('hard-stops at 10s with a single cancel and no double-fire', () => {
    sendTypingExperiment.start(PEER_ID);
    vi.advanceTimersByTime(5_000); // refresh
    expect(dispatches).toHaveLength(2);

    vi.advanceTimersByTime(5_000); // hard stop at 10s
    // exactly one cancel, no extra refresh at the 10s boundary
    const stops = dispatches.filter((d) => d.isStop);
    expect(stops).toEqual([{peerId: PEER_ID, isStop: true}]);
    expect(sendTypingExperiment.isActive(PEER_ID)).toBe(false);
  });

  it('stops immediately on reply (before the 10s budget)', () => {
    sendTypingExperiment.start(PEER_ID);
    vi.advanceTimersByTime(2_000);
    sendTypingExperiment.stop(PEER_ID);

    expect(dispatches[dispatches.length - 1]).toEqual({peerId: PEER_ID, isStop: true});
    expect(sendTypingExperiment.isActive(PEER_ID)).toBe(false);

    // no lingering timers should fire after stop
    const countAfterStop = dispatches.length;
    vi.advanceTimersByTime(20_000);
    expect(dispatches).toHaveLength(countAfterStop);
  });

  it('restart on an active peer resets the budget without stacking or flicker', () => {
    sendTypingExperiment.start(PEER_ID);
    vi.advanceTimersByTime(4_000);
    // restart before the first refresh — should NOT emit a cancel (no flicker)
    sendTypingExperiment.start(PEER_ID);

    const stopsSoFar = dispatches.filter((d) => d.isStop);
    expect(stopsSoFar).toHaveLength(0);

    // refresh cadence is measured from the restart, not the original start
    vi.advanceTimersByTime(5_000);
    expect(dispatches.filter((d) => !d.isStop)).toHaveLength(3); // start, restart, refresh
  });

  it('is a no-op for invalid peer ids', () => {
    sendTypingExperiment.start(0);
    sendTypingExperiment.start(-5);
    sendTypingExperiment.start(NaN);
    expect(dispatches).toHaveLength(0);
    expect(sendTypingExperiment.isActive(0)).toBe(false);
  });

  it('stop on an inactive peer is a silent no-op', () => {
    sendTypingExperiment.stop(PEER_ID);
    expect(dispatches).toHaveLength(0);
  });
});
