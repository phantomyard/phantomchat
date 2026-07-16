/**
 * PhantomChatGroupsSync
 *
 * Render pipeline for multi-party group messages, mirroring the DM
 * pipeline in `phantomchat-sync.ts`. Exports two pure functions consumed
 * directly by `GroupAPI`:
 *
 *   - `handleGroupIncoming(ownPubkey, groupId, rumor, senderPubkey, dispatch)`
 *     — persist + render bubbles for group messages received from other
 *     members. Called from `GroupAPI.handleIncomingGroupMessage`.
 *
 *   - `handleGroupOutgoing(ownPubkey, info, dispatch)` — persist + render
 *     the sender-side optimistic bubble. Called from `GroupAPI.sendMessage`
 *     immediately after wrapping. The self-wrap relay echo is dropped by
 *     `GroupAPI.sentMessageIds` dedup, so this is the sole sender-side
 *     render path.
 *
 * Render pipeline (both paths):
 *   1. Persist to IndexedDB message-store (keyed by eventId = rumor id).
 *   2. Build a tweb Message via PhantomChatPeerMapper (peerId = group peerId,
 *      fromPeerId = sender's user peerId).
 *   3. Write to `apiManagerProxy.mirrors.messages[<groupPeerId>_history][mid]`.
 *   4. Push to Worker storage via `appMessagesManager.setMessageToStorage`.
 *   5. `invalidateHistoryCache(groupPeerId)` so reopen-chat refetches.
 *   6. Dispatch `history_append` for live render when chat is open.
 *   7. Build tweb Dialog, dispatch `dialogs_multiupdate` TWICE (required
 *      by the two-dispatch rule for synthetic dialogs).
 *
 * Prior design used post-hoc callback assignment on the GroupAPI
 * singleton via a separate `initGroupsSync` + `window.__phantomchatGroupAPI`
 * lookup. That design was brittle under Vite dev module graph
 * duplication — the callback was set on one module instance but read
 * from another — and the callback body never executed. Direct function
 * imports avoid the indirection entirely.
 */

import {PhantomChatPeerMapper} from './phantomchat-peer-mapper';
import {getMessageStore} from './message-store';
import {groupIdToPeerId} from './group-types';
import {getGroupStore} from './group-store';
import {ensureSenderUserInjected} from './ensure-sender-user-injected';
import {buildPhantomChatMedia} from './phantomchat-media-shape';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';
import {phantomchatReactionsStore} from './phantomchat-reactions-store';

const LOG_PREFIX = '[PhantomChatGroupsSync]';

export type GroupDispatchFn = (event: string, data: any) => void;

export interface GroupOutgoingInfo {
  groupId: string;
  messageId: string;
  rumorId: string;
  content: string;
  timestamp: number;
  type: string;
  /** rumor id of the message this send is a reply to. Used to stamp
   *  `replyToMid` on the saved row so bubbles render the reply header. */
  replyToRumorId?: string;
}

interface ParsedGroupRumor {
  content: string;
  type: string;
  messageId: string;
  timestamp: number;
  /** Optional reply target — rumor id of the parent message. Populated
   *  when the sender included `replyToRumorId` in the payload. */
  replyToRumorId?: string;
  /** Encrypted-Blossom file payload when `type` is image/video/file/voice.
   *  Mirrors the 1-on-1 file rumor shape. */
  fileMetadata?: {
    url: string;
    sha256: string;
    keyHex: string;
    ivHex: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: string;
    servers?: string[];
  };
}

// Shared mapper — IndexedDB-backed (phantomchat-virtual-peers), so a single
// instance across calls is safe and avoids redundant reads.
let _mapper: PhantomChatPeerMapper | null = null;
function getMapper(): PhantomChatPeerMapper {
  if(!_mapper) _mapper = new PhantomChatPeerMapper();
  return _mapper;
}

