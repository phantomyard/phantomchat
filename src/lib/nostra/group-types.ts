/**
 * Group Messaging Types
 *
 * Type definitions for group metadata, control messages, and peer ID mapping.
 * Groups use negative peer IDs (peerChat convention) in a separate range
 * from user peers to avoid collisions.
 */

import type {DeliveryState} from './delivery-tracker';

// ─── Constants ──────────────────────────────────────────────────────

/** Base for group peer IDs (separate range from user peers at 10^15) */
export const GROUP_PEER_BASE = BigInt(2 * 10 ** 15);

/** Range for group peer IDs */
export const GROUP_PEER_RANGE = BigInt(9 * 10 ** 15);

/**
 * Returns true if peerId belongs to a group (negative, in GROUP_PEER_BASE range).
 */
export function isGroupPeer(peerId: number): boolean {
  return peerId < 0 && Math.abs(peerId) >= Number(GROUP_PEER_BASE);
}

// ─── Control Message Types ──────────────────────────────────────────

export type GroupControlType =
  | 'group_create'
  | 'group_add_member'
  | 'group_remove_member'
  | 'group_leave'
  | 'group_info_update'
  | 'group_admin_transfer'
  | 'group_edit_message'
  | 'group_delete_message'
  | 'group_reaction'
  | 'group_unreaction';

export interface GroupControlPayload {
  type: GroupControlType;
  groupId: string;
  groupName?: string;
  groupDescription?: string;
  groupAvatar?: string;
  memberPubkeys?: string[];
  targetPubkey?: string;
  adminPubkey?: string;
  // Edit-message fields (type === 'group_edit_message'):
  // `targetEventId` is the rumor id of the original message (= store row eventId).
  // `newText` is the post-edit content. `editedAt` is unix seconds.
  targetEventId?: string;
  newText?: string;
  editedAt?: number;
  // Reaction fields (type === 'group_reaction' | 'group_unreaction'):
  emoji?: string;
  reactionEventId?: string;
  createdAt?: number;
}

// ─── Group Record ───────────────────────────────────────────────────

export interface GroupRecord {
  groupId: string;
  name: string;
  description?: string;
  avatar?: string;
  adminPubkey: string;
  members: string[];
  peerId: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Group Delivery Info ────────────────────────────────────────────

export interface GroupDeliveryInfo {
  messageId: string;
  groupId: string;
  memberStates: Record<string, DeliveryState>;
  aggregateState: DeliveryState;
}

// ─── Peer ID Mapping ────────────────────────────────────────────────

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for(let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Interpret the first 8 bytes of a Uint8Array as a big-endian unsigned 64-bit integer.
 */
function bigEndianUint64(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for(let i = 0; i < 8; i++) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Map a group ID (hex string) to a deterministic negative peer ID.
 *
 * Algorithm mirrors `mapPubkeyToPeerId` in nostra-bridge.ts but negates
 * the result (negative for peerChat type) and uses GROUP_PEER_BASE range.
 *
 * result = -(GROUP_PEER_BASE + (hashBigInt % GROUP_PEER_RANGE))
 */
export async function groupIdToPeerId(groupId: string): Promise<number> {
  const groupBytes = hexToBytes(groupId);
  const first8 = groupBytes.slice(0, 8);
  const hashBuffer = await crypto.subtle.digest('SHA-256', first8);
  const hashBytes = new Uint8Array(hashBuffer);
  const hashBigInt = bigEndianUint64(hashBytes);

  return -Number(GROUP_PEER_BASE + (hashBigInt % GROUP_PEER_RANGE));
}
