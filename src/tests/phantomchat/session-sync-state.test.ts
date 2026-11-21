import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  enableSessionSync, resetSessionSync, getChatSyncStatus, getGroupsSyncStatus,
  setChatSyncStatus, setGroupsSyncStatus, canSendToSyncedChat, createGroupsReconciler,
  registerChatSyncRetry, retrySessionSync, subscribeSessionSync, markChatSyncStale, markGroupsSyncStale
} from '@lib/phantomchat/session-sync-state';

const PEER = -12_000_000_000_000_004;
afterEach(() => resetSessionSync());

describe('session freshness', () => {
  it('requires both metadata and message evidence; cached rendering is independent', () => {
    enableSessionSync(async() => true);
    expect(canSendToSyncedChat(PEER)).toBe(false);
    setChatSyncStatus(PEER, 'ready');
    expect(getChatSyncStatus(PEER)).toBe('syncing');
    setGroupsSyncStatus('ready');
    expect(canSendToSyncedChat(PEER)).toBe(true);
    markGroupsSyncStale();
    setGroupsSyncStatus('failed');
    expect(canSendToSyncedChat(PEER)).toBe(false);
  });

  it('routes composer retry to its peer and sidebar retry to metadata', () => {
    const groups = vi.fn().mockResolvedValue(true);
    const chat = vi.fn().mockResolvedValue(undefined);
    enableSessionSync(groups);
    registerChatSyncRetry(chat);
    retrySessionSync(PEER);
    retrySessionSync();
    expect(chat).toHaveBeenCalledWith(PEER);
    expect(groups).toHaveBeenCalledTimes(1);
  });

  it('coalesces a nudge mid-flight and keeps syncing until the trailing pass finishes', async() => {
    const releases: Array<(ok: boolean) => void> = [];
    const run = vi.fn(() => new Promise<boolean>((resolve) => releases.push(resolve)));
    const reconcile = createGroupsReconciler(run);
    enableSessionSync(reconcile);
    const first = reconcile();
    const second = reconcile();
    expect(run).toHaveBeenCalledTimes(1);
    releases.shift()(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(getGroupsSyncStatus()).toBe('syncing');
    releases.shift()(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(getGroupsSyncStatus()).toBe('ready');
  });

  it('does not claim readiness after a partial apply fails', async() => {
    const reconcile = createGroupsReconciler(async() => { throw new Error('IDB failure'); });
    enableSessionSync(reconcile);
    expect(await reconcile()).toBe(false);
    expect(getGroupsSyncStatus()).toBe('failed');
  });

  it('late completion from an old identity cannot unlock a new identity', async() => {
    let release: (ok: boolean) => void;
    const reconcile = createGroupsReconciler(() => new Promise<boolean>((resolve) => { release = resolve; }));
    enableSessionSync(reconcile);
    const old = reconcile();
    enableSessionSync(async() => true);
    release(true);
    await old;
    expect(getGroupsSyncStatus()).toBe('syncing');
  });

  it('unsubscribes UI listeners on disposal', () => {
    const render = vi.fn();
    const dispose = subscribeSessionSync(render);
    expect(render).toHaveBeenCalledTimes(1);
    dispose();
    setChatSyncStatus(PEER, 'offline');
    expect(render).toHaveBeenCalledTimes(1);
  });
});


it('untracked peers are unaffected; selected chats explicitly begin a check', () => {
  enableSessionSync(async() => true);
  expect(getChatSyncStatus(123)).toBe('ready');
  setChatSyncStatus(123, 'syncing');
  expect(canSendToSyncedChat(123)).toBe(false);
});

it('cold cached and previously verified chats retain offline queueing unless marked stale', () => {
  enableSessionSync(async() => true);
  setGroupsSyncStatus('ready');
  setChatSyncStatus(PEER, 'offline');
  expect(canSendToSyncedChat(PEER)).toBe(true);
  setChatSyncStatus(PEER, 'ready');
  setChatSyncStatus(PEER, 'offline');
  expect(canSendToSyncedChat(PEER)).toBe(true);
  setChatSyncStatus(PEER, 'failed');
  expect(canSendToSyncedChat(PEER)).toBe(true);
  markChatSyncStale(PEER);
  setChatSyncStatus(PEER, 'failed');
  expect(canSendToSyncedChat(PEER)).toBe(false);
});

it('a known remote metadata change revokes offline queueing until checked', () => {
  enableSessionSync(async() => true);
  setGroupsSyncStatus('ready');
  setChatSyncStatus(PEER, 'ready');
  markGroupsSyncStale();
  setGroupsSyncStatus('failed');
  expect(canSendToSyncedChat(PEER)).toBe(false);
  setGroupsSyncStatus('ready');
  expect(canSendToSyncedChat(PEER)).toBe(true);
});


it('starting offline keeps the existing queue available without waiting on a network timer', () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    enableSessionSync(async() => false);
    setChatSyncStatus(PEER, 'offline');
    expect(getGroupsSyncStatus()).toBe('offline');
    expect(canSendToSyncedChat(PEER)).toBe(true);
    markGroupsSyncStale();
    setGroupsSyncStatus('offline');
    expect(canSendToSyncedChat(PEER)).toBe(false);
  } finally {
    online.mockRestore();
  }
});

it('a slow metadata check exposes failure feedback and heals when it eventually completes', async() => {
  vi.useFakeTimers();
  try {
    let release: (ok: boolean) => void;
    const reconcile = createGroupsReconciler(() => new Promise<boolean>((resolve) => { release = resolve; }));
    enableSessionSync(reconcile);
    const pass = reconcile();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getGroupsSyncStatus()).toBe('failed');
    expect(canSendToSyncedChat(PEER)).toBe(true);
    release(true);
    await pass;
    expect(getGroupsSyncStatus()).toBe('ready');
  } finally {
    vi.useRealTimers();
  }
});
