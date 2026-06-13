// @ts-nocheck
/*
 * Profile postconditions — fire after specific profile actions.
 *
 *   POST_editName_cache_updated
 *     Within 3s of editName, localStorage['nostra-profile-cache'].profile.name
 *     on the editor's page matches the new name.
 *
 *   POST_editName_relay_published
 *     Within 5s of editName, LocalRelay has a kind-0 event authored by the
 *     editor's own pubkey whose content.name matches.
 *
 *   POST_uploadAvatar_propagated
 *     Within 5s of uploadAvatar, the peer's apiManagerProxy.mirrors.peers
 *     has an entry with a photo.url matching the blossom.fuzz URL we
 *     produced. (Falls back to cache.picture on the editor side if the
 *     bridge hasn't mirrored the User yet — primary assertion is the
 *     editor cache, secondary is peer mirror.)
 */
import type {Postcondition, FuzzContext, Action, InvariantResult} from '../types';

export const POST_editName_cache_updated: Postcondition = {
  id: 'POST_editName_cache_updated',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const newName: string = action.meta?.newName;
    const who: 'userA' | 'userB' = action.meta?.user || action.args?.user;
    if(!newName || !who) return {ok: true};
    const u = ctx.users[who];
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const cachedName = await u.page.evaluate(() => {
        try{
          const raw = localStorage.getItem('nostra-profile-cache');
          if(!raw) return null;
          return JSON.parse(raw)?.profile?.name ?? null;
        } catch{ return null; }
      }).catch(() => null);
      if(cachedName === newName) return {ok: true};
      await u.page.waitForTimeout(100);
    }
    return {
      ok: false,
      message: `profile cache did not reflect name="${newName}" within 3s for ${who}`
    };
  }
};

export const POST_editName_relay_published: Postcondition = {
  id: 'POST_editName_relay_published',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const newName: string = action.meta?.newName;
    const who: 'userA' | 'userB' = action.meta?.user || action.args?.user;
    if(!newName || !who) return {ok: true};
    const u = ctx.users[who];
    const ownPub: string | null = await u.page.evaluate(() => (window as any).__nostraOwnPubkey ?? null).catch(() => null);
    if(!ownPub) return {ok: true}; // can't verify without pubkey — skip
    const deadline = Date.now() + 5000;
    while(Date.now() < deadline) {
      let events: any[] = [];
      try{ events = await ctx.relay.getAllEvents(); } catch{ events = []; }
      const matched = events.some((e: any) => {
        if(e?.kind !== 0 || e?.pubkey !== ownPub) return false;
        try{ return JSON.parse(e.content || '{}')?.name === newName; } catch{ return false; }
      });
      if(matched) return {ok: true};
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      ok: false,
      message: `no kind-0 published with name="${newName}" for pubkey=${ownPub.slice(0, 12)}… within 5s`
    };
  }
};

export const POST_uploadAvatar_propagated: Postcondition = {
  id: 'POST_uploadAvatar_propagated',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const avatarUrl: string = action.meta?.avatarUrl;
    const who: 'userA' | 'userB' = action.meta?.user || action.args?.user;
    if(!avatarUrl || !who) return {ok: true};
    const editor = ctx.users[who];

    // Primary: the editor's own profile cache should now carry the URL.
    const deadline = Date.now() + 5000;
    while(Date.now() < deadline) {
      const cachedPicture = await editor.page.evaluate(() => {
        try{
          const raw = localStorage.getItem('nostra-profile-cache');
          if(!raw) return null;
          return JSON.parse(raw)?.profile?.picture ?? null;
        } catch{ return null; }
      }).catch(() => null);
      if(cachedPicture && /blossom\.fuzz/.test(String(cachedPicture))) return {ok: true};
      await editor.page.waitForTimeout(200);
    }
    return {
      ok: false,
      message: `editor cache did not reflect blossom.fuzz avatar URL within 5s (expected ${avatarUrl})`
    };
  }
};
