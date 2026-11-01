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
 * Base for SESSION peer IDs (owner batch 11, 2026-10-31).
 *
 * A session is a peer CLASS, not a tagged group. It sits in its own negative
 * range ABOVE the group range so the classification is a pure scalar test —
 * no module state, no per-thread index, no field on the dialog. The same answer
 * therefore holds on the main thread, in the MTPROTO worker, on an IDB replay
 * and after any reload, which is exactly what the tag-based rule could not
 * guarantee (its index was per-thread module state and the folder-membership
 * predicates run in the worker).
 */
export const SESSION_PEER_BASE = BigInt(12 * 10 ** 15);

/** Range for session peer IDs */
export const SESSION_PEER_RANGE = BigInt(9 * 10 ** 15);

/**
 * Returns true if peerId belongs to a group OR a session (negative, >= the
 * group base). This is the "is a phantom group-class peer" test: protocol
 * paths (membership, control messages, edits, reactions, avatars) must use it,
 * because a session speaks the group protocol and would otherwise be treated
 * as an unknown peer.
 *
 * Folder membership is a DIFFERENT question — see isChatGroupPeer/isSessionPeer.
 */
export function isGroupPeer(peerId: number): boolean {
  return peerId < 0 && Math.abs(peerId) >= Number(GROUP_PEER_BASE);
}

/**
 * True when the peer is a SESSION (the Session space's object class).
 *
 * Pure range test on purpose: it must be safe to call from any thread, at any
 * time, before the group store has been read.
 */
export function isSessionPeer(peerId: number): boolean {
  return peerId < 0 && Math.abs(peerId) >= Number(SESSION_PEER_BASE);
}

/**
 * True for a classic group — i.e. a group-class peer that is NOT a session.
 * This is the Groups folder's membership class, and ONLY that: everywhere else
 * (protocol, rendering, storage) the question is isGroupPeer.
 */
export function isChatGroupPeer(peerId: number): boolean {
  return isGroupPeer(peerId) && !isSessionPeer(peerId);
}

/**
 * The object class of a group record. `session` records live in the Session
 * space and nowhere else; the field is the INPUT to peer-id derivation at
 * create/join time and is never used as a live UI predicate (isSessionPeer is).
 */
export type GroupKind = 'group' | 'session';

// ─── Control Message Types ──────────────────────────────────────────

export type GroupControlType =
  | 'group_create'
  | 'group_add_member'
  | 'group_remove_member'
  | 'group_leave'
  | 'group_delete'
  | 'group_info_update'
  | 'group_admin_transfer'
  | 'group_edit_message'
  | 'group_delete_message'
  | 'group_reaction'
  | 'group_unreaction'
  | 'group_history_backfill';

export interface GroupControlPayload {
  type: GroupControlType;
  groupId: string;
  groupName?: string;
  groupDescription?: string;
  groupAvatar?: string;
  memberPubkeys?: string[];
  targetPubkey?: string;
  adminPubkey?: string;
  // Rebind migration (#188 remainder): a bound-id group_create that
  // SUPERSEDES a legacy (pre-#188, 32-hex) group id. Receivers that hold a
  // live record for the legacy id verify the sender against THAT record's
  // admin before migrating — the bound id authenticates the create, the
  // receiver's own record authenticates the supersede claim.
  supersedesGroupId?: string;
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
  /**
   * Object class, carried by `group_create` (owner batch 11). A receiver MUST
   * derive the same peerId as the creator, and the peerId range is a function
   * of this field — without it a session would land in the group range and the
   * two sides would disagree about which peer the conversation is.
   */
  groupKind?: GroupKind;
  /**
   * Backfill addressing + payload (`type === 'group_history_backfill'`).
   *
   * `historyTargetPubkey` is the newly added member the slice was wrapped for:
   * a device ingests a backfill ONLY when that field names its own key, so a
   * payload smuggled into a third member's wrap cannot inject rows into a
   * device that already holds the history.
   */
  historyTargetPubkey?: string;
  historyItems?: GroupHistoryItem[];
}

/**
 * One relayed historical message. The identity triple is the ORIGINAL rumor's,
 * so a receiver dedupes on `rumorId` exactly like a live delivery; `payload` is
 * the original rumor content (content/type/id/timestamp/replyToRumorId/
 * fileMetadata) rebuilt from the relayer's stored row.
 */
