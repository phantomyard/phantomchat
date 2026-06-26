/**
 * phantomchat-message-handler.ts
 *
 * Pure handler for incoming Nostr messages (phantomchat_new_message events).
 * Builds tweb-native Message/Dialog objects and injects them into mirrors.
 * Extracted from phantomchat-onboarding-integration.ts for testability.
 */

import {PhantomChatPeerMapper} from '@lib/phantomchat/phantomchat-peer-mapper';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';
import {buildPhantomChatMedia, type PhantomChatFileMetadata} from '@lib/phantomchat/phantomchat-media-shape';
import {logSwallow} from '@lib/phantomchat/log-swallow';
import {assertInvariant, validateTwebMessage, validateDialogTopMessage} from '@lib/phantomchat/bridge-invariants';
import {ensureSenderUserInjected} from '@lib/phantomchat/ensure-sender-user-injected';
import {isGroupPeer} from '@lib/phantomchat/group-types';

export interface IncomingMessageData {
  senderPubkey: string;
  peerId: number;
  mid: number;
  timestamp: number;
  message: {content: string; type?: string; fileMetadata?: PhantomChatFileMetadata};
}

export interface HandleMessageResult {
  msg: any;
  peerId: number;
  dialog: any;
  isNewPeer: boolean;
}

// --- Unread tracking ---
// Main-thread counter keyed by peerId. Synthetic P2P dialogs don't live in the
// Worker's dialogsStorage, so the standard readHistory path can't decrement
// them — we must track unread counts ourselves and clear on peer_changed.
const UNREAD_STORAGE_KEY = 'phantomchat-unread-counts';
const unreadCounts = new Map<number, number>();
const lastDialogs = new Map<number, any>();

(function loadUnreadCounts() {
  try {
    if(typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(UNREAD_STORAGE_KEY);
    if(!raw) return;
    const obj = JSON.parse(raw) as Record<string, number>;
    for(const k in obj) {
      const v = +obj[k];
      if(v > 0) unreadCounts.set(+k, v);
    }
  } catch(e) { logSwallow('MessageHandler.loadUnreadCounts', e); }
})();

let unreadFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushUnreadCounts(): void {
  if(unreadFlushTimer !== null) { clearTimeout(unreadFlushTimer); unreadFlushTimer = null; }
  try {
    if(typeof localStorage === 'undefined') return;
    const obj: Record<string, number> = {};
    unreadCounts.forEach((v, k) => { if(v > 0) obj[k] = v; });
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(obj));
  } catch(e) { logSwallow('MessageHandler.persistUnreadCounts', e); }
}

/**
 * Debounce the synchronous localStorage write off the per-message path. The
 * in-memory `unreadCounts` map is authoritative and already updated by the
 * caller; only the blocking serialize-and-write is coalesced, so a burst of N
 * incoming messages does ONE write instead of N (AGENTS.md principle #5: no
 * sync localStorage on a per-message path). Flushed eagerly on page hide so a
 * reload never loses the latest counts.
 */
// 300ms: long enough to coalesce a rapid reply burst into one write, short
// enough that a reload shortly after the last message still persists the
// latest counts (page-hide also force-flushes, so a real close never loses).
const UNREAD_FLUSH_DEBOUNCE_MS = 300;

function persistUnreadCounts(): void {
  if(unreadFlushTimer !== null) return; // a flush is already scheduled
  if(typeof setTimeout === 'undefined') { flushUnreadCounts(); return; }
  unreadFlushTimer = setTimeout(flushUnreadCounts, UNREAD_FLUSH_DEBOUNCE_MS);
}

// Durability: flush any pending counts before the tab is hidden/unloaded.
if(typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden' && unreadFlushTimer !== null) flushUnreadCounts();
  });
}
if(typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => { if(unreadFlushTimer !== null) flushUnreadCounts(); });
}

function isChatOpenFor(peerId: number): boolean {
  try {
    const im = (MOUNT_CLASS_TO as any).appImManager;
    const current = im?.chat?.peerId;
    if(current == null) return false;
    return +current === peerId;
  } catch{
    return false;
  }
}

export function getUnreadForPeer(peerId: number): number {
  return unreadCounts.get(peerId) ?? 0;
}

