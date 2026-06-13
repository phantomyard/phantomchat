// @ts-nocheck
/**
 * Group actions — createGroup, sendInGroup, addMemberToGroup,
 * removeMemberFromGroup, leaveGroup.
 *
 * Groups use negative peerIds in the GROUP_PEER_BASE range (2×10^15 to 9×10^15).
 * GroupAPI is a main-thread singleton initialized at onboarding; we access it
 * via dynamic import inside page.evaluate, mirroring the add-p2p-contact.ts
 * pattern used by the harness's linkContacts.
 *
 * Phase 2b.4 scope: 2 real users (A+B) + synthetic pubkeys for add/remove
 * coverage. A 3rd browser context is out of scope (Phase 2b.5).
 */
import type {ActionSpec, Action, FuzzContext, UserHandle} from '../types';
import * as fc from 'fast-check';

const GROUP_NAME_ARB = fc.oneof(
  {weight: 60, arbitrary: fc.string({minLength: 1, maxLength: 30})},
  {weight: 30, arbitrary: fc.constantFrom('Team', 'Crew', 'Family', 'Devs', '🔥 Fire', 'Alpha')},
  {weight: 10, arbitrary: fc.string({minLength: 1, maxLength: 100})}
);

const TEXT_ARB = fc.oneof(
  {weight: 70, arbitrary: fc.string({minLength: 1, maxLength: 120})},
  {weight: 20, arbitrary: fc.constantFrom('hi group', 'hello all', '👋', 'test 123', '🔥🔥🔥')},
  {weight: 10, arbitrary: fc.string({minLength: 1, maxLength: 500})}
);

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Generate a random 64-char hex string in the browser. Not a real keypair —
 * just a well-formed pubkey for control-message fan-out coverage. The
 * corresponding recipient will never decrypt anything (no sk).
 */
