import {createSignal, Accessor} from 'solid-js';
import rootScope from '@lib/rootScope';
import {getPubkey} from '@lib/nostra/virtual-peers-db';
import {
  loadCachedPeerProfile,
  refreshPeerProfileFromRelays
} from '@lib/nostra/peer-profile-cache';
import type {NostrProfile} from '@lib/nostra/nostr-profile';

type Setter = (value: NostrProfile | undefined) => void;

const signalByPeerId = new Map<PeerId, {
  get: Accessor<NostrProfile | undefined>,
  set: Setter,
  pubkey?: string
}>();

let listenerInstalled = false;

function installListener() {
  if(listenerInstalled) return;
  listenerInstalled = true;
  rootScope.addEventListener('nostra_peer_profile_updated', ({peerId, profile}) => {
    const entry = signalByPeerId.get(peerId);
    if(entry) entry.set(profile);
  });
}

/**
 * Solid hook returning a signal that holds the latest kind 0 profile
 * we have for a peer (or undefined if none known). Each peerId is
 * memoised — opening the same profile twice reuses the same signal.
 *
 * On first call for a peerId we:
 *   1. resolve its pubkey from virtual-peers-db
 *   2. seed the signal from localStorage cache (sync)
 *   3. fire refreshPeerProfileFromRelays in the background
 */
export function usePeerNostraProfile(peerId: PeerId): Accessor<NostrProfile | undefined> {
  installListener();

  const existing = signalByPeerId.get(peerId);
  if(existing) return existing.get;

  const [get, set] = createSignal<NostrProfile | undefined>(undefined);
  const entry = {get, set, pubkey: undefined as string | undefined};
  signalByPeerId.set(peerId, entry);

  // Async resolution: pubkey lookup + cache seed + background refresh.
  (async() => {
    const pubkey = await getPubkey(Math.abs(peerId as unknown as number));
    if(!pubkey) return;
    entry.pubkey = pubkey;

    const cached = loadCachedPeerProfile(pubkey);
    if(cached) set(cached.profile);

    refreshPeerProfileFromRelays(pubkey, peerId).catch(() => {});
  })();

  return get;
}
