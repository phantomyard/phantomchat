// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  installDiagnosticsLog,
  uninstallDiagnosticsLogForTests,
  diagLog,
  flushDiagnosticsLog,
  readDiagnosticsLog,
  registerDiagnosticsProbe,
  runDiagnosticsHeartbeatForTests,
  getBufferedDiagnosticsForTests,
  formatConsoleArgs,
  isExportDiagnosticsShortcut,
  isStorageUnsupported,
  DIAG_LOG_FILE,
  DIAG_LOG_OLD_FILE,
  DIAG_MAX_FILE_BYTES,
  DIAG_LINES_PER_MINUTE,
  WRITE_TIMEOUT_MS
} from '@lib/phantomchat/diagnostics-log';
import SuperMessagePort, {SLOW_INVOKE_MS} from '@lib/superMessagePort';

/**
 * #246 persistent diagnostics log. OPFS is faked with an in-memory directory
 * that implements the subset the module uses (getFileHandle / getFile /
 * createWritable with keepExistingData + seek), with real Blob semantics.
 */

function fakeOpfs(opts: {sync?: boolean, hangFirstWrite?: boolean, hangFirstSyncAcquisition?: boolean, getSizeDrift?: number} = {}) {
  // #255 P1: createSyncAccessHandle must resolve asynchronously, like the
  // real API — the fake defers at least one microtask so an implementation
  // that treats it as synchronous fails loudly.
  const delayMicrotasks = <T,>(value: T): Promise<T> =>
    (async() => { await Promise.resolve(); return value; })();
  const files = new Map<string, string>();
  let writeCount = 0;
  let syncAcquisitionCount = 0;
  const decoder = new TextDecoder();
  // #254 fake: an in-place handle over the same in-memory string.
  const syncHandle = (name: string) => ({
    write(buffer: Uint8Array, options?: {at?: number}) {
      const text = decoder.decode(buffer);
      const at = options?.at ?? 0;
      let content = files.get(name);
      // Real OPFS zero-pads when writing past EOF; the fake pads with spaces
      // so the drift test mirrors native placement.
      if(at > content.length) content = content + ' '.repeat(at - content.length);
      files.set(name, content.slice(0, at) + text + content.slice(at + text.length));
      return text.length;
    },
    flush() {},
    close() {},
    truncate(size: number) {
      files.set(name, files.get(name).slice(0, size));
    },
    getSize() {
      // #255 minor seam: getSize() is read AFTER acquisition, so a stalled
      // write can have moved the file since the pre-acquisition getFile()
      // snapshot. Drift makes the two disagree on demand.
      return files.get(name).length + (opts.getSizeDrift || 0);
    }
  });
  const dir = {
    async getFileHandle(name: string, options?: {create?: boolean}) {
      if(!files.has(name)) {
        if(!options?.create) throw Object.assign(new Error('not found'), {name: 'NotFoundError'});
        files.set(name, '');
      }

      return {
        async getFile() {
          // jsdom's Blob has no .text(); carry the content alongside.
          const content = files.get(name);
          const blob: any = new Blob([content]);
          blob.text = async() => content;
          blob.__content = content;
          return blob;
        },
        // Real OPFS: the handle arrives as a Promise (#255 P1 regression fake);
        // `delayMicrotasks` defers resolution a tick so a sync (un-awaited)
        // acquisition would write onto the Promise object and lose the batch.
        ...(opts.sync ? {createSyncAccessHandle: () => {
          syncAcquisitionCount++;
          // #255 P2 fake: the FIRST acquisition hangs for good — the handle
          // is held and never closed, exactly like a stalled sync write. Every
          // later acquisition on the locked file rejects the way real OPFS
          // does when a sync access handle is still open.
          if(opts.hangFirstSyncAcquisition) {
            if(syncAcquisitionCount === 1) return new Promise(() => {});
            const locked = Object.assign(new Error('file already locked'), {name: 'NoModificationAllowedError'});
            return delayMicrotasks({}).then(() => { throw locked; });
          }
          return delayMicrotasks(syncHandle(name));
        }} : {}),
        async createWritable(writableOpts?: {keepExistingData?: boolean}) {
          writeCount++;
          if(opts.hangFirstWrite && writeCount === 1) {
            // #254 fake: the first write() never settles.
            return {
              async seek() {},
              write: () => new Promise<void>(() => {}),
              async close() {}
            };
          }

          // Like the real API: writes land in a swap copy, committed on close.
          let swap = writableOpts?.keepExistingData ? files.get(name) : '';
          // Spec: the cursor starts at 0 even with keepExistingData, so an
          // append without seek() overwrites the head of the file.
          let pos = 0;
          return {
            async seek(p: number) {
              pos = p;
            },
            async write(data: string | Blob) {
              const text = typeof data === 'string' ? data : (data as any).__content;
              swap = swap.slice(0, pos) + text + swap.slice(pos + text.length);
              pos += text.length;
            },
            async close() {
              files.set(name, swap);
            }
          };
        }
      };
    }
  };
  return {files, getDirectory: async() => dir, get createWritableCalls() { return writeCount; }, get syncAcquisitions() { return syncAcquisitionCount; }};
}

