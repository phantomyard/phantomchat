import {describe, it, expect, vi} from 'vitest';
import {deliveryTrackerNoOrphans} from './delivery';
import type {FuzzContext, UserHandle} from '../types';

function userWith(result: any): UserHandle {
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
  return {users: {userA: userWith(result), userB: userWith(result)}, relay: null as any, snapshots: new Map(), actionIndex: 10};
}

describe('INV-delivery-tracker-no-orphans', () => {
  it('passes when every tracker mid has a DOM or IDB match', async() => {
    const r = await deliveryTrackerNoOrphans.check(ctx({trackerMids: [1, 2], domMids: [1], idbMids: [2]}));
    expect(r.ok).toBe(true);
  });

  it('fails when a tracker mid is in neither DOM nor IDB', async() => {
    const r = await deliveryTrackerNoOrphans.check(ctx({trackerMids: [1, 2, 3], domMids: [1], idbMids: [2]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/orphan/i);
  });
});
