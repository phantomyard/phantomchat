/**
 * IdleTransportController — Phase 1 transport state machine (issue #125).
 *
 * The old model held a WebSocket open forever and paid a supervisor to keep it
 * alive. That is what makes a backgrounded PWA a piece of shit: the browser/OS
 * murders the idle socket on sleep, the supervisor reconnect-storms on wake.
 *
 * This controller removes the *idle* held-open socket without touching the live
 * one. A Nostr `REQ` is just a query, so an idle heartbeat is a short-lived
 * `open → REQ → EOSE → close`. Two modes:
 *
 *   • ACTIVE — a socket is held open and streams tokens live, exactly as today.
 *              The relay pool's supervisor runs and earns its keep here (it is
 *              what survives dodgy wifi / cell roaming mid-conversation).
 *   • IDLE   — zero sockets. A periodic tick opens, queries since the watermark,
 *              and closes. Backs off 10s → 2min while quiet; snaps back to fast
 *              (and to ACTIVE if foreground) the moment a new message lands or
 *              the user does anything.
 *
 * ─── What triggers IDLE (revised per #125 discussion) ───
 *
 * A *visible* page is NEVER frozen or discarded by the browser — it keeps its
 * socket alive on every platform. So we do NOT idle a foreground chat: there is
 * no "walked away with the window on screen" timer by default (the browser won't
 * sleep us, and dropping a socket out from under a chat you're looking at is
 * pure loss). Idle keys off VISIBILITY + LIFECYCLE only:
 *
 *   • hidden (visibilitychange → hidden) — start a ~60s GRACE timer, don't close.
 *     A quick glance at another tab/app keeps the live socket. Only if still
 *     hidden after the grace do we tear down to tick mode. Cheap flicks are free.
 *   • freeze / pagehide — HARD close immediately. These are the "the browser is
 *     suspending/unloading us right now" signals (Page Lifecycle API); there is
 *     no advance warning, so we close cleanly rather than resume into a half-dead
 *     socket. Cancels any pending grace.
 *   • visible / resume — straight back to ACTIVE (reopen + resume streaming),
 *     cancelling any pending grace.
 *
 * The foreground-inactivity timer is kept as PLUMBING but defaults OFF
 * (`inactivityMs` unset ⇒ disabled). If battery complaints ever appear for
 * "chat left open, screen on, nobody touching it", flip it on via options —
 * no need to reintroduce the machinery.
 *
 * The controller owns ONLY the state machine: the visibility/lifecycle triggers,
 * the mode transitions and the backoff curve. It never touches a socket directly
 * — the pool supplies three hooks (`suspend`, `resume`, `pollOnce`) and the
 * controller decides when to call them. That split keeps the risky, well-tested
 * reconnect logic intact in the pool and makes the state machine unit-testable
 * in complete isolation (see transport-idle-controller.test.ts).
 *
 * Mobile caveat (per #125): a fully-backgrounded PWA has its JS timers throttled
 * or suspended by the OS, so the idle tick is unreliable there. That is fine —
 * the foreground/`resume` catch-up REQ is the recovery path after full
 * background, and Phase 2's desktop shell (which *can* tick backgrounded) fixes
 * it properly.
 */

import {logger, Logger} from '@lib/logger';

export interface IdleTransportHooks {
  /**
   * Enter socket-less idle: gate the pool's supervisor and close every live
   * socket. Must be idempotent (a second call while already suspended is a no-op).
   */
  suspend: () => void | Promise<void>;
  /**
   * Return to live: un-gate the supervisor and reopen sockets so streaming
   * resumes. Idempotent.
   */
  resume: () => void | Promise<void>;
  /**
   * One idle heartbeat: `open → REQ → EOSE → close` across the read relays.
   * Resolves `true` iff at least one NEW inbound message was delivered on this
   * tick (which is the signal to reset the backoff and, if foreground, wake to
   * ACTIVE). Must never throw — a failed tick resolves `false`.
   */
  pollOnce: () => Promise<boolean>;
}