function parseGroupRumorContent(raw: string): ParsedGroupRumor | null {
  try {
    const parsed = JSON.parse(raw);
    if(typeof parsed !== 'object' || parsed === null) return null;
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const type = typeof parsed.type === 'string' ? parsed.type : 'text';
    const messageId = typeof parsed.id === 'string' ? parsed.id : '';
    const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
    const replyToRumorId = typeof parsed.replyToRumorId === 'string' && parsed.replyToRumorId.length === 64 ?
      parsed.replyToRumorId :
      undefined;
    let fileMetadata: ParsedGroupRumor['fileMetadata'] | undefined;
    if(parsed.fileMetadata && typeof parsed.fileMetadata === 'object') {
      const fm = parsed.fileMetadata;
      if(typeof fm.url === 'string' && typeof fm.sha256 === 'string' &&
         typeof fm.keyHex === 'string' && typeof fm.ivHex === 'string' &&
         typeof fm.mimeType === 'string' && typeof fm.size === 'number') {
        const servers = Array.isArray(fm.servers) ?
          fm.servers.filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http')) :
          undefined;
        fileMetadata = {
          url: fm.url,
          sha256: fm.sha256,
          keyHex: fm.keyHex,
          ivHex: fm.ivHex,
          mimeType: fm.mimeType,
          size: fm.size,
          ...(typeof fm.width === 'number' ? {width: fm.width} : {}),
          ...(typeof fm.height === 'number' ? {height: fm.height} : {}),
          ...(typeof fm.duration === 'number' ? {duration: fm.duration} : {}),
          ...(typeof fm.waveform === 'string' ? {waveform: fm.waveform} : {}),
          ...(servers && servers.length ? {servers} : {})
        };
      }
    }
    if(!messageId) return null;
    return {content, type, messageId, timestamp, replyToRumorId, fileMetadata};
  } catch{
    return null;
  }
}

async function injectGroupMessageIntoMirrors(
  groupPeerId: number,
  msg: any
): Promise<void> {
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  if(proxy?.mirrors?.messages) {
    const storageKey = `${groupPeerId}_history`;
    if(!proxy.mirrors.messages[storageKey]) proxy.mirrors.messages[storageKey] = {};
    proxy.mirrors.messages[storageKey][msg.mid || msg.id] = msg;
  }

  try {
    const storageKey = `${groupPeerId}_history` as any;
    await rootScope.managers.appMessagesManager.setMessageToStorage(storageKey, msg);
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'setMessageToStorage non-critical:', e?.message);
  }
}

async function invalidateGroupHistoryCache(groupPeerId: number): Promise<void> {
  try {
    await rootScope.managers.appMessagesManager.invalidateHistoryCache(groupPeerId);
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'invalidateHistoryCache non-critical:', e?.message);
  }
}

function dispatchGroupHistoryAppend(groupPeerId: number, msg: any): void {
  try {
    rootScope.dispatchEvent('history_append' as any, {
      storageKey: `${groupPeerId}_history`,
      message: msg,
      peerId: groupPeerId
    });
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'history_append dispatch non-critical:', e?.message);
  }
}

function dispatchGroupDialogUpdate(groupPeerId: number, dialog: any): void {
  const toPeerId = (Number.prototype as any).toPeerId;
  const asPeerId = toPeerId ? (groupPeerId as any).toPeerId(true) : groupPeerId;
  // The typed envelope for `dialogs_multiupdate` is
  //   Map<PeerId, {dialog?: Dialog, topics?, saved?}>
  // — earlier we wrapped the dialog bare (`new Map([[peerId, dialog]])`),
  // which made the chat-list listener read `payload.dialog === undefined`
  // and silently skip the entry (FIND-3f07bfd3 γ — mirror was set but no
  // DOM row ever appeared). Wrap in `{dialog}` so the adapter picks it up.
  const envelope = {dialog};
  const dispatchOnce = () => {
    try {
      rootScope.dispatchEvent('dialogs_multiupdate' as any, new Map([[asPeerId, envelope]]) as any);
    } catch(e: any) {
      console.debug(LOG_PREFIX, 'dialogs_multiupdate dispatch non-critical:', e?.message);
    }
  };
  // Two-dispatch rule (see CLAUDE.md): first dispatch adds via sortedList.add,
  // second hits the existing-dialog branch and renders the preview text.
  dispatchOnce();
  setTimeout(dispatchOnce, 500);
}

