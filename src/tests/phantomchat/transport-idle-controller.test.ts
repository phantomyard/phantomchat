/**
 * Tests for IdleTransportController — the Phase 1 transport state machine (#125).
 *
 * The controller owns no sockets; it drives three injected hooks (suspend,
 * resume, pollOnce). These tests fake the hooks and the timers so the state
 * machine — mode transitions, the hidden→idle grace, the 10s→2min backoff, the
 * Page Lifecycle (freeze/resume) cutover and the opt-in foreground-inactivity
 * timer — is exercised in complete isolation, with no relay, no network, no
 * jsdom document dependency.
 */

import '../setup';
import {
  IdleTransportController,
  DEFAULT_MIN_TICK_MS,
  DEFAULT_MAX_TICK_MS,
  DEFAULT_HIDDEN_GRACE_MS
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

/** Standard controller wired to a fake clock + hooks, environment unbound. */
function makeController(opts: {
  clock: ReturnType<typeof makeClock>;
  hooks: ReturnType<typeof makeHooks>['hooks'];
  visible: () => boolean;
  hiddenGraceMs?: number;
  inactivityMs?: number;
}) {
  return new IdleTransportController({
    hooks: opts.hooks,
    bindEnvironment: false,
    isVisible: opts.visible,
    setTimeoutFn: opts.clock.setTimeoutFn,
    clearTimeoutFn: opts.clock.clearTimeoutFn,
    now: opts.clock.now,
    hiddenGraceMs: opts.hiddenGraceMs,
    inactivityMs: opts.inactivityMs
  });
}

describe('IdleTransportController', () => {
  it('a visible page NEVER idles on its own — no foreground timer by default', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = makeController({clock, hooks, visible: () => true});
    c.start();
    expect(c.mode).toBe('active');
    // No inactivity timer armed (default off) — nothing pending at all.
    expect(clock.pending()).toBe(0);

    // Even after a very long time visible-but-untouched, we stay ACTIVE.
    await clock.advance(60 * 60_000);
    expect(c.mode).toBe('active');
    expect(calls.suspend).toBe(0);
  });

  it('hidden starts a grace timer — a quick glance away keeps the live socket', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onBackground();
    expect(c.hiddenGracePending).toBe(true);
    expect(c.mode).toBe('active'); // still holding the socket during grace

    // Come back before the grace elapses → cancel teardown, stay ACTIVE.
    await clock.advance(DEFAULT_HIDDEN_GRACE_MS - 1);
    visible = true;
    c.onForeground();
    expect(c.hiddenGracePending).toBe(false);
    expect(c.mode).toBe('active');
    expect(calls.suspend).toBe(0); // socket was never dropped
  });

  it('sustained hidden past the grace tears down to tick mode', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onBackground();
    await clock.advance(DEFAULT_HIDDEN_GRACE_MS - 1);
    expect(c.mode).toBe('active');

    await clock.advance(2); // grace elapses
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);
    expect(c.tickIntervalMs).toBe(DEFAULT_MIN_TICK_MS);
  });

  it('freeze hard-closes immediately with NO grace (mobile sleep cutover)', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onFreeze();
    await flush();
    expect(c.mode).toBe('idle');
    expect(c.hiddenGracePending).toBe(false);
    expect(calls.suspend).toBe(1);
  });

  it('freeze during a pending hidden-grace cancels the grace and closes now', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onBackground();
    expect(c.hiddenGracePending).toBe(true);

    c.onFreeze(); // browser suspends us mid-grace
    await flush();
    expect(c.mode).toBe('idle');
    expect(c.hiddenGracePending).toBe(false);
    expect(calls.suspend).toBe(1);
  });

  it('pagehide hard-closes immediately, same as freeze', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onPageHide();
    await flush();
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);
  });

  it('resume while visible goes straight back to ACTIVE', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onFreeze();
    await flush();
    expect(c.mode).toBe('idle');

    visible = true;
    c.onResume(); // unfrozen AND visible
    await flush();
    expect(c.mode).toBe('active');
    expect(calls.resume).toBe(1);
  });

  it('resume while still hidden keeps ticking (does not wake to ACTIVE)', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onFreeze();
    await flush();
    // Back off a couple of ticks so we can prove resume RESETS the cadence.
    await clock.advance(10_000); // → 20s
    await clock.advance(20_000); // → 40s
    expect(c.tickIntervalMs).toBe(40_000);

    c.onResume(); // unfrozen but still background
    await flush();
    expect(c.mode).toBe('idle');
    expect(calls.resume).toBe(0); // did NOT wake
    // Resume kicks an immediate catch-up tick and resets backoff → next is 20s.
    expect(c.tickIntervalMs).toBe(20_000);
  });

  it('backs off the idle tick 10s → 2min while quiet, and holds at the ceiling', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();
    visible = false;
    c.onFreeze(); // → idle, first tick armed at 10s
    await flush();
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
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();
    // Drop to idle via a hard freeze, then pretend the tab is visible again so
    // the tick's "message-while-foreground" branch can fire.
    c.onFreeze();
    await flush();
    await clock.advance(10_000); // quiet tick → interval now 20s
    expect(c.tickIntervalMs).toBe(20_000);

    visible = true;
    setPollResult(true); // next tick delivers a message
    await clock.advance(20_000);
    expect(c.mode).toBe('active');
    expect(calls.resume).toBe(1);
  });

  it('a tick that finds a message while backgrounded stays IDLE but resets to fast tick', async() => {
    const clock = makeClock();
    const {hooks, setPollResult} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();
    visible = false;
    c.onFreeze(); // → idle immediately
    await flush();
    expect(c.mode).toBe('idle');

    await clock.advance(10_000); // quiet → 20s
    expect(c.tickIntervalMs).toBe(20_000);

    setPollResult(true);
    await clock.advance(20_000); // delivers, but hidden → stay idle, fast tick
    expect(c.mode).toBe('idle');
    expect(c.tickIntervalMs).toBe(DEFAULT_MIN_TICK_MS);
  });

  it('foreground after idle reopens sockets and returns to ACTIVE', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onFreeze();
    await flush();
    expect(c.mode).toBe('idle');

    // Let the tick back off to the ceiling while backgrounded.
    await clock.advance(10_000); // → 20s
    await clock.advance(20_000); // → 40s
    await clock.advance(40_000); // → 80s
    await clock.advance(80_000); // → 120s (cap)
    expect(c.tickIntervalMs).toBe(DEFAULT_MAX_TICK_MS);

    visible = true;
    c.onForeground();
    await flush();
    expect(c.mode).toBe('active');
    expect(calls.resume).toBe(1);
  });

  it('noteActivity wakes to ACTIVE from idle and reopens sockets', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();
    visible = false;
    c.onFreeze();
    await flush();
    expect(c.mode).toBe('idle');

    c.noteActivity();
    await flush();
    expect(c.mode).toBe('active');
    expect(calls.resume).toBe(1);
  });

  it('opt-in inactivity timer idles a visible page when explicitly enabled', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = makeController({clock, hooks, visible: () => true, inactivityMs: 8_000});
    c.start();
    expect(c.mode).toBe('active');
    expect(calls.suspend).toBe(0);

    await clock.advance(7_999);
    expect(c.mode).toBe('active'); // grace not yet elapsed

    await clock.advance(2);
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);
  });

  it('destroy() stops all timers — no tick or suspend fires afterward', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    let visible = true;
    const c = makeController({clock, hooks, visible: () => visible});
    c.start();

    visible = false;
    c.onBackground(); // arm the hidden grace
    expect(clock.pending()).toBe(1);

    c.destroy();
    expect(clock.pending()).toBe(0);
    await clock.advance(1_000_000);
    expect(calls.suspend).toBe(0);
    expect(calls.poll).toBe(0);
  });

  it('launching hidden arms the grace and idles after it, not instantly', async() => {
    const clock = makeClock();
    const {hooks, calls} = makeHooks();
    const c = makeController({clock, hooks, visible: () => false});
    c.start();
    // Held (grace pending), NOT idle immediately.
    expect(c.mode).toBe('active');
    expect(c.hiddenGracePending).toBe(true);
    expect(calls.suspend).toBe(0);

    await clock.advance(DEFAULT_HIDDEN_GRACE_MS + 1);
    expect(c.mode).toBe('idle');
    expect(calls.suspend).toBe(1);
  });
});