export interface IdleTransportOptions {
  hooks: IdleTransportHooks;
  /**
   * Grace after the page goes HIDDEN before we close sockets. A quick glance
   * away keeps the live socket; only sustained hidden tears down. Default 60s.
   */
  hiddenGraceMs?: number;
  /**
   * Foreground-inactivity timeout (visible-but-untouched → idle). PLUMBING,
   * DEFAULT OFF: unset/0 ⇒ never idle a visible page. Set >0 only if battery
   * cost of a held-open socket on a visible-idle chat ever becomes a problem.
   */
  inactivityMs?: number;
  /** First (fast) idle tick interval. */
  minTickMs?: number;
  /** Slowest idle tick interval (backoff ceiling). */
  maxTickMs?: number;
  /** Multiplier applied to the tick after each quiet (no-new-message) tick. */
  backoffFactor?: number;
  // ─── Test seams (all optional; default to real env/timers) ───
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  /** Is the app foreground-visible right now? Defaults to document.visibilityState. */
  isVisible?: () => boolean;
  /**
   * Bind visibility/lifecycle listeners to document/window. Default true. Tests
   * set false and drive onForeground()/onBackground()/onFreeze()/onResume()
   * directly.
   */
  bindEnvironment?: boolean;
}

export type TransportMode = 'active' | 'idle';

/** How long a page may stay hidden before we drop the socket (thrash guard). */
export const DEFAULT_HIDDEN_GRACE_MS = 60_000;
/** 10s fast tick (issue #125). */
export const DEFAULT_MIN_TICK_MS = 10_000;
/** 2min backoff ceiling (issue #125). */
export const DEFAULT_MAX_TICK_MS = 120_000;
/** 10s → 20s → 40s → 80s → 120s(cap). */
export const DEFAULT_BACKOFF_FACTOR = 2;
/**
 * Suggested value for the OPT-IN foreground-inactivity timer. Not applied by
 * default — pass `inactivityMs: DEFAULT_INACTIVITY_MS` to enable it.
 */
export const DEFAULT_INACTIVITY_MS = 120_000;

export class IdleTransportController {
  private readonly log: Logger;
  private readonly hooks: IdleTransportHooks;

  private readonly hiddenGraceMs: number;
  /** 0 ⇒ foreground-inactivity idling disabled (the default). */
  private readonly inactivityMs: number;
  private readonly minTickMs: number;
  private readonly maxTickMs: number;
  private readonly backoffFactor: number;

  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly nowFn: () => number;
  private readonly isVisibleFn: () => boolean;
  private readonly bindEnvironment: boolean;

  private _mode: TransportMode = 'active';
  private started = false;
  private destroyed = false;

  /** Pending "hidden long enough → go idle" timer (null unless counting down). */
  private hiddenGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Opt-in foreground-inactivity timer (null unless enabled and armed). */
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current idle tick interval — starts at minTickMs, backs off toward maxTickMs. */
  private currentTickMs: number;
  /** Guard so a manual catch-up and a scheduled tick never poll concurrently. */
  private tickInFlight = false;

  // Bound handlers kept so removeEventListener works (bind() would make new fns).
  private readonly onVisibilityChange = (): void => {
    if(this.isVisibleFn()) this.onForeground();
    else this.onBackground();
  };
  private readonly onFreezeEvent = (): void => this.onFreeze();
  private readonly onResumeEvent = (): void => this.onResume();
  private readonly onPageHideEvent = (): void => this.onPageHide();

  constructor(options: IdleTransportOptions) {
    this.log = logger('IdleTransport');
    this.hooks = options.hooks;
    this.hiddenGraceMs = options.hiddenGraceMs ?? DEFAULT_HIDDEN_GRACE_MS;
    this.inactivityMs = options.inactivityMs ?? 0;
    this.minTickMs = options.minTickMs ?? DEFAULT_MIN_TICK_MS;
    this.maxTickMs = options.maxTickMs ?? DEFAULT_MAX_TICK_MS;
    this.backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    this.currentTickMs = this.minTickMs;

    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
    this.nowFn = options.now ?? (() => Date.now());
    this.isVisibleFn = options.isVisible ??
      (() => typeof document === 'undefined' || document.visibilityState === 'visible');
    this.bindEnvironment = options.bindEnvironment ?? true;
  }

