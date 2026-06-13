import {describe, it, expect, vi} from 'vitest';
import {offlineQueuePurged} from './queue';
import type {FuzzContext, UserHandle} from '../types';

function user(result: any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {evaluate: vi.fn(async() => result)} as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 42,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(result: any): FuzzContext {
  return {users: {userA: user(result), userB: user(result)}, relay: null as any, snapshots: new Map(), actionIndex: 10};
}

describe('INV-offline-queue-purged', () => {
  it('passes when queue is empty', async() => {
    const r = await offlineQueuePurged.check(ctx({queueLen: 0}));
    expect(r.ok).toBe(true);
  });

  it('fails when queue still has pending messages after propagation window', async() => {
    const r = await offlineQueuePurged.check(ctx({queueLen: 3}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/queue/i);
  });
});
