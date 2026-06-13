/**
 * TorBootstrapLoop — scheduled retry loop for Tor bootstrap attempts.
 *
 * Walks a per-mode wait schedule (in seconds), calling `attempt()` each
 * iteration. First attempt fires immediately on `start()`. On success,
 * `onSuccess` is called and the loop stops. On failure or thrown error,
 * the loop waits for the next slot in the schedule; once the ladder is
 * exhausted, it stays at the last slot (steady-state) forever.
 *
 * The loop is cancelable via `stop()` — any in-flight wait is canceled
 * and no further attempts fire. `stop()` does NOT cancel an in-flight
 * `attempt()` promise; callers must tolerate a late resolution.
 */

export interface TorBootstrapLoopOpts {
  /** Wait durations in seconds. Last value is used as steady-state. */
  schedule: number[];
  /** Single bootstrap probe. Resolve true on success, false on failure. */
  attempt: () => Promise<boolean>;
  onSuccess: () => void;
  onFailure: (err: unknown, attemptNum: number) => void;
  /** Test hook — observes each wait in ms. */
  observeWait?: (ms: number) => void;
}

export class TorBootstrapLoop {
  private readonly opts: TorBootstrapLoopOpts;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptNum = 0;

  constructor(opts: TorBootstrapLoopOpts) {
    if(opts.schedule.length === 0) {
      throw new Error('TorBootstrapLoop: schedule must have at least one entry');
    }
    this.opts = opts;
  }

  start(): void {
    if(this.running) return;
    this.running = true;
    this.attemptNum = 0;
    void this.runOne();
  }

  stop(): void {
    this.running = false;
    if(this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runOne(): Promise<void> {
    if(!this.running) return;
    this.attemptNum += 1;
    let ok = false;
    try {
      ok = await this.opts.attempt();
    } catch(err) {
      if(!this.running) return;
      this.opts.onFailure(err, this.attemptNum);
      this.scheduleNext();
      return;
    }
    if(!this.running) return;
    if(ok) {
      this.running = false;
      this.opts.onSuccess();
      return;
    }
    this.opts.onFailure(new Error('attempt returned false'), this.attemptNum);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if(!this.running) return;
    const idx = Math.min(this.attemptNum - 1, this.opts.schedule.length - 1);
    const waitMs = this.opts.schedule[idx] * 1000;
    this.opts.observeWait?.(waitMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOne();
    }, waitMs);
  }
}
