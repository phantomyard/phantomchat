// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

export const avatarDomMatchesCache: Invariant = {
  id: 'INV-avatar-dom-matches-cache',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const res = await checkOne(ctx.users[id], id);
      if(!res.ok) return res;
    }
    return {ok: true};
  }
};

async function checkOne(user: UserHandle, id: 'userA' | 'userB'): Promise<InvariantResult> {
  const payload = await user.page.evaluate(() => {
    const img = document.querySelector('.sidebar-header .btn-menu-toggle .avatar img, .sidebar-header .avatar img') as HTMLImageElement | null;
    const domSrc = img?.getAttribute('src') || null;
    let cached: any = null;
    try{
      const raw = localStorage.getItem('nostra-profile-cache');
      if(raw) cached = JSON.parse(raw);
    } catch{}
    return {domSrc, cachedPicture: cached?.profile?.picture ?? null};
  });

  // No image mounted yet — benign (app still booting or no avatar widget on this route).
  if(!payload.domSrc) return {ok: true};

  // Empty string or 'null' src — bug.
  if(payload.domSrc === '' || payload.domSrc === 'null' || payload.domSrc === 'undefined') {
    return {
      ok: false,
      message: `avatar img src is empty/null on ${id}`,
      evidence: {user: id, domSrc: payload.domSrc}
    };
  }

  // If cache has a picture, DOM must match it.
  if(payload.cachedPicture && payload.domSrc !== payload.cachedPicture) {
    // Dicebear fallback is acceptable if cache has no picture.
    const isDicebear = payload.domSrc.includes('dicebear');
    if(!isDicebear) {
      return {
        ok: false,
        message: `avatar DOM src != cache picture on ${id}`,
        evidence: {user: id, domSrc: payload.domSrc, cachedPicture: payload.cachedPicture}
      };
    }
  }
  return {ok: true};
}
