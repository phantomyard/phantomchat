/*
 * PhantomChat desktop — diagnostics wiring (issue #243).
 *
 * Hooks every "the app froze / died" signal Electron exposes into the plain
 * text log from diagnostics.ts. Read it with:
 *
 *   cat ~/.config/phantomchat/logs/phantomchat.log       (Linux)
 *   phantomchat --log-path                                (prints the path)
 *
 * Also owns the GPU switch-off, which must run before app 'ready'.
 */
import {app, crashReporter, ipcMain, powerMonitor, type BrowserWindow} from 'electron';
import {release} from 'os';
import {
  DiagnosticsLog,
  GPU_DISABLE_SWITCHES,
  gpuOptOutRequested,
  HEARTBEAT_INTERVAL_MS,
  LivenessMonitor,
  parseHeartbeat,
  RateLimiter,
  readStaleSessionMarker,
  writeSessionMarker,
  clearSessionMarker,
  type LivenessEvent,
  type SessionMarker
} from './diagnostics';

/** IPC channel the preload heartbeat uses. Keep in lockstep with preload.ts. */
export const HEARTBEAT_CHANNEL = 'desktop:diag-heartbeat';

const SUMMARY_INTERVAL_MS = 5 * 60_000;
const CALL_STACK_TIMEOUT_MS = 5_000;

let log: DiagnosticsLog | undefined;
const liveness = new LivenessMonitor();
const consoleLimiter = new RateLimiter(20, 60_000);
let marker: SessionMarker | undefined;
let currentWindow: BrowserWindow | undefined;

export function logsDir(): string {
  return app.getPath('logs');
}

function emit(events: LivenessEvent[]): void {
  for(const e of events) {
    log?.write(e.level, e.event, e.fields);
    // An idle freeze never fires 'unresponsive' (that needs pending input),
    // so a missed heartbeat is where we grab the stuck JS stack instead.
    if(e.event === 'renderer-heartbeat-missed' && currentWindow && !currentWindow.isDestroyed()) {
      void logFrozenCallStack(currentWindow);
    }
  }
}

function windowState(win: BrowserWindow | undefined): Record<string, unknown> {
  if(!win || win.isDestroyed()) return {window: 'none'};
  return {visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused()};
}

/**
 * Before app 'ready'. Turns the GPU off, opens the log, records whether the
 * previous session ended uncleanly, and starts local-only crash dumps.
 * Call only in the instance that holds the single-instance lock — a second
 * launch must not touch the running instance's log or marker.
 */
export function startDiagnosticsEarly(): void {
  const gpuEnabled = gpuOptOutRequested(process.env);
  if(!gpuEnabled) {
    app.disableHardwareAcceleration();
    for(const sw of GPU_DISABLE_SWITCHES) app.commandLine.appendSwitch(sw);
  }
  // Lets webContents.mainFrame.collectJavaScriptCallStack() report where a
  // frozen renderer is stuck (paired with the Document-Policy header main.ts
  // adds to app:// responses).
  app.commandLine.appendSwitch('enable-features', 'DocumentPolicyIncludeJSCallStacksInCrashReports');

  const dir = logsDir();
  log = new DiagnosticsLog(dir);
  log.info('app-start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    os: release(),
    pid: process.pid,
    gpu: gpuEnabled ? 'ENABLED (PHANTOMCHAT_ENABLE_GPU=1)' : 'disabled',
    log: log.path
  });
  if(gpuEnabled) log.warn('gpu-opt-in', {note: 'GPU acceleration re-enabled by PHANTOMCHAT_ENABLE_GPU=1 — testing only'});

  const stale = readStaleSessionMarker(dir);
  if(stale) {
    log.error('previous-session-unclean', {
      ...stale,
      note: 'last session never quit cleanly (killed, crashed or power loss); its last log lines are just above'
    });
  }

  marker = {pid: process.pid, version: app.getVersion(), startedAt: new Date().toISOString(), lastAliveAt: new Date().toISOString()};
  writeSessionMarker(dir, marker);

  // Local crash dumps only — nothing is ever uploaded.
  try {
    crashReporter.start({uploadToServer: false, compress: false});
    log.info('crash-dumps', {dir: app.getPath('crashDumps')});
  } catch(err) {
    log.warn('crash-dumps-unavailable', {error: String(err)});
  }

  // Observe, don't change: a monitor listener leaves Node's default crash
  // behaviour intact, but the reason is on disk before the process dies.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    log?.error('main-uncaught-exception', {origin, message: err?.message}, err?.stack);
  });

  app.on('child-process-gone', (_event, details) => {
    const level = details.reason === 'clean-exit' ? 'INFO' : 'ERROR';
    log?.write(level, 'child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName
    });
  });

  app.on('before-quit', () => log?.info('app-before-quit'));
  app.on('will-quit', () => {
    log?.info('app-quit-clean');
    clearSessionMarker(dir);
  });
  process.on('exit', (code) => log?.info('process-exit', {code}));
}

