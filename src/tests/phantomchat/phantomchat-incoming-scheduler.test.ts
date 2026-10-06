import '../setup';
import {describe, expect, it, vi} from 'vitest';
import {
  createIncomingScheduler,
  INCOMING_UI_BATCH_SIZE
} from '@lib/phantomchat/phantomchat-incoming-scheduler';

describe('phantomchat incoming UI scheduler', () => {
  it('projects reconnect bursts in bounded batches with a main-thread yield', async() => {
    let active = 0;
    let peak = 0;
    const handled: number[] = [];
    const yieldToMain = vi.fn().mockResolvedValue(undefined);
    const scheduler = createIncomingScheduler<number>({
      handle: async(item) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        handled.push(item);
        active--;
      },
      yieldToMain
    });

    for(let i = 0; i < 10; i++) scheduler.enqueue(i);
    await scheduler.flush();

    expect(handled).toHaveLength(10);
    expect(peak).toBe(1);
    expect(yieldToMain).toHaveBeenCalledTimes(2);
    expect(scheduler.pending()).toBe(0);
  });

  it('moves the currently open chat ahead of queued background work', async() => {
    const order: string[] = [];
    const scheduler = createIncomingScheduler<{id: string; open: boolean}>({
      batchSize: 1,
      isPriority: (item) => item.open,
      handle: (item) => { order.push(item.id); },
      yieldToMain: () => Promise.resolve()
    });

    scheduler.enqueue({id: 'background-a', open: false});
    scheduler.enqueue({id: 'open-chat', open: true});
    scheduler.enqueue({id: 'background-b', open: false});
    await scheduler.flush();

    expect(order).toEqual(['open-chat', 'background-a', 'background-b']);
  });

  it('preserves arrival order inside a batch', async() => {
    const order: number[] = [];
    const scheduler = createIncomingScheduler<number>({
      batchSize: 2,
      handle: async(item) => {
        if(item === 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
        order.push(item);
      },
      yieldToMain: () => Promise.resolve()
    });

    scheduler.enqueue(1);
    scheduler.enqueue(2);
    await scheduler.flush();

    expect(order).toEqual([1, 2]);
  });

  it('isolates a failed projection and keeps draining durable rows', async() => {
    const handled: number[] = [];
    const onError = vi.fn();
    const scheduler = createIncomingScheduler<number>({
      batchSize: 2,
      handle: (item) => {
        if(item === 2) throw new Error('worker bridge failed');
        handled.push(item);
      },
      onError,
      yieldToMain: () => Promise.resolve()
    });

    scheduler.enqueue(1);
    scheduler.enqueue(2);
    scheduler.enqueue(3);
    await scheduler.flush();

    expect(handled).toEqual([1, 3]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
