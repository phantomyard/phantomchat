/*
 * Desktop diagnostics (issue #243): the log must stay one-event-per-line and
 * cat-readable, rotate instead of growing forever, flag an unclean previous
 * exit, and report each freeze as one begin/end pair — without crying wolf
 * on a hidden (throttled) window or a laptop that was asleep.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, readFileSync, rmSync, existsSync, readdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {
  DEFAULT_THRESHOLDS,
  DiagnosticsLog,
  GPU_DISABLE_SWITCHES,
  HEARTBEAT_INTERVAL_MS,
  LivenessMonitor,
  LOG_FILE_NAME,
  RateLimiter,
  SIGNAL_QUIT_TIMEOUT_MS,
  clearSessionMarker,
  createSignalQuitHandler,
  formatLogLine,
  gpuOptOutRequested,
  parseHeartbeat,
  readStaleSessionMarker,
  writeSessionMarker
} from './diagnostics';
import {HEARTBEAT_CHANNEL} from './diagnosticsElectron';

const AT = new Date('2026-10-21T21:00:00.000Z');
const events = (list: {event: string}[]) => list.map((e) => e.event);

describe('GPU switch-off', () => {
  it('disables GPU compositing, rasterization and video paths, not just "disable-gpu"', () => {
    for(const sw of ['disable-gpu', 'disable-gpu-compositing', 'disable-gpu-rasterization', 'disable-accelerated-video-decode']) {
      expect(GPU_DISABLE_SWITCHES).toContain(sw);
    }
  });

  it('stays off unless PHANTOMCHAT_ENABLE_GPU is exactly "1"', () => {
    expect(gpuOptOutRequested({})).toBe(false);
    expect(gpuOptOutRequested({PHANTOMCHAT_ENABLE_GPU: 'true'})).toBe(false);
    expect(gpuOptOutRequested({PHANTOMCHAT_ENABLE_GPU: '0'})).toBe(false);
    expect(gpuOptOutRequested({PHANTOMCHAT_ENABLE_GPU: '1'})).toBe(true);
  });
});

describe('formatLogLine', () => {
  it('writes time, level, event and key=value on one line', () => {
    expect(formatLogLine(AT, 'ERROR', 'renderer-gone', {reason: 'crashed', exitCode: 11}))
    .toBe('2026-10-21T21:00:00.000Z ERROR renderer-gone reason=crashed exitCode=11\n');
  });

  it('quotes values that could forge fields or break the line', () => {
    const line = formatLogLine(AT, 'WARN', 'renderer-console-error', {message: 'boom x=1\nERROR fake-event'});
    expect(line.split('\n')).toHaveLength(2); // one line + trailing newline
    expect(line).toContain('message="boom x=1\\nERROR fake-event"');
  });

  it('puts multi-line detail (a JS stack) on indented continuation lines', () => {
    const line = formatLogLine(AT, 'ERROR', 'renderer-js-stack', {}, '\n    at a (x.js:1)\n    at b (y.js:2)\n');
    expect(line).toBe('2026-10-21T21:00:00.000Z ERROR renderer-js-stack\n  |     at a (x.js:1)\n  |     at b (y.js:2)\n');
  });
});

describe('DiagnosticsLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-diag-'));
  });
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('appends plain lines to <dir>/phantomchat.log', () => {
    const log = new DiagnosticsLog(join(dir, 'logs'), {now: () => AT});
    log.info('app-start', {version: '1.0.323'});
    log.error('window-unresponsive');
    expect(log.path).toBe(join(dir, 'logs', LOG_FILE_NAME));
    expect(readFileSync(log.path, 'utf8')).toBe(
      '2026-10-21T21:00:00.000Z INFO  app-start version=1.0.323\n' +
      '2026-10-21T21:00:00.000Z ERROR window-unresponsive\n'
    );
  });

  it('rotates at maxBytes and keeps only N old files', () => {
    const log = new DiagnosticsLog(dir, {maxBytes: 200, keep: 2, now: () => AT});
    for(let i = 0; i < 40; ++i) log.info('alive', {i});
    const files = readdirSync(dir).sort();
    expect(files).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`]);
    for(const f of files) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(200);
    // newest event is always in the live file
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toContain('i=39');
  });

  it('continues an existing file across restarts', () => {
    new DiagnosticsLog(dir, {now: () => AT}).info('first');
    new DiagnosticsLog(dir, {now: () => AT}).info('second');
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('unclean-exit marker', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-diag-'));
  });
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('a marker left behind is reported; a clean quit clears it', () => {
    expect(readStaleSessionMarker(dir)).toBeUndefined();
    const marker = {pid: 42, version: '1.0.323', startedAt: AT.toISOString(), lastAliveAt: AT.toISOString()};
    writeSessionMarker(dir, marker);
    expect(readStaleSessionMarker(dir)).toEqual(marker);
    clearSessionMarker(dir);
    expect(readStaleSessionMarker(dir)).toBeUndefined();
    expect(existsSync(join(dir, 'session-running.json.tmp'))).toBe(false);
  });
});

describe('parseHeartbeat', () => {
  it('accepts the preload shape and rejects anything else', () => {
    expect(parseHeartbeat({visible: true, frameWaitMs: 0})).toEqual({visible: true, frameWaitMs: 0});
    expect(parseHeartbeat({visible: 'yes', frameWaitMs: 0})).toBeUndefined();
    expect(parseHeartbeat({visible: true, frameWaitMs: -1})).toBeUndefined();
    expect(parseHeartbeat({visible: true, frameWaitMs: Infinity})).toBeUndefined();
    expect(parseHeartbeat(null)).toBeUndefined();
  });
});

describe('LivenessMonitor', () => {
  const ok = {visible: true, frameWaitMs: 0};
  // Drive the monitor like main.ts does: a check() every interval.
  function run(m: LivenessMonitor, from: number, to: number) {
    const out: {event: string}[] = [];
    for(let t = from; t <= to; t += HEARTBEAT_INTERVAL_MS) out.push(...m.check(t));
    return out;
  }

  it('is silent while beats keep coming', () => {
    const m = new LivenessMonitor();
    const out: {event: string}[] = [];
    for(let t = 0; t <= 120_000; t += HEARTBEAT_INTERVAL_MS) {
      out.push(...m.beat(t, ok), ...m.check(t));
    }
    expect(out).toEqual([]);
  });

  it('reports a visible-window hang once, then its recovery with the duration', () => {
    const m = new LivenessMonitor();
    m.beat(0, ok);
    const during = run(m, 0, 60_000);
    expect(events(during)).toEqual(['renderer-heartbeat-missed']);
    const after = m.beat(65_000, ok);
    expect(after).toEqual([{level: 'WARN', event: 'renderer-heartbeat-recovered', fields: {stalledForMs: 65_000}}]);
  });

  it('tolerates hidden-window timer throttling', () => {
    const m = new LivenessMonitor();
    m.beat(0, {visible: false, frameWaitMs: 0});
    expect(run(m, 0, 60_000)).toEqual([]);
    expect(events(run(m, 65_000, DEFAULT_THRESHOLDS.hiddenStallMs + 5_000))).toEqual(['renderer-heartbeat-missed']);
  });

  it('does not count a suspended laptop as a hang', () => {
    const m = new LivenessMonitor();
    m.beat(0, ok);
    m.check(0);
    m.suspend();
    expect(run(m, 5_000, 3_600_000)).toEqual([]);
    m.resume(3_600_000);
    expect(m.check(3_605_000)).toEqual([]);
  });

  it('flags a paint wedge: timers alive, frame probe stuck, page visible', () => {
    const m = new LivenessMonitor();
    expect(m.beat(0, ok)).toEqual([]);
    expect(m.beat(5_000, {visible: true, frameWaitMs: 5_000})).toEqual([]);
    const stalled = m.beat(10_000, {visible: true, frameWaitMs: 10_000});
    expect(events(stalled)).toEqual(['renderer-frames-stalled']);
    expect(m.beat(15_000, {visible: true, frameWaitMs: 15_000})).toEqual([]); // reported once
    const recovered = m.beat(20_000, ok);
    expect(recovered).toEqual([{level: 'WARN', event: 'renderer-frames-recovered', fields: {stalledForMs: 20_000, visible: true}}]);
  });

  it('ignores a waiting frame probe on a hidden page (rAF never fires there)', () => {
    const m = new LivenessMonitor();
    expect(m.beat(0, {visible: false, frameWaitMs: 600_000})).toEqual([]);
  });

  it('flags the main process event loop running late', () => {
    const m = new LivenessMonitor();
    m.check(0);
    expect(m.check(HEARTBEAT_INTERVAL_MS)).toEqual([]);
    expect(events(m.check(HEARTBEAT_INTERVAL_MS * 2 + 9_000))).toEqual(['main-event-loop-stalled']);
  });

  it('reports a run of late main-loop checks as one begin/end pair', () => {
    const m = new LivenessMonitor();
    let t = 0;
    m.check(t);
    const late = () => events(m.check(t += HEARTBEAT_INTERVAL_MS + 6_000));
    expect(late()).toEqual(['main-event-loop-stalled']);
    expect(late()).toEqual([]);
    expect(late()).toEqual([]);
    const end = m.check(t += HEARTBEAT_INTERVAL_MS);
    expect(events(end)).toEqual(['main-event-loop-recovered']);
    expect(end[0].fields).toMatchObject({lateChecks: 3, worstLateByMs: 6_000});
    expect(late()).toEqual(['main-event-loop-stalled']);
  });

  it('does not close a main-loop lag run across a suspend', () => {
    const m = new LivenessMonitor();
    m.check(0);
    expect(events(m.check(HEARTBEAT_INTERVAL_MS + 6_000))).toEqual(['main-event-loop-stalled']);
    m.suspend();
    m.resume(100_000);
    expect(m.check(100_000 + HEARTBEAT_INTERVAL_MS)).toEqual([]);
  });

  it('summary counts since the last summary, then resets', () => {
    const m = new LivenessMonitor();
    m.beat(0, ok);
    m.beat(7_000, ok);
    expect(m.takeSummary()).toEqual({beats: 2, maxBeatGapMs: 7_000, maxFrameWaitMs: 0, stalls: 0, stalledNow: false});
    expect(m.takeSummary().beats).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('lets N through per window and reports how many were dropped', () => {
    const r = new RateLimiter(2, 1_000);
    expect(r.take(0).allow).toBe(true);
    expect(r.take(1).allow).toBe(true);
    expect(r.take(2).allow).toBe(false);
    expect(r.take(3).allow).toBe(false);
    expect(r.take(1_000)).toEqual({allow: true, droppedBefore: 2});
  });
});

describe('signal-driven quit', () => {
  function harness() {
    const calls: string[] = [];
    const timers: {fn: () => void; ms: number}[] = [];
    const logged: string[] = [];
    const handle = createSignalQuitHandler({
      quit: () => calls.push('quit'),
      exit: (code) => calls.push(`exit:${code}`),
      log: (_level, event) => logged.push(event),
      setTimer: (fn, ms) => timers.push({fn, ms})
    });
    return {calls, timers, logged, handle};
  }

  it('turns the first SIGTERM into a graceful quit, with no hard exit', () => {
    const h = harness();
    h.handle('SIGTERM');
    expect(h.calls).toEqual(['quit']);
    expect(h.logged).toEqual(['signal-quit']);
    expect(h.timers.map((t) => t.ms)).toEqual([SIGNAL_QUIT_TIMEOUT_MS]);
  });

  it('exits hard (marker kept) when the graceful quit never finishes', () => {
    const h = harness();
    h.handle('SIGTERM');
    h.timers[0].fn();
    expect(h.calls).toEqual(['quit', 'exit:143']);
    expect(h.logged).toEqual(['signal-quit', 'signal-quit-timeout']);
  });

  it('a second signal exits immediately with the conventional code', () => {
    const h = harness();
    h.handle('SIGINT');
    h.handle('SIGINT');
    expect(h.calls).toEqual(['quit', 'exit:130']);
    expect(h.logged).toEqual(['signal-quit', 'signal-repeat-exit']);
  });
});

describe('main-process lifecycle wiring', () => {
  const src = readFileSync(join(__dirname, 'diagnosticsElectron.ts'), 'utf8');

  it('routes SIGTERM and SIGINT through the graceful-quit handler', () => {
    expect(src).toMatch(/for\(const sig of \['SIGTERM', 'SIGINT'\] as const\) process\.on\(sig, \(\) => onSignal\(sig\)\)/);
    expect(src).toContain('quit: () => app.quit()');
  });

  it('clears the unclean-session marker on will-quit', () => {
    expect(src).toMatch(/app\.on\('will-quit', \(\) => \{[^}]*clearSessionMarker\(dir\)/);
  });

  it('reads the GPU feature status from gpu-info-update, not straight after ready', () => {
    expect(src).toContain(`app.once('gpu-info-update'`);
    const afterReady = src.slice(src.indexOf('export function startDiagnosticsAfterReady'));
    expect(afterReady).not.toMatch(/log\?\.info\('gpu-feature-status'/);
  });
});

describe('preload heartbeat wiring', () => {
  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8');

  it('sends on the channel main listens on, at the monitor interval', () => {
    expect(preload).toContain(`ipcRenderer.send('${HEARTBEAT_CHANNEL}'`);
    expect(preload).toMatch(new RegExp(`}, ${HEARTBEAT_INTERVAL_MS.toLocaleString('en-US').replace(',', '_')}\\);`));
  });

  it('does not expose the heartbeat to the page', () => {
    const exposed = preload.slice(preload.indexOf('const api'), preload.indexOf('contextBridge.exposeInMainWorld'));
    expect(exposed).not.toContain('diag');
  });
});