  get mode(): TransportMode {
    return this._mode;
  }

  /** Begin in ACTIVE mode (the pool has just connected). */
  start(): void {
    if(this.started || this.destroyed) return;
    this.started = true;
    this._mode = 'active';
    this.bindEnvironmentListeners();
    // If we launch hidden, start the grace countdown rather than holding a
    // socket open behind a backgrounded tab. If visible, just stay ACTIVE —
    // a visible page is never put to sleep, so there's nothing to arm.
    if(!this.isVisibleFn()) {
      this.onBackground();
    } else {
      this.armInactivity();
    }
  }

  /**
   * The user is actively using chat (typing, opened a conversation, sending).
   * Wakes to ACTIVE if idle, and (re)arms the opt-in inactivity grace either way.
   */
  noteActivity(): void {
    if(this.destroyed) return;
    if(this._mode === 'idle') {
      void this.goActive('activity');
      return;
    }
    this.armInactivity();
  }

  /**
   * Page became visible (tab shown, window unminimised). A visible page is never
   * frozen, so we return to live streaming and cancel any pending teardown.
   */
  onForeground(): void {
    if(this.destroyed) return;
    this.clearHiddenGrace();
    if(this._mode === 'idle') {
      void this.goActive('foreground');
    } else {
      // Already active — grace cancelled, socket still held. Re-arm the opt-in
      // inactivity timer (no-op when disabled).
      this.armInactivity();
    }
  }

  /**
   * Page became hidden (tab switch, minimise, screen lock). Do NOT close now —
   * a quick glance away should keep the socket. Start the grace countdown; only
   * if we're still hidden when it fires do we drop to tick mode.
   */
  onBackground(): void {
    if(this.destroyed) return;
    if(this._mode !== 'active') return;
    this.armHiddenGrace();
  }

  /**
   * Page Lifecycle `freeze`: the browser is suspending us RIGHT NOW. No grace —
   * close cleanly so we don't resume into a half-dead socket.
   */
  onFreeze(): void {
    this.hardSuspend('freeze');
  }

  /** `pagehide`: navigating away / unloading. Same hard cutover as freeze. */
  onPageHide(): void {
    this.hardSuspend('pagehide');
  }

  /**
   * Page Lifecycle `resume`: we were frozen and are running again. If we're
   * visible, go straight back to ACTIVE; if still hidden (unfrozen in the
   * background), resume the idle tick loop that the freeze had suspended.
   */
  onResume(): void {
    if(this.destroyed) return;
    if(this.isVisibleFn()) {
      this.onForeground();
      return;
    }
    if(this._mode === 'idle') {
      this.resetBackoff();
      this.clearTick();
      void this.runTick();
    }
  }

  destroy(): void {
    if(this.destroyed) return;
    this.destroyed = true;
    this.clearHiddenGrace();
    this.clearInactivity();
    this.clearTick();
    this.unbindEnvironmentListeners();
  }

  // ─── Transitions ───────────────────────────────────────────────

  private hardSuspend(reason: string): void {
    if(this.destroyed) return;
    this.clearHiddenGrace();
    if(this._mode === 'active') void this.goIdle(reason);
  }

  private async goIdle(reason: string): Promise<void> {
    if(this.destroyed || this._mode === 'idle') return;
    this._mode = 'idle';
    this.clearHiddenGrace();
    this.clearInactivity();
    this.log('[IdleTransport] → idle (' + reason + '): closing sockets, tick mode');
    try {
      await this.hooks.suspend();
    } catch(err) {
      this.log.warn('[IdleTransport] suspend hook threw:', err);
    }
    if(this.destroyed || this._mode !== 'idle') return;
    this.resetBackoff();
    this.scheduleTick(this.currentTickMs);
  }

  private async goActive(reason: string): Promise<void> {
    if(this.destroyed || this._mode === 'active') return;
    this._mode = 'active';
    this.clearTick();
    this.log('[IdleTransport] → active (' + reason + '): reopening sockets, live streaming');
    try {
      await this.hooks.resume();
    } catch(err) {
      this.log.warn('[IdleTransport] resume hook threw:', err);
    }
    if(this.destroyed || this._mode !== 'active') return;
    this.armInactivity();
  }

