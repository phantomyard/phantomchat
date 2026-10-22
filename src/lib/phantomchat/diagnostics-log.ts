/*
 * Persistent diagnostics log (#246).
 *
 * The white-screen hang lives in the SharedWorker, and nothing the worker
 * printed survived: its console is a separate DevTools target, the desktop
 * log only captures the renderer, and the worker cannot reach localStorage.
 * IndexedDB is the thing that wedges, so logging into it would wedge too.
 *
 * This writes a size-capped rolling plain-text log to the Origin Private File
 * System (OPFS) — reachable from windows AND workers, separate from IndexedDB,
 * and it survives a white screen, a renderer crash and a restart. Every
 * context (each window, the shared worker) appends to the SAME file, tagged,
 * so one export is one timeline. Writes are serialised across contexts with a
 * Web Lock.
 *
 * Captured: console.warn/error (which includes every logger error, the
 * superMessagePort TIMEOUT line and the IDB 'transaction not finished' line),
 * uncaught errors, a boot line, and a periodic heartbeat carrying event-loop
 * lag plus registered probes (outstanding invokes per port). Heartbeat lag
 * tells a CPU-blocked worker (huge lag, or no heartbeats at all) apart from
 * one idling on a promise that never settles (normal lag, invokes piling up).
 *
 * The log never leaves the device on its own. Export is user-initiated
 * (Report a Bug → Download diagnostics log, Ctrl+Alt+Shift+D, or
 * window.__phantomchatExportDiagnostics() from DevTools).
 */

export const DIAG_LOG_FILE = 'phantomchat-diag.log';
export const DIAG_LOG_OLD_FILE = 'phantomchat-diag.1.log';
export const DIAG_MAX_FILE_BYTES = 1024 * 1024;
export const DIAG_MAX_LINE_CHARS = 2000;
export const DIAG_LINES_PER_MINUTE = 1200;
export const DIAG_MAX_BUFFERED_LINES = 5000;
const FLUSH_INTERVAL_MS = 2000;
const LOCK_NAME = 'phantomchat-diag-log';
const LOCK_WAIT_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export type DiagLevel = 'E' | 'W' | 'I';

type DirectoryLike = {
  getFileHandle(name: string, options?: {create?: boolean}): Promise<FileHandleLike>;
};

type FileHandleLike = {
  getFile(): Promise<Blob>;
  createWritable(options?: {keepExistingData?: boolean}): Promise<WritableLike>;
};

type WritableLike = {
  seek?(position: number): Promise<void>;
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
};

export type DiagnosticsLogOptions = {
  // Context tag written on every line, e.g. 'worker' or 'win:ab12'.
  context: string;
  captureConsole?: boolean;
  captureErrors?: boolean;
  heartbeatMs?: number;
  // Test seams. Default to navigator.storage.getDirectory / navigator.locks.
  getDirectory?: () => Promise<DirectoryLike>;
  locks?: {request: (name: string, options: any, cb: () => Promise<void>) => Promise<void>} | null;
  now?: () => number;
  autoFlush?: boolean;
};

type State = {
  context: string;
  options: DiagnosticsLogOptions;
  buffer: string[];
  flushing: Promise<void> | null;
  minuteStart: number;
  minuteCount: number;
  dropped: number;
  lastText: string | null;
  lastLevel: DiagLevel;
  repeats: number;
  storageBroken: string | null;
  probes: Map<string, () => string | undefined>;
  timers: any[];
  restore: Array<() => void>;
};

let state: State | null = null;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const FORMAT_ONLY_RE = /^(%s\s*)+$/;

// Objects are NEVER serialised into the log. console.error(obj) is all over
// the app and its libraries — tasks with manager args, messages, peers — and
// the log is persistent and user-exported, so content must not reach it. An
// object is reduced to its class name plus a few allowlisted identifier-like
// fields (an API error's type/code, a TL constructor), never free text.
const SAFE_FIELDS = ['_', 'type', 'code'] as const;
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function describeObject(arg: object): string {
  const name = Array.isArray(arg) ? 'Array(' + arg.length + ')' : ((arg as any)?.constructor?.name || 'object');
  const parts: string[] = [];
  for(const field of SAFE_FIELDS) {
    let value: unknown;
    try {
      value = (arg as any)[field];
    } catch{
      continue;
    }

    if((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && SAFE_VALUE_RE.test(value))) {
      parts.push(field + '=' + value);
    }
  }

  return '[' + name + (parts.length ? ' ' + parts.join(' ') : '') + ']';
}

