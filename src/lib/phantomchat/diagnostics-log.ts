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
// #254: createWritable({keepExistingData}) rewrites the WHOLE file (up to
// DIAG_MAX_FILE_BYTES) on every flush. Where sync access handles are not
// available (window contexts, old Safari) the file must still be copied — so
// flush at most every 15s instead of every 2s and accept the copy.
const COPY_FLUSH_INTERVAL_MS = 15_000;
// #254: a write that never settles must not pin the Web Lock forever — one
// hung write used to silence the log in BOTH the window and the worker.
export const WRITE_TIMEOUT_MS = 8_000;
// #255 (P3): the raced write itself keeps running after the timeout — if it
// lands late, the requeued batch is written a second time and doubled lines
// appear in the log. Duplicates are the cheaper failure for a diagnostics
// log; the alternative (dropping the requeue) would lose lines outright.
// Anyone reading a log with doubled lines: this is why.
const LOCK_NAME = 'phantomchat-diag-log';
const LOCK_WAIT_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const ENCODER = new TextEncoder();

export type DiagLevel = 'E' | 'W' | 'I';

type DirectoryLike = {
  getFileHandle(name: string, options?: {create?: boolean}): Promise<FileHandleLike>;
};

type FileHandleLike = {
  getFile(): Promise<Blob>;
  createWritable(options?: {keepExistingData?: boolean}): Promise<WritableLike>;
  // Workers only (#254): writes in place, no whole-file swap copy.
  // Spec: returns a Promise; only the handle's own methods are synchronous.
  createSyncAccessHandle?(): Promise<SyncAccessHandleLike>;
};

