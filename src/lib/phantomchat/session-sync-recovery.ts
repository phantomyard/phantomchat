/** Await a step without allowing an abandoned attempt to continue past it. */
export function syncStep<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Sync attempt abandoned')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    work.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if(signal.aborted) abort();
  });
}

export const SYNC_ATTEMPT_MS = 30_000;
/** One bounded attempt at a time, automatic forced retries with capped backoff.
 * Cancellation fences late completions; it never clears or overwrites storage.
 */
export function createSyncRecovery(opts: {
  run(signal: AbortSignal, force: boolean): Promise<boolean>;
  status(status: 'syncing' | 'ready' | 'failed' | 'offline'): void;
  current(): boolean;
  cleanup(fn: () => void): void;
}): (force?: boolean) => Promise<boolean> {
  let flight: Promise<boolean> | undefined;
  let controller: AbortController;
  let retry: ReturnType<typeof setTimeout>;
  let failures = 0;
  let again = false;
  let disposed = false;
  let registered = false;
  const alive = () => !disposed && opts.current();
  const reconcile = (force = false): Promise<boolean> => {
    if(!alive()) return Promise.resolve(false);
    if(!registered) {
      registered = true;
      opts.cleanup(() => { disposed = true; clearTimeout(retry); controller?.abort(); });
    }
    if(flight) { again = true; return flight; }
    clearTimeout(retry);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    opts.status(offline ? 'offline' : 'syncing');
    controller = new AbortController();
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), SYNC_ATTEMPT_MS);
    flight = (async() => {
      let ok = false;
      try {
        do {
          again = false;
          ok = false;
          ok = offline ? await Promise.resolve(false) : await syncStep(opts.run(signal, force || failures > 0), signal);
        } while(ok && again && alive() && !signal.aborted);
      } catch(error) {
        if(alive()) console.warn('[session-sync] retrying failed attempt', error);
      } finally {
        clearTimeout(timeout);
        flight = undefined;
        if(alive()) {
          opts.status(ok ? 'ready' : offline ? 'offline' : 'failed');
          if(ok) failures = 0;
          else {
            const delay = Math.min(30_000, 2_000 * 2 ** Math.min(failures++, 4));
            retry = setTimeout(() => { void reconcile(true); }, delay);
          }
        }
      }
      return ok;
    })();
    return flight;
  };
  return reconcile;
}
