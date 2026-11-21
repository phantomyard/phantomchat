import {afterEach, expect, it, vi} from 'vitest';
vi.mock('@lib/langPack', () => ({i18n: (key: string) => document.createTextNode(key)}));
import {mountSessionSyncStatus, withStableSessionList, SYNC_PROGRESS_DELAY_MS, SYNC_PROGRESS_VISIBLE_MS} from '@lib/phantomchat/session-sync-ui';
import {enableSessionSync, resetSessionSync, setGroupsSyncStatus, setChatSyncStatus, markGroupsSyncStale, canSendToSyncedChat, getGroupsSyncStatus} from '@lib/phantomchat/session-sync-state';
afterEach(() => { resetSessionSync(); document.body.replaceChildren(); vi.useRealTimers(); });
it('delays active progress and hides failed, offline and settled status', async() => {
  vi.useFakeTimers();
  enableSessionSync(async() => true);
  setGroupsSyncStatus('ready');
  setChatSyncStatus(123, 'ready');
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = mountSessionSyncStatus(host, () => 123);
  const slot = host.querySelector<HTMLElement>('.session-sync-status');
  expect(slot.hidden).toBe(true);
  setChatSyncStatus(123, 'syncing');
  expect(slot.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(SYNC_PROGRESS_DELAY_MS - 1);
  expect(slot.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(slot.hidden).toBe(false);
  expect(slot.textContent).toContain('SessionSync.Messages');
  setChatSyncStatus(123, 'failed');
  expect(slot.hidden).toBe(true);
  expect(slot.textContent).toBe('');
  expect(slot.querySelector('button')).toBeNull();
  setChatSyncStatus(123, 'offline');
  expect(slot.hidden).toBe(true);
  expect(slot.textContent).toBe('');
  setChatSyncStatus(123, 'ready');
  expect(slot.hidden).toBe(true);
  dispose();
  expect(host.children.length).toBe(0);
});
it('keeps the cached list still while applying then reveals the reconciled list once', async() => {
  const live = document.createElement('div');
  live.id = 'folders-container';
  live.textContent = 'Cached session';
  document.body.append(live);
  let release: () => void;
  const pass = withStableSessionList(() => new Promise<void>((resolve) => { release = resolve; }));
  live.textContent = 'Current session';
  const snapshot = document.querySelector<HTMLElement>('.session-sync-snapshot');
  expect(snapshot.textContent).toBe('Cached session');
  expect(snapshot.getAttribute('aria-hidden')).toBe('true');
  expect(live.style.visibility).toBe('hidden');
  release();
  await pass;
  expect(document.querySelector('.session-sync-snapshot')).toBeNull();
  expect(live.style.visibility).toBe('');
  expect(live.textContent).toBe('Current session');
});
it('restores access to the live list when application fails', async() => {
  const live = document.createElement('div');
  live.id = 'folders-container';
  document.body.append(live);
  await expect(withStableSessionList(async() => { throw new Error('storage unavailable'); })).rejects.toThrow('storage unavailable');
  expect(live.style.visibility).toBe('');
  expect(document.querySelector('.session-sync-snapshot')).toBeNull();
});

it('reveals the usable cached list even if application never settles', async() => {
  vi.useFakeTimers();
  const live = document.createElement('div');
  live.id = 'folders-container';
  document.body.append(live);
  void withStableSessionList(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(live.style.visibility).toBe('');
  expect(document.querySelector('.session-sync-snapshot')).toBeNull();
  vi.useRealTimers();
});

it('bounds an unresolved episode across automatic retries without claiming readiness', async() => {
  vi.useFakeTimers();
  try {
    enableSessionSync(async() => false);
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = mountSessionSyncStatus(host);
    const slot = host.querySelector<HTMLElement>('.session-sync-status');
    expect(slot.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(SYNC_PROGRESS_DELAY_MS);
    expect(slot.hidden).toBe(false);
    markGroupsSyncStale([-123]);
    await vi.advanceTimersByTimeAsync(SYNC_PROGRESS_VISIBLE_MS - SYNC_PROGRESS_DELAY_MS);
    expect(slot.hidden).toBe(true);
    expect(getGroupsSyncStatus()).toBe('syncing');
    expect(canSendToSyncedChat(-123)).toBe(false);
    expect(canSendToSyncedChat(-456)).toBe(true);
    // Automatic retries must not keep resurrecting an unhelpful notification.
    for(let i = 0; i < 3; i++) {
      setGroupsSyncStatus('failed');
      await vi.advanceTimersByTimeAsync(30_000);
      setGroupsSyncStatus('syncing');
      expect(slot.hidden).toBe(true);
    }
    setGroupsSyncStatus('ready');
    setGroupsSyncStatus('syncing');
    expect(slot.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(SYNC_PROGRESS_DELAY_MS);
    expect(slot.hidden).toBe(false);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('never flashes progress for quick syncs or after disposal', async() => {
  vi.useFakeTimers();
  enableSessionSync(async() => true);
  const host = document.createElement('div');
  const dispose = mountSessionSyncStatus(host);
  const slot = host.querySelector<HTMLElement>('.session-sync-status');
  await vi.advanceTimersByTimeAsync(SYNC_PROGRESS_DELAY_MS - 1);
  setGroupsSyncStatus('ready');
  await vi.advanceTimersByTimeAsync(SYNC_PROGRESS_VISIBLE_MS);
  expect(slot.hidden).toBe(true);
  expect(slot.textContent).toBe('');
  setGroupsSyncStatus('syncing');
  dispose();
  expect(vi.getTimerCount()).toBe(0);
});