let clock = 0;

function install(extra: any = {}) {
  const opfs = fakeOpfs();
  installDiagnosticsLog({
    context: 'worker',
    getDirectory: opfs.getDirectory,
    locks: null,
    now: () => clock,
    autoFlush: false,
    ...extra
  });
  return opfs;
}

describe('formatConsoleArgs', () => {
  it('drops the app logger %s style token and ANSI colours', () => {
    const line = formatConsoleArgs(['%s \x1b[36m%s', '[16.2]', '[IDB-tweb-common-session]', 'transaction not finished']);
    expect(line).toBe('[16.2] [IDB-tweb-common-session] transaction not finished');
  });

  it('renders Errors with name, message and a trimmed stack on one line', () => {
    const err = new Error('boom');
    const line = formatConsoleArgs(['failed:', err]);
    expect(line.startsWith('failed: Error: boom | ')).toBe(true);
    expect(line).not.toContain('\n');
  });

  it('names DOM-like objects that stringify to {} instead of printing [object Object]', () => {
    class IDBTransaction {}
    expect(formatConsoleArgs([new IDBTransaction()])).toBe('[IDBTransaction]');
  });

  it('never serialises object content — class name and identifier-like type/code only', () => {
    const task = {type: 'invoke', id: 7, payload: {type: 'manager', payload: {name: 'm', method: 'x', args: ['PRIVATE_MESSAGE_SENTINEL']}}};
    expect(formatConsoleArgs(['task', task])).toBe('task [Object type=invoke]');
    expect(formatConsoleArgs([{type: 'FLOOD_WAIT_5', code: 420, message: 'PRIVATE_MESSAGE_SENTINEL'}])).toBe('[Object type=FLOOD_WAIT_5 code=420]');
    // Free text in an allowlisted field is still dropped.
    expect(formatConsoleArgs([{type: 'hello PRIVATE_MESSAGE_SENTINEL'}])).toBe('[Object]');
    expect(formatConsoleArgs([['PRIVATE_MESSAGE_SENTINEL']])).toBe('[Array(1)]');
  });

  it('keeps a real %s inside a message that is not just the style token', () => {
    expect(formatConsoleArgs(['100%s done'])).toBe('100%s done');
  });
});

