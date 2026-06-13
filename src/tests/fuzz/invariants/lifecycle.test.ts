import {describe, it, expect, vi} from 'vitest';
import {historyRehydratesIdentical, offlineQueuePersistence, noDupAfterDeleteRace, noOrphanTempMidPostReload} from './lifecycle';
import type {FuzzContext, UserHandle} from '../types';

function userMock(evalFn: (...args: any[]) => any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {
      evaluate: vi.fn(evalFn as any),
      waitForTimeout: vi.fn(async() => {}),
      reload: vi.fn(async() => {})
    } as any,
    displayName: 'A', npub: '', remotePeerId: 999,
    consoleLog: [], reloadTimes: [Date.now()]
  };
}

function ctxWith(user: UserHandle, snapshots = new Map()): FuzzContext {
  return {users: {userA: user, userB: user}, relay: null as any, snapshots, actionIndex: 0};
}

describe('INV-history-rehydrates-identical', () => {
  it('passes when history set matches snapshot', async() => {
    const snaps = new Map([['preReloadHistorySig-userA', {sig: 'x', count: 2, mids: ['1', '2']}]]);
    const u = userMock(async() => ['1', '2']);
    const r = await historyRehydratesIdentical.check(ctxWith(u, snaps), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('fails when history set diverges', async() => {
    const snaps = new Map([['preReloadHistorySig-userA', {sig: 'x', count: 2, mids: ['1', '2']}]]);
    const u = userMock(async() => ['1']);
    const r = await historyRehydratesIdentical.check(ctxWith(u, snaps), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('diverged');
  });

  it('skips when mode is during-pending-send', async() => {
    const u = userMock(async() => ['1']);
    const r = await historyRehydratesIdentical.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send'}, meta: {}});
    expect(r.ok).toBe(true);
  });
});

describe('INV-offline-queue-persistence', () => {
  it('passes when pending text is in DOM post-reload', async() => {
    const u = userMock(async() => ({inDom: true, inQueue: false}));
    const r = await offlineQueuePersistence.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send', pendingText: 'hello'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('passes when pending text is in offline queue IDB', async() => {
    const u = userMock(async() => ({inDom: false, inQueue: true}));
    const r = await offlineQueuePersistence.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send', pendingText: 'hello'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('passes when IDB not yet initialized (no store)', async() => {
    const u = userMock(async() => ({inDom: false, inQueue: false, noStore: true}));
    const r = await offlineQueuePersistence.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send', pendingText: 'hello'}, meta: {}});
    expect(r.ok).toBe(true);
  });
});

describe('INV-no-dup-after-delete-race', () => {
  it('passes when no user has duplicate', async() => {
    const u = userMock(async() => 1);
    const r = await noDupAfterDeleteRace.check(ctxWith(u), {name: 'deleteWhileSending', args: {user: 'userA'}, meta: {text: 'race-test-1'}});
    expect(r.ok).toBe(true);
  });

  it('fails when a user has >1 bubble with race text', async() => {
    const u = userMock(async() => 2);
    const r = await noDupAfterDeleteRace.check(ctxWith(u), {name: 'deleteWhileSending', args: {user: 'userA'}, meta: {text: 'race-test-1'}});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('2 bubbles');
  });
});

describe('INV-no-orphan-tempmid-post-reload', () => {
  it('passes when no temp mids present', async() => {
    const u = userMock(async() => []);
    const r = await noOrphanTempMidPostReload.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('fails when a 0.0001-pattern mid persists', async() => {
    const u = userMock(async() => ['0.0001']);
    const r = await noOrphanTempMidPostReload.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('orphan temp mid');
  });
});