/**
 * Clear the main-thread unread counter for a peer and re-dispatch the last
 * dialog with unread_count: 0 so the chat-list badge disappears immediately.
 * Called on peer_changed (see phantomchat-onboarding-integration.ts).
 *
 * Source priority for the dialog dispatched: apiManagerProxy.mirrors.dialogs
 * (set by VMT outgoing send), then `lastDialogs` (set by live incoming this
 * session), then a freshly-built one from message-store. The store fallback
 * is what makes post-reload work: `unreadCounts` is restored from
 * localStorage, but `lastDialogs` is in-memory only and starts empty after
 * reload, so without the fallback the chat-list badge (rendered from
 * `getDialogs` → `store.countUnread`) never received a clearing dispatch.
 *
 * Also defensively advances the IDB read cursor so the next `getDialogs`
 * (after another reload) reports unread = 0 even if the standard
 * `bubbles.ts → readHistory` path didn't fire.
 *
 * Handles both P2P peers (`peerId >= 1e15`) and group peers (negative,
 * GROUP_PEER_BASE range).
 */
export async function resetUnreadForPeer(peerId: number): Promise<void> {
  try {
    const proxy = (MOUNT_CLASS_TO as any).apiManagerProxy;
    const mirrored = proxy?.mirrors?.dialogs?.[peerId];
    const cached = lastDialogs.get(peerId);
    const had = (unreadCounts.get(peerId) ?? 0) > 0;

    if(had) {
      unreadCounts.set(peerId, 0);
      persistUnreadCounts();
    }

    const conv = await resolveConversation(peerId);
    const store = conv ? (await import('@lib/phantomchat/message-store')).getMessageStore() : null;

    let storeUnread = 0;
    if(conv && store) {
      try {
        storeUnread = await store.countUnread(conv.convId, conv.ownPk);
      } catch{ /* ignore — empty store, IDB closed, etc. */ }
    }
    const idbHasUnread = storeUnread > 0;
    const mirrorHasUnread = (mirrored?.unread_count ?? 0) > 0;
    const cachedHasUnread = (cached?.unread_count ?? 0) > 0;

    if(!had && !idbHasUnread && !mirrorHasUnread && !cachedHasUnread) return;

    if(conv && store) {
      try {
        const recent = await store.getMessages(conv.convId, 1);
        const top = recent[0]?.mid;
        if(top != null) await store.setReadCursor(conv.convId, top);
      } catch(e: any) { logSwallow('MessageHandler.resetUnread.cursor', e); }
    }

    let base: any = mirrored || cached;
    if(!base && conv && store) {
      base = await buildClearedDialogFromStore(peerId, conv, store);
    }
    if(!base) return;

    const cleared = {...base, unread_count: 0};
    if(proxy?.mirrors?.dialogs) {
      proxy.mirrors.dialogs[peerId] = cleared;
    }
    lastDialogs.set(peerId, cleared);
    dispatchDialogUpdate(peerId, cleared);
  } catch(e: any) {
    logSwallow('MessageHandler.resetUnreadForPeer', e);
  }
}

interface ConvRef {convId: string; ownPk: string;}

async function resolveConversation(peerId: number): Promise<ConvRef | null> {
  const ownPk = (window as any).__phantomchatOwnPubkey;
  if(!ownPk) return null;

  if(peerId >= 1e15) {
    const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
    const peerPubkey = await getPubkey(peerId);
    if(!peerPubkey) return null;
    const {getMessageStore} = await import('@lib/phantomchat/message-store');
    return {convId: getMessageStore().getConversationId(ownPk, peerPubkey), ownPk};
  }

  if(isGroupPeer(peerId)) {
    const {getGroupStore} = await import('@lib/phantomchat/group-store');
    const group = await getGroupStore().getByPeerId(peerId);
    if(!group) return null;
    return {convId: group.groupId, ownPk};
  }

  return null;
}

async function buildClearedDialogFromStore(peerId: number, conv: ConvRef, store: any): Promise<any | null> {
  const messages = await store.getMessages(conv.convId, 1);
  const latest = messages[0];
  if(!latest || latest.mid == null) return null;

  const mapper = new PhantomChatPeerMapper();
  const isOutgoing = latest.isOutgoing ?? (latest.senderPubkey === conv.ownPk);
  const fromPeerId = isOutgoing ?
    undefined :
    (peerId >= 1e15 ? peerId : await mapper.mapPubkey(latest.senderPubkey));

  const msg = mapper.createTwebMessage({
    mid: latest.mid,
    peerId,
    fromPeerId,
    date: latest.timestamp,
    text: latest.content || '',
    isOutgoing
  });
  const dialog = mapper.createTwebDialog({
    peerId,
    topMessage: latest.mid,
    topMessageDate: latest.timestamp,
    unreadCount: 0
  });
  (dialog as any).topMessage = msg;
  return dialog;
}