async function makeSyntheticPubkey(page: any): Promise<string> {
  return page.evaluate(() => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

/**
 * List the caller's groupIds (from IDB). Returns [] if store unavailable.
 */
async function listOwnGroups(user: UserHandle): Promise<Array<{groupId: string; peerId: number; members: string[]; adminPubkey: string; name: string}>> {
  return user.page.evaluate(async () => {
    try {
      const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
      const groups = await getGroupStore().getAll();
      return groups.map((g: any) => ({
        groupId: g.groupId,
        peerId: g.peerId,
        members: g.members,
        adminPubkey: g.adminPubkey,
        name: g.name
      }));
    } catch {
      return [];
    }
  });
}

function pickRandom<T>(arr: T[]): T | null {
  if(!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── createGroup ────────────────────────────────────────────────────

export const createGroup: ActionSpec = {
  name: 'createGroup',
  weight: 4,
  generateArgs: () => fc.record({
    from: fc.constantFrom('userA', 'userB'),
    name: GROUP_NAME_ARB,
    withSynthetic: fc.boolean()
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const fromId: 'userA' | 'userB' = action.args.from;
    const otherId: 'userA' | 'userB' = fromId === 'userA' ? 'userB' : 'userA';
    const sender = ctx.users[fromId];
    const other = ctx.users[otherId];

    const members: string[] = [other.pubkeyHex];
    if(action.args.withSynthetic) {
      members.push(await makeSyntheticPubkey(sender.page));
    }

    let result;
    try {
      result = await sender.page.evaluate(async ({name, memberPubkeys}: any) => {
        try {
          const {getGroupAPI} = await import('/src/lib/nostra/group-api.ts');
          const api = getGroupAPI();
          const groupId = await api.createGroup(name, memberPubkeys);
          // Look up the record we just wrote so we can snapshot peerId for the postcondition.
          const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
          const record = await getGroupStore().get(groupId);
          return {ok: true as const, groupId, peerId: record?.peerId ?? null, memberCount: record?.members.length ?? 0};
        } catch(err) {
          return {ok: false as const, error: err instanceof Error ? err.message : String(err)};
        }
      }, {name: action.args.name, memberPubkeys: members});
    } catch(err) {
      action.skipped = true;
      action.meta = {skipReason: `evaluate-threw:${err instanceof Error ? err.message : String(err)}`};
      return action;
    }

    if(!result.ok) {
      action.skipped = true;
      action.meta = {skipReason: result.error};
      return action;
    }

    action.meta = {
      groupId: result.groupId,
      peerId: result.peerId,
      memberCount: result.memberCount,
      creator: fromId,
      peerMember: otherId,
      syntheticIncluded: action.args.withSynthetic,
      createdAt: Date.now()
    };
    return action;
  }
};

// ─── sendInGroup ────────────────────────────────────────────────────

export const sendInGroup: ActionSpec = {
  name: 'sendInGroup',
  weight: 8,
  generateArgs: () => fc.record({
    from: fc.constantFrom('userA', 'userB'),
    text: TEXT_ARB
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const fromId: 'userA' | 'userB' = action.args.from;
    const otherId: 'userA' | 'userB' = fromId === 'userA' ? 'userB' : 'userA';
    const sender = ctx.users[fromId];

    const groups = await listOwnGroups(sender);
    if(!groups.length) {
      action.skipped = true;
      action.meta = {skipReason: 'no-groups-available'};
      return action;
    }

    const group = pickRandom(groups)!;

    // Open the group chat so bubbles render in DOM (postconditions look at .bubbles-inner).
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, group.peerId);
    await sender.page.waitForTimeout(300);

    let result;
    try {
      result = await sender.page.evaluate(async ({groupId, text}: any) => {
        try {
          const {getGroupAPI} = await import('/src/lib/nostra/group-api.ts');
          const {messageId} = await getGroupAPI().sendMessage(groupId, text);
          return {ok: true as const, messageId};
        } catch(err) {
          return {ok: false as const, error: err instanceof Error ? err.message : String(err)};
        }
      }, {groupId: group.groupId, text: action.args.text});
    } catch(err) {
      action.skipped = true;
      action.meta = {skipReason: `evaluate-threw:${err instanceof Error ? err.message : String(err)}`};
      return action;
    }

    if(!result.ok) {
      action.skipped = true;
      action.meta = {skipReason: result.error};
      return action;
    }

    // Precompute whether the peer is a member — postcondition needs this
    // to decide whether the peer should receive the bubble. A group can
    // be admin-only after the peer was removed.
    const peerIsMember = group.members.includes(ctx.users[otherId].pubkeyHex);

    action.meta = {
      groupId: group.groupId,
      peerId: group.peerId,
      messageId: result.messageId,
      fromId,
      peerId_other: otherId,
      peerIsMember,
      text: action.args.text,
      sentAt: Date.now()
    };
    return action;
  }
};

// ─── addMemberToGroup ───────────────────────────────────────────────

export const addMemberToGroup: ActionSpec = {
  name: 'addMemberToGroup',
  weight: 2,
  generateArgs: () => fc.record({
    admin: fc.constantFrom('userA', 'userB'),
    target: fc.constantFrom('peer', 'synthetic')
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const adminId: 'userA' | 'userB' = action.args.admin;
    const peerId: 'userA' | 'userB' = adminId === 'userA' ? 'userB' : 'userA';
    const admin = ctx.users[adminId];

    const groups = await listOwnGroups(admin);
    const owned = groups.filter((g) => g.adminPubkey === admin.pubkeyHex);
    if(!owned.length) {
      action.skipped = true;
      action.meta = {skipReason: 'no-admin-groups'};
      return action;
    }

    const group = pickRandom(owned)!;
    let targetPubkey: string;
    let targetKind: 'peer' | 'synthetic';

    if(action.args.target === 'peer' && !group.members.includes(ctx.users[peerId].pubkeyHex)) {
      // Peer isn't currently in the group — add them.
      targetPubkey = ctx.users[peerId].pubkeyHex;
      targetKind = 'peer';
    } else {
      // Either 'synthetic' was requested, or peer is already in the group.
      targetPubkey = await makeSyntheticPubkey(admin.page);
      targetKind = 'synthetic';
    }

    let result;
    try {
      result = await admin.page.evaluate(async ({groupId, newMember}: any) => {
        try {
          const {getGroupAPI} = await import('/src/lib/nostra/group-api.ts');
          await getGroupAPI().addMember(groupId, newMember);
          return {ok: true as const};
        } catch(err) {
          return {ok: false as const, error: err instanceof Error ? err.message : String(err)};
        }
      }, {groupId: group.groupId, newMember: targetPubkey});
    } catch(err) {
      action.skipped = true;
      action.meta = {skipReason: `evaluate-threw:${err instanceof Error ? err.message : String(err)}`};
      return action;
    }

    if(!result.ok) {
      action.skipped = true;
      action.meta = {skipReason: result.error};
      return action;
    }

    action.meta = {
      groupId: group.groupId,
      peerId: group.peerId,
      adminId,
      addedPubkey: targetPubkey,
      targetKind,
      addedAt: Date.now()
    };
    return action;
  }
};

// ─── removeMemberFromGroup ──────────────────────────────────────────

export const removeMemberFromGroup: ActionSpec = {
  name: 'removeMemberFromGroup',
  weight: 2,
  generateArgs: () => fc.record({
    admin: fc.constantFrom('userA', 'userB'),
    target: fc.constantFrom('peer', 'synthetic')
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const adminId: 'userA' | 'userB' = action.args.admin;
    const peerId: 'userA' | 'userB' = adminId === 'userA' ? 'userB' : 'userA';
    const admin = ctx.users[adminId];

    const groups = await listOwnGroups(admin);
    const owned = groups.filter((g) => g.adminPubkey === admin.pubkeyHex);
    if(!owned.length) {
      action.skipped = true;
      action.meta = {skipReason: 'no-admin-groups'};
      return action;
    }

    // Pick a group whose members are removable (at least one non-admin).
    const viable = owned.filter((g) => g.members.some((m) => m !== admin.pubkeyHex));
    if(!viable.length) {
      action.skipped = true;
      action.meta = {skipReason: 'admin-only-groups'};
      return action;
    }
    const group = pickRandom(viable)!;

    let targetPubkey: string | null = null;
    let targetKind: 'peer' | 'synthetic' = 'synthetic';

    const peerHex = ctx.users[peerId].pubkeyHex;
    const synthetics = group.members.filter((m) => m !== admin.pubkeyHex && m !== peerHex);

    if(action.args.target === 'peer' && group.members.includes(peerHex)) {
      targetPubkey = peerHex;
      targetKind = 'peer';
    } else if(synthetics.length) {
      targetPubkey = pickRandom(synthetics);
      targetKind = 'synthetic';
    } else if(group.members.includes(peerHex)) {
      // Fallback: remove peer if no synthetics exist.
      targetPubkey = peerHex;
      targetKind = 'peer';
    }

    if(!targetPubkey) {
      action.skipped = true;
      action.meta = {skipReason: 'no-removable-target'};
      return action;
    }

    let result;
    try {
      result = await admin.page.evaluate(async ({groupId, member}: any) => {
        try {
          const {getGroupAPI} = await import('/src/lib/nostra/group-api.ts');
          await getGroupAPI().removeMember(groupId, member);
          return {ok: true as const};
        } catch(err) {
          return {ok: false as const, error: err instanceof Error ? err.message : String(err)};
        }
      }, {groupId: group.groupId, member: targetPubkey});
    } catch(err) {
      action.skipped = true;
      action.meta = {skipReason: `evaluate-threw:${err instanceof Error ? err.message : String(err)}`};
      return action;
    }

    if(!result.ok) {
      action.skipped = true;
      action.meta = {skipReason: result.error};
      return action;
    }

    action.meta = {
      groupId: group.groupId,
      peerId: group.peerId,
      adminId,
      removedPubkey: targetPubkey,
      targetKind,
      removedAt: Date.now()
    };
    return action;
  }
};

// ─── leaveGroup ─────────────────────────────────────────────────────

export const leaveGroup: ActionSpec = {
  name: 'leaveGroup',
  weight: 1,
  generateArgs: () => fc.record({
    leaver: fc.constantFrom('userA', 'userB')
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const leaverId: 'userA' | 'userB' = action.args.leaver;
    const leaver = ctx.users[leaverId];

    const groups = await listOwnGroups(leaver);
    // Admin-leave is supported: handleMemberLeave on remaining members
    // auto-transfers adminPubkey to the lex-smallest remaining pubkey
    // (Phase 2b.4 fix for the admin-orphan bug).
    if(!groups.length) {
      action.skipped = true;
      action.meta = {skipReason: 'no-groups-available'};
      return action;
    }

    const group = pickRandom(groups)!;

    let result;
    try {
      result = await leaver.page.evaluate(async (groupId: string) => {
        try {
          const {getGroupAPI} = await import('/src/lib/nostra/group-api.ts');
          await getGroupAPI().leaveGroup(groupId);
          return {ok: true as const};
        } catch(err) {
          return {ok: false as const, error: err instanceof Error ? err.message : String(err)};
        }
      }, group.groupId);
    } catch(err) {
      action.skipped = true;
      action.meta = {skipReason: `evaluate-threw:${err instanceof Error ? err.message : String(err)}`};
      return action;
    }

    if(!result.ok) {
      action.skipped = true;
      action.meta = {skipReason: result.error};
      return action;
    }

    action.meta = {
      groupId: group.groupId,
      peerId: group.peerId,
      leaverId,
      wasAdmin: group.adminPubkey === leaver.pubkeyHex,
      leftAt: Date.now()
    };
    return action;
  }
};
