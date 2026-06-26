/**
 * chat-api-receive.ts
 *
 * Handles incoming relay messages: delete notifications, group routing,
 * self-echo handling (multi-device), unknown sender auto-add, message
 * parsing, dedup, store persistence, and delivery receipts.
 *
 * Extracted from ChatAPI.handleRelayMessage for testability.
 * Each step is a pure function that can be unit tested.
 */

import {DecryptedMessage} from './nostr-relay';
import {getMessageStore, StoredMessage} from './message-store';
import {getMessageRequestStore} from './message-requests';
import {isControlEvent, getGroupIdFromRumor} from './group-control-messages';
import type {ChatMessage, ChatMessageType} from './chat-api';
import rootScope from '@lib/rootScope';

/** Payload for an incoming edit notification */
export interface IncomingEdit {
  originalAppMessageId: string;
  newContent: string;
  editedAt: number;
  senderPubkey: string;
}

/** Context injected by ChatAPI for receive handler */
export interface ReceiveContext {
  ownId: string;
  history: ChatMessage[];
  activePeer: string | null;
  deliveryTracker: {
    sendDeliveryReceipt(eventId: string, sender: string): Promise<void>;
  } | null;
  offlineQueue: {acknowledge(id: string): void} | null;
  onMessage: ((msg: ChatMessage) => void) | null;
  onEdit: ((edit: IncomingEdit) => void) | null;
  log: {
    (...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
}

/** Result of processing a relay message */
export type ReceiveResult =
  | {action: 'skipped'; reason: string}
  | {action: 'deleted'; conversationId: string}
  | {action: 'routed_group'; groupId: string}
  | {action: 'routed_control'}
  | {action: 'echo_skipped'; id: string}
  | {action: 'echo_saved'; id: string}
  | {action: 'duplicate'; id: string}
  | {action: 'edited'; originalAppMessageId: string}
  | {action: 'received'; message: ChatMessage};

// ─── Step functions (testable individually) ────────────────────

/**
 * Check if the rumor tags carry a PhantomChat edit marker.
 * Returns the original app-level message ID being edited, or null if not an edit.
 *
 * Tag shape: ['phantomchat-edit', '<appMessageId>']
 *
 * The original ID is the application-level message ID (format `chat-<timestamp>-<n>`),
 * NOT the Nostr rumor hex. Using the app id keeps lookup consistent across sender
 * and receiver stores (sender's row is keyed by app id, receiver's row carries it
 * in the appMessageId field).
 */
export function isEditMessage(tags: string[][] | undefined): {originalAppMessageId: string} | null {
  if(!tags || !Array.isArray(tags)) return null;
  for(const tag of tags) {
    if(!Array.isArray(tag) || tag.length < 2) continue;
    if(tag[0] !== 'phantomchat-edit') continue;
    const id = tag[1];
    if(typeof id !== 'string') continue;
    if(!/^chat-\d+-\d+$/.test(id)) continue;
    return {originalAppMessageId: id};
  }
  return null;
}

/**
 * Check if the rumor tags carry a NIP-10 reply marker.
 * Returns the eventId of the message being replied to, or null otherwise.
 *
 * Tag shape: `['e', '<rumorEventId>', '<relayUrl-or-empty>', 'reply']`.
 * Per nostr-crypto.ts:127-139 we always set position 4 to 'reply' for our
 * own outgoing replies; we accept missing position 4 for forward-compat
 * with NIP-10 'positional' tag readings.
 */
export function isReplyMessage(tags: string[][] | undefined): {replyToEventId: string} | null {
  if(!tags || !Array.isArray(tags)) return null;
  for(const tag of tags) {
    if(!Array.isArray(tag) || tag.length < 2) continue;
    if(tag[0] !== 'e') continue;
    const marker = tag[3];
    // Only accept explicit 'reply' marker — 'mention' / 'root' carry different
    // semantics and should not surface as a quote header.
    if(marker !== 'reply') continue;
    const id = tag[1];
    if(typeof id !== 'string' || id.length !== 64) continue;
    return {replyToEventId: id};
  }
  return null;
}

/** Check if the message is a delete notification */
export function isDeleteNotification(content: string): {eventIds: string[]} | null {
  try {
    const parsed = JSON.parse(content);
    if(parsed.type === 'delete-notification' && Array.isArray(parsed.eventIds)) {
      return {eventIds: parsed.eventIds};
    }
  } catch{
    // Not JSON
  }
  return null;
}

/** Parse message content — handles JSON and plaintext */
export function parseMessageContent(content: string): {id?: string; content: string; type?: string} {
  try {
    const parsed = JSON.parse(content);
    return {
      id: parsed.id,
      content: parsed.content || content,
      type: parsed.type
    };
  } catch{
    return {content, type: 'text'};
  }
}

/**
 * Extract file metadata from a rumor. Normally a kind 15 rumor, but we also
 * accept kind 14 rumors whose parsed.content JSON carries {url, sha256}
 * (current PhantomChat sender publishes everything as kind 14 for historical
 * reasons — see chat-api.ts sendMessage; upgrading the wire kind is a
 * protocol follow-up that doesn't affect the receive path).
 */
export function extractFileMetadata(
  parsed: any,
  _rumorKind?: number
): ChatMessage['fileMetadata'] | undefined {
  try {
    const fileParsed = typeof parsed.content === 'string' ? JSON.parse(parsed.content) : parsed;
    if(fileParsed.url && fileParsed.sha256 && fileParsed.key && fileParsed.iv) {
      return {
        url: fileParsed.url,
        sha256: fileParsed.sha256,
        mimeType: fileParsed.mimeType || 'application/octet-stream',
        size: fileParsed.size || 0,
        width: fileParsed.width,
        height: fileParsed.height,
        keyHex: fileParsed.key || fileParsed.keyHex || '',
        ivHex: fileParsed.iv || fileParsed.ivHex || '',
        duration: typeof fileParsed.duration === 'number' ? fileParsed.duration : undefined,
        waveform: typeof fileParsed.waveform === 'string' ? fileParsed.waveform : undefined,
        caption: typeof fileParsed.caption === 'string' && fileParsed.caption ? fileParsed.caption : undefined,
        // Authoritative sender-tagged media class (image/video/voice/file).
        // Absent on pre-`mediaType` messages → buildPhantomChatMedia falls
        // back to the mime/duration heuristic.
        mediaType: fileParsed.mediaType === 'image' || fileParsed.mediaType === 'video' ||
          fileParsed.mediaType === 'voice' || fileParsed.mediaType === 'file' ?
          fileParsed.mediaType : undefined
      };
    }
  } catch{
    // Failed to parse file metadata
  }
  return undefined;
}

/** Check if message is a duplicate in history */
export function isDuplicate(history: ChatMessage[], msg: DecryptedMessage, chatId: string): boolean {
  return history.some(m => m.relayEventId === msg.id) ||
    history.some(m => m.id === chatId);
}

/**
 * Max skew (seconds) between rumor.created_at and wall-clock before we drop
 * the message. 3 days covers legitimate clock drift / seal randomization
 * (NIP-17 seals randomize created_at within ~48h) while rejecting attackers
 * who pin messages to the future to keep them at the top of the chat list.
 */
export const MAX_CREATED_AT_SKEW_SECONDS = 3 * 86400;

/**
 * Returns true if the rumor's created_at is within the accepted window.
 * Anything farther than `MAX_CREATED_AT_SKEW_SECONDS` from wall clock is
 * rejected — this blocks "pin-to-top forever" attacks (far-future timestamps)
 * as well as obvious replay/backdated garbage.
 */
export function isCreatedAtInWindow(createdAt: number, nowSeconds?: number): boolean {
  if(typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.abs(createdAt - now) <= MAX_CREATED_AT_SKEW_SECONDS;
}

// ─── Main handler ──────────────────────────────────────────────

/**
 * Process an incoming relay message.
 * Returns a result describing what happened (for logging/testing).
 */
export async function handleRelayMessage(
  msg: DecryptedMessage,
  ctx: ReceiveContext
): Promise<ReceiveResult> {
  // 0. Reject rumors whose `created_at` is too far from wall-clock. A sender
  //    can otherwise set `created_at = now + 10y` to pin the message to the
  //    top of the chat list forever, or backdate to bury follow-ups. The
  //    skew window (3 days) accommodates NIP-17 seal randomization plus
  //    legitimate clock drift; anything outside is dropped silently.
  if(!isCreatedAtInWindow(msg.timestamp)) {
    ctx.log.warn(
      '[ChatAPI] dropping message with out-of-window created_at:',
      msg.timestamp,
      'from:', msg.from?.slice(0, 8) + '...'
    );
    return {action: 'skipped', reason: 'created_at_out_of_window'};
  }

  // 1. Check for delete notification
  const deleteNotif = isDeleteNotification(msg.content);
  if(deleteNotif) {
    const store = getMessageStore();
    const conversationId = store.getConversationId(ctx.ownId, msg.from);
    await store.deleteMessages(conversationId, deleteNotif.eventIds);
    return {action: 'deleted', conversationId};
  }

  // 1b. Check for edit marker tag — handle in place, do NOT create a new bubble.
  // Edit lookup uses appMessageId so it works regardless of whether the original
  // row is sender-side (eventId == app id) or receiver-side (appMessageId column).
  const editMarker = isEditMessage(msg.tags);
  if(editMarker) {
    const store = getMessageStore();
    let original: StoredMessage | null = null;
    try {
      original = await store.getByAppMessageId(editMarker.originalAppMessageId);
    } catch{
      original = null;
    }
    if(!original) {
      ctx.log.warn('[ChatAPI] edit dropped — original not found:', editMarker.originalAppMessageId);
      return {action: 'skipped', reason: 'edit_original_missing'};
    }
    if(original.senderPubkey !== msg.from) {
      ctx.log.warn('[ChatAPI] edit dropped — sender pubkey mismatch:', msg.from.slice(0, 8) + '...');
      return {action: 'skipped', reason: 'edit_author_mismatch'};
    }

    // Parse the new content from the rumor body (full JSON envelope, same as send)
    const parsed = parseMessageContent(msg.content);
    const newContent = parsed.content;
    const editedAt = msg.timestamp;

    // Idempotency: if we already applied a same-or-newer edit, no-op
    if(original.content === newContent && (original.editedAt || 0) >= editedAt) {
      return {action: 'skipped', reason: 'edit_already_applied'};
    }

    try {
      await store.saveMessage({
        ...original,
        content: newContent,
        editedAt
      });
    } catch(err) {
      ctx.log.warn('[ChatAPI] edit store update failed:', err);
    }

    if(ctx.onEdit) {
      ctx.onEdit({
        originalAppMessageId: editMarker.originalAppMessageId,
        newContent,
        editedAt,
        senderPubkey: msg.from
      });
    }

    return {action: 'edited', originalAppMessageId: editMarker.originalAppMessageId};
  }

  // 2. Check if sender is blocked
  const requestStore = getMessageRequestStore();
  const isBlocked = await requestStore.isBlocked(msg.from).catch(() => false);
  if(isBlocked) {
    return {action: 'skipped', reason: 'blocked'};
  }

  // 3. Group message routing
  try {
    const rumorLike = {
      id: msg.id,
      kind: msg.rumorKind || 14,
      content: msg.content,
      pubkey: msg.from,
      created_at: msg.timestamp,
      tags: msg.tags || []
    };

    if(isControlEvent(rumorLike)) {
      try {
        const {getGroupAPI} = await import('./group-api');
        getGroupAPI().handleControlMessage(rumorLike, msg.from);
      } catch{
        // GroupAPI not initialized
      }
      return {action: 'routed_control'};
    }

    const groupId = getGroupIdFromRumor(rumorLike);
    if(groupId) {
      try {
        const {getGroupAPI} = await import('./group-api');
        getGroupAPI().handleIncomingGroupMessage(groupId, rumorLike, msg.from);
      } catch{
        // GroupAPI not initialized
      }
      return {action: 'routed_group', groupId};
    }
  } catch{
    // Routing check failed — continue with 1:1 handling
  }

  // 4. Self-echo handling (multi-device)
  if(msg.from === ctx.ownId) {
    return handleSelfEcho(msg, ctx);
  }

  // 4b. Tombstone gate — suppress relay replays of a deleted conversation.
  // Relays re-deliver kind-1059 gift-wraps (24h TTL) on every reconnect; without
  // this a message from a chat/contact the user just deleted re-creates the
  // dialog (the "delete boomerang"). Timestamp-gated: a strictly-newer message
  // (after the deletion watermark) is allowed through and revives the
  // conversation, matching Signal-style delete semantics. Dropping here — before
  // auto-add, history.push and the onMessage dispatch — also keeps the deleted
  // peer out of the contacts list and stops a replay from re-incrementing
  // unread counters. The store-level gate in saveMessage is the backstop.
  try {
    const store = getMessageStore();
    const conversationId = store.getConversationId(ctx.ownId, msg.from);
    const deletedAt = await store.getTombstone(conversationId);
    if(deletedAt > 0 && msg.timestamp <= deletedAt) {
      return {action: 'skipped', reason: 'tombstoned'};
    }
  } catch(err) {
    ctx.log.warn('[ChatAPI] tombstone gate check failed:', err);
  }

  // 5. Auto-add unknown senders
  const isKnown = await requestStore.isKnownContact(msg.from).catch(() => true);
  if(!isKnown && msg.from !== ctx.ownId) {
    ctx.log('[ChatAPI] auto-adding unknown sender:', msg.from.slice(0, 8) + '...');
    try {
      const {PhantomChatBridge} = await import('./phantomchat-bridge');
      const bridge = PhantomChatBridge.getInstance();
      const peerId = await bridge.mapPubkeyToPeerId(msg.from);
      await bridge.storePeerMapping(msg.from, peerId);
    } catch(err) {
      ctx.log.warn('[ChatAPI] failed to auto-add unknown sender:', err);
    }

    let firstMsg = msg.content;
    try {
      const p = JSON.parse(msg.content);
      firstMsg = p.content || msg.content;
    } catch{
      // plaintext
    }
    requestStore.addRequest(msg.from, firstMsg, msg.timestamp).catch((e) => console.debug('[ChatAPI] addRequest failed:', e?.message));
    rootScope.dispatchEvent('phantomchat_message_request', {pubkey: msg.from, firstMessage: firstMsg});
  }

  // 6. Parse content
  const parsed = parseMessageContent(msg.content);
  let msgType: ChatMessageType = (parsed.type || 'text') as ChatMessageType;
  const fileMetadata = extractFileMetadata(parsed, msg.rumorKind);
  if(fileMetadata) msgType = 'file';

  const chatMessage: ChatMessage = {
    id: parsed.id || msg.id,
    from: msg.from,
    to: ctx.ownId,
    type: msgType,
    // #11: for a file message the rendered bubble text is the caption (render
    // reads row.content as `text`) — never the fileContent JSON. Caption-less
    // files store ''. Plain text keeps parsed.content.
    content: fileMetadata ? (fileMetadata.caption || '') : parsed.content,
    timestamp: msg.timestamp,
    status: 'delivered',
    relayEventId: msg.id,
    fileMetadata
  };

  // 7. Dedup check
  if(isDuplicate(ctx.history, msg, chatMessage.id)) {
    if(ctx.offlineQueue) ctx.offlineQueue.acknowledge(chatMessage.id);
    return {action: 'duplicate', id: chatMessage.id};
  }

  // 7b. Persistent-store dedup — relays replay kind 1059 events (24h TTL) on
  // every reconnect. `ctx.history` is empty on fresh boot so the in-memory
  // check above doesn't catch replays, which would otherwise re-dispatch
  // phantomchat_new_message and re-increment the unread counter for already-read
  // messages. Look up the rumor id in the persistent store before proceeding.
  try {
    const store = getMessageStore();
    // Fast path: an eventId already persisted THIS session is a relay replay —
    // skip the IDB read entirely (this is the hot path under a reply burst). A
    // miss falls back to the authoritative IDB lookup for cold cross-session
    // replays; getByEventId records its hits, so the next replay is a fast hit.
    // N.B. `existing` is boolean | StoredMessage | null — only its truthiness is
    // used (hasSeenEventId true ⇒ replay; else the row, or null when genuinely new).
    const existing = store.hasSeenEventId?.(msg.id) || (await store.getByEventId(msg.id));
    if(existing) {
      if(ctx.offlineQueue) ctx.offlineQueue.acknowledge(chatMessage.id);
      ctx.history.push(chatMessage);
      return {action: 'duplicate', id: chatMessage.id};
    }
  } catch(err) {
    ctx.log.warn('[ChatAPI] persistent dedup lookup failed:', err);
  }

  // 8. Acknowledge, add to history, persist
  if(ctx.offlineQueue) ctx.offlineQueue.acknowledge(chatMessage.id);
  ctx.history.push(chatMessage);

  try {
    const store = getMessageStore();
    const conversationId = store.getConversationId(ctx.ownId, msg.from);
    // Compute mid/twebPeerId eagerly so the FIRST IDB row for an incoming
    // message carries them. Otherwise PhantomChatSync.onIncomingMessage races
    // with this save: if our fire-and-forget put lands AFTER PhantomChatSync's
    // awaited put, the merge preserves existing.mid via message-store.ts:139,
    // but the mirror vs. IDB invariant sees a window where the mirror has
    // a mid that IDB hasn't persisted yet. Closing FIND-e49755c1 requires
    // every write on either side of the race to contain mid+twebPeerId.
    let resolvedMid: number | undefined;
    let resolvedPeerId: number | undefined;
    try {
      const {PhantomChatBridge} = await import('./phantomchat-bridge');
      const bridge = PhantomChatBridge.getInstance();
      resolvedPeerId = await bridge.mapPubkeyToPeerId(msg.from);
      resolvedMid = await bridge.mapEventIdToMid(msg.id, Math.floor(msg.timestamp));
    } catch(e: any) {
      ctx.log.warn('[ChatAPI] incoming save: mid/peerId compute failed:', e?.message);
    }
    // Identity-triple contract: the FIRST IDB write for an incoming message
    // MUST carry mid+twebPeerId. Bridge failures would land a partial row and
    // leak into the mirror as a ghost mid via VMT read fallbacks — the exact
    // FIND-e49755c1 shape. If the bridge compute fails we skip the save
    // entirely and let PhantomChatSync.onIncomingMessage land the authoritative
    // row (it has the same inputs and a retry path).
    if(resolvedMid === undefined || resolvedPeerId === undefined) {
      ctx.log.warn('[ChatAPI] incoming save: skipping partial row (bridge resolve failed)', {eventId: msg.id});
    } else {
      // Resolve NIP-10 reply marker to the local mid of the original message,
      // if present in the rumor tags. Receiver-side resolution (sender did the
      // same on its own row in chat-api.ts).
      let replyToMid: number | undefined;
      const replyMarker = isReplyMessage(msg.tags);
      if(replyMarker) {
        try {
          const original = await store.getByEventId(replyMarker.replyToEventId);
          if(original) replyToMid = original.mid;
        } catch(e: any) {
          ctx.log.warn('[ChatAPI] reply_to mid resolve failed:', e?.message);
        }
      }
      const row: StoredMessage = {
        eventId: msg.id,
        appMessageId: chatMessage.id,
        conversationId,
        senderPubkey: msg.from,
        content: chatMessage.content,
        type: msgType === 'text' ? 'text' : 'file',
        timestamp: msg.timestamp,
        deliveryState: 'delivered',
        mid: resolvedMid,
        twebPeerId: resolvedPeerId,
        isOutgoing: false,
        ...(replyToMid !== undefined ? {replyToMid} : {}),
        fileMetadata: fileMetadata ? {
          url: fileMetadata.url,
          sha256: fileMetadata.sha256,
          mimeType: fileMetadata.mimeType,
          size: fileMetadata.size,
          width: fileMetadata.width,
          height: fileMetadata.height,
          keyHex: fileMetadata.keyHex,
          ivHex: fileMetadata.ivHex,
          duration: fileMetadata.duration,
          waveform: fileMetadata.waveform,
          // Persist the authoritative media class so reload classifies voice /
          // image / video without re-guessing from mime+duration.
          mediaType: fileMetadata.mediaType
        } : undefined
      };
      store.saveMessage(row).catch((err) => {
        ctx.log.warn('[ChatAPI] failed to save incoming message:', err);
      });
    }
  } catch(err) {
    ctx.log.warn('[ChatAPI] message store error:', err);
  }

  // 9. Send delivery receipt
  if(ctx.deliveryTracker && msg.from !== ctx.ownId) {
    ctx.deliveryTracker.sendDeliveryReceipt(chatMessage.id, msg.from).catch((err) => {
      ctx.log.warn('[ChatAPI] delivery receipt failed:', err);
    });
  }

  // 10. Notify callback
  if(ctx.onMessage) {
    ctx.onMessage(chatMessage);
  }

  return {action: 'received', message: chatMessage};
}

/** Handle self-echo (own message returning from relay) */
async function handleSelfEcho(
  msg: DecryptedMessage,
  ctx: ReceiveContext
): Promise<ReceiveResult> {
  // Bug #3 (FIND-4e18d35d): same-device dedup is done by rumor id (msg.id,
  // 64-hex) because sender rows are now keyed by rumorId too. Cross-device
  // saves also use rumorId so all stores converge on the same key. The parsed
  // chat-XXX-N id survives as `appMessageId` on the stored row.
  const echoId = msg.id;
  let appMessageId: string | undefined;
  try {
    const parsed = JSON.parse(msg.content);
    if(parsed.id) appMessageId = parsed.id;
  } catch{ /* not JSON */ }

  const store = getMessageStore();
  const existing = await store.getByEventId(echoId);
  if(existing) {
    return {action: 'echo_skipped', id: echoId};
  }

  // Cross-device: not in our store — save as outgoing
  const pTag = msg.tags?.find((t) => t[0] === 'p');
  const peerPubkey = pTag?.[1] || '';
  if(!peerPubkey) {
    return {action: 'skipped', reason: 'own echo no recipient'};
  }

  const conversationId = store.getConversationId(ctx.ownId, peerPubkey);
  const parsed = parseMessageContent(msg.content);
  // Self-echo carries the same wire payload as a normal incoming message, so it
  // must run the SAME file-metadata reconstruction — otherwise voice notes /
  // images echoed back to our own devices render their raw metadata JSON as
  // text (FIND: "Unknown file" + JSON bubble). Mirror the incoming path:
  // extract fileMetadata, switch type to 'file', and use the caption (not the
  // JSON) as the bubble text.
  let echoType: ChatMessageType = (parsed.type || 'text') as ChatMessageType;
  const echoFileMetadata = extractFileMetadata(parsed, msg.rumorKind);
  if(echoFileMetadata) echoType = 'file';
  const echoContent = echoFileMetadata ? (echoFileMetadata.caption || '') : parsed.content;

  // Identity-triple contract: cross-device self-echo writes MUST carry
  // mid+twebPeerId or they become ghost-mid sources downstream.
  let resolvedMid: number | undefined;
  let resolvedPeerId: number | undefined;
  try {
    const {PhantomChatBridge} = await import('./phantomchat-bridge');
    const bridge = PhantomChatBridge.getInstance();
    resolvedPeerId = await bridge.mapPubkeyToPeerId(peerPubkey);
    resolvedMid = await bridge.mapEventIdToMid(echoId, Math.floor(msg.timestamp));
  } catch(e: any) {
    ctx.log.warn('[ChatAPI] self-echo: bridge resolve failed', e?.message);
  }

  if(resolvedMid === undefined || resolvedPeerId === undefined) {
    ctx.log.warn('[ChatAPI] self-echo: skipping partial save (bridge resolve failed)', {echoId});
    return {action: 'skipped', reason: 'self_echo_bridge_failed'};
  }

  await store.saveMessage({
    eventId: echoId,
    conversationId,
    senderPubkey: ctx.ownId,
    content: echoContent,
    type: echoType === 'text' ? 'text' : 'file',
    timestamp: msg.timestamp,
    deliveryState: 'sent',
    mid: resolvedMid,
    twebPeerId: resolvedPeerId,
    isOutgoing: true,
    appMessageId,
    fileMetadata: echoFileMetadata ? {
      url: echoFileMetadata.url,
      sha256: echoFileMetadata.sha256,
      mimeType: echoFileMetadata.mimeType,
      size: echoFileMetadata.size,
      width: echoFileMetadata.width,
      height: echoFileMetadata.height,
      keyHex: echoFileMetadata.keyHex,
      ivHex: echoFileMetadata.ivHex,
      duration: echoFileMetadata.duration,
      waveform: echoFileMetadata.waveform,
      // Persist the authoritative media class so reload classifies it as voice
      // without re-guessing from mime+duration.
      mediaType: echoFileMetadata.mediaType
    } : undefined
  });

  if(ctx.onMessage) {
    ctx.onMessage({
      id: echoId,
      from: ctx.ownId,
      to: peerPubkey,
      type: echoType,
      content: echoContent,
      timestamp: msg.timestamp,
      status: 'sent',
      relayEventId: msg.id,
      isOutgoing: true,
      fileMetadata: echoFileMetadata
    } as any);
  }

  return {action: 'echo_saved', id: echoId};
}