function stringifyArg(arg: unknown): string {
  if(typeof arg === 'string') return arg;
  if(arg instanceof Error) {
    const stack = arg.stack ? ' | ' + arg.stack.split('\n').slice(1, 4).map((s) => s.trim()).join(' | ') : '';
    return arg.name + ': ' + arg.message + stack;
  }

  if(arg === null || arg === undefined || typeof arg !== 'object') return String(arg);
  return describeObject(arg);
}

/**
 * Turn console arguments into one line. The app logger passes a leading
 * '%s' / '%s <ansi>%s' style token; drop it and strip ANSI colour codes.
 */
export function formatConsoleArgs(args: unknown[]): string {
  let list = args;
  if(typeof list[0] === 'string' && FORMAT_ONLY_RE.test((list[0] as string).replace(ANSI_RE, ''))) {
    list = list.slice(1);
  }

  return list.map(stringifyArg).join(' ').replace(ANSI_RE, '').replace(/\s*\n\s*/g, ' | ').trim();
}

function now(): number {
  return state?.options.now ? state.options.now() : Date.now();
}

function pushLine(level: DiagLevel, text: string) {
  const s = state;
  const line = new Date(now()).toISOString() + ' ' + s.context + ' ' + level + ' ' + text + '\n';
  s.buffer.push(line);
  if(s.buffer.length > DIAG_MAX_BUFFERED_LINES) {
    // Storage is stuck or broken: keep the newest lines.
    const cut = s.buffer.length - DIAG_MAX_BUFFERED_LINES;
    s.buffer.splice(0, cut);
    s.dropped += cut;
  }
}

function emitRepeats() {
  const s = state;
  if(s.repeats > 0) {
    pushLine(s.lastLevel, '(previous line repeated ' + s.repeats + 'x)');
    s.repeats = 0;
  }
}

/**
 * Append one line. No-op unless installDiagnosticsLog() ran in this context,
 * so library code (superMessagePort) can call it unconditionally.
 */
export function diagLog(level: DiagLevel, text: string) {
  const s = state;
  if(!s) return;

  if(text.length > DIAG_MAX_LINE_CHARS) text = text.slice(0, DIAG_MAX_LINE_CHARS) + '…';

  // Collapse back-to-back duplicates (relay reconnect spam) into a count.
  if(text === s.lastText && level === s.lastLevel) {
    s.repeats++;
    return;
  }

  const t = now();
  if(t - s.minuteStart >= 60_000) {
    if(s.dropped > 0) {
      pushLine('W', 'diagnostics-log dropped ' + s.dropped + ' lines (rate cap ' + DIAG_LINES_PER_MINUTE + '/min)');
      s.dropped = 0;
    }

    s.minuteStart = t;
    s.minuteCount = 0;
  }

  if(s.minuteCount >= DIAG_LINES_PER_MINUTE) {
    s.dropped++;
    return;
  }

  emitRepeats();
  s.minuteCount++;
  s.lastText = text;
  s.lastLevel = level;
  pushLine(level, text);
}

export function registerDiagnosticsProbe(name: string, probe: () => string | undefined) {
  state?.probes.set(name, probe);
}

async function appendChunk(dir: DirectoryLike, chunk: string) {
  const handle = await dir.getFileHandle(DIAG_LOG_FILE, {create: true});
  const file = await handle.getFile();
  const bytes = new Blob([chunk]).size;

  if(file.size > 0 && file.size + bytes > DIAG_MAX_FILE_BYTES) {
    // Rotate: current → .1 (one generation kept), then start fresh.
    const old = await dir.getFileHandle(DIAG_LOG_OLD_FILE, {create: true});
    const oldWritable = await old.createWritable();
    await oldWritable.write(file);
    await oldWritable.close();

    const fresh = await handle.createWritable();
    await fresh.write(chunk);
    await fresh.close();
    return;
  }

  const writable = await handle.createWritable({keepExistingData: true});
  if(writable.seek) await writable.seek(file.size);
  await writable.write(chunk);
  await writable.close();
}