/**
 * Ensure the group is materialised as a tweb Chat in the main-thread
 * `mirrors.chats` map and in the Worker-side `appChatsManager.chats[]`.
 * tweb's `setPeer({peerId: -chatId})` reads both to resolve the chat title
 * + avatar; without the entries the bubble container never mounts even
 * though the message is in `mirrors.messages[]`.
 *
 * Idempotent — safe to call on every send/receive.
 */
export async function ensureGroupChatInjected(
  groupId: string,
  groupPeerId: number
): Promise<void> {
  const chatId = Math.abs(groupPeerId);
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  const alreadyMirrored = !!proxy?.mirrors?.chats?.[chatId];

  // Pull canonical group state so the chat title + member count match the
  // store. If the store read fails (HMR race, etc.), fall back to a minimal
  // entry — still enough for setPeer to mount.
  let groupName = 'Group';
  let memberCount = 1;
  let createdAt = Math.floor(Date.now() / 1000);
  try {
    const rec = await getGroupStore().get(groupId);
    if(rec) {
      groupName = rec.name || groupName;
      memberCount = Array.isArray(rec.members) ? rec.members.length : memberCount;
      createdAt = Math.floor((rec.createdAt || Date.now()) / 1000);
    }
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'ensureGroupChatInjected: group store read failed:', e?.message);
  }

  const mapper = getMapper();
  const chat = mapper.createTwebChat({
    chatId,
    title: groupName,
    membersCount: memberCount,
    date: createdAt
  });

  if(proxy?.mirrors) {
    if(!proxy.mirrors.chats) proxy.mirrors.chats = {};
    proxy.mirrors.chats[chatId] = chat;
  }

  try {
    // saveApiChat seeds Worker-side appChatsManager.chats[] so peer lookups
    // + avatar derivation succeed on the Worker side too.
    await rootScope.managers.appChatsManager.saveApiChat(chat as any);
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'ensureGroupChatInjected: saveApiChat non-critical:', e?.message);
  }

  if(!alreadyMirrored) {
    // Notify stores so <ChatList> and <TopBar> observe the new chat title.
    try {
      const {reconcilePeer} = await import('@stores/peers');
      const asPeerId = (chat as any).id ? (-chatId) as unknown as any : groupPeerId;
      reconcilePeer(asPeerId, chat as any);
    } catch(e: any) {
      console.debug(LOG_PREFIX, 'ensureGroupChatInjected: reconcilePeer non-critical:', e?.message);
    }
  }

  // Force a topbar refresh whenever this runs — tweb's chat-info template
  // subscribes to `peer_title_edit` for late updates. Without this, the
  // topbar stays frozen on the previous peer's title after a setPeer
  // transition (FIND-3f07bfd3 β). Idempotent — dispatching when no title
  // changed is a no-op for downstream renderers.
  try {
    const asPeerId = (groupPeerId as any).toPeerId ?
      (groupPeerId as any).toPeerId(true) :
      groupPeerId;
    rootScope.dispatchEvent('peer_title_edit' as any, {peerId: asPeerId} as any);
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'ensureGroupChatInjected: peer_title_edit dispatch non-critical:', e?.message);
  }
}

/**
 * Render-side counterpart to `writeGroupCreateServiceMessage`: materialise
 * the group in main-thread mirrors (so `getPeer(-chatId)` resolves) and
 * dispatch `dialogs_multiupdate` TWICE so the chat list gains a row with
 * a valid `top_message` pointing at the service "group created" row.
 *
 * Called at group-creation time on BOTH sides (creator in `createGroup`,
 * receivers in `handleGroupCreate`). Without this, the group appears in
 * the chat list only after the first real message is sent or received.
 *
 * Idempotent — `ensureGroupChatInjected` + `dialogs_multiupdate` are both
 * upsert-shaped.
 */
