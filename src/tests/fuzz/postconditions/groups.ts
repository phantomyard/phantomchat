// @ts-nocheck
/**
 * Group postconditions — checked immediately after each group action.
 *
 * Pattern: postconditions do not perform work — they verify observable
 * effects. Skipped actions (action.skipped === true) always return ok:true.
 *
 * All timeouts match the existing patience budget: ~3s for relay round-trips,
 * ~500ms for local IDB operations.
 */
import type {Postcondition, FuzzContext, Action, InvariantResult, UserHandle} from '../types';

async function storeHasGroup(user: UserHandle, groupId: string): Promise<boolean> {
  return user.page.evaluate(async (id: string) => {
    try {
      const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
      const rec = await getGroupStore().get(id);
      return !!rec;
    } catch {
      return false;
    }
  }, groupId);
}

async function groupMembers(user: UserHandle, groupId: string): Promise<string[] | null> {
  return user.page.evaluate(async (id: string) => {
    try {
      const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
      const rec = await getGroupStore().get(id);
      return rec ? rec.members : null;
    } catch {
      return null;
    }
  }, groupId);
}

async function waitUntil<T>(
  probe: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 200
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while(Date.now() < deadline) {
    last = await probe();
    if(predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last!;
}

async function bubbleWithTextInGroup(user: UserHandle, groupPeerId: number, text: string, timeoutMs: number): Promise<boolean> {
  // Ensure the group chat is open so bubbles render in DOM.
  await user.page.evaluate((pid: number) => {
    (window as any).appImManager?.setPeer?.({peerId: pid});
  }, groupPeerId);
  await user.page.waitForTimeout(200);

  const deadline = Date.now() + timeoutMs;
  // tweb trims send text before display. Match on trimmed text; empty
  // strings are dropped entirely by the send path.
  const needle = String(text).trim();
  if(!needle) return true;
  while(Date.now() < deadline) {
    const found = await user.page.evaluate((n: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        if((b.textContent || '').includes(n)) {
          const el = b as HTMLElement;
          if(el.classList.contains('is-sending') || el.classList.contains('is-outgoing')) continue;
          return true;
        }
      }
      return false;
    }, needle);
    if(found) return true;
    await user.page.waitForTimeout(200);
  }
  return false;
}

// ─── createGroup ────────────────────────────────────────────────────

export const POST_createGroup_record_exists: Postcondition = {
  id: 'POST-createGroup-record-exists',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, creator, peerMember, syntheticIncluded} = action.meta ?? {};
    if(!groupId) return {ok: true};

    // Record the creation timestamp so INV-group-bilateral-membership can
    // honour the grace window. Also overwrite any prior marker so the most
    // recent createGroup wins.
    ctx.snapshots.set('lastGroupCreateAt', Date.now());

    // Creator: must have the record immediately (local write).
    const senderHas = await storeHasGroup(ctx.users[creator as 'userA' | 'userB'], groupId);
    if(!senderHas) {
      return {ok: false, message: `createGroup: creator ${creator} has no group record for ${groupId.slice(0, 8)}`};
    }

    // Peer member: must have the record within 3s (relay round-trip).
    // Only holds if peer is actually a member of the group — synthetic-only
    // groups can skip this check (but Phase 2b.4 always includes the peer).
    const peer = ctx.users[peerMember as 'userA' | 'userB'];
    const got = await waitUntil(
      () => storeHasGroup(peer, groupId),
      (v) => v === true,
      5000
    );
    if(!got) {
      return {
        ok: false,
        message: `createGroup: peer ${peerMember} never received group ${groupId.slice(0, 8)} within 5s`,
        evidence: {groupId, syntheticIncluded}
      };
    }
    return {ok: true};
  }
};

// ─── sendInGroup ────────────────────────────────────────────────────

export const POST_sendInGroup_bubble_on_sender: Postcondition = {
  id: 'POST-sendInGroup-bubble-on-sender',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, peerId, fromId, text} = action.meta ?? {};
    if(!groupId || typeof peerId !== 'number') return {ok: true};
    const sender = ctx.users[fromId as 'userA' | 'userB'];
    const ok = await bubbleWithTextInGroup(sender, peerId, text, 3000);
    if(!ok) {
      return {
        ok: false,
        message: `sendInGroup: sent bubble "${String(text).trim().slice(0, 40)}" never appeared on sender ${fromId}`,
        evidence: {groupId, peerId}
      };
    }
    return {ok: true};
  }
};

