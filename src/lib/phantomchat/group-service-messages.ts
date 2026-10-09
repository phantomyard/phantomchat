/**
 * Group service messages — local-only synthetic messages used to give a group
 * dialog a valid `top_message` before any real chat message arrives.
 *
 * WHY this exists: tweb's `appMessagesManager.fillConversations` iterates folder
 * dialogs and logs `something strange with dialog` for every row whose
 * `top_message` fails `getServerMessageId()`. A freshly-created group has no
 * messages, so its synthesized dialog ends up with `top_message: 0`. Writing a
 * synthetic service row into the message-store gives VMT `getDialogs` a real
 * `mid` to return and satisfies tweb's validation.
 *
 * The rows are NEVER transmitted over the wire. They are produced on both
 * creator and receiver sides at group_create time and stored alongside
 * regular group messages under `conversationId = 'group:<groupId>'` (the
 * canonical group conversation key — see issue #207).
 */

import {getMessageStore, type StoredMessage} from './message-store';
import {PhantomChatBridge} from './phantomchat-bridge';

// Deterministic eventId for a group's create row: same groupId → same mid on
// every device. Never collides with a real Nostr event id (64 lowercase hex).
function chatCreateEventId(groupId: string): string {
  return `group-create-${groupId}`;
}

// Deterministic eventId for the rebind notice row (#188 rebind migration).
function chatRebindEventId(groupId: string): string {
  return `group-rebind-${groupId}`;
}

export const GROUP_REBIND_NOTICE = 'Group upgraded — earlier history was moved here.';

export interface GroupRebindNoticeInput {
  groupId: string;
  peerId: number;
  /** Seconds since epoch. */
  timestamp: number;
  /** Sender (group admin) hex pubkey, used to key the notice row. */
  adminPubkey: string;
}

/**
 * Write the visible "group upgraded, history moved here" notice into the
 * rebound conversation (Lena review of #188, 2026-10-04): auto-rebind must
 * not be silent — members are otherwise confronted with a new group id
 * appearing out of nowhere. Idempotent like the create service row.
 */
export async function writeGroupRebindNoticeMessage(
  input: GroupRebindNoticeInput
): Promise<void> {
  const eventId = chatRebindEventId(input.groupId);
  const mid = await PhantomChatBridge.getInstance().mapEventIdToMid(eventId, input.timestamp);

  const row: StoredMessage = {
    eventId,
    conversationId: `group:${input.groupId}`,
    senderPubkey: input.adminPubkey,
    content: GROUP_REBIND_NOTICE,
    type: 'text',
    timestamp: input.timestamp,
    deliveryState: 'delivered',
    mid,
    twebPeerId: input.peerId,
    isOutgoing: false
  };

  await getMessageStore().saveMessage(row);
}

export interface GroupCreateServiceInput {
  groupId: string;
  peerId: number;
  /** Seconds since epoch. */
  timestamp: number;
  /** Sender (group admin) hex pubkey, used to key the service row. */
  adminPubkey: string;
  /** Group display name — embedded into servicePayload for VMT to render. */
  title: string;
  /** Member tweb peerIds (positive for users, group excluded). Optional. */
  memberPeerIds?: number[];
  /** Whether the local user created this group (vs. received it). */
  isOutgoing: boolean;
}

export interface GroupCreateServiceResult {
  eventId: string;
  mid: number;
  timestamp: number;
}

/**
 * Write a synthetic "group created" service row into the message-store.
 * Idempotent: re-calling for the same groupId upserts the existing row.
 */
export async function writeGroupCreateServiceMessage(
  input: GroupCreateServiceInput
): Promise<GroupCreateServiceResult> {
  const eventId = chatCreateEventId(input.groupId);
  const mid = await PhantomChatBridge.getInstance().mapEventIdToMid(eventId, input.timestamp);

  const row: StoredMessage = {
    eventId,
    // Canonical group conversation key (#207). Writing the service row bare
    // meant VMT getDialogs / store read cursors keyed under `group:` never
    // saw it; every group reader must agree on `group:<groupId>`.
    conversationId: `group:${input.groupId}`,
    senderPubkey: input.adminPubkey,
    content: '',
    type: 'text',
    timestamp: input.timestamp,
    deliveryState: input.isOutgoing ? 'sent' : 'delivered',
    mid,
    twebPeerId: input.peerId,
    isOutgoing: input.isOutgoing,
    serviceType: 'chatCreate',
    servicePayload: {
      title: input.title,
      memberPeerIds: input.memberPeerIds
    }
  };

  await getMessageStore().saveMessage(row);
  return {eventId, mid, timestamp: input.timestamp};
}
