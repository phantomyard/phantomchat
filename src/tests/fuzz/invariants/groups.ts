// @ts-nocheck
/**
 * Group invariants — membership, peer-id determinism, bilateral store coherence.
 *
 * Phase 2b.4 scope: 2-user harness (A+B). Invariants run over both users'
 * IndexedDB state and main-thread mirrors.
 */
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

// Inlined to avoid importing lib/nostra into the Node harness.
const GROUP_PEER_BASE = 2 * 10 ** 15;

interface StoredGroup {
  groupId: string;
  name: string;
  adminPubkey: string;
  members: string[];
  peerId: number;
  createdAt: number;
}

async function listGroups(user: UserHandle): Promise<StoredGroup[]> {
  return user.page.evaluate(async () => {
    try {
      const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
      const groups = await getGroupStore().getAll();
      return groups.map((g: any) => ({
        groupId: g.groupId,
        name: g.name,
        adminPubkey: g.adminPubkey,
        members: g.members,
        peerId: g.peerId,
        createdAt: g.createdAt || 0
      }));
    } catch {
      return [];
    }
  });
}

// ─── INV-group-admin-is-member ──────────────────────────────────────
// Cheap: runs every action. Admin must be in members[].

export const groupAdminIsMember: Invariant = {
  id: 'INV-group-admin-is-member',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const user = ctx.users[id];
      const groups = await listGroups(user);
      for(const g of groups) {
        if(!g.members.includes(g.adminPubkey)) {
          return {
            ok: false,
            message: `group ${g.groupId.slice(0, 8)} on ${id}: admin ${g.adminPubkey.slice(0, 8)} not in members`,
            evidence: {user: id, groupId: g.groupId, members: g.members, admin: g.adminPubkey}
          };
        }
      }
    }
    return {ok: true};
  }
};

// ─── INV-group-store-unique-ids ─────────────────────────────────────
// Medium: runs every 10 actions. groupId and peerId must be unique per user.

export const groupStoreUniqueIds: Invariant = {
  id: 'INV-group-store-unique-ids',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const user = ctx.users[id];
      const groups = await listGroups(user);
      const seenGroupIds = new Set<string>();
      const seenPeerIds = new Set<number>();
      for(const g of groups) {
        if(seenGroupIds.has(g.groupId)) {
          return {
            ok: false,
            message: `duplicate groupId ${g.groupId.slice(0, 8)} on ${id}`,
            evidence: {user: id, groupId: g.groupId}
          };
        }
        if(seenPeerIds.has(g.peerId)) {
          return {
            ok: false,
            message: `duplicate group peerId ${g.peerId} on ${id}`,
            evidence: {user: id, peerId: g.peerId, groupId: g.groupId}
          };
        }
        seenGroupIds.add(g.groupId);
        seenPeerIds.add(g.peerId);
      }
    }
    return {ok: true};
  }
};

// ─── INV-group-bilateral-membership ─────────────────────────────────
// Medium: if A has a group whose members include B's pubkeyHex, B should
// have that group in its store (within a reasonable propagation window).
// The grace window uses the group's own `createdAt` timestamp — cleaner
// than snapshot-based approximation because the warmup path bypasses
// postconditions entirely and never sets `lastGroupCreateAt`.
//
// 30s window covers the worst-case cold-start relay-sub propagation we've
// seen in warmup (which itself runs up to 15s). In steady state, group
// control messages propagate in <1s, so this window is effectively gating
// only the cold-start grace — not masking real bugs.

const MEMBERSHIP_GRACE_MS = 30_000;