export async function injectGroupCreateDialog(
  groupId: string,
  serviceMid: number,
  timestampSec: number
): Promise<void> {
  let groupPeerId: number;
  try {
    groupPeerId = await groupIdToPeerId(groupId);
  } catch(err) {
    console.warn(LOG_PREFIX, 'create-dialog: groupIdToPeerId failed; skipping', {groupId, err});
    return;
  }

  await ensureGroupChatInjected(groupId, groupPeerId);

  const mapper = getMapper();
  const dialog = mapper.createTwebDialog({
    peerId: groupPeerId,
    topMessage: serviceMid,
    topMessageDate: timestampSec,
    unreadCount: 0,
    // Read markers must equal top_message when unread is 0; otherwise tweb's
    // getDialogs flags this dialog as "noIdsDialogs" and spams reloadConversation.
    readInboxMaxId: serviceMid,
    readOutboxMaxId: serviceMid
  });

  // Write the dialog into the main-thread mirror BEFORE dispatching the
  // multiupdate so the chat-list adapter resolving by `mirrors.dialogs[
  // peerId]` finds a record on the same tick. Without this, receiving
  // members had the group in `mirrors.chats` + `mirrors.peers` but NOT in
  // `mirrors.dialogs`, so the chat-list row only appeared after the first
  // real history_append from the sender (FIND-e60cef56 carry-forward).
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  if(proxy?.mirrors) {
    if(!proxy.mirrors.dialogs) proxy.mirrors.dialogs = {};
    proxy.mirrors.dialogs[groupPeerId] = dialog;
  }

  dispatchGroupDialogUpdate(groupPeerId, dialog);
}

/**
 * Symmetric cleanup for `ensureGroupChatInjected` — invoked when this user
 * leaves or is removed from a group. Without this, `GroupAPI.leaveGroup` /
 * `handleRemoveMember` delete the group record from `group-store` but leave
 * the Chat entry behind in `apiManagerProxy.mirrors.peers` and
 * `mirrors.chats`. That orphan is what INV-group-no-orphan-mirror-peer
 * detects: a group peerId present in `mirrors.peers` with no backing
 * `group-store` record.
 *
 * Keeping the orphan around also causes UX drift: the chat list resolver
 * still sees a valid Chat object for the peer and the "left" group can
 * briefly re-render on chat-list refresh until the user reloads. Symmetric
 * cleanup makes leave idempotent with create.
 *
 * Idempotent — safe to call even when no injection was ever performed.
 */
export async function cleanupGroupChatInjection(groupPeerId: number): Promise<void> {
  const chatId = Math.abs(groupPeerId);
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  if(proxy?.mirrors?.peers) delete proxy.mirrors.peers[groupPeerId];
  if(proxy?.mirrors?.chats) delete proxy.mirrors.chats[chatId];
  // FIND-01e78a01 #2: previously only `peers` + `chats` were cleared. The
  // dialog entry survived in `mirrors.dialogs`, so a subsequent
  // `setInnerPeer({peerId: leftGroupPeerId})` happily resolved to the stale
  // dialog and rendered the chat container back into view — combined with
  // FIND-01e78a01 #1 (send-side membership gate) that was the exploit
  // path. Clear the dialog mirror symmetrically.
  if(proxy?.mirrors?.dialogs) delete proxy.mirrors.dialogs[groupPeerId];
}

/**
 * Render + persist an incoming group message. Called by
 * `GroupAPI.handleIncomingGroupMessage` after dedup.
 */
