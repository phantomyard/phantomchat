// Scratch cleanup for the Electron smoke scripts. These run in `finally`, where a
// throw would replace the real failure: on Windows the just-closed Electron can
// still hold its profile, so rmSync raises EPERM and the log shows only that.
// A leftover scratch dir on a runner is harmless, so warn instead of failing.
import {rmSync} from 'node:fs';

// Playwright's close() tears down the browser context; it does NOT await the
// Electron child's exit. That gap is not cosmetic: the single-instance lock
// lives in userData (electron/main.ts), so a relaunch on the same profile while
// the old process is still shutting down is refused the lock, calls app.quit()
// before it ever makes a window, and firstWindow() waits out its whole timeout
// on an app that is behaving exactly as designed. That is how run 42475769969
// failed its offline relaunch, and the same still-running child is what makes
// removeScratch hit EPERM on Windows. Every smoke script therefore waits for
// the process it closed; this is the one place that does it.
const EXIT_TIMEOUT_MS = 30000;

export async function stopElectron(desktop, {timeoutMs = EXIT_TIMEOUT_MS, kill = true} = {}) {
  if(!desktop) return;
  const proc = desktop.process();
  const exited = new Promise((resolveExit) => {
    if(proc.exitCode !== null || proc.signalCode !== null) resolveExit();
    else proc.once('exit', resolveExit);
  });
  await desktop.close();
  const gone = await Promise.race([
    exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), timeoutMs).unref())
  ]);
  // A child that ignores the graceful close must not wedge the job: kill it, so
  // the lock and the profile are released for the next launch either way.
  if(gone || !kill) return;
  proc.kill('SIGKILL');
  await exited;
}

export function removeScratch(dir, rm = rmSync) {
  try {
    rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 500});
  } catch(err) {
    console.warn(`Could not remove smoke scratch ${dir}: ${err?.message ?? err}`);
  }
}
