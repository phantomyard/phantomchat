import {describe, it, expect, beforeEach, vi, afterEach} from 'vitest';
import {
  markChatListReady,
  whenChatListReady,
  resetChatListReady,
  READY_TIMEOUT_MS
} from '@lib/phantomchat/phantomchat-ready-gate';

describe('phantomchat-ready-gate (#217 cold-start paint gate)', () => {
  beforeEach(() => {
    resetChatListReady();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetChatListReady();
  });

  it('stays pending until BOTH signals land, then resolves every waiter', async() => {
    let ready = false;
    const gate = whenChatListReady().then(() => { ready = true; });

    markChatListReady('previews');
    await Promise.resolve();
    expect(ready).toBe(false); // read state not settled yet — splash holds

    markChatListReady('read-state');
    await gate;
    expect(ready).toBe(true);
  });

  it('resolves immediately once both signals already landed', async() => {
    markChatListReady('previews');
    markChatListReady('read-state');
    await expect(whenChatListReady()).resolves.toBeUndefined();
  });

  it('repeated signals are no-ops (periodic reconciles cannot re-gate)', async() => {
    markChatListReady('previews');
    markChatListReady('read-state');
    markChatListReady('read-state');
    markChatListReady('previews');
    await expect(whenChatListReady()).resolves.toBeUndefined();
  });

  it('breaks the hold on its own timeout so a dead relay can never wedge the UI', async() => {
    vi.useFakeTimers();
    const gate = whenChatListReady();
    let ready = false;
    void gate.then(() => { ready = true; });

    vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(ready).toBe(false);

    vi.advanceTimersByTime(1);
    await gate;
    expect(ready).toBe(true);
  });

  it('honours an explicit timeout argument', async() => {
    vi.useFakeTimers();
    const gate = whenChatListReady(50);
    let ready = false;
    void gate.then(() => { ready = true; });
    vi.advanceTimersByTime(50);
    await gate;
    expect(ready).toBe(true);
  });

  it('resolves pending waiters on reset (logout) instead of hanging them', async() => {
    const gate = whenChatListReady();
    markChatListReady('previews');
    resetChatListReady();
    await gate; // must not hang
    // And the gate is fresh afterwards: one signal alone is not enough.
    let ready = false;
    void whenChatListReady().then(() => { ready = true; });
    markChatListReady('previews');
    await Promise.resolve();
    expect(ready).toBe(false);
  });
});