export const groupBilateralMembership: Invariant = {
  id: 'INV-group-bilateral-membership',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const [aGroups, bGroups] = await Promise.all([listGroups(ctx.users.userA), listGroups(ctx.users.userB)]);
    const aByGroupId = new Map(aGroups.map((g) => [g.groupId, g]));
    const bByGroupId = new Map(bGroups.map((g) => [g.groupId, g]));

    const aPk = ctx.users.userA.pubkeyHex;
    const bPk = ctx.users.userB.pubkeyHex;
    const now = Date.now();

    // A's groups: if members include B, B should have the group too (once grace elapsed).
    for(const g of aGroups) {
      if(!g.members.includes(bPk)) continue;
      if(bByGroupId.has(g.groupId)) continue;
      // Skip fresh groups — peer propagation may legitimately still be in flight.
      if(g.createdAt && now - g.createdAt < MEMBERSHIP_GRACE_MS) continue;
      return {
        ok: false,
        message: `group ${g.groupId.slice(0, 8)}: A has B as member but B has no record`,
        evidence: {groupId: g.groupId, name: g.name, admin: g.adminPubkey, ageMs: g.createdAt ? now - g.createdAt : null}
      };
    }

    // Symmetric: B's groups with A as member must be in A's store.
    for(const g of bGroups) {
      if(!g.members.includes(aPk)) continue;
      if(aByGroupId.has(g.groupId)) continue;
      if(g.createdAt && now - g.createdAt < MEMBERSHIP_GRACE_MS) continue;
      return {
        ok: false,
        message: `group ${g.groupId.slice(0, 8)}: B has A as member but A has no record`,
        evidence: {groupId: g.groupId, name: g.name, admin: g.adminPubkey, ageMs: g.createdAt ? now - g.createdAt : null}
      };
    }

    return {ok: true};
  }
};

// ─── INV-group-peer-id-deterministic (regression) ───────────────────
// For every group in either user's store, groupIdToPeerId(groupId) must
// equal the stored peerId. Catches any drift in the hash derivation.

export const groupPeerIdDeterministic: Invariant = {
  id: 'INV-group-peer-id-deterministic',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const user = ctx.users[id];
      const mismatches = await user.page.evaluate(async () => {
        try {
          const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
          const {groupIdToPeerId} = await import('/src/lib/nostra/group-types.ts');
          const groups = await getGroupStore().getAll();
          const out: Array<{groupId: string; stored: number; computed: number}> = [];
          for(const g of groups) {
            const computed = await groupIdToPeerId(g.groupId);
            if(computed !== g.peerId) {
              out.push({groupId: g.groupId, stored: g.peerId, computed});
            }
          }
          return out;
        } catch {
          return [];
        }
      });
      if(mismatches.length) {
        const m = mismatches[0];
        return {
          ok: false,
          message: `group ${m.groupId.slice(0, 8)} on ${id}: stored peerId ${m.stored} ≠ computed ${m.computed}`,
          evidence: {user: id, mismatches}
        };
      }
    }
    return {ok: true};
  }
};

// ─── INV-group-no-orphan-mirror-peer (regression) ───────────────────
// Every peer in apiManagerProxy.mirrors.peers whose id is in the group-peer
// range (abs value >= GROUP_PEER_BASE) must correspond to a groupStore record.
// An orphan would mean a Chat entry survived group deletion, which breaks
// dialog rendering.

export const groupNoOrphanMirrorPeer: Invariant = {
  id: 'INV-group-no-orphan-mirror-peer',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const user = ctx.users[id];
      const orphans = await user.page.evaluate(async (basePositive: number) => {
        try {
          const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
          const store = getGroupStore();
          const proxy: any = (window as any).apiManagerProxy;
          const peers = proxy?.mirrors?.peers || {};
          const groupPeerIds: number[] = [];
          for(const key of Object.keys(peers)) {
            const pid = Number(key);
            if(Number.isNaN(pid)) continue;
            if(pid < 0 && Math.abs(pid) >= basePositive) groupPeerIds.push(pid);
          }
          const out: Array<{peerId: number}> = [];
          for(const pid of groupPeerIds) {
            const rec = await store.getByPeerId(pid);
            if(!rec) out.push({peerId: pid});
          }
          return out;
        } catch {
          return [];
        }
      }, GROUP_PEER_BASE);
      if(orphans.length) {
        return {
          ok: false,
          message: `${orphans.length} orphan group peer(s) in mirrors on ${id}: ${orphans[0].peerId}`,
          evidence: {user: id, orphans}
        };
      }
    }
    return {ok: true};
  }
};