describe('diagnostics log', () => {
  beforeEach(() => {
    clock = Date.parse('2026-10-22T07:00:00Z');
  });

  afterEach(() => {
    uninstallDiagnosticsLogForTests();
  });

  it('is a no-op before install (library code may call it unconditionally)', () => {
    diagLog('E', 'nobody listening');
    expect(getBufferedDiagnosticsForTests()).toEqual([]);
  });

  it('captures console.error/warn and writes tagged lines to the OPFS file', async() => {
    const opfs = install();
    const spy = vi.spyOn(console, 'error');
    console.error('%s', '[MP-MTPROTO]', 'invoke TIMEOUT after 60000ms: manager:appMessagesManager.getHistory');
    console.warn('relay down');
    await flushDiagnosticsLog();

    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text).toContain('2026-10-22T07:00:00.000Z worker I boot worker');
    expect(text).toContain('worker E [MP-MTPROTO] invoke TIMEOUT after 60000ms: manager:appMessagesManager.getHistory\n');
    expect(text).toContain('worker W relay down\n');
    spy.mockRestore();
  });

  it('still calls through to the real console', () => {
    const calls: any[] = [];
    const original = console.warn;
    console.warn = (...args) => calls.push(args);
    install();
    console.warn('hello');
    uninstallDiagnosticsLogForTests();
    console.warn = original;
    expect(calls).toEqual([['hello']]);
  });

  it('appends across flushes instead of overwriting', async() => {
    const opfs = install();
    diagLog('I', 'first');
    await flushDiagnosticsLog();
    diagLog('I', 'second');
    await flushDiagnosticsLog();
    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text.indexOf('first')).toBeGreaterThan(-1);
    expect(text.indexOf('second')).toBeGreaterThan(text.indexOf('first'));
  });

  it('collapses back-to-back duplicates into one line plus a repeat count', async() => {
    const opfs = install();
    for(let i = 0; i < 50; i++) diagLog('W', '[NostrRelay] WebSocket error');
    diagLog('E', 'something else');
    await flushDiagnosticsLog();
    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text.match(/WebSocket error/g)).toHaveLength(1);
    expect(text).toContain('(previous line repeated 49x)');
    expect(text.indexOf('repeated 49x')).toBeLessThan(text.indexOf('something else'));
  });

  it('caps lines per minute, then reports how many were dropped', async() => {
    const opfs = install();
    for(let i = 0; i < DIAG_LINES_PER_MINUTE + 100; i++) diagLog('E', 'err ' + i);
    clock += 60_000;
    diagLog('E', 'next minute');
    await flushDiagnosticsLog();
    const text = opfs.files.get(DIAG_LOG_FILE);
    // boot line used one slot of the first minute.
    expect(text).toContain('diagnostics-log dropped 101 lines');
    expect(text).toContain('next minute');
    expect(text).not.toContain('err ' + (DIAG_LINES_PER_MINUTE + 99) + '\n');
  });

  it('keeps 492 startup errors that the old 20/min desktop cap threw away', async() => {
    const opfs = install();
    for(let i = 0; i < 492; i++) diagLog('E', 'startup error ' + i);
    await flushDiagnosticsLog();
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('startup error 491\n');
  });

  it('rotates to one older generation when the file passes the size cap', async() => {
    const opfs = install();
    opfs.files.set(DIAG_LOG_FILE, 'x'.repeat(DIAG_MAX_FILE_BYTES - 10) + '\n');
    diagLog('I', 'after rotation');
    await flushDiagnosticsLog();

    expect(opfs.files.get(DIAG_LOG_OLD_FILE).length).toBe(DIAG_MAX_FILE_BYTES - 9);
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('after rotation');
    expect(opfs.files.get(DIAG_LOG_FILE).length).toBeLessThan(500);

    const all = await readDiagnosticsLog();
    expect(all.indexOf('xxxx')).toBeLessThan(all.indexOf('after rotation'));
  });

  it('puts a batch back when a write fails transiently and writes it next time', async() => {
    const opfs = fakeOpfs();
    let fail = true;
    installDiagnosticsLog({
      context: 'worker',
      locks: null,
      now: () => clock,
      autoFlush: false,
      getDirectory: async() => {
        if(fail) throw new Error('lock wait timed out');
        return opfs.getDirectory();
      }
    });
    diagLog('E', 'must survive');
    await flushDiagnosticsLog();
    expect(opfs.files.get(DIAG_LOG_FILE)).toBeUndefined();
    fail = false;
    await flushDiagnosticsLog();
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('must survive');
  });

  it('stops trying when OPFS is unavailable and says so in the export', async() => {
    installDiagnosticsLog({
      context: 'win:test',
      locks: null,
      now: () => clock,
      autoFlush: false,
      getDirectory: async() => {
        throw new Error('OPFS unavailable');
      }
    });
    diagLog('E', 'memory only');
    await flushDiagnosticsLog();
    diagLog('E', 'after the switch');
    await flushDiagnosticsLog();
    const text = await readDiagnosticsLog();
    expect(text).toContain('OPFS unavailable in this browser');
    // The batch the failed flush took is kept, not just the notice.
    expect(text).toContain('boot win:test');
    expect(text).toContain('memory only');
    expect(text).toContain('after the switch');
  });

  it('keeps the first batch when the export itself is the first (failing) flush', async() => {
    installDiagnosticsLog({
      context: 'win:test',
      locks: null,
      now: () => clock,
      autoFlush: false,
      getDirectory: async() => {
        throw new Error('OPFS unavailable');
      }
    });
    diagLog('E', 'FIRST_BATCH_SENTINEL');
    const text = await readDiagnosticsLog();
    expect(text).toContain('FIRST_BATCH_SENTINEL');
  });

  it('serialises writes through the cross-context Web Lock', async() => {
    const opfs = fakeOpfs();
    const names: string[] = [];
    installDiagnosticsLog({
      context: 'worker',
      getDirectory: opfs.getDirectory,
      now: () => clock,
      autoFlush: false,
      locks: {
        request: async(name, _options, cb) => {
          names.push(name);
          return cb();
        }
      }
    });
    diagLog('I', 'locked write');
    await flushDiagnosticsLog();
    expect(names).toEqual(['phantomchat-diag-log']);
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('locked write');
  });

  it('heartbeat records event-loop lag and every probe', async() => {
    const opfs = install();
    registerDiagnosticsProbe('mp', () => 'awaiting=1 [manager:x.y 61s] handling=0');
    registerDiagnosticsProbe('broken', () => {
      throw new Error('nope');
    });
    runDiagnosticsHeartbeatForTests(4200);
    runDiagnosticsHeartbeatForTests(4200);
    await flushDiagnosticsLog();
    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text).toContain('worker I heartbeat lag=4200ms mp{awaiting=1 [manager:x.y 61s] handling=0} broken{probe error Error: nope');
    // Two identical heartbeats are both kept: a missing beat is the signal.
    expect(text.match(/heartbeat lag/g)).toHaveLength(2);
  });

  it('captures uncaught errors from the global error event', async() => {
    const opfs = install();
    const event = new ErrorEvent('error', {message: 'Uncaught TypeError: x is undefined', filename: 'app://localhost/index.js', lineno: 2, colno: 99});
    self.dispatchEvent(event);
    await flushDiagnosticsLog();
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('E uncaught Uncaught TypeError: x is undefined at app://localhost/index.js:2:99');
  });

  it('truncates very long lines', async() => {
    const opfs = install();
    diagLog('E', 'y'.repeat(10_000));
    await flushDiagnosticsLog();
    const line = opfs.files.get(DIAG_LOG_FILE).split('\n').find((l) => l.includes('yyy'));
    expect(line.length).toBeLessThan(2100);
  });
});

