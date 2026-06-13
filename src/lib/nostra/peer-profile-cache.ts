/*
 * Nostra.chat — Peer profile cache
 *
 * Per-peer kind 0 metadata cache. Parallels profile-cache.ts (which
 * handles the user's own profile) but keyed by peer pubkey so multiple
 * peers can be cached side-by-side. Each entry stores created_at for
 * conflict resolution when the same pubkey publishes new kind 0 events
 * from another client.
 *
 * Consumers: virtual-mtproto-server.ts (hydrates UserFull.about on
 * users.getFullUser) and stores/peerNostraProfile.ts (drives the
 * right-sidebar User Info rows).
 */

import rootScope from '@lib/rootScope';
import {DEFAULT_RELAYS} from './nostr-relay-pool';
import {queryRelayForProfileWithMeta, type NostrProfile} from './nostr-profile';
import {updateMappingProfile} from './virtual-peers-db';

export const PEER_PROFILE_CACHE_PREFIX = 'nostra-peer-profile-cache:';

const LOG_PREFIX = '[PeerProfileCache]';

export interface CachedPeerProfile {
  profile: NostrProfile;
  created_at: number;
}

export function loadCachedPeerProfile(pubkey: string): CachedPeerProfile | null {
  try {
    const raw = localStorage.getItem(PEER_PROFILE_CACHE_PREFIX + pubkey);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(parsed && typeof parsed.created_at === 'number' && parsed.profile && typeof parsed.profile === 'object') {
      return parsed as CachedPeerProfile;
    }
    return null;
  } catch{
    return null;
  }
}

export function saveCachedPeerProfile(pubkey: string, cached: CachedPeerProfile): void {
  try {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + pubkey, JSON.stringify(cached));
  } catch{
    // storage full / disabled — silently drop
  }
}

/**
 * Query every configured relay in parallel for a peer's kind 0 event,
 * keep the newest (highest created_at), and — only if strictly newer
 * than the cached entry — persist and dispatch `nostra_peer_profile_updated`.
 *
 * Returns when all relay queries have settled. Intended to be fired
 * without awaiting in hot paths.
 */
export async function refreshPeerProfileFromRelays(pubkey: string, peerId: PeerId): Promise<void> {
  const relayUrls = DEFAULT_RELAYS.map((r) => r.url);
  const results = await Promise.all(
    relayUrls.map((url) => queryRelayForProfileWithMeta(url, pubkey).catch((): null => null))
  );

  let best: {profile: NostrProfile, created_at: number} | null = null;
  for(const r of results) {
    if(!r) continue;
    if(!best || r.created_at > best.created_at) best = r;
  }
  if(!best) return;

  const cached = loadCachedPeerProfile(pubkey);
  if(cached && best.created_at <= cached.created_at) {
    return;
  }

  saveCachedPeerProfile(pubkey, {profile: best.profile, created_at: best.created_at});
  console.log(`${LOG_PREFIX} refreshed ${pubkey.slice(0, 8)}... created_at=${best.created_at}`);

  // Persist into virtual-peers-db so subsequent appUsersManager.getApiUser
  // returns the new displayName (chatlist re-renders fall back on this).
  // Wraps in try/catch — IDB may be locked / closed during teardown and we
  // should not surface that to the caller.
  try {
    const displayName = best.profile.display_name || best.profile.name || '';
    if(displayName) {
      await updateMappingProfile(pubkey, displayName, best.profile);
    }
  } catch(err) {
    console.warn(`${LOG_PREFIX} updateMappingProfile failed:`, err);
  }

  rootScope.dispatchEventSingle('nostra_peer_profile_updated', {
    peerId,
    pubkey,
    profile: best.profile
  });

  // Fan out to the tweb-native rendering events so the chatlist's
  // .user-title and the chat topbar's .person-title refresh on the next
  // tick. Without this, the right-sidebar User Info row updates (via the
  // nostra_peer_profile_updated listener in stores/peerNostraProfile.ts)
  // but the chatlist row + topbar keep showing the stale displayName until
  // a chat switch forces a fresh getApiUser. FIND-5329aa12.
  // Cast to any: tweb's typed signatures expect a UserId for user_update
  // and a {peerId, threadId} for peer_title_edit; the receivers care only
  // about identity, not provenance.
  if(peerId.isUser?.()) {
    rootScope.dispatchEvent('user_update', peerId.toUserId() as any);
  }
  rootScope.dispatchEvent('peer_title_edit', {peerId} as any);
}

/**
 * Remove every peer profile cache entry. Called from nostra-cleanup on
 * logout. Iterates localStorage because entries are keyed by pubkey
 * and we don't track which pubkeys we've seen.
 */
export function clearPeerProfileCache(): void {
  try {
    const toRemove: string[] = [];
    for(let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if(key && key.startsWith(PEER_PROFILE_CACHE_PREFIX)) {
        toRemove.push(key);
      }
    }
    for(const key of toRemove) {
      localStorage.removeItem(key);
    }
  } catch{
    // ignore
  }
}
