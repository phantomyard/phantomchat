/**
 * Tests for IdleTransportController — the Phase 1 transport state machine (#125).
 *
 * The controller owns no sockets; it drives three injected hooks (suspend,
 * resume, pollOnce). These tests fake the hooks and the timers so the state
 * machine — mode transitions, the inactivity grace, the 10s→2min backoff, and
 * the visibility/activity triggers — is exercised in complete isolation, with
 * no relay, no network, no jsdom document dependency.
 */

import '../setup';
import {
  IdleTransportController,
  DEFAULT_MIN_TICK_MS,
  DEFAULT_MAX_TICK_MS
} from '@lib/phantomchat/transport-idle-controller';

/**
 * Minimal deterministic timer harness: setTimeout returns an incrementing id,
 * and `advance(ms)` fires every timer whose deadline has passed, in order.
 * Lets us assert exact backoff intervals without real time.
 */
function makeClock() {
  let nowMs = 0;
  let seq = 1;
  const timers = new Map<number, {at: number; fn: () => void}>();
  return {
    now: () => nowMs,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = seq++;
      timers.set(id, {at: nowMs + ms, fn});
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number);
    },
    /** Advance virtual time, firing due timers (earliest first). Async-drains microtasks between fires. */
    advance: async(ms: number) => {
      const target = nowMs + ms;
      // Fire in deadline order until we pass `target`. Re-scan each loop because
      // a fired timer may schedule a new one.
      for(;;) {
        let next: {id: number; at: number; fn: () => void} | null = null;
        for(const [id, t] of timers) {
          if(t.at <= target && (next === null || t.at < next.at)) next = {id, at: t.at, fn: t.fn};
        }
        if(!next) break;
        timers.delete(next.id);
        nowMs = next.at;
        next.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      nowMs = target;
    },
    pending: () => timers.size
  };
}

/** Drain a handful of microtasks so an un-awaited async transition settles. */
async function flush(): Promise<void> {
  for(let i = 0; i < 5; i++) await Promise.resolve();
}

function makeHooks() {
  const calls = {suspend: 0, resume: 0, poll: 0};
  let pollResult = false;
  return {
    calls,
    setPollResult: (v: boolean) => { pollResult = v; },
    hooks: {
      suspend: () => { calls.suspend++; },
      resume: () => { calls.resume++; },
      pollOnce: async() => { calls.poll++; return pollResult; }
    }
  };
}

describe('IdleTransportController', () => {
  it('starts ACTIVE and does not touch sockets until the inactivity grace elapses', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      inactivityMs: 8_000
    });
    c.start();
    expect(c.mode).toBe('active');
    expect(calls.suspend).toBe(0);

    await clock.advance(7_999);
    expect(c.mode).toBe('active'); // grace not yet elapsed

    await clock.advance(2);
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);
  });

  it('backs off the idle tick 10s → 2min while quiet, and holds at the ceiling', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      inactivityMs: 8_000
    });
    c.start();
    await clock.advance(8_001); // → idle, first tick armed at 10s
    expect(c.mode).toBe('idle');
    expect(c.tickIntervalMs).toBe(DEFAULT_MIN_TICK_MS);

    // Each quiet tick doubles the interval: 10 → 20 → 40 → 80 → 120(cap).
    await clock.advance(10_000);
    expect(calls.poll).toBe(1);
    expect(c.tickIntervalMs).toBe(20_000);

    await clock.advance(20_000);
    expect(c.tickIntervalMs).toBe(40_000);

    await clock.advance(40_000);
    expect(c.tickIntervalMs).toBe(80_000);

    await clock.advance(80_000);
    expect(c.tickIntervalMs).toBe(DEFAULT_MAX_TICK_MS); // 160k capped to 120k

    await clock.advance(120_000);
    expect(c.tickIntervalMs).toBe(DEFAULT_MAX_TICK_MS); // stays at ceiling
    expect(calls.poll).toBe(5);
  });

  it('a tick that finds a message while foreground resets backoff AND wakes to ACTIVE', async() => {
    const clock = makeClock();
    const {hooks, calls, setPollResult} = makeHooks();
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      inactivityMs: 8_000
    });
    c.start();
    await clock.advance(8_001);
    await clock.advance(10_000); // quiet tick → interval now 20s
    expect(c.tickIntervalMs).toBe(20_000);

    setPollResult(true); // next tick delivers a message
    await clock.advance(20_000);
    expect(c.mode).toBe('active');
    expect(calls.resume).toBe(1);
  });

  it('a tick that finds a message while backgrounded stays IDLE but resets to fast tick', async() => {
    const clock = makeClock();
    const {hooks, setPollResult} = makeHooks();
    let visible = true;
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => visible,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      inactivityMs: 8_000
    });
    c.start();
    visible = false;
    c.onBackground(); // → idle immediately
    await flush(); // let goIdle settle (suspend + first tick scheduled)
    expect(c.mode).toBe('idle');

    await clock.advance(10_000); // quiet → 20s
    expect(c.tickIntervalMs).toBe(20_000);

    setPollResult(true);
    await clock.advance(20_000); // delivers, but hidden → stay idle, fast tick
    expect(c.mode).toBe('idle');
    expect(c.tickIntervalMs).toBe(DEFAULT_MIN_TICK_MS);
  });

  it('background closes sockets immediately (no grace); foreground catches up via one-shot REQ', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => visible,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now
    });
    c.start();

    visible = false;
    c.onBackground();
    await flush();
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);

    // Let the tick back off to the ceiling while backgrounded.
    await clock.advance(10_000); // → 20s
    await clock.advance(20_000); // → 40s
    await clock.advance(40_000); // → 80s
    await clock.advance(80_000); // → 120s (cap)
    expect(c.tickIntervalMs).toBe(DEFAULT_MAX_TICK_MS);

    // Coming back to foreground fires an immediate catch-up poll and RESETS the
    // backoff — the next cadence is fast again, not stuck at 2min. One quiet
    // catch-up tick lands us at 20s (reset to 10s, then one backoff step),
    // proving the reset happened (it would still be 120s otherwise).
    visible = true;
    const pollsBefore = calls.poll;
    c.onForeground();
    await flush();
    expect(calls.poll).toBe(pollsBefore + 1);
    expect(c.mode).toBe('idle');
    expect(c.tickIntervalMs).toBe(20_000);
  });

  it('noteActivity wakes to ACTIVE from idle and reopens sockets', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      inactivityMs: 8_000
    });
    c.start();
    await clock.advance(8_001);
    expect(c.mode).toBe('idle');

    c.noteActivity();
    await flush();
    expect(c.mode).toBe('active');
    expect(calls.resume).toBe(1);
  });

  it('destroy() stops all timers — no tick or suspend fires afterward', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      inactivityMs: 8_000
    });
    c.start();
    c.destroy();
    expect(clock.pending()).toBe(0);
    await clock.advance(1_000_000);
    expect(calls.suspend).toBe(0);
    expect(calls.poll).toBe(0);
  });

  it('launching hidden goes straight to IDLE without holding a socket open', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = new IdleTransportController({
      hooks,
      bindEnvironment: false,
      isVisible: () => false, // launched behind a backgrounded tab
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now
    });
    c.start();
    await Promise.resolve();
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);
  });
});
