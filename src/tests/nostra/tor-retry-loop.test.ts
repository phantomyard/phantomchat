import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TorBootstrapLoop} from '@lib/nostra/tor-bootstrap-loop';

describe('TorBootstrapLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks the ladder and stops at steady state when never succeeding', async() => {
    const waitsSeen: number[] = [];
    let attemptCount = 0;
    const loop = new TorBootstrapLoop({
      schedule: [5, 10, 20, 40],
      attempt: async() => {
        attemptCount++;
        return false;
      },
      onSuccess: () => { throw new Error('should not succeed'); },
      onFailure: () => {},
      observeWait: (ms) => waitsSeen.push(ms)
    });
    loop.start();
    // Attempt 1 fires immediately on start()
    await vi.advanceTimersByTimeAsync(0);
    expect(attemptCount).toBe(1);
    // Wait slot 1 = 5s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attemptCount).toBe(2);
    // Wait slot 2 = 10s
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attemptCount).toBe(3);
    // 20s
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attemptCount).toBe(4);
    // 40s (ladder exhausted, steady-state)
    await vi.advanceTimersByTimeAsync(40_000);
    expect(attemptCount).toBe(5);
    // Subsequent waits all 40s
    await vi.advanceTimersByTimeAsync(40_000);
    expect(attemptCount).toBe(6);
    expect(waitsSeen).toEqual([5_000, 10_000, 20_000, 40_000, 40_000, 40_000]);
    loop.stop();
  });

  it('calls onSuccess and halts the schedule when an attempt returns true', async() => {
    const onSuccess = vi.fn();
    let calls = 0;
    const loop = new TorBootstrapLoop({
      schedule: [5, 10],
      attempt: async() => {
        calls++;
        return calls >= 2; // succeed on 2nd attempt
      },
      onSuccess,
      onFailure: () => {},
      observeWait: () => {}
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // No further attempts after success
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
  });

  it('stop() cancels a pending wait and prevents future attempts', async() => {
    let attemptCount = 0;
    const loop = new TorBootstrapLoop({
      schedule: [5, 10],
      attempt: async() => { attemptCount++; return false; },
      onSuccess: () => {},
      onFailure: () => {},
      observeWait: () => {}
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attemptCount).toBe(1);
    loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attemptCount).toBe(1);
    expect(loop.isRunning()).toBe(false);
  });

  it('onFailure receives the caught error and the 1-based attempt number', async() => {
    const onFailure = vi.fn();
    const err = new Error('boom');
    let calls = 0;
    const loop = new TorBootstrapLoop({
      schedule: [5],
      attempt: async() => {
        calls++;
        if(calls === 1) throw err;
        return true;
      },
      onSuccess: () => {},
      onFailure,
      observeWait: () => {}
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onFailure).toHaveBeenCalledWith(err, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
  });
});