describe('#254: in-place writes and the stall bound', () => {
  beforeEach(() => {
    clock = Date.parse('2026-10-22T07:00:00Z');
  });

  afterEach(() => {
    uninstallDiagnosticsLogForTests();
    vi.useRealTimers();
  });

  it('steady-state flushes append in place: zero createWritable calls, so no new OPFS backing file per flush', async() => {
    const opfs = fakeOpfs({sync: true});
    install({getDirectory: opfs.getDirectory});
    diagLog('I', 'one');
    await flushDiagnosticsLog();
    diagLog('I', 'two');
    await flushDiagnosticsLog();
    diagLog('I', 'three');
    await flushDiagnosticsLog();
    expect(opfs.createWritableCalls).toBe(0);
    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text.indexOf('one')).toBeGreaterThan(-1);
    expect(text.indexOf('three')).toBeGreaterThan(text.indexOf('one'));
  });

  it('rotates one generation in sync mode too, still without a swap-file write', async() => {
    const opfs = fakeOpfs({sync: true});
    install({getDirectory: opfs.getDirectory});
    opfs.files.set(DIAG_LOG_FILE, 'x'.repeat(DIAG_MAX_FILE_BYTES - 10) + '\n');
    diagLog('I', 'after rotation');
    await flushDiagnosticsLog();
    expect(opfs.files.get(DIAG_LOG_OLD_FILE).length).toBe(DIAG_MAX_FILE_BYTES - 9);
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('after rotation');
    expect(opfs.createWritableCalls).toBe(0);
  });

  it('acquires the sync handle asynchronously: the fake\'s handle is a Promise and both acquisitions still land (P1 regression)', async() => {
    const opfs = fakeOpfs({sync: true});
    install({getDirectory: opfs.getDirectory});
    const dir: any = await opfs.getDirectory();
    const fileHandle: any = await dir.getFileHandle(DIAG_LOG_FILE, {create: true});
    const acquisition = fileHandle.createSyncAccessHandle();
    expect(acquisition).toBeInstanceOf(Promise);
    await acquisition.then((sync: any) => sync.close());
    diagLog('I', 'async-acquired');
    await flushDiagnosticsLog();
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('async-acquired');
  });

  it('a hung write releases the Web Lock, keeps the lines in memory and logs a stall marker', async() => {
    vi.useFakeTimers();
    const opfs = fakeOpfs({hangFirstWrite: true});
    let held = false;
    const locks = {
      async request(_name: string, _options: any, cb: () => Promise<void>) {
        if(held) throw Object.assign(new Error('lock wait timed out'), {name: 'AbortError'});
        held = true;
        try {
          return await cb();
        } finally {
          held = false;
        }
      }
    };
    install({getDirectory: opfs.getDirectory, locks});

    diagLog('E', 'before stall');
    const flush1 = flushDiagnosticsLog();
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
    // Still hung mid-write: the batch is in flight and the lock is held.
    expect(getBufferedDiagnosticsForTests()).toEqual([]);
    expect(held).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    await flush1;
    const buffered = getBufferedDiagnosticsForTests().join('');
    expect(buffered).toContain('before stall');
    expect(buffered).toContain('diag write stalled');
    // The lock callback settled at the timeout, so the lock is free again —
    // the OTHER context is no longer silenced by this one's hung write.
    expect(held).toBe(false);

    diagLog('E', 'after stall');
    await flushDiagnosticsLog();
    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text).toContain('before stall');
    expect(text).toContain('diag write stalled');
    expect(text).toContain('after stall');
  });

  it('a stalled sync handle locks the file for the session: one marker, then no more acquisition attempts (P2)', async() => {
    vi.useFakeTimers();
    const opfs = fakeOpfs({sync: true, hangFirstSyncAcquisition: true});
    install({getDirectory: opfs.getDirectory});

    diagLog('E', 'before stall');
    const flush1 = flushDiagnosticsLog();
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 2);
    await flush1;
    // The acquisition hung: stall marker, lines kept in memory, file empty.
    const buffered1 = getBufferedDiagnosticsForTests().join('');
    expect(buffered1).toContain('before stall');
    expect(buffered1).toContain('diag write stalled');
    expect(opfs.files.get(DIAG_LOG_FILE) || '').not.toContain('before stall');
    expect(opfs.syncAcquisitions).toBe(1);

    // Next flush: the hung handle still holds the exclusive lock, so the
    // acquisition rejects with NoModificationAllowedError.
    diagLog('E', 'after stall');
    await flushDiagnosticsLog();
    const buffered2 = getBufferedDiagnosticsForTests().join('');
    expect(buffered2).toContain('after stall');
    expect(buffered2).toContain('locked by a stalled write');
    expect(opfs.syncAcquisitions).toBe(2);

    // Retrying forever would never land a byte (createWritable needs the
    // same exclusive access) — so the log goes memory-only: no further
    // acquisition attempts, exactly one locked-marker, lines still kept.
    diagLog('E', 'third');
    await flushDiagnosticsLog();
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS * 3);
    const buffered3 = getBufferedDiagnosticsForTests().join('');
    expect(buffered3).toContain('third');
    expect((buffered3.match(/locked by a stalled write/g) || []).length).toBe(1);
    expect(opfs.syncAcquisitions).toBe(2);
  });

  it('appends at the post-acquisition live size, not the pre-acquisition getFile() snapshot (#255 minor)', async() => {
    // Stalled-write edge: between the getFile() snapshot and the sync
    // acquisition the file grew (drift 40) — the append must land at the
    // LIVE size, leaving the drifted gap, not overwrite per the snapshot.
    const opfs = fakeOpfs({sync: true, getSizeDrift: 40});
    install({getDirectory: opfs.getDirectory});
    opfs.files.set(DIAG_LOG_FILE, 'x'.repeat(40) + '\n'); // 41 live-at-snapshot
    diagLog('I', 'appended after live size');
    await flushDiagnosticsLog();
    const text = opfs.files.get(DIAG_LOG_FILE);
    expect(text.startsWith('x'.repeat(40))).toBe(true);
    // 41 snapshot bytes + 40 drifted bytes, THEN the line — not at 41.
    expect(text.slice(41, 81)).toBe(' '.repeat(40));
    expect(text.indexOf('appended after live size')).toBeGreaterThan(81);
  });

  it('copy-only contexts slow their flush cadence from 2s to 15s', async() => {
    vi.useFakeTimers();
    const opfs = fakeOpfs(); // no sync handles: window / old Safari
    install({getDirectory: opfs.getDirectory, autoFlush: true});
    diagLog('E', 'first');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('first');

    diagLog('E', 'second');
    await vi.advanceTimersByTimeAsync(2_000); // the old cadence would have flushed here
    expect(opfs.files.get(DIAG_LOG_FILE) || '').not.toContain('second');
    await vi.advanceTimersByTimeAsync(13_000); // 15s after the first copy flush
    expect(opfs.files.get(DIAG_LOG_FILE)).toContain('second');
  });
});

