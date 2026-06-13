// @ts-nocheck
import {describe, it, expect, vi} from 'vitest';
import {
  POST_createGroup_record_exists,
  POST_sendInGroup_bubble_on_sender,
  POST_sendInGroup_bubble_on_peer,
  POST_addMember_member_in_store,
  POST_removeMember_member_gone_admin,
  POST_removeMember_target_loses_group,
  POST_leaveGroup_record_gone_leaver
} from './groups';
import type {FuzzContext, UserHandle, Action} from '../types';

const A_PK = 'a'.repeat(64);
const B_PK = 'b'.repeat(64);
const SYN = 'c'.repeat(64);

function userWith(evaluateMock: any, pubkeyHex: string = A_PK, id: 'userA' | 'userB' = 'userA'): UserHandle {
  return {
    id,
    context: null as any,
    page: {evaluate: vi.fn(evaluateMock), waitForTimeout: vi.fn(async() => {})} as any,
    displayName: id === 'userA' ? 'A' : 'B',
    npub: '',
    pubkeyHex,
    remotePeerId: 0,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(a: UserHandle, b: UserHandle): FuzzContext {
  return {users: {userA: a, userB: b}, relay: null as any, snapshots: new Map(), actionIndex: 0};
}

const skippedAction: Action = {name: 'x', args: {}, skipped: true};

describe('POST-createGroup-record-exists', () => {
  it('returns ok when action is skipped', async() => {
    const r = await POST_createGroup_record_exists.check(
      ctx(userWith(async() => false), userWith(async() => false, B_PK, 'userB')),
      skippedAction
    );
    expect(r.ok).toBe(true);
  });

  it('fails when creator has no record', async() => {
    const a = userWith(async() => false, A_PK, 'userA'); // store.get returns null
    const b = userWith(async() => true, B_PK, 'userB');
    const action: Action = {
      name: 'createGroup',
      args: {},
      meta: {groupId: 'g1', creator: 'userA', peerMember: 'userB', syntheticIncluded: false}
    };
    const r = await POST_createGroup_record_exists.check(ctx(a, b), action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/creator .* no group record/i);
  });

  it('fails when peer never receives the group', async() => {
    const a = userWith(async() => true, A_PK, 'userA');
    const b = userWith(async() => false, B_PK, 'userB'); // always false → timeout
    const action: Action = {
      name: 'createGroup',
      args: {},
      meta: {groupId: 'g1', creator: 'userA', peerMember: 'userB', syntheticIncluded: false}
    };
    // Short-circuit the timeout for test speed — the probe loop polls every
    // 200ms up to 5s. We rely on deterministic false; the probe returns false
    // throughout so eventually we exit with ok:false.
    const r = await POST_createGroup_record_exists.check(ctx(a, b), action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/peer .* never received/i);
  }, 10_000);
});

describe('POST-sendInGroup-bubble-on-peer', () => {
  it('returns ok when peerIsMember=false (peer intentionally excluded)', async() => {
    const a = userWith(async() => false, A_PK, 'userA');
    const b = userWith(async() => false, B_PK, 'userB');
    const action: Action = {
      name: 'sendInGroup',
      args: {},
      meta: {
        groupId: 'g1',
        peerId: -2e15,
        peerId_other: 'userB',
        peerIsMember: false,
        text: 'hello'
      }
    };
    const r = await POST_sendInGroup_bubble_on_peer.check(ctx(a, b), action);
    expect(r.ok).toBe(true);
  });

  it('returns ok on skipped action', async() => {
    const a = userWith(async() => false);
    const b = userWith(async() => false, B_PK, 'userB');
    const r = await POST_sendInGroup_bubble_on_peer.check(ctx(a, b), skippedAction);
    expect(r.ok).toBe(true);
  });
});

describe('POST-addMember-member-in-store', () => {
  it('passes when added pubkey is present in members', async() => {
    const a = userWith(async() => [A_PK, SYN], A_PK, 'userA');
    const b = userWith(async() => [], B_PK, 'userB');
    const action: Action = {
      name: 'addMemberToGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', addedPubkey: SYN, targetKind: 'synthetic'}
    };
    const r = await POST_addMember_member_in_store.check(ctx(a, b), action);
    expect(r.ok).toBe(true);
  });

  it('fails when added pubkey missing', async() => {
    const a = userWith(async() => [A_PK], A_PK, 'userA');
    const b = userWith(async() => [], B_PK, 'userB');
    const action: Action = {
      name: 'addMemberToGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', addedPubkey: SYN, targetKind: 'synthetic'}
    };
    const r = await POST_addMember_member_in_store.check(ctx(a, b), action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not in group/i);
  });
});

