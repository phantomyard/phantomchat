/**
 * Bounded main-thread scheduler for persisted incoming messages.
 *
 * Relay/unwrap work can deliver a large catch-up burst at boot or reconnect.
 * The rows are already durable in IndexedDB before they reach this scheduler,
 * so UI projection may be spread across turns without risking message loss.
 * Keeping only a small number of projections in flight prevents Worker bridge
 * calls and synchronous rootScope listeners from monopolising the main thread.
 */

export const INCOMING_UI_BATCH_SIZE = 4;

export interface IncomingSchedulerOptions<T> {
  handle(item: T): Promise<void> | void;
  isPriority?(item: T): boolean;
  batchSize?: number;
  yieldToMain?(): Promise<void>;
  onError?(error: unknown): void;
}

export interface IncomingScheduler<T> {
  enqueue(item: T): void;
  flush(): Promise<void>;
  pending(): number;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function createIncomingScheduler<T>(opts: IncomingSchedulerOptions<T>): IncomingScheduler<T> {
  const queue: T[] = [];
  const batchSize = Math.max(1, opts.batchSize ?? INCOMING_UI_BATCH_SIZE);
  const yieldToMain = opts.yieldToMain ?? defaultYield;
  let running: Promise<void> | null = null;

  const takeNext = (): T | undefined => {
    if(!queue.length) return undefined;
    if(opts.isPriority) {
      const priorityIndex = queue.findIndex(opts.isPriority);
      if(priorityIndex > 0) return queue.splice(priorityIndex, 1)[0];
    }
    return queue.shift();
  };

  const drain = async() => {
    while(queue.length) {
      const batch: T[] = [];
      while(batch.length < batchSize && queue.length) {
        const item = takeNext();
        if(item !== undefined) batch.push(item);
      }
      // Preserve arrival order within each batch. In particular, two messages
      // for one conversation must not race setDialogTopMessage and leave the
      // older row as the preview. The bounded batch + yield is what protects
      // responsiveness; parallel Worker bridge calls are unnecessary here.
      for(const item of batch) {
        try {
          await opts.handle(item);
        } catch(err) {
          opts.onError?.(err);
        }
      }
      if(queue.length) await yieldToMain();
    }
  };

  const start = () => {
    if(running) return;
    running = Promise.resolve()
    .then(drain)
    .finally(() => {
      running = null;
      if(queue.length) start();
    });
  };

  return {
    enqueue(item) {
      queue.push(item);
      start();
    },
    async flush() {
      while(running || queue.length) {
        if(!running) start();
        await running;
      }
    },
    pending: () => queue.length
  };
}
