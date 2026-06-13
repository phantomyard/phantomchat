/**
 * Group Control Messages
 *
 * NIP-17 wrapping/unwrapping for group lifecycle control messages:
 * group_create, group_add_member, group_remove_member, group_leave,
 * group_info_update, group_admin_transfer.
 *
 * Control messages carry a ['control', 'true'] tag in the rumor to
 * distinguish them from regular group messages. This tag is used by
 * the receipt loop (Pitfall 5) to avoid sending receipts for control events.
 */

import {
  createRumor,
  createSeal,
  createGiftWrap,
  unwrapGiftWrap
} from './nostr-crypto';
import {getPublicKey} from 'nostr-tools/pure';
import type {NTNostrEvent, SignedEvent} from './nostr-crypto';
import type {GroupControlPayload} from './group-types';

/**
 * Check if a rumor event is a group control message.
 * Returns true if the rumor has a ['control', 'true'] tag.
 */
export function isControlEvent(rumor: {tags?: string[][]}): boolean {
  return rumor.tags?.some(t => t[0] === 'control' && t[1] === 'true') ?? false;
}

/**
 * Extract the group ID from a rumor's tags.
 * Returns null if no ['group', ...] tag is found.
 */
export function getGroupIdFromRumor(rumor: {tags?: string[][]}): string | null {
  const tag = rumor.tags?.find(t => t[0] === 'group');
  return tag ? tag[1] : null;
}

/**
 * Wrap a group control payload as NIP-17 gift-wrap for a single recipient.
 *
 * The rumor contains:
 * - content: JSON.stringify(payload)
 * - tags: [['control', 'true'], ['group', payload.groupId], ['p', recipientPubHex]]
 *
 * @returns Array with 1 kind 1059 event for the recipient
 */
export function wrapGroupControl(
  senderSk: Uint8Array,
  recipientPubHex: string,
  payload: GroupControlPayload
): NTNostrEvent[] {
  const tags: string[][] = [
    ['control', 'true'],
    ['group', payload.groupId],
    ['p', recipientPubHex]
  ];

  const rumor = createRumor(JSON.stringify(payload), senderSk, tags);
  const seal = createSeal(rumor, senderSk, recipientPubHex);
  const wrap = createGiftWrap(seal, recipientPubHex);

  return [wrap as unknown as NTNostrEvent];
}

/**
 * Unwrap a gift-wrapped control message and extract the GroupControlPayload.
 *
 * Returns null if the unwrapped rumor is not a control event or if
 * JSON parsing fails.
 */
export function unwrapGroupControl(
  sk: Uint8Array,
  giftWrap: NTNostrEvent
): {payload: GroupControlPayload; senderPubkey: string} | null {
  try {
    const {rumor} = unwrapGiftWrap(giftWrap as unknown as SignedEvent, sk);
    if(!isControlEvent(rumor)) return null;
    const payload = JSON.parse(rumor.content) as GroupControlPayload;
    return {payload, senderPubkey: rumor.pubkey};
  } catch{
    return null;
  }
}

/**
 * Broadcast a group control message to all members + self.
 *
 * Wraps the control payload individually for each member and the sender
 * (for multi-device recovery). Returns a flat array of all gift-wrap events.
 *
 * @returns Array of kind 1059 events: memberPubkeys.length + 1 (self-send)
 */
export function broadcastGroupControl(
  senderSk: Uint8Array,
  memberPubkeys: string[],
  payload: GroupControlPayload
): NTNostrEvent[] {
  const senderPubHex = getPublicKey(senderSk);
  const allWraps: NTNostrEvent[] = [];

  // One gift-wrap per member
  for(const memberPk of memberPubkeys) {
    allWraps.push(...wrapGroupControl(senderSk, memberPk, payload));
  }

  // Self-send for multi-device
  allWraps.push(...wrapGroupControl(senderSk, senderPubHex, payload));

  return allWraps;
}