describe('isStorageUnsupported', () => {
  it('only treats real capability failures as permanent', () => {
    expect(isStorageUnsupported(new Error('OPFS unavailable'))).toBe(true);
    expect(isStorageUnsupported(Object.assign(new Error('x'), {name: 'SecurityError'}))).toBe(true);
    expect(isStorageUnsupported(new TypeError('handle.createWritable is not a function'))).toBe(true);
    // A bug or transient error must not switch the log off for the session.
    expect(isStorageUnsupported(new TypeError('data.text is not a function'))).toBe(false);
    expect(isStorageUnsupported(Object.assign(new Error('quota'), {name: 'QuotaExceededError'}))).toBe(false);
    expect(isStorageUnsupported(Object.assign(new Error('aborted'), {name: 'AbortError'}))).toBe(false);
  });
});

describe('export shortcut', () => {
  it('is Ctrl+Alt+Shift+D only', () => {
    expect(isExportDiagnosticsShortcut({ctrlKey: true, altKey: true, shiftKey: true, key: 'D', code: 'KeyD'} as any)).toBe(true);
    expect(isExportDiagnosticsShortcut({ctrlKey: true, altKey: false, shiftKey: true, key: 'D', code: 'KeyD'} as any)).toBe(false);
    // L is the passcode-lock key (user-chosen modifiers + L): never claim it.
    expect(isExportDiagnosticsShortcut({ctrlKey: true, altKey: true, shiftKey: true, key: 'L', code: 'KeyL'} as any)).toBe(false);
  });
});