/**
 * Permanent "this browser can't do it" failures only. Anything else (lock
 * timeout, quota, a transient I/O error, a bug) keeps the batch for retry —
 * a broad match here would silently switch the log off for the session.
 */
export function isStorageUnsupported(err: any): boolean {
  const name = err?.name;
  if(name === 'SecurityError' || name === 'NotSupportedError') return true;
  const message = String(err?.message || err);
  // Our own probe, or Safari < 26 where workers lack createWritable.
  return message === 'OPFS unavailable' || /createWritable is not a function/.test(message);
}

function getDefaultDirectory(): Promise<DirectoryLike> {
  const storage: any = typeof navigator !== 'undefined' ? (navigator as any).storage : undefined;
  if(!storage?.getDirectory) return Promise.reject(new Error('OPFS unavailable'));
  return storage.getDirectory();
}

function getLocks() {
  const s = state;
  if(s.options.locks !== undefined) return s.options.locks;
  return typeof navigator !== 'undefined' ? (navigator as any).locks || null : null;
}

/**
 * Write buffered lines to OPFS. Resolves once this batch is written (or has
 * failed and been put back). Safe to call often; concurrent calls coalesce.
 */
export function flushDiagnosticsLog(): Promise<void> {
  const s = state;
  if(!s || s.storageBroken) return Promise.resolve();
  if(s.flushing) return s.flushing;

  emitRepeats();
  if(!s.buffer.length) return Promise.resolve();

  const lines = s.buffer.splice(0, s.buffer.length);
  const chunk = lines.join('');
  const getDirectory = s.options.getDirectory || getDefaultDirectory;

  const write = async() => {
    const dir = await getDirectory();
    await appendChunk(dir, chunk);
  };

  const locks = getLocks();
  const run = locks ?
    locks.request(LOCK_NAME, {signal: typeof AbortSignal !== 'undefined' && (AbortSignal as any).timeout ? (AbortSignal as any).timeout(LOCK_WAIT_MS) : undefined}, write) :
    write();

  s.flushing = Promise.resolve(run).catch((err: any) => {
    if(state !== s) return;
    // Put the batch back in front whatever happened: on a transient failure
    // (lock timeout, quota) it is retried; with no OPFS at all it stays in the
    // bounded in-memory buffer so export still has the boot line and every
    // error logged before the first flush.
    s.buffer.unshift(...lines);
    if(isStorageUnsupported(err)) {
      // No OPFS here (old Safari, private mode): stop trying, keep memory-only.
      s.storageBroken = err?.message || String(err);
    }

    if(s.buffer.length > DIAG_MAX_BUFFERED_LINES) {
      const cut = s.buffer.length - DIAG_MAX_BUFFERED_LINES;
      s.buffer.splice(0, cut);
      s.dropped += cut;
    }
  }).finally(() => {
    if(state === s) s.flushing = null;
  });

  return s.flushing;
}

function runHeartbeat(expectedAt: number) {
  const s = state;
  if(!s) return;
  const lag = Math.max(0, now() - expectedAt);
  const parts = ['heartbeat lag=' + lag + 'ms'];
  s.probes.forEach((probe, name) => {
    try {
      const value = probe();
      if(value) parts.push(name + '{' + value + '}');
    } catch(err) {
      parts.push(name + '{probe error ' + stringifyArg(err) + '}');
    }
  });

  // Heartbeats are deliberately never deduped against each other.
  s.lastText = null;
  diagLog('I', parts.join(' '));
}