export interface GroupHistoryItem {
  rumorId: string;
  senderPubkey: string;
  /** Unix seconds — the original rumor's created_at. */
  createdAt: number;
  /** Original rumor content JSON. */
  payload: string;
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
  /**
   * Unix-millis timestamp of the USER-INITIATED create (#180) — the proof
   * that may clear a durable delete in the groups CRDT merge. Stamped ONLY
   * by GroupAPI.createGroup (the user's create gesture); receivers' local
   * handleGroupCreate records stay unstamped, and groups-sync apply()
   * persists the origin's entry-level stamp instead. Never backfilled.
   */
  deliberateAddAt?: number;
  /**
   * Legacy-id rebind (#188): ids of the pre-#188 groups this record
   * migrated from. Late relay traffic addressed to a superseded id remaps
   * to this record (messages), and a live record for a superseded id is
   * torn down once this successor exists.
   */
  supersededGroupIds?: string[];
  /** Unix-seconds stamp of the rebind that minted this record — the
   * deterministic winner tuple (reboundAt, groupId) settles competing
   * rebinds from two of the admin's devices without a coordinator. */
  reboundAt?: number;
  /**
   * Object class (owner batch 11). `session` = a Session-space peer: its peerId
   * is derived in the SESSION_PEER_BASE range, it is listed only in the Session
   * (or Session-Archive) space, and it has one phantom member. Immutable after
   * create — a session can never become a group, because the peerId is derived
   * from it and every local row is keyed by that peerId.
   */
  kind?: GroupKind;
  /**
   * Unix-millis archive stamp for a SESSION. Present = the session is in the
   * Session Archive space (read-only there). Absent/null = live.
   * Lives on the record so the groups CRDT carries it to every device with no
   * schema bump; the local dialog mirrors it as `folder_id === 1` so tweb's
   * existing archive machinery (folder_peers / getFolderDialogs) does the work.
   */
  archivedAt?: number;
  /**
   * Unix-millis PIN stamp (owner batch 15). Present = the row is pinned in the
   * chat list; `0` = explicitly unpinned (same absent/0 semantics as
   * `archivedAt`, so a writer that knows nothing about pinning cannot clear
   * someone's pin and an older build's rename cannot resurrect it).
   *
   * The local dialog mirrors it as `pFlags.pinned`, which is the flag tweb's
   * badge + pinned ordering already read for a chat — a group pins exactly the
   * way a chat does, no separate pin machinery.
   */
  pinnedAt?: number;
  /**
   * Unix-millis MARK-UNREAD stamp (owner batch 15). Present = the user marked
   * the row unread by hand, so the chat list shows the unread dot even with
   * `unread_count === 0`. Mirrors as `pFlags.unread_mark`, the flag a chat's
   * "Mark as unread" sets. `0` = explicitly cleared.
   */
  unreadMarkAt?: number;
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
 * Algorithm mirrors `mapPubkeyToPeerId` in phantomchat-bridge.ts but negates
 * the result (negative for peerChat type) and uses GROUP_PEER_BASE range.
 *
 * result = -(GROUP_PEER_BASE + (hashBigInt % GROUP_PEER_RANGE))
 *
 * #188: bound ids (<64-hex adminPubkey><32-hex random>) must derive their
 * peerId from the WHOLE id — hashing only the first 8 bytes hashes the
 * admin prefix, so every group created by one admin would collapse onto
 * the same peerId (the group store has a unique index on peerId — the
 * second group cannot even be saved). Legacy 32-hex ids keep the original
 * first-8-bytes derivation so existing groups never change peerId.
 */
export async function groupIdToPeerId(groupId: string, kind: GroupKind = 'group'): Promise<number> {
  const groupBytes = hexToBytes(groupId);
  const deriveBytes = groupBytes.length > 16 ? groupBytes : groupBytes.slice(0, 8);
  const hashBuffer = await crypto.subtle.digest('SHA-256', deriveBytes);
  const hashBytes = new Uint8Array(hashBuffer);
  const hashBigInt = bigEndianUint64(hashBytes);

  // Sessions derive from their OWN base (owner batch 11): the peerId is what
  // classifies the object, so it must be a pure function of (groupId, kind) on
  // every device and every thread.
  const base = kind === 'session' ? SESSION_PEER_BASE : GROUP_PEER_BASE;
  const range = kind === 'session' ? SESSION_PEER_RANGE : GROUP_PEER_RANGE;
  return -Number(base + (hashBigInt % range));
}