/** After app 'ready': GPU proof, power events, heartbeat IPC, timers. */
export function startDiagnosticsAfterReady(getWindow: () => BrowserWindow | null): void {
  try {
    log?.info('gpu-feature-status', app.getGPUFeatureStatus() as unknown as Record<string, unknown>);
  } catch(err) {
    log?.warn('gpu-feature-status-unavailable', {error: String(err)});
  }

  // Sleep/lock: the "freezes after idle" theory is tested directly by these.
  powerMonitor.on('suspend', () => {
    liveness.suspend();
    log?.info('power-suspend', windowState(getWindow() ?? undefined));
  });
  powerMonitor.on('resume', () => {
    liveness.resume(Date.now());
    log?.info('power-resume', windowState(getWindow() ?? undefined));
  });
  powerMonitor.on('lock-screen', () => log?.info('screen-locked'));
  powerMonitor.on('unlock-screen', () => log?.info('screen-unlocked'));
  powerMonitor.on('shutdown', () => log?.info('os-shutdown'));
  powerMonitor.on('on-ac', () => log?.info('power-ac'));
  powerMonitor.on('on-battery', () => log?.info('power-battery'));

  ipcMain.on(HEARTBEAT_CHANNEL, (event, raw: unknown) => {
    const win = getWindow();
    // Only the main window's own renderer may feed the liveness monitor.
    if(!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const beat = parseHeartbeat(raw);
    if(beat) emit(liveness.beat(Date.now(), beat));
  });

  setInterval(() => emit(liveness.check(Date.now())), HEARTBEAT_INTERVAL_MS).unref();

  setInterval(() => {
    const win = getWindow() ?? undefined;
    let processes = '';
    try {
      processes = app.getAppMetrics()
      .map((m) => `${m.type}:${m.pid}:cpu${m.cpu.percentCPUUsage.toFixed(1)}%:${Math.round(m.memory.workingSetSize / 1024)}MB`)
      .join(',');
    } catch{
      // metrics are a nice-to-have
    }
    log?.info('alive', {...liveness.takeSummary(), ...windowState(win), processes});
    if(marker) {
      marker.lastAliveAt = new Date().toISOString();
      writeSessionMarker(logsDir(), marker);
    }
  }, SUMMARY_INTERVAL_MS).unref();
}

async function logFrozenCallStack(win: BrowserWindow): Promise<void> {
  try {
    const stack = await Promise.race([
      win.webContents.mainFrame.collectJavaScriptCallStack(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CALL_STACK_TIMEOUT_MS))
    ]);
    if(typeof stack === 'string' && stack.length > 0) {
      log?.error('renderer-js-stack', {}, stack);
    } else {
      log?.warn('renderer-js-stack-unavailable', {note: 'no stack returned (renderer not running JS, or stack collection unsupported)'});
    }
  } catch(err) {
    log?.warn('renderer-js-stack-unavailable', {error: String(err)});
  }
}

/** Per-window hooks: hangs, renderer death, load failures, visibility. */
export function attachWindowDiagnostics(win: BrowserWindow): void {
  currentWindow = win;
  const wc = win.webContents;
  log?.info('window-created', {id: win.id});

  // Chromium's hang monitor: the renderer stopped acking input events.
  win.on('unresponsive', () => {
    log?.error('window-unresponsive', {...windowState(win), note: 'renderer stopped responding to input'});
    void logFrozenCallStack(win);
  });
  win.on('responsive', () => log?.warn('window-responsive-again'));

  wc.on('render-process-gone', (_event, details) => {
    liveness.resetRenderer();
    log?.error('renderer-gone', {reason: details.reason, exitCode: details.exitCode});
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if(isMainFrame) log?.error('load-failed', {errorCode, errorDescription, url: validatedURL});
  });
  wc.on('preload-error', (_event, preloadPath, error) => {
    log?.error('preload-error', {preloadPath, message: error?.message}, error?.stack);
  });
  wc.on('did-finish-load', () => {
    liveness.resetRenderer();
    // The renderer PID, so a live freeze can be inspected from a shell
    // (e.g. `cat /proc/<pid>/status`, `top -p <pid>`) before it is killed.
    log?.info('page-loaded', {rendererPid: wc.getOSProcessId(), mainPid: process.pid});
  });

  // Renderer errors only (not info/debug noise), rate-limited so a loop of
  // errors cannot rotate the freeze evidence out of the log.
  wc.on('console-message', (event) => {
    if(event.level !== 'error') return;
    const {allow, droppedBefore} = consoleLimiter.take(Date.now());
    if(droppedBefore > 0) log?.warn('renderer-console-errors-dropped', {count: droppedBefore});
    if(allow) log?.warn('renderer-console-error', {source: event.sourceId, line: event.lineNumber, message: event.message});
  });

  for(const name of ['show', 'hide', 'minimize', 'restore'] as const) {
    win.on(name as 'show', () => log?.info(`window-${name}`));
  }
  win.on('closed', () => {
    if(currentWindow === win) currentWindow = undefined;
    liveness.resetRenderer();
    log?.info('window-closed');
  });
}