  // ─── Idle tick loop ────────────────────────────────────────────

  private async runTick(): Promise<void> {
    if(this.destroyed || this._mode !== 'idle') return;
    if(this.tickInFlight) return;
    this.tickInFlight = true;
    let found = false;
    try {
      found = await this.hooks.pollOnce();
    } catch(err) {
      // Hooks contract says pollOnce never throws, but never trust that blindly.
      this.log.warn('[IdleTransport] pollOnce threw:', err);
      found = false;
    } finally {
      this.tickInFlight = false;
    }

    if(this.destroyed || this._mode !== 'idle') return;

    if(found) {
      this.resetBackoff();
      // A message arrived while we're looking at the app → a conversation is
      // (re)starting; wake to ACTIVE so it streams live. When backgrounded we
      // stay idle but tick fast to drain whatever else is coming.
      if(this.isVisibleFn()) {
        void this.goActive('message-while-foreground');
        return;
      }
      this.scheduleTick(this.minTickMs);
      return;
    }

    // Quiet tick — extend the interval toward the ceiling.
    this.currentTickMs = Math.min(this.maxTickMs, Math.round(this.currentTickMs * this.backoffFactor));
    this.scheduleTick(this.currentTickMs);
  }

  private scheduleTick(ms: number): void {
    this.clearTick();
    if(this.destroyed || this._mode !== 'idle') return;
    this.tickTimer = this.setTimeoutFn(() => {
      this.tickTimer = null;
      void this.runTick();
    }, ms);
  }

  private resetBackoff(): void {
    this.currentTickMs = this.minTickMs;
  }

  // ─── Hidden grace (ACTIVE → IDLE after sustained hidden) ────────

  private armHiddenGrace(): void {
    this.clearHiddenGrace();
    if(this.destroyed || this._mode !== 'active') return;
    this.hiddenGraceTimer = this.setTimeoutFn(() => {
      this.hiddenGraceTimer = null;
      void this.goIdle('hidden');
    }, this.hiddenGraceMs);
  }

  private clearHiddenGrace(): void {
    if(this.hiddenGraceTimer !== null) {
      this.clearTimeoutFn(this.hiddenGraceTimer);
      this.hiddenGraceTimer = null;
    }
  }

  // ─── Opt-in foreground inactivity (disabled unless inactivityMs > 0) ──

  private armInactivity(): void {
    this.clearInactivity();
    if(this.inactivityMs <= 0) return;
    if(this.destroyed || this._mode !== 'active') return;
    this.inactivityTimer = this.setTimeoutFn(() => {
      this.inactivityTimer = null;
      void this.goIdle('inactivity');
    }, this.inactivityMs);
  }

  private clearInactivity(): void {
    if(this.inactivityTimer !== null) {
      this.clearTimeoutFn(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private clearTick(): void {
    if(this.tickTimer !== null) {
      this.clearTimeoutFn(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ─── Environment wiring ────────────────────────────────────────

  private bindEnvironmentListeners(): void {
    if(!this.bindEnvironment) return;
    if(typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      // Page Lifecycle API — not on every browser; addEventListener is harmless
      // where unsupported (the events simply never fire).
      document.addEventListener('freeze', this.onFreezeEvent);
      document.addEventListener('resume', this.onResumeEvent);
    }
    if(typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHideEvent);
    }
  }

  private unbindEnvironmentListeners(): void {
    if(!this.bindEnvironment) return;
    if(typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      document.removeEventListener('freeze', this.onFreezeEvent);
      document.removeEventListener('resume', this.onResumeEvent);
    }
    if(typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHideEvent);
    }
  }

  // ─── Diagnostics (tests) ───────────────────────────────────────

  /** Current idle tick interval in ms (exposed for tests/diagnostics). */
  get tickIntervalMs(): number {
    return this.currentTickMs;
  }

  /** True while the hidden→idle grace countdown is pending (tests/diagnostics). */
  get hiddenGracePending(): boolean {
    return this.hiddenGraceTimer !== null;
  }
}