export async function handleGroupIncoming(
  ownPubkey: string,
  groupId: string,
  rumor: any,
  senderPubkey: string,
  dispatch: GroupDispatchFn
): Promise<void> {
  const mapper = getMapper();
  const store = getMessageStore();

  const parsed = parseGroupRumorContent(rumor.content);
  if(!parsed) {
    console.warn(LOG_PREFIX, 'rx: rumor content unparseable; dropping', {groupId, rumorId: rumor?.id});
    return;
  }
  const {content, type, messageId, timestamp: appTsMs, replyToRumorId, fileMetadata} = parsed;
  const rumorId: string = rumor.id;
  const timestampSec = typeof rumor.created_at === 'number' ?
    rumor.created_at :
    Math.floor((appTsMs || Date.now()) / 1000);

  // Resurrection guard (live path). The history-rebuild path in
  // virtual-mtproto-server already refuses to revive a tombstoned group, but
  // relays re-deliver group rumors (kind-1059 gift-wraps, 24h TTL) on every
  // reconnect — and THIS live-receive path rendered them unconditionally,
  // re-creating a group the user had just deleted (the "zombie HQ"). Gate it
  // the same way the 1:1 receive path does: if the group conversation carries a
  // deletion tombstone and this rumor is not strictly newer than the deletion
  // watermark, drop it before any saveMessage/inject/dispatch. A genuinely new
  // message (sent after the delete) is still allowed through and revives the
  // group, matching Signal-style delete semantics. The store-level gate in
  // saveMessage is the backstop.
  try {
    const deletedAt = await store.getTombstone(`group:${groupId}`);
    if(deletedAt > 0 && timestampSec <= deletedAt) {
      console.log(LOG_PREFIX, 'rx: dropping tombstoned group rumor', {
        groupId: groupId.slice(0, 8),
        timestampSec,
        deletedAt
      });
      return;
    }
  } catch(err) {
    console.warn(LOG_PREFIX, 'rx: tombstone gate check failed; continuing', {err});
  }

  let groupPeerId: number;
  try {
    groupPeerId = await groupIdToPeerId(groupId);
  } catch(err) {
    console.warn(LOG_PREFIX, 'rx: groupIdToPeerId failed; dropping', {groupId, err});
    return;
  }

  // Ensure the Chat entry exists before any bubble/dialog dispatch — without
  // this, tweb's peer resolution returns undefined and the chat never mounts.
  await ensureGroupChatInjected(groupId, groupPeerId);

  const mid = await mapper.mapEventId(rumorId, timestampSec);
  const senderPeerId = await mapper.mapPubkey(senderPubkey);

  // Own-pubkey echoes from the relay subscription must keep
  // `isOutgoing: true` — otherwise the upsert merge in message-store
  // overwrites the prior write from `handleGroupOutgoing` and the bubble
  // flips to the left after reload (the in-memory `sentMessageIds` dedup
  // resets on each boot, so post-reload re-subscriptions re-deliver own
  // events). Mirrors the DM design: same-device echo is a no-op merge,
  // cross-device own message persists as outgoing.
  const isOutgoing = senderPubkey === ownPubkey;

  // Without a User entry for the sender, getPeer(senderPeerId) returns
  // undefined and the bubble title falls back to "Deleted Account"
  // (getPeerTitle.ts + lang.ts 'HiddenName'). Idempotent — re-run is cheap.
  try {
    await ensureSenderUserInjected({
      senderPubkey,
      peerId: senderPeerId,
      logPrefix: LOG_PREFIX + ' rx'
    });
  } catch(err) {
    console.warn(LOG_PREFIX, 'rx: ensureSenderUserInjected failed; continuing', {err});
  }

  // Resolve reply target — `replyToRumorId` in the payload points at the
  // parent's rumor id (= the parent's `eventId` in our message-store). We
  // map it to the parent's `mid` so bubbles render the reply preview header
  // exactly the way DM replies do (NIP-10 `['e', ...]` path). Falls
  // through to undefined if the parent isn't in our store yet — out-of-order
  // delivery just shows a plain bubble in that case.
  let replyToMid: number | undefined;
  if(replyToRumorId) {
    try {
      const parent = await store.getByEventId(replyToRumorId);
      if(parent?.mid) replyToMid = parent.mid;
    } catch(err) {
      console.debug(LOG_PREFIX, 'rx: replyTo lookup failed; bubble will render without reply header:', (err as any)?.message);
    }
  }

  try {
    await store.saveMessage({
      eventId: rumorId,
      appMessageId: messageId,
      conversationId: `group:${groupId}`,
      senderPubkey,
      content,
      type: type === 'text' ? 'text' : 'file',
      timestamp: timestampSec,
      deliveryState: isOutgoing ? 'sent' : 'delivered',
      mid,
      twebPeerId: groupPeerId,
      isOutgoing,
      ...(replyToMid !== undefined ? {replyToMid} : {}),
      ...(fileMetadata ? {fileMetadata} : {})
    });
  } catch(err) {
    console.warn(LOG_PREFIX, 'rx: saveMessage failed; continuing', {err});
  }

  // Build a tweb MessageMedia from the rumor's fileMetadata so the bubble
  // renders the image/video/file attachment. Shape matches the 1-on-1
  // path (buildPhantomChatMedia → messageMediaPhoto / messageMediaDocument with
  // a `phantomchatFileMetadata` sidecar that the download manager reads to
  // fetch+decrypt the encrypted Blossom blob on demand).
  // The group rumor carries the authoritative media class at the payload's
  // top level (`type`), not inside fileMetadata. Thread it onto the metadata
  // so buildPhantomChatMedia classifies voice notes correctly instead of
  // re-guessing from mime (mirrors the DM `mediaType` wire field).
  const mediaFm = fileMetadata && type !== 'text' ?
    {...fileMetadata, mediaType: (fileMetadata as any).mediaType ?? type} :
    fileMetadata;
  const media = mediaFm ? buildPhantomChatMedia(mid, mediaFm) : undefined;

  const msg = mapper.createTwebMessage({
    mid,
    peerId: groupPeerId,
    fromPeerId: senderPeerId,
    date: timestampSec,
    text: content,
    isOutgoing,
    ...(replyToMid !== undefined ? {replyToMid} : {}),
    ...(media ? {media} : {})
  });

  await injectGroupMessageIntoMirrors(groupPeerId, msg);
  await invalidateGroupHistoryCache(groupPeerId);
  dispatchGroupHistoryAppend(groupPeerId, msg);

  const dialog = mapper.createTwebDialog({
    peerId: groupPeerId,
    topMessage: mid,
    topMessageDate: timestampSec,
    unreadCount: 1,
    // Outbox cursor (= our own read state on members' messages) is consistent
    // with unreadCount=1: we have not read this incoming message yet, so leave
    // read_inbox_max_id at 0 isn't safe (after the user reads it tweb wipes
    // unread → noIdsDialogs branch fires). Set it to mid - 1 to model "all
    // prior messages read, this one pending". After the user opens the chat,
    // unread → 0 and the readInboxMaxId is bumped to mid by other paths.
    readInboxMaxId: mid > 0 ? mid - 1 : 0,
    readOutboxMaxId: mid
  });
  (dialog as any).topMessage = msg;
  dispatchGroupDialogUpdate(groupPeerId, dialog);

  console.log(LOG_PREFIX, 'rx rendered', {groupPeerId, mid, groupId: groupId.slice(0, 8)});
  dispatch('phantomchat_new_message', {
    peerId: groupPeerId,
    mid,
    senderPubkey,
    message: {id: messageId, content, type, from: senderPubkey, timestamp: timestampSec, groupId},
    timestamp: timestampSec
  });

  // Reference ownPubkey to silence unused-param warning — kept in signature
  // for future delivery-tracker wiring (mark sender-self-echoes read, etc).
  void ownPubkey;
}

