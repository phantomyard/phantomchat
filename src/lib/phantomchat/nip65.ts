/**
 * NIP-65 — Relay List Metadata (kind 10002)
 *
 * Builds and parses kind 10002 replaceable events that advertise
 * the user's preferred relay list. Published at identity init and
 * whenever the relay list changes.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/65.md
 */

import {finalizeEvent} from 'nostr-tools/pure';
import type {RelayConfig} from './nostr-relay-pool';

/**
 * NIP-65 relay list metadata event kind
 */
export const NOSTR_KIND_RELAY_LIST = 10002;

/**
 * Build a NIP-65 kind 10002 event advertising the user's relay list.
 *
 * Tags:
 * - ['r', url] for read+write
 * - ['r', url, 'read'] for read-only
 * - ['r', url, 'write'] for write-only
 *
 * @param relays - Array of relay configs to advertise
 * @param privateKey - 32-byte private key for signing
 * @param previousTimestamp - If provided, ensure created_at > previousTimestamp
 * @returns Signed Nostr event
 */
export function buildNip65Event(
  relays: RelayConfig[],
  privateKey: Uint8Array,
  previousTimestamp?: number
): any {
  const tags: string[][] = [];

  for(const relay of relays) {
    if(relay.read && relay.write) {
      tags.push(['r', relay.url]);
    } else if(relay.read) {
      tags.push(['r', relay.url, 'read']);
    } else if(relay.write) {
      tags.push(['r', relay.url, 'write']);
    }
  }

  let createdAt = Math.floor(Date.now() / 1000);

  // Ensure strictly newer than previous timestamp (Pitfall 3)
  if(previousTimestamp !== undefined && createdAt <= previousTimestamp) {
    createdAt = previousTimestamp + 1;
  }

  const event = finalizeEvent({
    kind: NOSTR_KIND_RELAY_LIST,
    created_at: createdAt,
    tags,
    content: ''
  }, privateKey);

  return event;
}

/**
 * Parse a NIP-65 kind 10002 event into RelayConfig[].
 *
 * @param event - Event object with tags array
 * @returns Parsed relay configurations
 */
export function parseNip65Event(event: {tags: string[][]}): RelayConfig[] {
  const relays: RelayConfig[] = [];

  for(const tag of event.tags) {
    if(tag[0] !== 'r' || !tag[1]) continue;

    const url = tag[1];
    const marker = tag[2];

    if(marker === 'read') {
      relays.push({url, read: true, write: false});
    } else if(marker === 'write') {
      relays.push({url, read: false, write: true});
    } else {
      relays.push({url, read: true, write: true});
    }
  }

  return relays;
}
