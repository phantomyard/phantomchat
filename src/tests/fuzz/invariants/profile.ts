// @ts-nocheck
/*
 * Profile invariants:
 *
 *   INV-profile-kind0-single-active  (cheap)
 *     For each pubkey observed on LocalRelay, at most one kind-0 event
 *     exists per (pubkey, created_at). Relays replace older kind-0s
 *     transparently (NIP-01 replaceable events). If we see >1 active
 *     kind-0 with the same pubkey *and* the same created_at, the local
 *     publishing path duplicated the event.
 *
 *   INV-profile-cache-coherent  (medium)
 *     localStorage['nostra-profile-cache'].profile.name must match the
 *     latest kind-0 event this browser knows about (content.name parsed
 *     from `nostra-profile-cache`'s created_at > any older kind-0 on
 *     relay, but within tolerance). We compare cache.name with the
 *     most recently published kind-0 for that pubkey on the relay.
 *
 *   INV-profile-propagates  (regression tier)
 *     After an editName action, the peer's apiManagerProxy.mirrors.peers
 *     entry for the editor eventually reports the new first_name. We poll
 *     up to 5s; if still stale we fail.
 *
 * Data sources:
 *   - LocalRelay.getAllEvents() — ground truth for kind-0 events
 *   - localStorage['nostra-profile-cache'] — client cache (see profile-cache.ts)
 *   - window.apiManagerProxy.mirrors.peers — peer-side mirror
 */
import type {Invariant, FuzzContext, Action, InvariantResult} from '../types';

export const invProfileKind0SingleActive: Invariant = {
  id: 'INV-profile-kind0-single-active',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    let events: Array<{kind: number; pubkey: string; created_at: number; id?: string}> = [];
    try{
      events = await ctx.relay.getAllEvents();
    } catch{
      // Relay not responsive — defer. Cheap tier runs every action, so
      // we don't want transient relay hiccups to flood FINDs.
      return {ok: true};
    }
    const byKey = new Map<string, number[]>();
    for(const e of events) {
      if(e?.kind !== 0) continue;
      const list = byKey.get(e.pubkey) || [];
      list.push(e.created_at);
      byKey.set(e.pubkey, list);
    }
    // Multiple kind-0s per pubkey are normal (edits). The violation is
    // multiple kind-0s with the *same* created_at for the same pubkey —
    // that indicates the same event was republished.
    for(const [pubkey, timestamps] of byKey.entries()) {
      const counts = new Map<number, number>();
      for(const ts of timestamps) counts.set(ts, (counts.get(ts) || 0) + 1);
      for(const [ts, n] of counts.entries()) {
        if(n > 1) {
          return {
            ok: false,
            message: `pubkey ${pubkey} has ${n} kind-0 events at created_at=${ts} (expected 1)`,
            evidence: {pubkey, created_at: ts, count: n}
          };
        }
      }
    }
    return {ok: true};
  }
};

export const invProfileCacheCoherent: Invariant = {
  id: 'INV-profile-cache-coherent',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    // For each user: read their cache + their latest kind-0 on relay.
    // Only fail if both exist AND both carry a `name` field AND they
    // diverge. (No cache => no write ever happened, ok. No relay event
    // => publish never succeeded, also ok — not our concern here.)
    let relayEvents: Array<{kind: number; pubkey: string; created_at: number; content?: string}> = [];
    try{
      relayEvents = await ctx.relay.getAllEvents();
    } catch{
      return {ok: true};
    }
    for(const user of ['userA', 'userB'] as const) {
      const u = ctx.users[user];
      const ownPub: string | null = await u.page.evaluate(() => (window as any).__nostraOwnPubkey ?? null).catch(() => null);
      if(!ownPub) continue;
      const cache: {name?: string; created_at?: number} | null = await u.page.evaluate(() => {
        try{
          const raw = localStorage.getItem('nostra-profile-cache');
          if(!raw) return null;
          const obj = JSON.parse(raw);
          return {name: obj?.profile?.name, created_at: obj?.created_at};
        } catch{ return null; }
      }).catch(() => null);
      if(!cache || !cache.name) continue;
      // Find the relay's latest kind-0 for this pubkey.
      let latest: {created_at: number; content: string} | null = null;
      for(const e of relayEvents) {
        if(e.kind !== 0 || e.pubkey !== ownPub) continue;
        if(!latest || (e.created_at > latest.created_at)) {
          latest = {created_at: e.created_at, content: e.content || ''};
        }
      }
      if(!latest) continue;
      let relayName: string | undefined;
      try{ relayName = JSON.parse(latest.content || '{}')?.name; } catch{}
      if(!relayName) continue;
      // Only fail if cache's created_at claims to be <= relay latest yet
      // disagrees on name. If cache is newer than relay (pending publish),
      // skip — that's a legitimate in-flight state.
      if((cache.created_at ?? 0) > latest.created_at) continue;
      if(cache.name !== relayName) {
        return {
          ok: false,
          message: `cache.name="${cache.name}" != latest kind-0 name="${relayName}" for ${user}`,
          evidence: {user, cache_created_at: cache.created_at, relay_created_at: latest.created_at}
        };
      }
    }
    return {ok: true};
  }
};

export const invProfilePropagates: Invariant = {
  id: 'INV-profile-propagates',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    // Only applies after an editName action. Poll the peer's mirror for
    // up to 5 seconds.
    if(!action || action.name !== 'editName' || action.skipped) return {ok: true};
    const newName: string = action.meta?.newName;
    const who: 'userA' | 'userB' = action.meta?.user || action.args?.user;
    if(!newName || !who) return {ok: true};
    const peer = who === 'userA' ? ctx.users.userB : ctx.users.userA;
    const deadline = Date.now() + 5000;
    while(Date.now() < deadline) {
      const hit = await peer.page.evaluate((expected: string) => {
        const proxy = (window as any).apiManagerProxy;
        const peers = proxy?.mirrors?.peers ?? {};
        for(const p of Object.values(peers) as any[]) {
          if(!p) continue;
          if(p.first_name === expected || p.display_name === expected) return true;
        }
        return false;
      }, newName).catch(() => false);
      if(hit) return {ok: true};
      await peer.page.waitForTimeout(250);
    }
    return {
      ok: false,
      message: `peer never saw new name="${newName}" within 5s (editor=${who})`,
      evidence: {who, newName}
    };
  }
};
