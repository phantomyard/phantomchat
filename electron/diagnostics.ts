/*
 * PhantomChat desktop — diagnostics (issue #243).
 *
 * Goal: when the app freezes or dies, the reason is readable with nothing
 * but SSH and `cat`. Everything here writes plain, timestamped, one-event-
 * per-line text to a rotating file under userData/logs. No DevTools, no
 * remote endpoints, nothing leaves the machine.
 *
 * This module holds the Electron-free parts (log writer, liveness monitor,
 * the GPU switch list) so they can be unit-tested; main.ts wires them to
 * Electron events.
 */
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from 'fs';
import {join} from 'path';

// --- GPU ---------------------------------------------------------------------

/**
 * Chromium switches that keep every rendering path off the GPU. Applied on
 * top of app.disableHardwareAcceleration(), which on its own still leaves
 * some accelerated paths (video decode, canvas) negotiable. Rendering is
 * done in software by the compositor instead.
 */
export const GPU_DISABLE_SWITCHES: readonly string[] = [
  'disable-gpu',
  'disable-gpu-compositing',
  'disable-gpu-rasterization',
  'disable-accelerated-2d-canvas',
  'disable-accelerated-video-decode',
  'disable-accelerated-video-encode'
];

/**
 * Escape hatch for A/B testing only: PHANTOMCHAT_ENABLE_GPU=1 restores the
 * Electron defaults so a freeze can be compared with and without the GPU.
 * Any other value (or none) keeps the GPU off.
 */
export function gpuOptOutRequested(env: NodeJS.ProcessEnv): boolean {
  return env.PHANTOMCHAT_ENABLE_GPU === '1';
}

// --- Log writer ----------------------------------------------------------------

export const LOG_FILE_NAME = 'phantomchat.log';
export const SESSION_MARKER_FILE = 'session-running.json';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export type LogFields = Record<string, unknown>;

