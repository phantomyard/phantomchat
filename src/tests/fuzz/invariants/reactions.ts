// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult} from '../types';

async function storeAllOn(user: any): Promise<any[]> {
  return user.page.evaluate(async () => {
    const s = (window as any).__nostraReactionsStore;
    if(!s) return [];
    return await s.getAll();
  });
}

export const reactionDedupe: Invariant = {
  id: 'INV-reaction-dedupe',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const rows = await storeAllOn(ctx.users[id]);
      const seen = new Map<string, number>();
      for(const r of rows) {
        const k = `${r.targetEventId}|${r.fromPubkey}|${r.emoji}`;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      for(const [k, n] of seen) {
        if(n > 1) return {ok: false, message: `duplicate reaction row on ${id}: ${k} × ${n}`, evidence: {user: id, key: k, count: n}};
      }
    }
    return {ok: true};
  }
};

export const noKind7SelfEchoDrop: Invariant = {
  id: 'INV-no-kind7-self-echo-drop',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    // Only check right after a reactToRandomBubble or reactMultipleEmoji.
    if(!action || (action.name !== 'reactToRandomBubble' && action.name !== 'reactMultipleEmoji')) return {ok: true};
    if(action.skipped) return {ok: true};
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    const rows = await storeAllOn(user);
    const expected: string[] = action.name === 'reactMultipleEmoji' ? action.args.emojis : [action.args.emoji];
    for(const em of expected) {
      const match = rows.find((r: any) => r.emoji === em && r.fromPubkey);
      if(!match) {
        return {ok: false, message: `own kind-7 emoji ${em} missing from sender store (self-echo drop)`, evidence: {user: action.args.user, expected: em}};
      }
    }
    return {ok: true};
  }
};

export const reactionBilateral: Invariant = {
  id: 'INV-reaction-bilateral',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const [rowsA, rowsB] = await Promise.all([
      storeAllOn(ctx.users.userA),
      storeAllOn(ctx.users.userB)
    ]);
    // Every row on A with fromPubkey=ownPubkeyA must appear on B too (and vice versa).
    const ownA = await ctx.users.userA.page.evaluate(() => (window as any).__nostraOwnPubkey);
    const ownB = await ctx.users.userB.page.evaluate(() => (window as any).__nostraOwnPubkey);
    for(const row of rowsA) {
      if(row.fromPubkey !== ownA) continue;
      const mirror = rowsB.find((r: any) => r.reactionEventId === row.reactionEventId);
      if(!mirror) {
        return {ok: false, message: `reaction ${row.emoji} (${row.reactionEventId}) from A not propagated to B`, evidence: {row}};
      }
    }
    for(const row of rowsB) {
      if(row.fromPubkey !== ownB) continue;
      const mirror = rowsA.find((r: any) => r.reactionEventId === row.reactionEventId);
      if(!mirror) {
        return {ok: false, message: `reaction ${row.emoji} (${row.reactionEventId}) from B not propagated to A`, evidence: {row}};
      }
    }
    return {ok: true};
  }
};

export const reactionAuthorCheck: Invariant = {
  id: 'INV-reaction-author-check',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const rows = await storeAllOn(ctx.users[id]);
      // Check: for each row, verify reactionEventId is a well-formed hex (NIP-01 64 chars).
      for(const r of rows) {
        if(!/^[0-9a-f]{64}$/i.test(r.reactionEventId)) {
          return {ok: false, message: `malformed reactionEventId on ${id}: ${r.reactionEventId}`, evidence: {user: id, row: r}};
        }
      }
    }
    return {ok: true};
  }
};

export const reactionRemoveKind: Invariant = {
  id: 'INV-reaction-remove-kind',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    // Only triggered post-removeReaction: verify kind-5 event exists on relay
    // referencing the removed reactionEventId.
    if(!action || action.name !== 'removeReaction' || action.skipped) return {ok: true};
    const removedId = action.meta?.removedReactionId;
    if(!removedId) return {ok: true};
    const events = await ctx.relay.getAllEvents();
    const deletes = events.filter((e: any) => e.kind === 5);
    const match = deletes.find((e: any) => e.tags?.some((t: any[]) => t[0] === 'e' && t[1] === removedId));
    if(!match) {
      return {ok: false, message: `removeReaction did not emit a kind-5 targeting ${removedId}`, evidence: {removedId, kind5Count: deletes.length}};
    }
    return {ok: true};
  }
};

/**
 * After reactMultipleEmoji with N distinct emojis on one mid, the sender's
 * own bubble must render all N emojis in .reactions once the store settles.
 * Regression for FIND-bbf8efa8.
 */
export const reactionAggregatedRender: Invariant = {
  id: 'INV-reaction-aggregated-render',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    if(!action || action.name !== 'reactMultipleEmoji' || action.skipped) return {ok: true};
    const emojis: string[] = action.meta?.emojis || [];
    const mid = action.meta?.targetMid;
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    if(!emojis.length || !mid) return {ok: true};
    // One final read, not a polling window — this invariant runs AFTER the
    // postcondition (which polls), so the store has already settled.
    const rendered = await user.page.evaluate((m: string) => {
      const el = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"] .reactions`);
      return el ? (el.textContent || '') : '';
    }, String(mid));
    const missing = emojis.filter((em) => !rendered.includes(em));
    if(missing.length === 0) return {ok: true};
    return {ok: false, message: `aggregated reactions missing ${missing.join(',')} on mid=${mid}`, evidence: {rendered, expected: emojis, missing}};
  }
};
