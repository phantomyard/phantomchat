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
import {groupIdToPeerId, isSessionPeer} from './group-types';
import {intendedGroupKind} from './group-class-reconcile';
import type {GroupKind, GroupHistoryItem} from './group-types';
import {FOLDER_ID_ARCHIVE, FOLDER_ID_GROUPS, FOLDER_ID_SESSION} from '@appManagers/constants';
import getDialogIndexKey from '@appManagers/utils/dialogs/getDialogIndexKey';
import {getGroupStore} from './group-store';
import {ensureSenderUserInjected} from './ensure-sender-user-injected';
import {buildPhantomChatMedia} from './phantomchat-media-shape';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';
import {isConversationSelected} from '@lib/phantomchat/selected-conversation';
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

/**
 * The delayed half of the two-dispatch rule, per peer. It replays a SNAPSHOT, so
 * if the row was archived, moved to another peer id or deleted inside the 500ms
 * window, replaying it puts the old row back into the list it just left.
 */
const pendingGroupDialogRepaints = new Map<number, ReturnType<typeof setTimeout>>();

function cancelPendingGroupDialogRepaint(groupPeerId: number): void {
  const pending = pendingGroupDialogRepaints.get(groupPeerId);
  if(pending === undefined) return;
  clearTimeout(pending);
  pendingGroupDialogRepaints.delete(groupPeerId);
}

