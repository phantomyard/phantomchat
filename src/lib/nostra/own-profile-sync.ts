/*
 * Nostra.chat — Own profile sync (cache-first with background refresh)
 *
 * Orchestrates the stale-while-revalidate pattern for the user's own kind 0
 * metadata:
 *
 *   1. At boot: hydrate the Solid store from localStorage immediately so the
 *      UI renders with no latency.
 *   2. In the background: fetch the most recent kind 0 from all configured
 *      relays, compare `created_at` against the cache, and update both the
 *      cache and the store if the relay has a newer version.
 *   3. On save: update the cache + store optimistically (so the UI stays
 *      consistent across tab opens) alongside the relay publish.
 *
 * Single source of truth on the relay; localStorage is a read-through cache.
 */

import rootScope from '@lib/rootScope';
import {fetchOwnKind0, type NostrProfile} from './nostr-profile';
import {loadCachedProfile, saveCachedProfile, type CachedProfile} from './profile-cache';

const LOG_PREFIX = '[OwnProfileSync]';

/**
 * Synchronous cache hydration. Call at boot BEFORE the first render that
 * reads from the nostraIdentity store. Dispatches
 * `nostra_identity_updated` with the cached fields.
 */
export function hydrateOwnProfileFromCache(): CachedProfile | null {
  const cached = loadCachedProfile();
  if(!cached) return null;

  rootScope.dispatchEventSingle('nostra_identity_updated', cachedToEvent(cached.profile));
  console.log(`${LOG_PREFIX} hydrated from cache, created_at=${cached.created_at}`);
  return cached;
}

/**
 * Background fetch from relays. Call after the WebSocket relay pool has
 * connected. If the relays have a newer version than the cache, the cache
 * and store are updated in place.
 *
 * @returns The synced profile, or null if no relay returned anything.
 */
export async function refreshOwnProfileFromRelays(
  pubkey: string,
  relayUrls?: string[]
): Promise<CachedProfile | null> {
  try {
    const relayResult = await fetchOwnKind0(pubkey, relayUrls);
    if(!relayResult) {
      console.log(`${LOG_PREFIX} no kind 0 on any relay for own pubkey`);
      return null;
    }

    const cached = loadCachedProfile();
    if(cached && cached.created_at >= relayResult.created_at) {
      console.log(`${LOG_PREFIX} cache is newer or equal (cache=${cached.created_at}, relay=${relayResult.created_at}) — no update`);
      return cached;
    }

    const fresh: CachedProfile = {
      profile: relayResult.profile,
      created_at: relayResult.created_at
    };
    saveCachedProfile(fresh);
    rootScope.dispatchEventSingle('nostra_identity_updated', cachedToEvent(fresh.profile));
    console.log(`${LOG_PREFIX} updated from relay, created_at=${relayResult.created_at}`);
    return fresh;
  } catch(err) {
    console.warn(`${LOG_PREFIX} relay fetch failed:`, err);
    return null;
  }
}

/**
 * Persist a local optimistic update (called by the profile edit tab right
 * before publishing kind 0 to relays). Updates the cache with the given
 * profile and dispatches the store update event.
 *
 * @param profile The fields the user just saved (partial OK).
 * @param created_at The created_at the kind 0 event will use (UNIX seconds).
 */
export function saveOwnProfileLocal(profile: NostrProfile, created_at: number): void {
  const cached = loadCachedProfile();
  const merged: NostrProfile = {
    ...(cached?.profile ?? {}),
    ...profile
  };
  const fresh: CachedProfile = {profile: merged, created_at};
  saveCachedProfile(fresh);
  rootScope.dispatchEventSingle('nostra_identity_updated', cachedToEvent(merged));
}

function cachedToEvent(profile: NostrProfile) {
  return {
    displayName: profile.display_name || profile.name || undefined,
    nip05: profile.nip05 || undefined,
    picture: profile.picture || undefined,
    about: profile.about || undefined,
    website: profile.website || undefined,
    lud16: profile.lud16 || undefined,
    banner: profile.banner || undefined
  };
}
