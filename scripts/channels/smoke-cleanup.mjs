// Scratch cleanup for the Electron smoke scripts. These run in `finally`, where a
// throw would replace the real failure: on Windows the just-closed Electron can
// still hold its profile, so rmSync raises EPERM and the log shows only that.
// A leftover scratch dir on a runner is harmless, so warn instead of failing.
import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';

// ElectronApplication.close() closes the browser context, which quits the app
// over CDP and then awaits the child (playwright-core: electron.js close() ->
// browserContext.close()). That await is the trap: an app that ignores the quit
// never returns from it, and the single-instance lock lives in userData
// (electron/main.ts) — so the relaunch on the same profile is refused the lock,
// calls app.quit() before it ever makes a window, and firstWindow() waits out its
// whole timeout on an app behaving exactly as designed. Run 42475769969 failed
// its offline relaunch that way, and the still-running child is also what makes
// removeScratch hit EPERM on Windows. Every smoke script therefore closes through
// stopElectron, which bounds the wait instead of trusting close() to return.
const EXIT_TIMEOUT_MS = 30000;

const TIMED_OUT = Symbol('timed out');

// Races a promise against a timer and clears the timer either way, so a resolved
// teardown never leaves a live handle behind.
function within(promise, ms) {
  let handle;
  const timer = new Promise((resolveTimer) => {
    handle = setTimeout(() => resolveTimer(TIMED_OUT), ms);
    handle.unref?.();
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(handle));
}

// SIGKILL on the direct child is not the app. On win32 Playwright spawns Electron
// through a shell (`shell: true`), so process() is cmd.exe and killing it leaves
// Electron holding the profile; on POSIX the GPU/renderer children outlive the
// main process. Playwright's own force kill is `taskkill /pid <pid> /T /F` on
// win32 and `process.kill(-pid, 'SIGKILL')` elsewhere — the latter works because
// it spawns the child detached, as its own process-group leader
// (playwright-core processLauncher.js). This mirrors that.
export function killProcessTree(proc, {platform = process.platform, spawnFn = spawnSync, killProcess = process.kill} = {}) {
  const pid = proc?.pid;
  if(!pid) return false;
  try {
    if(platform === 'win32') {
      spawnFn(`taskkill /pid ${pid} /T /F`, {shell: true, stdio: 'ignore'});
      return true;
    }
    killProcess(-pid, 'SIGKILL');
    return true;
  } catch(err) {
    // ESRCH when the child was not spawned detached, so it leads no group.
    try {
      proc.kill('SIGKILL');
      return true;
    } catch {
      console.warn(`Could not kill smoke process tree ${pid}: ${err?.message ?? err}`);
      return false;
    }
  }
}

export async function stopElectron(desktop, {timeoutMs = EXIT_TIMEOUT_MS, kill = true, killTree = killProcessTree} = {}) {
  if(!desktop) return;
  const proc = desktop.process();
  let gone = proc.exitCode !== null || proc.signalCode !== null;
  const exited = new Promise((resolveExit) => {
    if(gone) return resolveExit();
    proc.once('exit', () => {
      gone = true;
      resolveExit();
    });
  });

  // close() is started but never awaited on its own: on a wedged app it does not
  // settle, which is the whole failure mode. It still rejects harmlessly when the
  // app is already gone (TargetClosedError), so swallow that too.
  const closing = Promise.resolve()
    .then(() => desktop.close())
    .then(() => {}, () => {});

  if(await within(exited, timeoutMs) === TIMED_OUT && !gone && kill) {
    killTree(proc);
    // The kill is best effort: bound the wait for the exit as well, so a process
    // we failed to kill cannot wedge the job the way close() would have.
    if(await within(exited, timeoutMs) === TIMED_OUT && !gone)
      console.warn(`Smoke Electron process ${proc.pid} still running ${timeoutMs}ms after the kill`);
  }
  void closing;
}

export function removeScratch(dir, rm = rmSync) {
  try {
    rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 500});
  } catch(err) {
    console.warn(`Could not remove smoke scratch ${dir}: ${err?.message ?? err}`);
  }
}