class TestPort extends SuperMessagePort<any, any, true> {
  constructor() {
    super('TEST');
  }

  public resolveLatest(result: any) {
    const ids = Object.keys(this.awaiting);
    this.processResultTask({type: 'result', payload: {taskId: Number(ids[ids.length - 1]), result}} as any);
  }

  public handle(type: string, payload: any) {
    return this.processInvokeTask({type: 'invoke', id: 7, payload: {type, payload}} as any, undefined, undefined);
  }
}

describe('superMessagePort diagnostics hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-22T07:00:00Z'));
  });

  afterEach(() => {
    uninstallDiagnosticsLogForTests();
    vi.useRealTimers();
  });

  it('logs a slow invoke with its label once it finally settles', () => {
    installDiagnosticsLog({context: 'win:t', locks: null, autoFlush: false, captureConsole: false});
    const port = new TestPort();
    port.invoke('manager', {name: 'appMessagesManager', method: 'getHistory', args: ['secret']});
    vi.advanceTimersByTime(SLOW_INVOKE_MS + 1500);
    port.resolveLatest(1);
    const lines = getBufferedDiagnosticsForTests().join('');
    expect(lines).toContain('slow invoke 6500ms: manager:appMessagesManager.getHistory');
    expect(lines).not.toContain('secret');
  });

  it('does not log a fast invoke', () => {
    installDiagnosticsLog({context: 'win:t', locks: null, autoFlush: false, captureConsole: false});
    const port = new TestPort();
    port.invoke('manager', {name: 'a', method: 'b'});
    vi.advanceTimersByTime(100);
    port.resolveLatest(1);
    expect(getBufferedDiagnosticsForTests().join('')).not.toContain('slow invoke');
  });

  it('describeOutstanding lists what this side awaits and what it is still handling, oldest first', async() => {
    installDiagnosticsLog({context: 'worker', locks: null, autoFlush: false, captureConsole: false});
    const port = new TestPort();
    let release: () => void;
    port.addEventListener('manager', () => new Promise<void>((r) => release = r));
    const handled = port.handle('manager', {name: 'appStateManager', method: 'save', args: ['secret']});

    port.invoke('manager', {name: 'old', method: 'call'});
    vi.advanceTimersByTime(30_000);
    port.invoke('manager', {name: 'new', method: 'call'});
    vi.advanceTimersByTime(2_000);

    expect(port.describeOutstanding()).toBe('awaiting=2 [manager:old.call 32s, manager:new.call 2s] handling=1 [manager:appStateManager.save 32s]');

    release();
    await handled;
    expect(port.describeOutstanding()).toContain('handling=0');
    // The handler took 32 s: logged as a slow handler, without args.
    const lines = getBufferedDiagnosticsForTests().join('');
    expect(lines).toContain('slow handler 32000ms: manager:appStateManager.save');
    expect(lines).not.toContain('secret');
  });
});