describe('POST-removeMember-member-gone-admin', () => {
  it('passes when target no longer in members', async() => {
    const a = userWith(async() => [A_PK], A_PK, 'userA');
    const b = userWith(async() => [], B_PK, 'userB');
    const action: Action = {
      name: 'removeMemberFromGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', removedPubkey: SYN, targetKind: 'synthetic'}
    };
    const r = await POST_removeMember_member_gone_admin.check(ctx(a, b), action);
    expect(r.ok).toBe(true);
  });

  it('fails when target still in members', async() => {
    const a = userWith(async() => [A_PK, SYN], A_PK, 'userA');
    const b = userWith(async() => [], B_PK, 'userB');
    const action: Action = {
      name: 'removeMemberFromGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', removedPubkey: SYN, targetKind: 'synthetic'}
    };
    const r = await POST_removeMember_member_gone_admin.check(ctx(a, b), action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still in group/i);
  });
});

describe('POST-removeMember-target-loses-group', () => {
  it('returns ok for synthetic targets (no real user to check)', async() => {
    const a = userWith(async() => true, A_PK, 'userA');
    const b = userWith(async() => true, B_PK, 'userB'); // would fail if we incorrectly enforced
    const action: Action = {
      name: 'removeMemberFromGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', removedPubkey: SYN, targetKind: 'synthetic'}
    };
    const r = await POST_removeMember_target_loses_group.check(ctx(a, b), action);
    expect(r.ok).toBe(true);
  });

  it('passes when removed peer loses the group within the deadline', async() => {
    const a = userWith(async() => true, A_PK, 'userA');
    const b = userWith(async() => false, B_PK, 'userB');
    const action: Action = {
      name: 'removeMemberFromGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', removedPubkey: B_PK, targetKind: 'peer'}
    };
    const r = await POST_removeMember_target_loses_group.check(ctx(a, b), action);
    expect(r.ok).toBe(true);
  });

  it('fails when peer still has the group after timeout', async() => {
    const a = userWith(async() => true, A_PK, 'userA');
    const b = userWith(async() => true, B_PK, 'userB'); // always true → never loses
    const action: Action = {
      name: 'removeMemberFromGroup',
      args: {},
      meta: {groupId: 'g1', adminId: 'userA', removedPubkey: B_PK, targetKind: 'peer'}
    };
    const r = await POST_removeMember_target_loses_group.check(ctx(a, b), action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still has group/i);
  }, 10_000);
});

describe('POST-leaveGroup-record-gone-leaver', () => {
  it('passes when leaver no longer has the group', async() => {
    const a = userWith(async() => false, A_PK, 'userA');
    const b = userWith(async() => true, B_PK, 'userB');
    const action: Action = {
      name: 'leaveGroup',
      args: {},
      meta: {groupId: 'g1', leaverId: 'userA'}
    };
    const r = await POST_leaveGroup_record_gone_leaver.check(ctx(a, b), action);
    expect(r.ok).toBe(true);
  });

  it('fails when leaver still has the group', async() => {
    const a = userWith(async() => true, A_PK, 'userA');
    const b = userWith(async() => false, B_PK, 'userB');
    const action: Action = {
      name: 'leaveGroup',
      args: {},
      meta: {groupId: 'g1', leaverId: 'userA'}
    };
    const r = await POST_leaveGroup_record_gone_leaver.check(ctx(a, b), action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still has group/i);
  }, 5_000);
});

describe('POST_sendInGroup_bubble_on_sender has sane shape', () => {
  it('returns ok on skipped action', async() => {
    const a = userWith(async() => false);
    const b = userWith(async() => false, B_PK, 'userB');
    const r = await POST_sendInGroup_bubble_on_sender.check(ctx(a, b), skippedAction);
    expect(r.ok).toBe(true);
  });
});
