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
 * regular group messages under `conversationId = group.groupId`.
 */

import {getMessageStore, type StoredMessage} from './message-store';
import {NostraBridge} from './nostra-bridge';

// Deterministic eventId for a group's create row: same groupId → same mid on
// every device. Never collides with a real Nostr event id (64 lowercase hex).
function chatCreateEventId(groupId: string): string {
  return `group-create-${groupId}`;
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
  const mid = await NostraBridge.getInstance().mapEventIdToMid(eventId, input.timestamp);

  const row: StoredMessage = {
    eventId,
    conversationId: input.groupId,
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
