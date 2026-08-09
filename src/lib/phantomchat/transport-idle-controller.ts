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
 * The controller owns ONLY the state machine: the inactivity/visibility
 * triggers, the mode transitions and the backoff curve. It never touches a
 * socket directly — the pool supplies three hooks (`suspend`, `resume`,
 * `pollOnce`) and the controller decides when to call them. That split keeps
 * the risky, well-tested reconnect logic intact in the pool and makes the state
 * machine unit-testable in complete isolation (see transport-idle-controller.test.ts).
 *
 * Mobile caveat (per #125): a fully-backgrounded PWA has its JS timers throttled
 * or suspended by the OS, so the idle tick is unreliable there. That is fine —
 * the `onForeground()` catch-up REQ is the recovery path after full background,
 * and Phase 2's desktop shell (which *can* tick backgrounded) fixes it properly.
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
  /** Grace after the last activity before we close sockets (thrash guard). */
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
   * Bind visibility/focus listeners to document/window. Default true. Tests set
   * false and drive onForeground()/onBackground() directly.
   */
  bindEnvironment?: boolean;
}

export type TransportMode = 'active' | 'idle';

/** Close a few seconds after the last activity — not instantly (avoids thrashing on brief pauses). */
export const DEFAULT_INACTIVITY_MS = 8_000;
/** 10s fast tick (issue #125). */
export const DEFAULT_MIN_TICK_MS = 10_000;
/** 2min backoff ceiling (issue #125). */
export const DEFAULT_MAX_TICK_MS = 120_000;
/** 10s → 20s → 40s → 80s → 120s(cap). */
export const DEFAULT_BACKOFF_FACTOR = 2;

export class IdleTransportController {
  private readonly log: Logger;
  private readonly hooks: IdleTransportHooks;

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
  private readonly onWindowFocus = (): void => this.onForeground();
  private readonly onWindowBlur = (): void => this.onBackground();
  private readonly onPageHide = (): void => this.onBackground();

  constructor(options: IdleTransportOptions) {
    this.log = logger('IdleTransport');
    this.hooks = options.hooks;
    this.inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
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

  /** Begin in ACTIVE mode (the pool has just connected). Arms the inactivity timer. */
  start(): void {
    if(this.started || this.destroyed) return;
    this.started = true;
    this._mode = 'active';
    this.bindEnvironmentListeners();
    // If we launch hidden, close down to idle right away rather than holding a
    // socket open behind a backgrounded tab.
    if(!this.isVisibleFn()) {
      void this.goIdle('launched-hidden');
    } else {
      this.armInactivity();
    }
  }

  /**
   * The user is actively using chat (typing, opened a conversation, sending).
   * Wakes to ACTIVE if idle, and (re)arms the inactivity grace either way.
   */
  noteActivity(): void {
    if(this.destroyed) return;
    if(this._mode === 'idle') {
      void this.goActive('activity');
      return;
    }
    this.armInactivity();
  }

  /** Foreground/visible (tab shown, window focused). Catch up immediately. */
  onForeground(): void {
    if(this.destroyed) return;
    if(this._mode !== 'idle') return;
    // Opening/navigating catches up immediately via one-shot REQ (#125), and
    // resets the backoff so we're responsive again. We stay IDLE (foreground-but-
    // idle keeps ticking) unless the catch-up itself finds a message.
    this.resetBackoff();
    this.clearTick();
    void this.runTick();
  }

  /** Background/hidden (tab hidden, window blurred). Drop the socket now. */
  onBackground(): void {
    if(this.destroyed) return;
    // The tab is gone — no grace, close immediately and flip to ticks.
    if(this._mode === 'active') void this.goIdle('backgrounded');
  }

  destroy(): void {
    if(this.destroyed) return;
    this.destroyed = true;
    this.clearInactivity();
    this.clearTick();
    this.unbindEnvironmentListeners();
  }

  // ─── Transitions ───────────────────────────────────────────────

  private async goIdle(reason: string): Promise<void> {
    if(this.destroyed || this._mode === 'idle') return;
    this._mode = 'idle';
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

  // ─── Inactivity grace (ACTIVE → IDLE) ──────────────────────────

  private armInactivity(): void {
    this.clearInactivity();
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
    }
    if(typeof window !== 'undefined') {
      window.addEventListener('focus', this.onWindowFocus);
      window.addEventListener('blur', this.onWindowBlur);
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  private unbindEnvironmentListeners(): void {
    if(!this.bindEnvironment) return;
    if(typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    if(typeof window !== 'undefined') {
      window.removeEventListener('focus', this.onWindowFocus);
      window.removeEventListener('blur', this.onWindowBlur);
      window.removeEventListener('pagehide', this.onPageHide);
    }
  }

  // ─── Diagnostics (tests) ───────────────────────────────────────

  /** Current idle tick interval in ms (exposed for tests/diagnostics). */
  get tickIntervalMs(): number {
    return this.currentTickMs;
  }
}