// WU-2: apply an incoming/own group reaction. Mirrors applyGroupEdit's
// eventId→local-mid resolution, then persists to phantomchatReactionsStore and
// dispatches phantomchat_reactions_changed so every member's bubble re-renders.
export async function applyGroupReaction(
  groupId: string,
  targetEventId: string,
  emoji: string,
  fromPubkey: string,
  createdAtSec: number
): Promise<void> {
  if(!emoji) return;
  const store = getMessageStore();

  let existing: any = null;
  try {
    existing = await store.getByEventId(targetEventId);
  } catch{
    existing = null;
  }
  if(!existing) {
    console.warn(LOG_PREFIX, 'reaction: target eventId not found in store', {targetEventId});
    return;
  }
  if(existing.conversationId !== `group:${groupId}`) {
    console.warn(LOG_PREFIX, 'reaction: target belongs to different conversation', {expected: `group:${groupId}`, got: existing.conversationId});
    return;
  }

  let groupPeerId: number;
  try {
    groupPeerId = await groupIdToPeerId(groupId);
  } catch{
    return;
  }

  // Deterministic reactionEventId so a re-delivered control message is
  // idempotent (store.add is first-write-wins) and a future unreaction can
  // target the exact row.
  try {
    await phantomchatReactionsStore.add({
      targetEventId,
      targetMid: existing.mid,
      targetPeerId: groupPeerId,
      fromPubkey,
      emoji,
      reactionEventId: `grp:${targetEventId}:${fromPubkey}:${emoji}`,
      createdAt: createdAtSec
    });
  } catch(err) {
    console.warn(LOG_PREFIX, 'reaction: store add failed', err);
    return;
  }

  try {
    rootScope.dispatchEventSingle('phantomchat_reactions_changed' as any, {peerId: groupPeerId, mid: existing.mid});
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'reaction: dispatch non-critical:', e?.message);
  }
}

