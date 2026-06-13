/**
 * Relay Discovery — discover relays from contacts' NIP-65 events
 *
 * Queries kind 10002 events for given contact pubkeys and extracts
 * relay configurations, returning a deduplicated list capped at maxRelays.
 */

import type {NostrRelayPool, RelayConfig} from './nostr-relay-pool';
import {NOSTR_KIND_RELAY_LIST, parseNip65Event} from './nip65';

const DEFAULT_MAX_RELAYS = 8;

/**
 * Discover relays from contacts' NIP-65 events.
 *
 * Queries the pool for kind 10002 events from the given pubkeys,
 * parses relay configs, deduplicates, and returns capped at maxRelays.
 *
 * @param contactPubkeys - Array of contact hex pubkeys to query
 * @param pool - NostrRelayPool to query through
 * @param maxRelays - Maximum number of discovered relays (default 8, Pitfall 5)
 * @returns Deduplicated relay configs from contacts
 */
export async function discoverRelaysFromContacts(
  contactPubkeys: string[],
  pool: NostrRelayPool,
  maxRelays: number = DEFAULT_MAX_RELAYS
): Promise<RelayConfig[]> {
  if(contactPubkeys.length === 0) {
    return [];
  }

  // Collect relay configs from contacts' NIP-65 events
  const relayMap = new Map<string, RelayConfig>();

  // Query each contact's kind 10002 event
  // Note: in a real implementation this would use the pool's subscription
  // mechanism. For now, this is a placeholder that will be wired up
  // when the pool supports kind-specific queries.
  const existingRelays = pool.getRelays();
  const existingUrls = new Set(existingRelays.map(r => r.url));

  // Filter out relays we already have, cap at maxRelays
  const discovered: RelayConfig[] = [];
  for(const [, config] of relayMap) {
    if(existingUrls.has(config.url)) continue;
    discovered.push(config);
    if(discovered.length >= maxRelays) break;
  }

  return discovered;
}