/**
 * Build a tweb Message from incoming Nostr event data.
 * Pure function — no side effects.
 */
export function buildTwebMessage(data: IncomingMessageData): any {
  const mapper = new PhantomChatPeerMapper();
  const media = data.message.fileMetadata ?
    buildPhantomChatMedia(data.mid, data.message.fileMetadata) :
    undefined;
  const msg = mapper.createTwebMessage({
    mid: data.mid,
    peerId: data.peerId,
    fromPeerId: data.peerId,
    date: data.timestamp,
    text: media ? (data.message.fileMetadata?.caption || '') : data.message.content,
    isOutgoing: false,
    media
  });
  assertInvariant('Rule6/TwebMessageShape', validateTwebMessage(msg));
  return msg;
}

/**
 * Build a tweb Dialog for the incoming message.
 * Attaches msg object as topMessage so setLastMessage can use it directly
 * without getMessageByPeer lookup (which fails when hasReachedTheEnd is false).
 */
export function buildTwebDialog(peerId: number, msg: any, timestamp: number, unreadCount: number = 1): any {
  const mapper = new PhantomChatPeerMapper();
  const dialog = mapper.createTwebDialog({
    peerId,
    topMessage: msg.mid || msg.id,
    topMessageDate: msg.date || timestamp,
    unreadCount
  });
  (dialog as any).topMessage = msg;
  assertInvariant('Rule8/DialogTopMessage', validateDialogTopMessage(dialog));
  return dialog;
}

/**
 * Inject message into main-thread mirrors (messages + peers).
 * Does NOT call Worker's saveMessages/getHistory — that pollutes the history cache.
 */
export async function injectIntoMirrors(
  peerId: number,
  msg: any,
  senderPubkey: string
): Promise<{isNewPeer: boolean}> {
  let isNewPeer = false;
  const proxy = MOUNT_CLASS_TO.apiManagerProxy;

  if(proxy?.mirrors?.messages) {
    const storageKey = `${peerId}_history`;
    if(!proxy.mirrors.messages[storageKey]) proxy.mirrors.messages[storageKey] = {};
    proxy.mirrors.messages[storageKey][msg.mid || msg.id] = msg;
  }

  // Push into Worker's history storage for subsequent getHistory calls
  try {
    const storageKey = `${peerId}_history` as any;
    await rootScope.managers.appMessagesManager.setMessageToStorage(storageKey, msg);
  } catch(e: any) { console.debug('[MessageHandler] non-critical:', e?.message); }

  const result = await ensureSenderUserInjected({
    senderPubkey,
    peerId,
    logPrefix: '[MessageHandler]'
  });
  isNewPeer = result.isNewPeer;

  return {isNewPeer};
}

/**
 * Dispatch dialog update to chat list. Fires twice:
 * - First dispatch adds the dialog via sortedList.add (returns early, skips setLastMessageN)
 * - Second dispatch (after 500ms) hits the existing-dialog branch for preview text
 */
export function dispatchDialogUpdate(peerId: number, dialog: any): void {
  const dispatchFn = () => {
    rootScope.dispatchEvent('dialogs_multiupdate' as any, new Map([[
      peerId.toPeerId ? (peerId as any).toPeerId(false) : peerId,
      {dialog}
    ]]));
  };
  dispatchFn();
  setTimeout(dispatchFn, 500);
}

/**
 * Invalidate Worker's history cache for a peer.
 * Without this, reopened chats return stale SliceEnd.Both data.
 */
export async function invalidateHistoryCache(peerId: number): Promise<void> {
  try {
    await rootScope.managers.appMessagesManager.invalidateHistoryCache(peerId);
  } catch(e: any) { console.debug('[MessageHandler] invalidateHistoryCache:', e?.message); }
}