/**
 * Apply an incoming (or self-echoed) edit to a group message. Symmetric
 * to ChatAPI.editMessage's local update for DMs.
 *
 * Lookup is by `eventId = targetEventId` (the rumor id of the original
 * message). The sender must match the original message's sender — anyone
 * else editing is rejected to prevent impersonation.
 *
 * On success: updates the message-store row, the main-thread mirror,
 * and dispatches tweb's `message_edit` event so bubbles re-render.
 */
export async function applyGroupEdit(
  groupId: string,
  targetEventId: string,
  newText: string,
  editedAtSec: number,
  senderPubkey: string
): Promise<void> {
  const store = getMessageStore();

  let existing: any = null;
  try {
    existing = await store.getByEventId(targetEventId);
  } catch{
    existing = null;
  }
  if(!existing) {
    console.warn(LOG_PREFIX, 'edit: target eventId not found in store', {targetEventId});
    return;
  }

  if(existing.conversationId !== `group:${groupId}`) {
    console.warn(LOG_PREFIX, 'edit: target belongs to different conversation', {expected: `group:${groupId}`, got: existing.conversationId});
    return;
  }

  if(existing.senderPubkey !== senderPubkey) {
    console.warn(LOG_PREFIX, 'edit: refusing edit from non-author', {targetEventId, sender: senderPubkey.slice(0, 8), author: existing.senderPubkey.slice(0, 8)});
    return;
  }

  try {
    await store.saveMessage({
      ...existing,
      content: newText,
      editedAt: editedAtSec
    });
  } catch(err) {
    console.warn(LOG_PREFIX, 'edit: saveMessage failed', err);
  }

  let groupPeerId: number;
  try {
    groupPeerId = await groupIdToPeerId(groupId);
  } catch{
    return;
  }

  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  const storageKey = `${groupPeerId}_history`;
  const existingMirror = proxy?.mirrors?.messages?.[storageKey]?.[existing.mid];
  if(existingMirror) {
    existingMirror.message = newText;
    existingMirror.edit_date = editedAtSec;
  }

  try {
    rootScope.dispatchEvent('message_edit' as any, {
      storageKey,
      peerId: groupPeerId,
      mid: existing.mid,
      message: existingMirror || {mid: existing.mid, peerId: groupPeerId, message: newText, edit_date: editedAtSec}
    });
  } catch(e: any) {
    console.debug(LOG_PREFIX, 'edit: message_edit dispatch non-critical:', e?.message);
  }

  console.log(LOG_PREFIX, 'edit applied', {groupPeerId, mid: existing.mid, targetEventId: targetEventId.slice(0, 8)});
}

/**
 * Render + persist the sender-side optimistic bubble for an outgoing
 * group message. Called by `GroupAPI.sendMessage` immediately after
 * wrapping, before the relay publish completes.
 */
