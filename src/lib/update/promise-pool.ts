/**
 * Bounded-concurrency promise runner.
 * Used to throttle parallel asset downloads during update to avoid
 * saturating the CDN origin.
 */

export class PromisePool {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if(this.running >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if(next) next();
    }
  }
}