function dispatchGroupDialogUpdate(groupPeerId: number, dialog: any): void {
  const toPeerId = (Number.prototype as any).toPeerId;
  const asPeerId = toPeerId ? (groupPeerId as any).toPeerId(true) : groupPeerId;
  // Carry the user-set dialog flags forward (owner batch 15). The tx/rx paths
  // build a FRESH dialog per message, so without this the pin badge and the
  // manual unread dot would vanish the moment the next message lands — a pin
  // that survives exactly until the group is next active is worse than none.
  // Read from the in-memory mirror (no IDB on the message path) and copy the
  // flags the record stamped there; `applyGroupDialogFlags` is the writer.
  const mirrored = (MOUNT_CLASS_TO.apiManagerProxy as any)?.mirrors?.dialogs?.[groupPeerId];
  if(dialog && mirrored) {
    applyGroupDialogFlagsToDialog(dialog, {
      pinnedAt: mirrored.pFlags?.pinned ? 1 : 0,
      unreadMarkAt: mirrored.pFlags?.unread_mark ? 1 : 0
    });
    if(mirrored.folder_id) dialog.folder_id = mirrored.folder_id;
  }
  // The typed envelope for `dialogs_multiupdate` is
  //   Map<PeerId, {dialog?: Dialog, topics?, saved?}>
  // — earlier we wrapped the dialog bare (`new Map([[peerId, dialog]])`),
  // which made the chat-list listener read `payload.dialog === undefined`
  // and silently skip the entry (FIND-3f07bfd3 γ — mirror was set but no
  // DOM row ever appeared). Wrap in `{dialog}` so the adapter picks it up.
  const envelope = {dialog};
  // A newer update for this peer supersedes the delayed repaint of the older one.
  cancelPendingGroupDialogRepaint(groupPeerId);
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
  pendingGroupDialogRepaints.set(groupPeerId, setTimeout(() => {
    pendingGroupDialogRepaints.delete(groupPeerId);
    dispatchOnce();
  }, 500));
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
 * Resolve a group's peer id from its store record.
 *
 * The peerId is a function of (groupId, kind), so it CANNOT be derived from the
 * id alone any more: a session would resolve to a classic group's peerId and
 * every mirror keyed by peerId would point at a different conversation. Records
 * are the source of truth for the class; an absent record (teardown in flight)
 * falls back to the classic derivation.
 */
/**
 * groupId -> kind, filled on every store read below.
 *
 * `resolveGroupPeerId` is on the message hot path — inbound, outgoing, edits,
 * reactions, typing ticks — and a record's `kind` never changes, so an
 * IndexedDB transaction per message was pure overhead. The store stays the
 * fallback on a miss (and is still the source of truth).
 */
const kindByGroupId = new Map<string, GroupKind>();

export async function resolveGroupPeerId(groupId: string): Promise<number> {
  let kind = kindByGroupId.get(groupId);
  if(!kind) {
    try {
      const record = await getGroupStore().get(groupId);
      if(record) {
        kind = intendedGroupKind(record);
        kindByGroupId.set(groupId, kind);
      }
    } catch{
      // store unavailable — use the classic class
    }
  }
  return groupIdToPeerId(groupId, kind ?? 'group');
}

/**
 * Overwrite the hot-path class cache for one group.
 *
 * The class reconcile (group-class-reconcile.ts) repairs records whose stored
 * peerId was derived from the wrong class. Without this, `resolveGroupPeerId`
 * keeps answering from the value it cached BEFORE the repair, so inbound and
 * outbound group traffic would keep landing on the old peer id until a reload.
 */
export function primeGroupKindCache(groupId: string, kind: GroupKind): void {
  kindByGroupId.set(groupId, kind);
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
  timestampSec: number,
  record?: {kind?: GroupKind, archivedAt?: number, pinnedAt?: number, unreadMarkAt?: number}
): Promise<void> {
  let groupPeerId: number;
  try {
    // The caller holds the record here; seed the hot-path cache from it so the
    // create path does not pay for the read resolveGroupPeerId would otherwise
    // fall back to.
    if(record?.kind) kindByGroupId.set(groupId, record.kind);
    groupPeerId = await resolveGroupPeerId(groupId);
  } catch(err) {
    console.warn(LOG_PREFIX, 'create-dialog: groupIdToPeerId failed; skipping', {groupId, err});
    return;
  }

  await ensureGroupChatInjected(groupId, groupPeerId);

  // The dialog's folder index key follows the peer CLASS (the mapper reads it
  // off the peerId range), and an archived session is created straight into the
  // chat archive's folder_id so it lands in the Session Archive. The caller
  // holds the record — re-reading the store here would race the IndexedDB write
  // on the create path.
  const mapper = getMapper();
  const dialog = mapper.createTwebDialog({
    peerId: groupPeerId,
    topMessage: serviceMid,
    topMessageDate: timestampSec,
    unreadCount: 0,
    archived: !!record?.archivedAt,
    pinned: !!record?.pinnedAt,
    unreadMark: !!record?.unreadMarkAt,
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
 * Stamp the USER-SET dialog flags a group record carries onto a dialog row
 * (owner batch 15). Pure, so the mapping is testable without booting sync.
 *
 * Pin and mark-unread are `pFlags.pinned` / `pFlags.unread_mark` — the exact
 * flags a chat uses — because every reader downstream (chat-list badge, pinned
 * ordering, selection badge suppression) already tests those. Clearing uses
 * `delete`, not `= false`: tweb's readers test `!!dialog.pFlags?.pinned`, but a
 * lingering `false` would come back as a truthy OBJECT key in some serializers
 * and the built-in "unpinned" path (`handleDialogUnpinning`) deletes for the
 * same reason.
 */
export function applyGroupDialogFlagsToDialog(
  dialog: any,
  record: {pinnedAt?: number, unreadMarkAt?: number}
): void {
  if(!dialog) return;
  dialog.pFlags ??= {};
  if(record.pinnedAt) dialog.pFlags.pinned = true;
  else delete dialog.pFlags.pinned;
  if(record.unreadMarkAt) dialog.pFlags.unread_mark = true;
  else delete dialog.pFlags.unread_mark;
}

/**
 * Live-UI half of a pin / mark-unread toggle for a group (owner batch 15).
 *
 * The flag itself lives on the RECORD (`pinnedAt` / `unreadMarkAt`, synced over
 * the groups CRDT); this stamps the existing dialog row, keeps the folder's
 * pinned order in step, and asks dialogs storage to reindex, so the badge appears
 * and the row sorts into the pinned block without a reload. A reload converges
 * too — `getDialogs` builds every group dialog from its record.
 *
 * Deliberately mirrors `applyGroupDialogFolder`: same mirror-then-live-read, the
 * same `pushDialog` (which re-runs processDialogForFilters → pinned index), the
 * same dispatch so the row repaints.
 */
export async function applyGroupDialogFlags(
  record: {groupId: string, kind?: GroupKind, archivedAt?: number, pinnedAt?: number, unreadMarkAt?: number}
): Promise<void> {
  const groupPeerId = await resolveGroupPeerId(record.groupId);
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  const mirrored = proxy?.mirrors?.dialogs?.[groupPeerId];
  if(mirrored) applyGroupDialogFlagsToDialog(mirrored, record);

  let dialog: any = mirrored;
  try {
    const dialogsStorage = (rootScope as any).managers.dialogsStorage;
    if(!dialogsStorage?.getDialog || !dialogsStorage?.pushDialog) {
      console.warn(LOG_PREFIX, 'applyGroupDialogFlags: dialogsStorage hooks missing — live toggle skipped');
    }
    const entry = await dialogsStorage.getDialog?.(groupPeerId);
    const live = Array.isArray(entry) ? entry[0] : entry;
    if(live) dialog = live;
    if(dialog) {
      applyGroupDialogFlagsToDialog(dialog, record);

      // The pinned ORDER, not just the flag: see setPinnedOrderEntry. The folder
      // is the one the row lives in — archive is a plain folder_id, a session
      // lives in Sessions, everything else in Groups.
      const folderId = record.archivedAt ?
        FOLDER_ID_ARCHIVE :
        (isSessionPeer(groupPeerId) ? FOLDER_ID_SESSION : FOLDER_ID_GROUPS);
      try {
        // Managers cross a MessagePort: mutating getPinnedOrders() would
        // mutate a cloned array (and without await, a Promise). Own the
        // mutation inside the Worker before reindexing its dialog.
        await dialogsStorage.setDialogPinnedOrder(groupPeerId, folderId, !!record.pinnedAt);
      } catch(err: any) {
        console.debug(LOG_PREFIX, 'applyGroupDialogFlags: pinned order non-critical:', err?.message);
      }

      // pushDialog re-runs processDialogForFilters, which is what moves the row
      // into (or out of) the pinned block: the pinned index is derived from the
      // folder's pinned order for a REAL_FOLDER, which is what Groups is.
      //
      // `offsetDate: 0`: see relocateGroupDialog. Without it pushDialog falls
      // back to the top message's date, and for a row that is not pinned that
      // date is older than the folder's saved offset — so an unloaded Archive
      // (or a not-yet-loaded Groups folder) makes it DROP the persisted row and
      // return before setDialogToState. A flag-only change must never move a row
      // or lose it; the flag itself has already been applied to the record.
      await dialogsStorage.pushDialog?.({dialog, offsetDate: 0});
      // A flag-only push can retain the same sort index. Refresh unread sets
      // explicitly so Groups, Sessions and custom-folder badges update now.
      await dialogsStorage.processChangedUnreadOrUnmuted?.(groupPeerId);

      // Dispatch the row the WORKER reindexed, not the copy read before the
      // push: on a pin -> unpin the copy still carries the pinned sort index,
      // and the list keys membership and position on that index, so it kept the
      // row in the pinned block with the badge already gone (owner bug
      // 2026-11-01). No `dropFolderIdsOnFailure` here — a flag change never
      // moves the row out of its space, so clearing its folder index would
      // evict a live row.
      dialog = await rereadReindexedGroupDialog(groupPeerId, dialog);
    }
  } catch(err: any) {
    console.debug(LOG_PREFIX, 'applyGroupDialogFlags: reindex non-critical:', err?.message);
  }

  if(dialog) dispatchGroupDialogUpdate(groupPeerId, dialog);
}

/**
 * The row the LIVE chat list has to be handed after `pushDialog`.
 *
 * `dialogsStorage` here is the main-thread proxy: every call crosses the
 * MessagePort, so the dialog handed to `pushDialog` is CLONED on its way to
 * the worker. The per-folder index recompute that decides membership and sort
 * position happens on the WORKER's copy — the object we still hold keeps the
 * index it was read with. That is why an archived group/session used to stay on
 * screen in Sessions / Groups until the space was rebuilt by navigating away and
 * back: `AutonomousDialogList.testDialogForFilter` tests membership for those
 * spaces on `index_4` / `index_3`, and the dispatched copy still carried it, so
 * the list repainted the row as a genuine member instead of evicting it. The
 * same shape bit pin -> unpin (owner bug 2026-11-01): the dispatch carried the
 * PINNED index, so the list kept the row in the pinned block after the badge
 * was already gone.
 *
 * So read back the row the worker now holds and dispatch THAT — it carries the
 * indices storage actually computed, in every direction (archive drops
 * `index_4` / `index_3`, unarchive re-stamps them, unpin drops the pinned
 * index).
 *
 * `dropFolderIdsOnFailure` is one-directional on purpose, and only the archive
 * move passes it. The row read at the top of that function is the LIVE one, so
 * it carries `index_0` and no `index_3` / `index_4`: clearing the live-folder
 * keys therefore makes an unreachable re-read safe when ARCHIVING (the row
 * leaves the space), and leaves an unarchived row out of Sessions / Groups
 * until the space is rebuilt — the acceptable direction to lose, since the row
 * is still there and reachable. A flag change must NOT clear anything: the row
 * stays in its space, so the caller passes no folders.
 */
async function rereadReindexedGroupDialog(
  groupPeerId: number,
  fallback: any,
  dropFolderIdsOnFailure: number[] = []
): Promise<any> {
  let fresh: any;
  try {
    const reread = await (rootScope as any).managers.dialogsStorage?.getDialog?.(groupPeerId);
    fresh = Array.isArray(reread) ? reread[0] : reread;
  } catch(err: any) {
    console.debug(LOG_PREFIX, 're-read non-critical:', err?.message);
  }

  if(!fresh) {
    for(const folderId of dropFolderIdsOnFailure) {
      delete fallback[getDialogIndexKey(folderId as any)];
    }

    return fallback;
  }

  // A live dispatch must leave the mirror honest too, or the next message-path
  // repaint would hand the list a row claiming its old folder indices.
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  if(proxy?.mirrors?.dialogs) proxy.mirrors.dialogs[groupPeerId] = fresh;
  return fresh;
}

/**
 * Move a group's dialog between the live space and the archive (owner batch 12).
 *
 * Archive state is the RECORD's `archivedAt` (it syncs over the groups CRDT);
 * the dialog mirrors it as `folder_id` (1 = archived), which is the flag tweb's
 * folder machinery already understands — the same flag a chat uses. This
 * function is the live-UI half: it moves the existing dialog and asks dialogs
 * storage to recompute its per-folder indices, so the row leaves Groups /
 * Sessions and appears in Archives without a reload. A reload converges too —
 * `getDialogs` rebuilds every group dialog from its record.
 */
export async function applyGroupDialogFolder(record: {groupId: string, kind?: GroupKind, archivedAt?: number}): Promise<void> {
  const groupPeerId = await resolveGroupPeerId(record.groupId);
  const folderId = record.archivedAt ? 1 : 0;

  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  const mirrored = proxy?.mirrors?.dialogs?.[groupPeerId];
  if(mirrored) mirrored.folder_id = folderId;

  let dialog = mirrored;
  try {
    const dialogsStorage = (rootScope as any).managers.dialogsStorage;
    // These are looked up dynamically (`?.`) because this reaches into tweb's
    // dialogs storage through a cast. If either name changes, the live move
    // silently no-ops and only a reload converges — say so rather than looking
    // like "archive needs a restart".
    if(!dialogsStorage?.getDialog || !dialogsStorage?.pushDialog) {
      console.warn(LOG_PREFIX, 'applyGroupDialogFolder: dialogsStorage.getDialog/pushDialog missing — live move skipped');
    }
    const entry = await dialogsStorage.getDialog?.(groupPeerId);
    const live = Array.isArray(entry) ? entry[0] : entry;
    if(live) dialog = live;
    if(dialog) {
      dialog.folder_id = folderId;
      // pushDialog re-runs processDialogForFilters, which is what clears
      // index_3 / index_4 / index_1 (and the folder unread counts) for this row.
      // `offsetDate: 0`: see relocateGroupDialog. The Archive folder is often not
      // loaded yet, and that branch would drop the row it is moving there.
      await dialogsStorage.pushDialog?.({dialog, offsetDate: 0});
      dialog = await rereadReindexedGroupDialog(groupPeerId, dialog, [FOLDER_ID_GROUPS, FOLDER_ID_SESSION]);
    }
  } catch(err: any) {
    console.debug(LOG_PREFIX, 'applyGroupDialogFolder: reindex non-critical:', err?.message);
  }

  // An open chat pane cannot see the dialog move, and the composer must go away
  // (or come back) with it. Dispatched with a cast: rootScope's event map is
  // typed for tweb's own events, and this is a PhantomChat-internal one.
  (rootScope as any).dispatchEvent('dialog_folder_update', {peerId: groupPeerId, folderId});

  if(dialog) dispatchGroupDialogUpdate(groupPeerId, dialog);
}

/**
 * The dialog state a relocated row has to keep. Everything the user set or has
 * already seen lives ONLY on the dialog row, so it has to be read off the old
 * row before it is dropped and re-stamped onto the new one.
 *
 * Pure and exported so the read-marker rule is testable without booting the
 * sync module.
 */
export function carriedDialogState(previous: any, topMessage: number): {
  unreadCount: number,
  readInboxMaxId: number,
  readOutboxMaxId: number,
  pinned: boolean,
  unreadMark: boolean,
  muteUntil: number,
  unreadMentionsCount: number,
  unreadReactionsCount: number
} {
  const unreadCount = Number(previous?.unread_count) || 0;
  // Read markers must equal top_message when unread is 0, or tweb's getDialogs
  // flags the row as a noIdsDialog and spams reloadConversation. When unread is
  // NOT 0 the marker is real state and a genuine 0 (nothing read yet) has to
  // survive: `|| topMessage` would lift it to the top message, so the badge says
  // N unread while every row compares as read.
  const carried = (key: 'read_inbox_max_id' | 'read_outbox_max_id'): number => {
    if(!previous || unreadCount === 0) return topMessage;
    const value = Number(previous[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    unreadCount,
    readInboxMaxId: carried('read_inbox_max_id'),
    readOutboxMaxId: carried('read_outbox_max_id'),
    pinned: !!previous?.pFlags?.pinned,
    // The manual "mark unread" dot is user state too (owner batch 15): dropping
    // it on a class repair would silently clear a mark the user set.
    unreadMark: !!previous?.pFlags?.unread_mark,
    muteUntil: Number(previous?.notify_settings?.mute_until) || 0,
    unreadMentionsCount: Number(previous?.unread_mentions_count) || 0,
    unreadReactionsCount: Number(previous?.unread_reactions_count) || 0
  };
}

/**
 * Move an existing group/session dialog onto a DIFFERENT peer id.
 *
 * Only the class reconcile calls this. Folder membership is a pure range test
 * on the peer id (`isSessionPeer`), so a record whose stored peerId was derived
 * from the wrong class puts the row in the wrong space FOREVER — Groups claims
 * a session, Sessions stays empty. Re-deriving the record's peerId is not
 * enough on its own: the persisted dialog row, the chat/peer mirrors and the
 * history cache all key on the OLD id, so the stale row would keep rendering in
 * Groups while a second row appeared in Sessions. This re-materialises the row
 * under the new id, then drops the old row for real.
 *
 * Rejects only while the old row is still intact (or no row was moved), so a
 * rejection always means "the group is still where it was". Resolving means the
 * new row landed.
 *
 * Message rows are re-stamped by the caller (`setConversationTwebPeerId`) — the
 * conversation key is the group id, so nothing is lost by the move. Read
 * markers, unread count and the top message are carried across so the session
 * does not reappear as unread with an empty preview.
 */
export async function relocateGroupDialog(
  groupId: string,
  fromPeerId: number,
  toPeerId: number,
  record?: {kind?: GroupKind, archivedAt?: number, pinnedAt?: number, unreadMarkAt?: number}
): Promise<void> {
  const proxy = MOUNT_CLASS_TO.apiManagerProxy as any;
  const dialogsStorage = (rootScope as any).managers.dialogsStorage;
  if(!dialogsStorage?.pushDialog || !dialogsStorage?.getAnyDialog) {
    throw new Error('relocateGroupDialog: dialogsStorage hooks missing');
  }

  const readRow = async(peerId: number): Promise<any> => {
    const entry = await dialogsStorage.getAnyDialog(peerId);
    return (Array.isArray(entry) ? entry[0] : entry) ?? null;
  };

  // Read what the user sees NOW: the read markers live only on the dialog row.
  // A failed read rejects here, before anything has changed.
  const source = await readRow(fromPeerId) ?? proxy?.mirrors?.dialogs?.[fromPeerId] ?? null;
  const target = await readRow(toPeerId);

  // A retry after a failed record save (#296): the row already moved. Pushing it
  // again could only fail or lose state, and there is no old row left to fall
  // back on, so this path cannot reject. The record save decides the outcome.
  if(!source && target) {
    try {
      if(record?.kind) kindByGroupId.set(groupId, record.kind);
      await cleanupGroupChatInjection(fromPeerId);
      await ensureGroupChatInjected(groupId, toPeerId);
    } catch(e: any) {
      console.warn(LOG_PREFIX, 'relocateGroupDialog: retry refresh failed:', e?.message);
    }
    dispatchGroupDialogUpdate(toPeerId, target);
    return;
  }

  const previous = source ?? proxy?.mirrors?.dialogs?.[toPeerId] ?? null;
  const previousKind = kindByGroupId.get(groupId);
  const previousTargetMirror = proxy?.mirrors?.dialogs?.[toPeerId];

  // Make before break: the new row must land before the old one is touched, so a
  // failure at any step here leaves the old row intact for the caller to return to.
  let dialog: any;
  try {
    if(record?.kind) kindByGroupId.set(groupId, record.kind);
    await ensureGroupChatInjected(groupId, toPeerId);

    const topMessage = Number(previous?.top_message) || 0;
    const sortIndex = Number(previous?.index_0) || 0;
    const carried = carriedDialogState(previous, topMessage);
    dialog = getMapper().createTwebDialog({
      peerId: toPeerId,
      topMessage,
      // index_0 is the sort index — seconds * 0x10000 (see createTwebDialog).
      topMessageDate: sortIndex ? Math.floor(sortIndex / 0x10000) : Math.floor(Date.now() / 1000),
      unreadCount: carried.unreadCount,
      readInboxMaxId: carried.readInboxMaxId,
      readOutboxMaxId: carried.readOutboxMaxId,
      archived: !!record?.archivedAt
    });
    // State createTwebDialog does not take as an option, but which the user set:
    // without it a pinned session falls out of the pinned list and a muted one
    // starts notifying again after the repair.
    if(carried.pinned) (dialog as any).pFlags.pinned = 1;
    if(carried.unreadMark) (dialog as any).pFlags.unread_mark = true;
    if(carried.muteUntil > 0) (dialog as any).notify_settings.mute_until = carried.muteUntil;
    if(carried.unreadMentionsCount > 0) (dialog as any).unread_mentions_count = carried.unreadMentionsCount;
    if(carried.unreadReactionsCount > 0) (dialog as any).unread_reactions_count = carried.unreadReactionsCount;

    if(proxy?.mirrors) {
      if(!proxy.mirrors.dialogs) proxy.mirrors.dialogs = {};
      proxy.mirrors.dialogs[toPeerId] = dialog;
    }
    // pushDialog re-runs processDialogForFilters, which stamps the index key the
    // row's NEW class belongs to (index_4 for a session) and persists the row.
    // `offsetDate: 0` is required: a truthy offset older than a not-yet-loaded
    // folder's makes pushDialog drop the persisted row and return without an error.
    await dialogsStorage.pushDialog({dialog, offsetDate: 0});
    if(!await readRow(toPeerId)) throw new Error('target dialog row did not land');
  } catch(err) {
    if(previousKind) kindByGroupId.set(groupId, previousKind);
    else kindByGroupId.delete(groupId);
    try {
      if(target) {
        if(proxy?.mirrors?.dialogs) proxy.mirrors.dialogs[toPeerId] = previousTargetMirror ?? target;
      } else {
        await dialogsStorage.dropDialogWithEvent?.(toPeerId);
        await cleanupGroupChatInjection(toPeerId);
      }
    } catch(e: any) {
      console.warn(LOG_PREFIX, 'relocateGroupDialog: target cleanup failed:', e?.message);
    }
    throw err;
  }

  // The new row is in place, so the move has succeeded. A failure from here on
  // can only leave a stale old row, which the orphan sweep removes. It must not
  // reject, or the caller would point the history back at the old id.
  try {
    // Persisted row + folder caches + mirror.
    await dialogsStorage.dropDialogWithEvent?.(fromPeerId);
  } catch(e: any) {
    console.warn(LOG_PREFIX, 'relocateGroupDialog: old dialog drop failed:', e?.message);
  }
  try {
    await cleanupGroupChatInjection(fromPeerId);
    await invalidateGroupHistoryCache(fromPeerId);
    await invalidateGroupHistoryCache(toPeerId);
  } catch(e: any) {
    console.warn(LOG_PREFIX, 'relocateGroupDialog: old peer cleanup failed:', e?.message);
  }
  dispatchGroupDialogUpdate(toPeerId, dialog);
}

/**
 * Move a group onto a new peer id because a SYNCED record changed its class, and
 * save the record. One unit, in the same order as the boot repair: history, dialog,
 * record. Without the dialog move the row stays on the old id, the orphan sweep
 * deletes it, and the session vanishes until a reload.
 *
 * Any failure puts history and the dialog row back together on the id the stored
 * record still claims, then rejects so the next sync pass retries. If the row
 * cannot be moved back, history stays with the row: rows must never point at a
 * peer id that has no dialog.
 */
export async function moveSyncedGroupToPeer(
  record: {groupId: string, peerId: number, kind?: GroupKind, archivedAt?: number},
  existing: {peerId: number, kind?: GroupKind, archivedAt?: number},
  saveRecord: () => Promise<void>
): Promise<void> {
  const conversationId = `group:${record.groupId}`;
  const store = getMessageStore();
  const fromPeerId = existing.peerId;
  const restoreHistory = async() => {
    try {
      await store.setConversationTwebPeerId(conversationId, fromPeerId);
    } catch(e: any) {
      console.warn(LOG_PREFIX, 'moveSyncedGroupToPeer: history rollback failed:', e?.message);
    }
  };

  try {
    // Not atomic (one write per row), so a rejection can leave some rows moved.
    await store.setConversationTwebPeerId(conversationId, record.peerId);
    await relocateGroupDialog(record.groupId, fromPeerId, record.peerId, record);
  } catch(err) {
    await restoreHistory();
    throw err;
  }

  try {
    await saveRecord();
  } catch(err) {
    try {
      await relocateGroupDialog(record.groupId, record.peerId, fromPeerId, {
        kind: intendedGroupKind(existing),
        archivedAt: existing.archivedAt
      });
    } catch(e: any) {
      console.warn(LOG_PREFIX, 'moveSyncedGroupToPeer: dialog rollback failed:', e?.message);
      throw err;
    }
    await restoreHistory();
    throw err;
  }
}

/**
 * True when the record says this group is archived. Every dialog snapshot has to
 * carry it, because `createTwebDialog` stamps the folder index from `archived`.
 */
async function isGroupArchived(groupId: string): Promise<boolean> {
  try {
    return !!(await getGroupStore().get(groupId))?.archivedAt;
  } catch{
    return false;
  }
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
  cancelPendingGroupDialogRepaint(groupPeerId);
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
/**
 * Options for {@link handleGroupIncoming}.
 *
 * `silent` is the BACKFILL mode: a slice of history relayed by a member who was
 * already in the group (`group_history_backfill`). The rows are persisted and
 * rendered in place, but nothing about the user's current view may move — no
 * dialog bump, no unread counter, no read cursor, no `phantomchat_new_message`.
 * Anything else would resurrect old messages as if they had just arrived.
 */
export interface GroupIncomingOptions {
  silent?: boolean;
}

export async function handleGroupIncoming(
  ownPubkey: string,
  groupId: string,
  rumor: any,
  senderPubkey: string,
  dispatch: GroupDispatchFn,
  options: GroupIncomingOptions = {}
): Promise<void> {
  const silent = options.silent === true;
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
    groupPeerId = await resolveGroupPeerId(groupId);
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
      asContact: false,
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

  // Backfilled history stops here: the bubble exists and scrolling finds it,
  // but the dialog, the unread badge, the read cursor and the new-message event
  // all describe "what just arrived", and backfill is by definition old.
  if(silent) {
    console.log(LOG_PREFIX, 'rx backfill rendered', {groupPeerId, mid, groupId: groupId.slice(0, 8)});
    return;
  }

  const selected = isConversationSelected(groupPeerId);
  if(selected && mid > 0) {
    void store.setReadCursor(`group:${groupId}`, mid).catch((err) => {
      console.warn(LOG_PREFIX, 'selected group read cursor failed:', err);
    });
  }
  const dialog = mapper.createTwebDialog({
    peerId: groupPeerId,
    topMessage: mid,
    topMessageDate: timestampSec,
    // #207: an own echo (cross-device send, or a self-wrap that wasn't
    // deduped) is never unread. Only a genuinely new *incoming* message may
    // bump the badge. Same-device echoes are dropped earlier by the persistent
    // replay dedup in GroupAPI.handleIncomingGroupMessage, but a message sent
    // from another device of ours legitimately reaches this path.
    unreadCount: isOutgoing || selected ? 0 : 1,
    // Without this, every message in an archived session puts it back in Sessions.
    archived: await isGroupArchived(groupId),
    // Outbox cursor (= our own read state on members' messages) is consistent
    // with unreadCount: for an incoming message we have not read yet, leave
    // read_inbox_max_id at mid - 1 to model "all prior messages read, this one
    // pending"; for our own echo everything up to mid is read. (After the user
    // opens the chat, unread → 0 and the readInboxMaxId is bumped to mid by
    // other paths.)
    readInboxMaxId: isOutgoing || selected || mid <= 0 ? mid : mid - 1,
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

/**
 * Ingest a `group_history_backfill` slice relayed by a member who was already in
 * the group.
 *
 * Items arrive OLDEST-FIRST and are ingested in order: `history_append` order is
 * the reading order of the thread, so this loop is deliberately sequential
 * (each item depends on the previous one having been appended). The whole burst
 * is bounded by the sender (<= HISTORY_BACKFILL_MAX_MESSAGES) and runs once per
 * join, never on a hot path.
 *
 * Each item is replayed through the ordinary receive pipeline in `silent` mode,
 * so the persisted row, the mirrors and the reply/file rendering are identical
 * to a live delivery — only the dialog/unread/read-cursor/new-message side
 * effects are skipped.
 *
 * @returns number of rows actually ingested (already-known items are skipped).
 */
export async function ingestBackfilledGroupHistory(
  ownPubkey: string,
  groupId: string,
  items: GroupHistoryItem[],
  dispatch: GroupDispatchFn
): Promise<number> {
  if(!Array.isArray(items) || items.length === 0) return 0;
  const store = getMessageStore();
  let ingested = 0;

  for(const item of items) {
    try {
      // Dedupe on the ORIGINAL rumor id: a relay replay, a second member
      // relaying the same window, or a message we already had live all resolve
      // to the same row.
      const known = store.hasSeenEventId?.(item.rumorId) || await store.getByEventId(item.rumorId);
      if(known) continue;

      await handleGroupIncoming(
        ownPubkey,
        groupId,
        {id: item.rumorId, content: item.payload, created_at: item.createdAt},
        item.senderPubkey,
        dispatch,
        {silent: true}
      );
      ingested++;
    } catch(err) {
      console.warn(LOG_PREFIX, 'backfill: item ingest failed; continuing', {rumorId: item?.rumorId, err});
    }
  }

  console.log(LOG_PREFIX, 'backfill: ingested', ingested, 'of', items.length, 'item(s) for', groupId.slice(0, 8));
  return ingested;
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
    groupPeerId = await resolveGroupPeerId(groupId);
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
    groupPeerId = await resolveGroupPeerId(groupId);
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
    groupPeerId = await resolveGroupPeerId(groupId);
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
      asContact: false,
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
    archived: await isGroupArchived(groupId),
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