export const POST_sendInGroup_bubble_on_peer: Postcondition = {
  id: 'POST-sendInGroup-bubble-on-peer',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, peerId, peerId_other, peerIsMember, text} = action.meta ?? {};
    if(!groupId || typeof peerId !== 'number') return {ok: true};
    // If the peer isn't a member of the group, they shouldn't receive it —
    // and a missing bubble is the correct behaviour.
    if(!peerIsMember) return {ok: true};

    const peer = ctx.users[peerId_other as 'userA' | 'userB'];
    const ok = await bubbleWithTextInGroup(peer, peerId, text, 5000);
    if(!ok) {
      return {
        ok: false,
        message: `sendInGroup: bubble "${String(text).trim().slice(0, 40)}" never appeared on peer ${peerId_other} member of group`,
        evidence: {groupId, peerId}
      };
    }
    return {ok: true};
  }
};

// ─── addMember ──────────────────────────────────────────────────────

export const POST_addMember_member_in_store: Postcondition = {
  id: 'POST-addMember-member-in-store',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, adminId, addedPubkey} = action.meta ?? {};
    if(!groupId || !addedPubkey) return {ok: true};
    const admin = ctx.users[adminId as 'userA' | 'userB'];
    const members = await groupMembers(admin, groupId);
    if(!members) {
      return {ok: false, message: `addMember: admin lost group ${groupId.slice(0, 8)} after add`};
    }
    if(!members.includes(addedPubkey)) {
      return {
        ok: false,
        message: `addMember: ${addedPubkey.slice(0, 8)} not in group ${groupId.slice(0, 8)}'s members on admin`,
        evidence: {groupId, members}
      };
    }
    return {ok: true};
  }
};

// ─── removeMember ───────────────────────────────────────────────────

export const POST_removeMember_member_gone_admin: Postcondition = {
  id: 'POST-removeMember-member-gone-admin',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, adminId, removedPubkey} = action.meta ?? {};
    if(!groupId || !removedPubkey) return {ok: true};
    const admin = ctx.users[adminId as 'userA' | 'userB'];
    const members = await groupMembers(admin, groupId);
    if(!members) {
      return {ok: false, message: `removeMember: admin lost group ${groupId.slice(0, 8)} after remove`};
    }
    if(members.includes(removedPubkey)) {
      return {
        ok: false,
        message: `removeMember: ${removedPubkey.slice(0, 8)} still in group ${groupId.slice(0, 8)}'s members on admin`,
        evidence: {groupId, members}
      };
    }
    return {ok: true};
  }
};

export const POST_removeMember_target_loses_group: Postcondition = {
  id: 'POST-removeMember-target-loses-group',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, adminId, targetKind, removedPubkey} = action.meta ?? {};
    if(targetKind !== 'peer' || !groupId) return {ok: true};
    // The removed party is the "peer" user — the one that is NOT admin.
    const peerId: 'userA' | 'userB' = adminId === 'userA' ? 'userB' : 'userA';
    const peer = ctx.users[peerId];
    // Guardrail: only enforce if the removed pubkey really was the peer's hex.
    if(peer.pubkeyHex !== removedPubkey) return {ok: true};

    const got = await waitUntil(
      () => storeHasGroup(peer, groupId),
      (v) => v === false,
      5000
    );
    if(got) {
      return {
        ok: false,
        message: `removeMember: peer ${peerId} still has group ${groupId.slice(0, 8)} after being removed`,
        evidence: {groupId, adminId, removedPubkey}
      };
    }
    return {ok: true};
  }
};

// ─── leaveGroup ─────────────────────────────────────────────────────

export const POST_leaveGroup_record_gone_leaver: Postcondition = {
  id: 'POST-leaveGroup-record-gone-leaver',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const {groupId, leaverId} = action.meta ?? {};
    if(!groupId) return {ok: true};
    const leaver = ctx.users[leaverId as 'userA' | 'userB'];
    // leaveGroup deletes the local record synchronously, so this should
    // resolve immediately. Short timeout.
    const got = await waitUntil(
      () => storeHasGroup(leaver, groupId),
      (v) => v === false,
      1500
    );
    if(got) {
      return {
        ok: false,
        message: `leaveGroup: leaver ${leaverId} still has group ${groupId.slice(0, 8)} after leaveGroup()`,
        evidence: {groupId}
      };
    }
    return {ok: true};
  }
};