function formatValue(value: unknown): string {
  if(value === undefined) return 'undefined';
  if(value === null) return 'null';
  if(typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = typeof value === 'string' ? value : safeJson(value);
  // Bare when it is a simple token, JSON-quoted otherwise so a value can never
  // forge a second key=value pair or break the one-line-per-event contract.
  return /^[A-Za-z0-9_.:\/@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch{
    return String(value);
  }
}

/**
 * One event per line: `<ISO time> <LEVEL> <event> key=value ...`. A multi-
 * line `detail` (a JS stack) follows on indented `  | ` lines so `grep` on
 * the event name still finds the header line.
 */
export function formatLogLine(at: Date, level: LogLevel, event: string, fields: LogFields = {}, detail?: string): string {
  const parts = [at.toISOString(), level.padEnd(5), event];
  for(const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  let line = parts.join(' ') + '\n';
  if(detail) {
    // Chromium's stacks start with a blank line; drop leading/trailing blanks.
    for(const detailLine of detail.replace(/\r/g, '').replace(/^(\s*\n)+/, '').trimEnd().split('\n')) {
      line += `  | ${detailLine}\n`;
    }
  }
  return line;
}

export interface DiagnosticsLogOptions {
  /** Rotate once the live file would exceed this. Default 5 MiB. */
  maxBytes?: number;
  /** Number of rotated files kept (phantomchat.log.1 … .N). Default 3. */
  keep?: number;
  now?: () => Date;
}

/**
 * Synchronous, append-only, rotating log. Writes are sync on purpose: the
 * process may be SIGKILLed seconds after a freeze is logged, and buffered
 * output would die with it. Volume is low (events, plus a summary every few
 * minutes), so the cost is negligible. Logging never throws.
 */
export class DiagnosticsLog {
  readonly dir: string;
  readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;
  private size = 0;
  private broken = false;

  constructor(dir: string, options: DiagnosticsLogOptions = {}) {
    this.dir = dir;
    this.path = join(dir, LOG_FILE_NAME);
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, options.keep ?? 3);
    this.now = options.now ?? (() => new Date());
    try {
      mkdirSync(dir, {recursive: true});
      this.size = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch(err) {
      this.broken = true;
      console.error('diagnostics log unavailable:', err);
    }
  }

  info(event: string, fields?: LogFields, detail?: string): void {
    this.write('INFO', event, fields, detail);
  }

  warn(event: string, fields?: LogFields, detail?: string): void {
    this.write('WARN', event, fields, detail);
  }

  error(event: string, fields?: LogFields, detail?: string): void {
    this.write('ERROR', event, fields, detail);
  }

  write(level: LogLevel, event: string, fields?: LogFields, detail?: string): void {
    const line = formatLogLine(this.now(), level, event, fields, detail);
    // Mirror to stderr so `phantomchat` launched from a terminal shows it too.
    if(level !== 'INFO') console.error(line.trimEnd());
    if(this.broken) return;
    try {
      const bytes = Buffer.byteLength(line);
      if(this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.path, line);
      this.size += bytes;
    } catch(err) {
      console.error('diagnostics log write failed:', err);
    }
  }

  private rotate(): void {
    const oldest = `${this.path}.${this.keep}`;
    if(existsSync(oldest)) unlinkSync(oldest);
    for(let i = this.keep - 1; i >= 1; --i) {
      const from = `${this.path}.${i}`;
      if(existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
    }
    if(existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }
}

// --- Unclean-exit marker -------------------------------------------------------

export interface SessionMarker {
  pid: number;
  version: string;
  startedAt: string;
  /** Refreshed by every periodic summary: the last moment we know it was alive. */
  lastAliveAt: string;
}

/**
 * Read the marker a previous session left behind. A marker that survives to
 * the next start means that session never reached a clean quit (killed after
 * a freeze, crashed, power loss). Returns undefined when there is none.
 */
export function readStaleSessionMarker(dir: string): SessionMarker | {unreadable: string} | undefined {
  const path = join(dir, SESSION_MARKER_FILE);
  if(!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionMarker;
  } catch(err) {
    return {unreadable: err instanceof Error ? err.message : String(err)};
  }
}

export function writeSessionMarker(dir: string, marker: SessionMarker): void {
  const path = join(dir, SESSION_MARKER_FILE);
  try {
    writeFileSync(path + '.tmp', JSON.stringify(marker));
    renameSync(path + '.tmp', path);
  } catch{
    // best effort: the log itself is the primary record
  }
}

export function clearSessionMarker(dir: string): void {
  try {
    unlinkSync(join(dir, SESSION_MARKER_FILE));
  } catch{
    // already gone
  }
}

// --- Renderer liveness ---------------------------------------------------------

/** What the preload sends every HEARTBEAT_INTERVAL_MS. */
export interface HeartbeatPayload {
  /** document.visibilityState === 'visible' at send time. */
  visible: boolean;
  /**
   * How long the most recent requestAnimationFrame probe has been waiting
   * (ms), or 0 when it already fired. rAF only fires when the compositor
   * produces a frame, so a visible page whose probe keeps waiting while its
   * timers still run is a paint/compositor wedge, not a JS hang.
   */
  frameWaitMs: number;
}

export function parseHeartbeat(raw: unknown): HeartbeatPayload | undefined {
  if(!raw || typeof raw !== 'object') return undefined;
  const {visible, frameWaitMs} = raw as Record<string, unknown>;
  if(typeof visible !== 'boolean') return undefined;
  if(typeof frameWaitMs !== 'number' || !Number.isFinite(frameWaitMs) || frameWaitMs < 0) return undefined;
  return {visible, frameWaitMs: Math.min(frameWaitMs, 7 * 24 * 3600 * 1000)};
}

export const HEARTBEAT_INTERVAL_MS = 5_000;

export interface LivenessThresholds {
  /** No heartbeat for this long while the page was last visible → JS hang. */
  visibleStallMs: number;
  /**
   * Same, while the page was last hidden. Chromium throttles timers in
   * hidden pages to about once a minute, so a short gap there is normal.
   */
  hiddenStallMs: number;
  /** A visible page whose frame probe waited this long → paint wedge. */
  frameStallMs: number;
  /** The main process's own check timer ran this late → main loop blocked. */
  mainLagMs: number;
}

export const DEFAULT_THRESHOLDS: LivenessThresholds = {
  visibleStallMs: 20_000,
  hiddenStallMs: 150_000,
  frameStallMs: 10_000,
  mainLagMs: 5_000
};

export interface LivenessEvent {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

/**
 * Pure state machine behind the heartbeat checks — fed beats and clock
 * ticks, it returns the events to log. Each stall is reported once when it
 * starts and once when it ends (with its total duration), so a freeze shows
 * up as a clear begin/end pair instead of a line every five seconds.
 * Suspend/resume resets the clocks: a laptop asleep for an hour is not a
 * one-hour hang.
 */
export class LivenessMonitor {
  private readonly t: LivenessThresholds;
  private lastBeatAt: number | undefined;
  private lastVisible = true;
  private lastCheckAt: number | undefined;
  private suspended = false;
  private heartbeatStallSince: number | undefined;
  private frameStallSince: number | undefined;
  // A run of consecutive late main-process checks, reported as one
  // begin/end pair so a chronically lagging main loop cannot churn the log.
  private mainLag: {since: number; lateChecks: number; worstLateByMs: number} | undefined;
  // Counters for the periodic summary.
  private beats = 0;
  private maxBeatGapMs = 0;
  private maxFrameWaitMs = 0;
  private stalls = 0;

  constructor(thresholds: LivenessThresholds = DEFAULT_THRESHOLDS) {
    this.t = thresholds;
  }

  beat(now: number, beat: HeartbeatPayload): LivenessEvent[] {
    const events: LivenessEvent[] = [];
    if(this.lastBeatAt !== undefined) this.maxBeatGapMs = Math.max(this.maxBeatGapMs, now - this.lastBeatAt);
    if(this.heartbeatStallSince !== undefined) {
      events.push({level: 'WARN', event: 'renderer-heartbeat-recovered', fields: {stalledForMs: now - this.heartbeatStallSince}});
      this.heartbeatStallSince = undefined;
    }
    this.lastBeatAt = now;
    this.lastVisible = beat.visible;
    this.beats++;
    this.maxFrameWaitMs = Math.max(this.maxFrameWaitMs, beat.frameWaitMs);

    const frameStalled = beat.visible && beat.frameWaitMs >= this.t.frameStallMs;
    if(frameStalled && this.frameStallSince === undefined) {
      this.frameStallSince = now - beat.frameWaitMs;
      this.stalls++;
      events.push({
        level: 'ERROR',
        event: 'renderer-frames-stalled',
        fields: {frameWaitMs: beat.frameWaitMs, note: 'JS alive but no frame painted: compositor/paint wedge'}
      });
    } else if(!frameStalled && this.frameStallSince !== undefined && beat.frameWaitMs < this.t.frameStallMs) {
      events.push({level: 'WARN', event: 'renderer-frames-recovered', fields: {stalledForMs: now - this.frameStallSince, visible: beat.visible}});
      this.frameStallSince = undefined;
    }
    return events;
  }

  /** Called from a main-process timer every HEARTBEAT_INTERVAL_MS. */
  check(now: number): LivenessEvent[] {
    const events: LivenessEvent[] = [];
    if(this.lastCheckAt !== undefined && !this.suspended) {
      const lateBy = now - this.lastCheckAt - HEARTBEAT_INTERVAL_MS;
      if(lateBy >= this.t.mainLagMs) {
        if(this.mainLag === undefined) {
          this.mainLag = {since: this.lastCheckAt, lateChecks: 1, worstLateByMs: lateBy};
          events.push({level: 'ERROR', event: 'main-event-loop-stalled', fields: {lateByMs: lateBy}});
        } else {
          this.mainLag.lateChecks++;
          this.mainLag.worstLateByMs = Math.max(this.mainLag.worstLateByMs, lateBy);
        }
      } else if(this.mainLag !== undefined) {
        events.push({level: 'WARN', event: 'main-event-loop-recovered', fields: {
          lateChecks: this.mainLag.lateChecks,
          worstLateByMs: this.mainLag.worstLateByMs,
          laggingForMs: this.lastCheckAt - this.mainLag.since
        }});
        this.mainLag = undefined;
      }
    }
    this.lastCheckAt = now;
    if(this.suspended || this.lastBeatAt === undefined || this.heartbeatStallSince !== undefined) return events;

    const gap = now - this.lastBeatAt;
    const limit = this.lastVisible ? this.t.visibleStallMs : this.t.hiddenStallMs;
    if(gap >= limit) {
      this.heartbeatStallSince = this.lastBeatAt;
      this.stalls++;
      events.push({
        level: 'ERROR',
        event: 'renderer-heartbeat-missed',
        fields: {sinceLastBeatMs: gap, lastVisible: this.lastVisible, note: 'renderer main thread not running'}
      });
    }
    return events;
  }

  suspend(): void {
    this.suspended = true;
  }

  /** After resume, restart every clock from now. */
  resume(now: number): void {
    this.suspended = false;
    // A lag run that straddles a sleep has no meaningful end; drop it.
    this.mainLag = undefined;
    this.lastCheckAt = now;
    if(this.lastBeatAt !== undefined) this.lastBeatAt = now;
  }

  /** The renderer was replaced (crash/reload): forget its liveness state. */
  resetRenderer(): void {
    this.lastBeatAt = undefined;
    this.heartbeatStallSince = undefined;
    this.frameStallSince = undefined;
    this.lastVisible = true;
  }

  /** Counters since the previous summary; resets them. */
  takeSummary(): LogFields {
    const summary = {
      beats: this.beats,
      maxBeatGapMs: this.maxBeatGapMs,
      maxFrameWaitMs: this.maxFrameWaitMs,
      stalls: this.stalls,
      stalledNow: this.heartbeatStallSince !== undefined || this.frameStallSince !== undefined
    };
    this.beats = 0;
    this.maxBeatGapMs = 0;
    this.maxFrameWaitMs = 0;
    this.stalls = 0;
    return summary;
  }
}

// --- Renderer console ----------------------------------------------------------

/**
 * Caps how many renderer console errors reach the log per window, so a
 * runaway error loop cannot fill the disk or rotate the freeze evidence away.
 */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;
  private dropped = 0;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Returns whether to log, plus how many were dropped in the window that just closed. */
  take(now: number): {allow: boolean; droppedBefore: number} {
    let droppedBefore = 0;
    if(now - this.windowStart >= this.windowMs) {
      droppedBefore = this.dropped;
      this.windowStart = now;
      this.count = 0;
      this.dropped = 0;
    }
    if(this.count < this.limit) {
      this.count++;
      return {allow: true, droppedBefore};
    }
    this.dropped++;
    return {allow: false, droppedBefore};
  }
}

// --- Signal-driven quit -----------------------------------------------------

export const SIGNAL_QUIT_TIMEOUT_MS = 10_000;

const SIGNAL_NUMBERS: Record<string, number> = {SIGINT: 2, SIGTERM: 15};

export interface SignalQuitDeps {
  /** Starts Electron's normal quit (before-quit -> will-quit -> exit). */
  quit(): void;
  /** Exits immediately, skipping the quit events. */
  exit(code: number): void;
  log(level: LogLevel, event: string, fields: LogFields): void;
  setTimer(fn: () => void, ms: number): void;
  timeoutMs?: number;
}

/**
 * Turns SIGTERM/SIGINT into a graceful app.quit() so 'will-quit' records the
 * shutdown and clears the unclean-session marker. A second signal, or a quit
 * that has not finished after timeoutMs, exits hard and deliberately leaves
 * the marker in place: a quit that hangs is itself freeze evidence.
 *
 * On Linux, Chromium owns SIGTERM/SIGINT and already quits gracefully, so
 * these handlers never run there. They matter where Node's handlers are the
 * ones that fire (macOS), and they are harmless everywhere else.
 */
export function createSignalQuitHandler(deps: SignalQuitDeps): (signal: string) => void {
  let quitting = false;
  return (signal) => {
    const code = 128 + (SIGNAL_NUMBERS[signal] ?? 0);
    if(quitting) {
      deps.log('WARN', 'signal-repeat-exit', {signal, code});
      deps.exit(code);
      return;
    }
    quitting = true;
    deps.log('INFO', 'signal-quit', {signal});
    const timeoutMs = deps.timeoutMs ?? SIGNAL_QUIT_TIMEOUT_MS;
    deps.setTimer(() => {
      deps.log('ERROR', 'signal-quit-timeout', {signal, timeoutMs, code, note: 'graceful quit did not finish; exiting hard'});
      deps.exit(code);
    }, timeoutMs);
    deps.quit();
  };
}