export function installDiagnosticsLog(options: DiagnosticsLogOptions) {
  if(state) return;

  state = {
    context: options.context,
    options,
    buffer: [],
    flushing: null,
    minuteStart: options.now ? options.now() : Date.now(),
    minuteCount: 0,
    dropped: 0,
    lastText: null,
    lastLevel: 'I',
    repeats: 0,
    storageBroken: null,
    probes: new Map(),
    timers: [],
    restore: []
  };

  const s = state;
  const scope: any = typeof self !== 'undefined' ? self : undefined;

  if(options.captureConsole !== false && typeof console !== 'undefined') {
    (['error', 'warn'] as const).forEach((method) => {
      const original = console[method];
      const level: DiagLevel = method === 'error' ? 'E' : 'W';
      console[method] = function(...args: any[]) {
        try {
          diagLog(level, formatConsoleArgs(args));
        } catch{}
        return original.apply(this, args);
      };
      s.restore.push(() => console[method] = original);
    });
  }

  if(options.captureErrors !== false && scope?.addEventListener) {
    const onError = (event: ErrorEvent) => {
      const where = event.filename ? ' at ' + event.filename + ':' + event.lineno + ':' + event.colno : '';
      const err = event.error ? ' ' + stringifyArg(event.error) : '';
      diagLog('E', 'uncaught ' + (event.message || 'error') + where + err);
    };
    scope.addEventListener('error', onError);
    s.restore.push(() => scope.removeEventListener('error', onError));
  }

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  diagLog('I', 'boot ' + options.context + ' ua=' + ua);

  if(options.autoFlush !== false) {
    s.timers.push(setInterval(() => flushDiagnosticsLog(), FLUSH_INTERVAL_MS));

    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if(heartbeatMs > 0) {
      let expectedAt = now() + heartbeatMs;
      s.timers.push(setInterval(() => {
        runHeartbeat(expectedAt);
        expectedAt = now() + heartbeatMs;
      }, heartbeatMs));
    }

    if(typeof document !== 'undefined' && document.addEventListener) {
      const onHide = () => {
        if(document.visibilityState === 'hidden') flushDiagnosticsLog();
      };
      document.addEventListener('visibilitychange', onHide);
      s.restore.push(() => document.removeEventListener('visibilitychange', onHide));
    }
  }
}

/** Exposed for tests: run one heartbeat as if `lagMs` late. */
export function runDiagnosticsHeartbeatForTests(lagMs = 0) {
  runHeartbeat(now() - lagMs);
}

export function uninstallDiagnosticsLogForTests() {
  if(!state) return;
  state.timers.forEach((t) => clearInterval(t));
  state.restore.forEach((fn) => fn());
  state = null;
}

export function getBufferedDiagnosticsForTests(): string[] {
  return state ? state.buffer.slice() : [];
}

async function readFileText(dir: DirectoryLike, name: string): Promise<string> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return file.text();
  } catch{
    return '';
  }
}

/**
 * Read the whole log (older generation first) plus this context's unflushed
 * lines. Reads OPFS directly, so it works while the worker is hung.
 */
export async function readDiagnosticsLog(): Promise<string> {
  const s = state;
  // Best effort: don't let a stuck flush block the export.
  await Promise.race([flushDiagnosticsLog(), new Promise((r) => setTimeout(r, 3000))]);

  let stored = '';
  try {
    const dir = await (s?.options.getDirectory || getDefaultDirectory)();
    stored = (await readFileText(dir, DIAG_LOG_OLD_FILE)) + (await readFileText(dir, DIAG_LOG_FILE));
  } catch(err) {
    stored = '(stored log unavailable: ' + stringifyArg(err) + ')\n';
  }

  const pending = s ? s.buffer.join('') : '';
  const note = s?.storageBroken ? '(OPFS unavailable in this browser: ' + s.storageBroken + ' — in-memory lines only)\n' : '';
  return note + stored + (pending ? '--- unflushed lines from this window ---\n' + pending : '');
}

/** Download the log as a file. Window context only. */
export async function exportDiagnosticsLog(header = ''): Promise<void> {
  const text = await readDiagnosticsLog();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([header + text], {type: 'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'phantomchat-diagnostics-' + stamp + '.log';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isExportDiagnosticsShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.altKey && event.shiftKey && (event.code === 'KeyD' || event.key === 'D' || event.key === 'd');
}

/**
 * Window-side install: also wires the keyboard shortcut and DevTools hook so
 * the log can be exported from a white screen (the renderer's JS still runs
 * while the worker is hung — only the UI is empty).
 */
export function installWindowDiagnosticsLog(getHeader: () => string) {
  const tab = Math.random().toString(36).slice(2, 6);
  installDiagnosticsLog({context: 'win:' + tab});

  (window as any).__phantomchatExportDiagnostics = () => exportDiagnosticsLog(getHeader());
  window.addEventListener('keydown', (event) => {
    if(isExportDiagnosticsShortcut(event)) {
      event.preventDefault();
      exportDiagnosticsLog(getHeader());
    }
  }, true);
}
