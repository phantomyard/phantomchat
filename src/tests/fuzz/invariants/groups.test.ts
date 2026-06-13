// @ts-nocheck
import {describe, it, expect, vi} from 'vitest';
import {
  groupAdminIsMember,
  groupStoreUniqueIds,
  groupBilateralMembership,
  groupPeerIdDeterministic,
  groupNoOrphanMirrorPeer
} from './groups';
import type {FuzzContext, UserHandle} from '../types';

const A_PK = 'a'.repeat(64);
const B_PK = 'b'.repeat(64);
const SYN = 'c'.repeat(64);

function userWith(result: any, pubkeyHex: string = A_PK): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {evaluate: vi.fn(async() => result)} as any,
    displayName: 'A',
    npub: '',
    pubkeyHex,
    remotePeerId: 0,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function twoUserCtx(aResult: any, bResult: any): FuzzContext {
  return {
    users: {
      userA: userWith(aResult, A_PK),
      userB: {...userWith(bResult, B_PK), id: 'userB', displayName: 'B'}
    },
    relay: null as any,
    snapshots: new Map(),
    actionIndex: 10
  };
}

// ─── INV-group-admin-is-member ──────────────────────────────────────

describe('INV-group-admin-is-member', () => {
  it('passes when admin is in members', async() => {
    const r = await groupAdminIsMember.check(twoUserCtx(
      [{groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK, B_PK], peerId: -2e15}],
      []
    ));
    expect(r.ok).toBe(true);
  });

  it('fails when admin is missing from members', async() => {
    const r = await groupAdminIsMember.check(twoUserCtx(
      [{groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [B_PK], peerId: -2e15}],
      []
    ));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/admin/i);
  });
});

// ─── INV-group-store-unique-ids ─────────────────────────────────────

describe('INV-group-store-unique-ids', () => {
  it('passes on unique ids', async() => {
    const r = await groupStoreUniqueIds.check(twoUserCtx(
      [
        {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK], peerId: -2e15},
        {groupId: 'g2', name: 'n', adminPubkey: A_PK, members: [A_PK], peerId: -3e15}
      ],
      []
    ));
    expect(r.ok).toBe(true);
  });

  it('fails on duplicate groupId', async() => {
    const r = await groupStoreUniqueIds.check(twoUserCtx(
      [
        {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK], peerId: -2e15},
        {groupId: 'g1', name: 'n2', adminPubkey: A_PK, members: [A_PK], peerId: -3e15}
      ],
      []
    ));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/duplicate groupId/i);
  });

  it('fails on duplicate peerId', async() => {
    const r = await groupStoreUniqueIds.check(twoUserCtx(
      [
        {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK], peerId: -2e15},
        {groupId: 'g2', name: 'n2', adminPubkey: A_PK, members: [A_PK], peerId: -2e15}
      ],
      []
    ));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/duplicate group peerId/i);
  });
});

// ─── INV-group-bilateral-membership ─────────────────────────────────

describe('INV-group-bilateral-membership', () => {
  const ancient = Date.now() - 120_000; // past 30s grace
  const fresh = Date.now() - 1000;      // inside grace

  it('passes when both users have the same group', async() => {
    const group = {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK, B_PK], peerId: -2e15, createdAt: ancient};
    const r = await groupBilateralMembership.check(twoUserCtx([group], [group]));
    expect(r.ok).toBe(true);
  });

  it('passes during grace window (recent createGroup)', async() => {
    const group = {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK, B_PK], peerId: -2e15, createdAt: fresh};
    const ctx = twoUserCtx([group], []);
    const r = await groupBilateralMembership.check(ctx);
    expect(r.ok).toBe(true);
  });

  it('fails when A has group with B member but B has no record (past grace)', async() => {
    const group = {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK, B_PK], peerId: -2e15, createdAt: ancient};
    const ctx = twoUserCtx([group], []);
    const r = await groupBilateralMembership.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/A has B/i);
  });

  it('does not require bilateral for groups that exclude the peer', async() => {
    // A has an admin-only group (no B). B correctly has no record.
    const group = {groupId: 'g1', name: 'n', adminPubkey: A_PK, members: [A_PK, SYN], peerId: -2e15, createdAt: ancient};
    const ctx = twoUserCtx([group], []);
    const r = await groupBilateralMembership.check(ctx);
    expect(r.ok).toBe(true);
  });
});

// ─── INV-group-peer-id-deterministic ────────────────────────────────

describe('INV-group-peer-id-deterministic', () => {
  it('passes when stored peerId equals computed', async() => {
    // The evaluate mock runs in the test, so we pre-compute and return an
    // empty mismatches array.
    const ctx = twoUserCtx(
      [],
      []
    );
    ctx.users.userA.page.evaluate = vi.fn(async() => []) as any;
    ctx.users.userB.page.evaluate = vi.fn(async() => []) as any;
    const r = await groupPeerIdDeterministic.check(ctx);
    expect(r.ok).toBe(true);
  });

  it('fails when the mocked evaluate reports a mismatch', async() => {
    const ctx = twoUserCtx([], []);
    ctx.users.userA.page.evaluate = vi.fn(async() => [
      {groupId: 'g1abc', stored: -100, computed: -200}
    ]) as any;
    ctx.users.userB.page.evaluate = vi.fn(async() => []) as any;
    const r = await groupPeerIdDeterministic.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/stored peerId/i);
  });
});

// ─── INV-group-no-orphan-mirror-peer ────────────────────────────────

describe('INV-group-no-orphan-mirror-peer', () => {
  it('passes when every group peer in mirrors has a store record', async() => {
    const ctx = twoUserCtx([], []);
    ctx.users.userA.page.evaluate = vi.fn(async() => []) as any; // no orphans
    ctx.users.userB.page.evaluate = vi.fn(async() => []) as any;
    const r = await groupNoOrphanMirrorPeer.check(ctx);
    expect(r.ok).toBe(true);
  });

  it('fails when an orphan group peer exists', async() => {
    const ctx = twoUserCtx([], []);
    ctx.users.userA.page.evaluate = vi.fn(async() => [{peerId: -2e15 - 7}]) as any;
    ctx.users.userB.page.evaluate = vi.fn(async() => []) as any;
    const r = await groupNoOrphanMirrorPeer.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/orphan group peer/i);
  });
});
