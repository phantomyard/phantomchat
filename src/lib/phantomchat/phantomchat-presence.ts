/**
 * PhantomChat.chat Presence Module
 *
 * Tracks peer "last seen" status based on:
 * 1. Message reception timestamps (primary signal)
 * 2. Kind 30315 heartbeat publish (NIP-38 inspired) for own status
 * 3. Kind 30315 heartbeat subscription for contacts via lightweight WS
 *
 * The module updates tweb's User.status field on synthetic P2P users
 * so the UI shows "online", "last seen recently", etc.
 */

import rootScope from '@lib/rootScope';
import {MOUNT_CLASS_TO} from '@config/debug';

const LOG_PREFIX = '[PhantomChatPresence]';

/** How often to publish own heartbeat (ms) */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Consider a peer offline if no activity for this long (ms) */
const OFFLINE_THRESHOLD_MS = 180_000;

/** Kind 30315 = NIP-38 user status */
const KIND_STATUS = 30315;

let ownPubkey: string | null = null;
let ownPrivkey: Uint8Array | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;

/** Map pubkey → last activity timestamp (ms) */
const lastActivity = new Map<string, number>();

/** Map pubkey → peerId for status updates */
const pubkeyToPeerId = new Map<string, number>();

/**
 * Initialize the presence system.
 * Call once after identity is loaded and relay pool is connected.
 */