export async function handleGroupOutgoing(
  ownPubkey: string,
  info: GroupOutgoingInfo,
  dispatch: GroupDispatchFn
): Promise<void> {
  const mapper = getMapper();
  const store = getMessageStore();

  const {groupId, messageId, rumorId, content, timestamp, type, replyToRumorId} = info;
  const timestampSec = Math.floor((timestamp || Date.now()) / 1000);

  let groupPeerId: number;
  try {
    groupPeerId = await groupIdToPeerId(groupId);
  } catch(err) {
    console.warn(LOG_PREFIX, 'tx: groupIdToPeerId failed; skipping', {groupId, err});
    return;
  }

  // Ensure the Chat entry exists before any bubble/dialog dispatch — without
  // this, tweb's peer resolution returns undefined and the chat never mounts.
  await ensureGroupChatInjected(groupId, groupPeerId);

  let mid: number;
  try {
    mid = await mapper.mapEventId(rumorId, timestampSec);
  } catch(err) {
    console.warn(LOG_PREFIX, 'tx: mapEventId failed; skipping', {err});
    return;
  }

  // Resolve reply target — same logic as the rx path so the sender's
  // optimistic bubble already has the right reply header at first paint.
  let replyToMid: number | undefined;
  if(replyToRumorId) {
    try {
      const parent = await store.getByEventId(replyToRumorId);
      if(parent?.mid) replyToMid = parent.mid;
    } catch(err) {
      console.debug(LOG_PREFIX, 'tx: replyTo lookup failed; bubble will render without reply header:', (err as any)?.message);
    }
  }

  try {
    await store.saveMessage({
      eventId: rumorId,
      appMessageId: messageId,
      conversationId: `group:${groupId}`,
      senderPubkey: ownPubkey,
      content,
      type: type === 'text' ? 'text' : 'file',
      timestamp: timestampSec,
      deliveryState: 'sent',
      mid,
      twebPeerId: groupPeerId,
      isOutgoing: true,
      ...(replyToMid !== undefined ? {replyToMid} : {})
    });
  } catch(err) {
    console.warn(LOG_PREFIX, 'tx: saveMessage failed; continuing', {err});
  }

  // Resolve own peerId so the bubble + dialog preview attribute the
  // message to the user instead of falling back to the group peer
  // (which would render "<group name>: text" in the chat list).
  let ownPeerId: number | undefined;
  try {
    ownPeerId = await mapper.mapPubkey(ownPubkey);
    await ensureSenderUserInjected({
      senderPubkey: ownPubkey,
      peerId: ownPeerId,
      logPrefix: LOG_PREFIX + ' tx-self'
    });
  } catch(err) {
    console.warn(LOG_PREFIX, 'tx: ensureSenderUserInjected (self) failed; continuing', {err});
  }

  const msg = mapper.createTwebMessage({
    mid,
    peerId: groupPeerId,
    fromPeerId: ownPeerId,
    date: timestampSec,
    text: content,
    isOutgoing: true,
    ...(replyToMid !== undefined ? {replyToMid} : {})
  });

  await injectGroupMessageIntoMirrors(groupPeerId, msg);
  await invalidateGroupHistoryCache(groupPeerId);
  dispatchGroupHistoryAppend(groupPeerId, msg);

  const dialog = mapper.createTwebDialog({
    peerId: groupPeerId,
    topMessage: mid,
    topMessageDate: timestampSec,
    unreadCount: 0,
    // Outgoing send: nothing unread. Without read markers tweb spams
    // reloadConversation for this dialog every getDialogs pass.
    readInboxMaxId: mid,
    readOutboxMaxId: mid
  });
  (dialog as any).topMessage = msg;
  dispatchGroupDialogUpdate(groupPeerId, dialog);

  console.log(LOG_PREFIX, 'tx rendered', {groupPeerId, mid, groupId: groupId.slice(0, 8)});
  dispatch('phantomchat_new_message', {
    peerId: groupPeerId,
    mid,
    senderPubkey: ownPubkey,
    message: {id: messageId, content, type, from: ownPubkey, timestamp: timestampSec, groupId},
    timestamp: timestampSec
  });
}
