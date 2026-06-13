/**
 * Nostr Profile Fetcher
 *
 * Queries relays for kind 0 metadata events to resolve a pubkey's
 * display name, NIP-05, and avatar. Used when adding P2P contacts
 * to show meaningful names instead of truncated pubkeys.
 */

import {DEFAULT_RELAYS} from './nostr-relay-pool';
import {logSwallow} from './log-swallow';
import {verifyEvent} from 'nostr-tools/pure';

/** Extract relay URLs from DEFAULT_RELAYS (which are RelayConfig objects) */
const DEFAULT_RELAY_URLS = DEFAULT_RELAYS.map((r) => r.url);

const LOG_PREFIX = '[NostrProfile]';

export interface NostrProfile {
  name?: string;
  display_name?: string;
  nip05?: string;
  picture?: string;
  about?: string;
  website?: string;
  lud16?: string;
  banner?: string;
}

/** NostrProfile + the kind 0 event metadata required for conflict resolution. */
export interface NostrProfileWithMeta {
  profile: NostrProfile;
  created_at: number;
  pubkey: string;
}

/**
 * Fetch kind 0 profile metadata for a pubkey from relays.
 * Tries each relay in order, returns the first valid result.
 * Times out after 5 seconds per relay.
 *
 * @param pubkey - Hex pubkey to look up
 * @param relayUrls - Relay URLs to query (defaults to DEFAULT_RELAYS)
 * @returns Parsed profile or null if not found
 */
export async function fetchNostrProfile(
  pubkey: string,
  relayUrls?: string[]
): Promise<NostrProfile | null> {
  const relays = relayUrls ?? DEFAULT_RELAY_URLS;

  for(const relayUrl of relays) {
    try {
      const profile = await queryRelayForProfile(relayUrl, pubkey);
      if(profile) {
        console.log(`${LOG_PREFIX} found profile for ${pubkey.slice(0, 8)}... on ${relayUrl}`);
        return profile;
      }
    } catch(err) {
      console.debug(`${LOG_PREFIX} relay ${relayUrl} failed:`, err);
    }
  }

  console.debug(`${LOG_PREFIX} no profile found for ${pubkey.slice(0, 8)}...`);
  return null;
}

/**
 * Derive the best display name from a Nostr profile.
 * Priority: display_name > name > nip05 > null
 */
export function profileToDisplayName(profile: NostrProfile | null): string | null {
  if(!profile) return null;
  if(profile.display_name?.trim()) return profile.display_name.trim();
  if(profile.name?.trim()) return profile.name.trim();
  if(profile.nip05?.trim()) return profile.nip05.trim();
  return null;
}

/**
 * Fetch own kind 0 metadata from ALL configured relays and return the newest
 * (highest created_at). Unlike fetchNostrProfile (which returns the first
 * relay hit), this function is conflict-aware: if the user edited their
 * profile on another device and published to one relay, this picks up the
 * change even if an older version still exists on other relays.
 */
export async function fetchOwnKind0(
  pubkey: string,
  relayUrls?: string[]
): Promise<NostrProfileWithMeta | null> {
  const relays = relayUrls ?? DEFAULT_RELAY_URLS;

  const results = await Promise.all(
    relays.map((url): Promise<NostrProfileWithMeta | null> =>
      queryRelayForProfileWithMeta(url, pubkey).catch((): null => null)
    )
  );

  let best: NostrProfileWithMeta | null = null;
  for(const r of results) {
    if(!r) continue;
    if(!best || r.created_at > best.created_at) {
      best = r;
    }
  }

  if(best) {
    console.log(`${LOG_PREFIX} newest own kind 0 for ${pubkey.slice(0, 8)}... created_at=${best.created_at}`);
  }
  return best;
}

const QUERY_TIMEOUT_MS = 5000;

export function queryRelayForProfileWithMeta(relayUrl: string, pubkey: string): Promise<NostrProfileWithMeta | null> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    const subId = 'ownprof-' + Math.random().toString(36).slice(2, 8);
    let resolved = false;

    const timeout = setTimeout(() => {
      if(!resolved) {
        resolved = true;
        try { ws.close(); } catch(e) { logSwallow('NostrProfile.ownProfile.wsCloseTimeout', e); }
        resolve(null);
      }
    }, QUERY_TIMEOUT_MS);

    try {
      ws = new WebSocket(relayUrl);
    } catch(err) {
      clearTimeout(timeout);
      reject(err);
      return;
    }

    ws.onopen = () => {
      const filter = {kinds: [0], authors: [pubkey], limit: 1};
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if(msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const nostrEvent = msg[2];
          if(nostrEvent.kind === 0 && nostrEvent.content && typeof nostrEvent.created_at === 'number') {
            // Security: relay may serve a kind 0 event with a forged pubkey or
            // a pubkey not matching the one we asked for. Verify both the
            // Schnorr signature and the author binding before trusting it.
            if(nostrEvent.pubkey !== pubkey) {
              console.warn(`${LOG_PREFIX} dropping kind 0 from ${relayUrl}: pubkey mismatch`);
              return;
            }
            if(!verifyEvent(nostrEvent)) {
              console.warn(`${LOG_PREFIX} dropping kind 0 from ${relayUrl}: bad signature`);
              return;
            }
            const profile = JSON.parse(nostrEvent.content) as NostrProfile;
            if(!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve({profile, created_at: nostrEvent.created_at, pubkey: nostrEvent.pubkey});
            }
          }
        } else if(msg[0] === 'EOSE' && msg[1] === subId) {
          if(!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        }
      } catch{
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      if(!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    };

    ws.onclose = () => {
      if(!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    };
  });
}

function queryRelayForProfile(relayUrl: string, pubkey: string): Promise<NostrProfile | null> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    const subId = 'profile-' + Math.random().toString(36).slice(2, 8);
    let resolved = false;

    const timeout = setTimeout(() => {
      if(!resolved) {
        resolved = true;
        try { ws.close(); } catch(e) { logSwallow('NostrProfile.queryProfile.wsCloseTimeout', e); }
        resolve(null);
      }
    }, QUERY_TIMEOUT_MS);

    try {
      ws = new WebSocket(relayUrl);
    } catch(err) {
      clearTimeout(timeout);
      reject(err);
      return;
    }

    ws.onopen = () => {
      // Send REQ for kind 0 from this pubkey, limit 1
      const filter = {kinds: [0], authors: [pubkey], limit: 1};
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if(msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const nostrEvent = msg[2];
          if(nostrEvent.kind === 0 && nostrEvent.content) {
            // Security: guard against a hostile relay returning a kind 0 with
            // a forged pubkey (impersonating the user we asked about) or an
            // invalid signature. Both checks required.
            if(nostrEvent.pubkey !== pubkey) {
              console.warn(`${LOG_PREFIX} dropping kind 0 from ${relayUrl}: pubkey mismatch`);
              return;
            }
            if(!verifyEvent(nostrEvent)) {
              console.warn(`${LOG_PREFIX} dropping kind 0 from ${relayUrl}: bad signature`);
              return;
            }
            const profile = JSON.parse(nostrEvent.content) as NostrProfile;
            if(!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve(profile);
            }
          }
        } else if(msg[0] === 'EOSE' && msg[1] === subId) {
          // End of stored events — no profile found on this relay
          if(!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        }
      } catch{
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      if(!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`WebSocket error for ${relayUrl}`));
      }
    };

    ws.onclose = () => {
      if(!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    };
  });
}