describe('privacy: captured console never persists manager args', () => {
  // Silence the real console underneath the capture wrapper (spy first, so
  // the wrapper installed afterwards still sees every call).
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    uninstallDiagnosticsLogForTests();
    vi.restoreAllMocks();
  });

  it('a throwing manager handler logs its label, not its args', async() => {
    const opfs = fakeOpfs();
    installDiagnosticsLog({context: 'worker', locks: null, autoFlush: false, getDirectory: opfs.getDirectory});
    const port = new TestPort();
    port.addEventListener('manager', () => {
      throw new Error('handler failed');
    });
    await port.handle('manager', {name: 'appMessagesManager', method: 'sendText', args: ['PRIVATE_MESSAGE_SENTINEL']});

    const text = await readDiagnosticsLog();
    expect(text).toContain('worker task error: manager:appMessagesManager.sendText');
    expect(text).toContain('handler failed');
    expect(text).not.toContain('PRIVATE_MESSAGE_SENTINEL');
  });

  it('an app console.error with a private object stores no content', async() => {
    const opfs = fakeOpfs();
    installDiagnosticsLog({context: 'win:t', locks: null, autoFlush: false, getDirectory: opfs.getDirectory});
    console.error('send failed', {message: 'PRIVATE_MESSAGE_SENTINEL', peerId: 12345}, ['PRIVATE_MESSAGE_SENTINEL']);
    const text = await readDiagnosticsLog();
    expect(text).toContain('send failed [Object] [Array(1)]');
    expect(text).not.toContain('PRIVATE_MESSAGE_SENTINEL');
  });
});

describe('wiring', () => {
  const SRC = path.resolve(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf-8');

  it('the shared worker installs the log before its other imports evaluate and probes its port', () => {
    const src = read('lib/mainWorker/index.worker.ts');
    // A side-effect import, not a call: imports are hoisted, so a call in the
    // body would run after every other import had evaluated.
    expect(src.indexOf('import \'@lib/mainWorker/installDiagnosticsLog\'')).toBeGreaterThan(-1);
    expect(src.indexOf('import \'@lib/mainWorker/installDiagnosticsLog\'')).toBeLessThan(src.indexOf('import cryptoWorker'));
    expect(read('lib/mainWorker/installDiagnosticsLog.ts')).toContain('installDiagnosticsLog({context: \'worker\'})');
    expect(src).toContain('registerDiagnosticsProbe(\'mp\', () => port.describeOutstanding())');
  });

  it('the window installs the log, the shortcut and its port probe', () => {
    const src = read('index.ts');
    expect(src).toContain('installWindowDiagnosticsLog(');
    expect(src).toContain('MTProtoMessagePort.getInstance()?.describeOutstanding()');
  });

  it('Report a Bug offers the log download', () => {
    const src = read('components/popups/reportBug.ts');
    expect(src).toContain('Download diagnostics log');
    expect(src).toContain('exportDiagnosticsLog(');
  });
});