type SyncAccessHandleLike = {
  write(buffer: Uint8Array, options?: {at?: number}): number;
  flush(): void;
  close(): void;
  truncate?(size: number): void;
  // Spec method; when read AFTER acquisition it is the live file size,
  // unlike the pre-acquisition getFile() snapshot (#255 minor).
  getSize?(): number;
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
  flushTimer: any;
  flushIntervalMs: number;
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

// #254: sentinel rejected by the bounded write when the OPFS write stalls.
const WRITE_STALL = {stall: true};

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

/**
 * Append a chunk. Returns the write path used (#254):
 * - 'sync' — in place via FileSystemSyncAccessHandle (workers): no swap file,
 *   so steady-state logging creates no new OPFS backing file per flush.
 * - 'copy' — createWritable({keepExistingData}), which rewrites the whole
 *   file; the caller slows its flush cadence in that mode.
 */
async function appendChunk(dir: DirectoryLike, chunk: string): Promise<'sync' | 'copy'> {
  const handle = await dir.getFileHandle(DIAG_LOG_FILE, {create: true});
  const file = await handle.getFile();
  const bytes = new Blob([chunk]).size;
  const rotate = file.size > 0 && file.size + bytes > DIAG_MAX_FILE_BYTES;

  if(typeof handle.createSyncAccessHandle === 'function') {
    if(rotate) {
      // Rotate: current → .1 (one generation kept), then start fresh.
      const text = await file.text();
      const oldHandle = await dir.getFileHandle(DIAG_LOG_OLD_FILE, {create: true});
      const oldSync = await oldHandle.createSyncAccessHandle!();
      try {
        oldSync.truncate?.(0);
        oldSync.write(ENCODER.encode(text));
        oldSync.flush();
      } finally {
        oldSync.close();
      }
    }

    const sync = await handle.createSyncAccessHandle!();
    try {
      if(rotate) sync.truncate?.(0);
      // #255: getSize() after acquisition is the live size — the getFile()
      // snapshot was taken before, and a write that stalled while holding
      // the handle can have moved the file since. Prefer the handle's own
      // size when the browser exposes it.
      const at = rotate ? 0 : (typeof sync.getSize === 'function' ? sync.getSize() : file.size);
      sync.write(ENCODER.encode(chunk), {at});
      sync.flush();
    } finally {
      sync.close();
    }
    return 'sync';
  }

  if(rotate) {
    const old = await dir.getFileHandle(DIAG_LOG_OLD_FILE, {create: true});
    const oldWritable = await old.createWritable();
    await oldWritable.write(file);
    await oldWritable.close();

    const fresh = await handle.createWritable();
    await fresh.write(chunk);
    await fresh.close();
    return 'copy';
  }

  const writable = await handle.createWritable({keepExistingData: true});
  if(writable.seek) await writable.seek(file.size);
  await writable.write(chunk);
  await writable.close();
  return 'copy';
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
 * #254: once a flush has gone through on the copy path, re-arm the flush
 * timer at the slow cadence — windows have no sync access handles, so their
 * every-2s flush was rewriting the whole file each time.
 */
function slowFlushTimer(s: State) {
  if(s.flushIntervalMs === COPY_FLUSH_INTERVAL_MS) return;
  s.flushIntervalMs = COPY_FLUSH_INTERVAL_MS;
  if(s.flushTimer) {
    clearInterval(s.flushTimer);
    s.timers = s.timers.filter((t) => t !== s.flushTimer);
    s.flushTimer = setInterval(() => flushDiagnosticsLog(), COPY_FLUSH_INTERVAL_MS);
    s.timers.push(s.flushTimer);
  }
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

  let writeMode: 'sync' | 'copy' | null = null;
  const write = async() => {
    const dir = await getDirectory();
    writeMode = await appendChunk(dir, chunk);
  };

  // #254: bound the whole write. A hung OPFS write used to pin the Web Lock
  // and this context's `flushing` promise forever, silencing the log in both
  // the window and the worker. Racing the write settles the lock callback at
  // the timeout — which releases the lock (an AbortSignal cannot release a
  // lock once its callback is running) — while the batch is kept in memory.
  const bounded = async() => {
    if(typeof setTimeout === 'undefined') {
      await write();
      return;
    }

    let timer: any;
    const stall = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(WRITE_STALL), WRITE_TIMEOUT_MS);
    });
    try {
      await Promise.race([write(), stall]);
    } finally {
      clearTimeout(timer);
    }
  };

  const locks = getLocks();
  const run = locks ?
    locks.request(LOCK_NAME, {signal: typeof AbortSignal !== 'undefined' && (AbortSignal as any).timeout ? (AbortSignal as any).timeout(LOCK_WAIT_MS) : undefined}, bounded) :
    bounded();

  s.flushing = Promise.resolve(run).catch((err: any) => {
    if(state !== s) return;
    // Put the batch back in front whatever happened: on a transient failure
    // (lock timeout, quota) it is retried; with no OPFS at all it stays in the
    // bounded in-memory buffer so export still has the boot line and every
    // error logged before the first flush.
    s.buffer.unshift(...lines);
    if(err === WRITE_STALL) {
      // Marker lands in the in-memory buffer so the export still shows it.
      pushLine('W', 'diag write stalled — ' + lines.length + ' lines kept in memory, will retry');
    }
    if(isStorageUnsupported(err)) {
      // No OPFS here (old Safari, private mode): stop trying, keep memory-only.
      s.storageBroken = err?.message || String(err);
    }
    // #255 (P2): a stalled write can leave a sync access handle holding the
    // file's exclusive lock FOREVER — it is never closed, so every later
    // acquisition (and createWritable on the same file) rejects with
    // NoModificationAllowedError. That is not isStorageUnsupported, but it
    // is just as permanent for this session, and retrying every 2s would
    // burn the worker without ever landing a byte. Falling back to the copy
    // path cannot work either: createWritable needs the same exclusive
    // access and rejects the same way. So: mark it once, stop flushing, keep
    // everything in the bounded memory buffer for export.
    if(err?.name === 'NoModificationAllowedError') {
      pushLine('W', 'diag log file locked by a stalled write — lines kept in memory only, will not retry');
      s.storageBroken = 'stalled write left the diag log file locked';
    }

    if(s.buffer.length > DIAG_MAX_BUFFERED_LINES) {
      const cut = s.buffer.length - DIAG_MAX_BUFFERED_LINES;
      s.buffer.splice(0, cut);
      s.dropped += cut;
    }
  }).finally(() => {
    if(state === s) {
      s.flushing = null;
      if(writeMode === 'copy') slowFlushTimer(s);
    }
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
    flushTimer: null,
    flushIntervalMs: FLUSH_INTERVAL_MS,
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
    s.flushTimer = setInterval(() => flushDiagnosticsLog(), FLUSH_INTERVAL_MS);
    s.timers.push(s.flushTimer);

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