export interface IncomingEditData {
  peerId: number;
  mid: number;
  senderPubkey: string;
  originalEventId: string;
  newContent: string;
  editedAt: number;
}

/**
 * Apply an incoming edit to a tweb message in the main-thread mirrors and
 * notify bubbles.ts via the existing tweb `message_edit` event so the bubble
 * re-renders with the new text + "edited" marker.
 *
 * No-op for self edits — the local edit path already updated the bubble.
 */
export async function handleIncomingEdit(data: IncomingEditData, ownPubkey: string): Promise<void> {
  if(data.senderPubkey === ownPubkey) return;

  const proxy = MOUNT_CLASS_TO.apiManagerProxy;
  const storageKey = `${data.peerId}_history`;

  const existing = proxy?.mirrors?.messages?.[storageKey]?.[data.mid];
  if(existing) {
    existing.message = data.newContent;
    existing.edit_date = data.editedAt;
  }

  // Tell the Worker to update its own storage so subsequent getHistory calls
  // return the edited content.
  try {
    await rootScope.managers.appMessagesManager.setMessageToStorage(storageKey as any, {
      ...(existing || {}),
      mid: data.mid,
      peerId: data.peerId,
      message: data.newContent,
      edit_date: data.editedAt
    });
  } catch(e: any) { console.debug('[MessageHandler] edit setMessageToStorage:', e?.message); }

  rootScope.dispatchEvent('message_edit' as any, {
    storageKey,
    peerId: data.peerId,
    mid: data.mid,
    message: existing || {mid: data.mid, peerId: data.peerId, message: data.newContent, edit_date: data.editedAt}
  });
}

/**
 * Full incoming message handler — orchestrates build, inject, dispatch.
 * Returns result for pending-message tracking.
 */
export async function handleIncomingMessage(
  data: IncomingMessageData,
  ownPubkey: string
): Promise<HandleMessageResult | null> {
  // Skip own echoes — already handled by Worker's sendText flow
  if(data.senderPubkey === ownPubkey) return null;

  const msg = buildTwebMessage(data);
  const peerId = data.peerId;

  const {isNewPeer} = await injectIntoMirrors(peerId, msg, data.senderPubkey);
  await invalidateHistoryCache(peerId);

  // sortedDialogList reads the sort key from Worker's dialogsStorage, not
  // the dialog object on the dispatched event — without this, an existing
  // P2P chat receiving a message would not re-sort to the top. No-op when
  // the Worker has no dialog yet (new peer); the dual local dispatch below
  // handles that case via sortedList.add.
  try {
    await rootScope.managers.appMessagesManager.setDialogTopMessage(msg);
  } catch(e: any) { console.debug('[MessageHandler] setDialogTopMessage failed:', e?.message); }

  // Dispatch history_append for real-time bubble rendering (when chat is open).
  // bubbles.ts deduplicates by fullMid — if getHistory already loaded this
  // message, the duplicate append is silently skipped.
  rootScope.dispatchEvent('history_append' as any, {
    storageKey: `${peerId}_history`,
    message: msg,
    peerId
  });

  // Compute unread count. If the chat is already open for this peer, the
  // message is effectively read — keep the counter at 0. Otherwise increment
  // the persisted per-peer counter so multi-message bursts count correctly.
  let unread: number;
  if(isChatOpenFor(peerId)) {
    unread = 0;
    unreadCounts.set(peerId, 0);
  } else {
    unread = (unreadCounts.get(peerId) ?? 0) + 1;
    unreadCounts.set(peerId, unread);
  }
  persistUnreadCounts();

  const dialog = buildTwebDialog(peerId, msg, data.timestamp, unread);
  lastDialogs.set(peerId, dialog);
  dispatchDialogUpdate(peerId, dialog);

  // Fire desktop/system notification when chat is not in the foreground.
  // Worker's notifyAboutMessage path is bypassed by VMT for P2P peers, so
  // this is the sole notification trigger for incoming PhantomChat traffic.
  try {
    const {notifyIncoming} = await import('@lib/phantomchat/phantomchat-notify');
    notifyIncoming({
      peerId,
      mid: data.mid,
      senderPubkey: data.senderPubkey,
      message: data.message
    }, ownPubkey);
  } catch(e: any) { console.debug('[MessageHandler] notify dispatch:', e?.message); }

  return {msg, peerId, dialog, isNewPeer};
}