export async function initPresence(pubkey: string, privkeyHex: string): Promise<void> {
  ownPubkey = pubkey;
  try {
    const {hexToBytes} = await import('nostr-tools/utils');
    ownPrivkey = hexToBytes(privkeyHex);
  } catch(err) {
    console.warn(`${LOG_PREFIX} failed to parse privkey:`, err);
    return;
  }

  // Start publishing heartbeats
  setTimeout(publishHeartbeat, 5000); // delay to let relay pool connect
  heartbeatTimer = setInterval(publishHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Check for stale peers every 60s
  staleCheckTimer = setInterval(checkStalePresence, 60_000);

  // Re-check presence whenever a chat opens (catch-up before the next beat).
  wireChatOpenRefresh();

  console.log(`${LOG_PREFIX} initialized for ${pubkey.slice(0, 8)}...`);
}

/**
 * Register a contact's pubkey for presence tracking. Presence events are NOT
 * fetched here: kind-30315 beats arrive over the SHARED relay pool (the same
 * subscription that already carries gift-wraps / typing / reactions) and are
 * fed in via `onRemotePresenceEvent`. This just records the pubkey→peerId map
 * so an incoming beat can be resolved to the right contact. Idempotent.
 */
export function trackPeerPresence(pubkey: string, peerId: number): void {
  pubkeyToPeerId.set(pubkey, peerId);
}

/**
 * Feed a kind-30315 presence event received over the shared relay pool (routed
 * here by chat-api's raw-event dispatcher). Resolves the author to a tracked
 * contact and updates their status to online. Safe to call with any event —
 * non-30315 or untracked authors are ignored.
 */
export function onRemotePresenceEvent(event: any): void {
  handlePresenceEvent(event);
}

/**
 * Called when a message is received from a contact.
 * Updates their "last seen" to now.
 */
export function onPeerActivity(pubkey: string): void {
  const now = Date.now();
  lastActivity.set(pubkey, now);

  const peerId = pubkeyToPeerId.get(pubkey);
  if(peerId) {
    updatePeerStatus(peerId, 'online', Math.floor(now / 1000));
  }
}

/**
 * Publish own heartbeat — kind 30315, d="general", content="online"
 */
async function publishHeartbeat(): Promise<void> {
  if(!ownPubkey || !ownPrivkey) return;

  try {
    const {finalizeEvent} = await import('nostr-tools/pure');

    const event = finalizeEvent({
      kind: KIND_STATUS,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'general'],
        ['status', 'online']
      ],
      content: 'online'
    }, ownPrivkey);

    // Publish via ChatAPI relay pool
    const chatAPI = (window as any).__phantomchatChatAPI;
    const pool = chatAPI?.relayPool;
    if(pool && pool.isConnected()) {
      await pool.publishRawEvent(event);
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} heartbeat publish failed:`, err);
  }
}

/**
 * Handle incoming presence event.
 */
function handlePresenceEvent(event: any): void {
  if(!event || event.kind !== KIND_STATUS) return;

  const pubkey = event.pubkey;
  const peerId = pubkeyToPeerId.get(pubkey);
  if(!peerId) return;

  const timestamp = event.created_at * 1000;
  lastActivity.set(pubkey, timestamp);
  updatePeerStatus(peerId, 'online', event.created_at);
}

/**
 * Update a P2P peer's status in tweb's user system.
 *
 * CRITICAL: the status must be written to the WORKER's appUsersManager, because
 * that is the store the topbar/profile read back through `getUser` when a chat
 * (re)opens. Writing only the main-thread peer mirror — as this did before —
 * left the worker copy on its injected default, so switching chats and
 * returning reverted the badge to "last seen recently" even though the peer was
 * online. We update both: the worker (authoritative for the readers) AND the
 * main-thread mirror (immediate reactive refresh).
 */
function updatePeerStatus(peerId: number, status: 'online' | 'offline', timestamp: number): void {
  const onlineUntil = timestamp + Math.floor(OFFLINE_THRESHOLD_MS / 1000);

  // (1) Worker store — the source of truth the topbar reads on chat open.
  try {
    const updateStatus = rootScope.managers?.appUsersManager?.updateP2PUserStatus;
    if(updateStatus) {
      Promise.resolve(
        updateStatus.call(
          rootScope.managers.appUsersManager,
          peerId,
          status === 'online',
          timestamp,
          status === 'online' ? onlineUntil : undefined
        )
      ).catch((e) => console.debug('[PhantomChatPresence] worker status update failed:', e?.message));
    }
  } catch(e: any) {
    console.debug('[PhantomChatPresence] worker status update threw:', e?.message);
  }

  // (2) Main-thread mirror — immediate reactive UI refresh.
  const apiManagerProxy = MOUNT_CLASS_TO.apiManagerProxy;
  if(!apiManagerProxy) return;

  const peerIdValue: PeerId = peerId.toPeerId(false);
  const peer = apiManagerProxy.getPeer(peerIdValue);
  if(!peer || peer._ !== 'user') return;

  if(status === 'online') {
    (peer as any).status = {
      _: 'userStatusOnline',
      expires: onlineUntil
    };
  } else {
    (peer as any).status = {
      _: 'userStatusOffline',
      was_online: timestamp
    };
  }

  // Reconcile peer to trigger UI update
  import('@stores/peers').then(({reconcilePeer}) => {
    reconcilePeer(peerIdValue, peer);
  }).catch((e) => console.debug('[PhantomChatPresence] peer reconcile failed:', e?.message));

  // Notify topbar/profile to refresh status string
  rootScope.dispatchEvent('user_update' as any, peerId);
}

/**
 * Catch-up on chat open: re-assert any presence we already know and fire a
 * one-shot kind-30315 query for the peer's latest heartbeat. Without this,
 * opening a chat before the first periodic beat of the session showed the stale
 * injected default; Andrew asked for an explicit check on chat load (then the
 * 60s cadence keeps it fresh).
 */
async function refreshPeerOnOpen(peerId: number): Promise<void> {
  // Resolve this peerId back to its pubkey (reverse of pubkeyToPeerId).
  let pubkey: string | undefined;
  for(const [pk, pid] of pubkeyToPeerId) {
    if(pid === peerId) { pubkey = pk; break; }
  }
  if(!pubkey) return;

  // Re-assert known activity first so the badge updates instantly if we already
  // have a recent beat for this peer.
  const known = lastActivity.get(pubkey);
  if(known && Date.now() - known <= OFFLINE_THRESHOLD_MS) {
    updatePeerStatus(peerId, 'online', Math.floor(known / 1000));
  }

  // Then query the relays for the freshest heartbeat (authoritative).
  try {
    const chatAPI = (window as any).__phantomchatChatAPI;
    const pool = chatAPI?.relayPool;
    if(!pool?.isConnected?.()) return;
    const events: any[] = await pool.queryRawEvents({
      kinds: [KIND_STATUS],
      authors: [pubkey],
      limit: 1
    });
    let latest: any | undefined;
    for(const ev of events || []) {
      if(ev?.kind === KIND_STATUS && (!latest || ev.created_at > latest.created_at)) latest = ev;
    }
    if(latest) handlePresenceEvent(latest);
  } catch(err) {
    console.debug(`${LOG_PREFIX} chat-open presence query failed:`, (err as Error)?.message);
  }
}

/**
 * Hook a chat-open signal so presence is re-checked when the user enters a
 * conversation. Call once from initPresence.
 */
function wireChatOpenRefresh(): void {
  rootScope.addEventListener('peer_changed' as any, (payload: any) => {
    const peerId: number | undefined = typeof payload === 'number' ? payload : payload?.peerId;
    if(typeof peerId !== 'number') return;
    // Only P2P virtual peers carry presence; ignore others cheaply.
    if(!pubkeyToPeerId.size) return;
    void refreshPeerOnOpen(peerId);
  });
}

/**
 * Check for peers that haven't sent activity recently.
 * Mark them as offline.
 */
function checkStalePresence(): void {
  const now = Date.now();

  for(const [pubkey, lastSeen] of lastActivity) {
    if(now - lastSeen > OFFLINE_THRESHOLD_MS) {
      const peerId = pubkeyToPeerId.get(pubkey);
      if(peerId) {
        updatePeerStatus(peerId, 'offline', Math.floor(lastSeen / 1000));
      }
      lastActivity.delete(pubkey);
    }
  }
}

/**
 * Clean up on page unload.
 */
export function destroyPresence(): void {
  if(heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if(staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }
  lastActivity.clear();
  pubkeyToPeerId.clear();
  ownPubkey = null;
  ownPrivkey = null;
}
