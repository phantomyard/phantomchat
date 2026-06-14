/**
 * PhantomChat.chat Presence Module — PING / PONG model
 *
 * HONEST presence. The previous design was a one-way kind-30315 beacon: each
 * side shouted "I'm online" on a timer and nobody ever answered. A green badge
 * meant "the peer published a beacon", NOT "the peer can actually hear you" — so
 * a peer whose inbound subscription had gone deaf still showed online while
 * silently dropping your messages.
 *
 * This module replaces that with a round-trip handshake over the SAME NIP-17
 * gift-wrap path that real messages travel:
 *
 *   - On chat-open, and every 60s while that chat stays open, we send a PING
 *     (a gift-wrapped `{type:'presence-ping', nonce}` envelope) to the peer.
 *   - The peer answers with a PONG echoing the nonce.
 *   - A returned pong is proof the peer received our gift-wrap — i.e. the real
 *     delivery path is alive — so we flip the badge to a TRUE online.
 *   - No pong within the offline threshold ⇒ the badge falls to "last seen".
 *
 * Because the ping rides kind-1059 (not a side channel), "online" now means
 * "I just proved I can deliver to you", which is exactly the signal the user
 * needs before trusting that a message will land.
 *
 * Incoming pings are answered (pong) by chat-api's presence wiring; receiving a
 * ping OR a normal message also marks that peer alive (both prove liveness).
 */

import rootScope from '@lib/rootScope';
import {MOUNT_CLASS_TO} from '@config/debug';

const LOG_PREFIX = '[PhantomChatPresence]';

/** How often we re-ping the currently-open chat's peer (ms). */
const PING_INTERVAL_MS = 60_000;

/** A pending ping older than this is considered lost and swept (ms). */
const PING_TIMEOUT_MS = 15_000;

/** Consider a peer offline if no proof-of-life for this long (ms). */
const OFFLINE_THRESHOLD_MS = 180_000;

let ownPubkey: string | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Map pubkey → last proof-of-life timestamp (ms). */
const lastAlive = new Map<string, number>();

/** Map pubkey → peerId for status updates. */
const pubkeyToPeerId = new Map<string, number>();

/** Outstanding pings we sent, keyed by nonce → {pubkey, sentAt}. */
const pendingPings = new Map<string, {pubkey: string; sentAt: number}>();

/** The peer whose chat is currently open — the one we actively probe. */
let activePeerPubkey: string | null = null;

/**
 * Initialize the presence system.
 * Call once after identity is loaded and the relay pool is connected.
 */
export async function initPresence(pubkey: string, _privkeyHex?: string): Promise<void> {
  ownPubkey = pubkey;

  // Populate the tracking set from the authoritative contact mapping store so an
  // inbound ping/pong resolves to the right contact regardless of which screen
  // the user is on (see refreshTrackedContacts).
  await refreshTrackedContacts();

  // Probe the currently-open chat's peer on the 60s cadence. Opening a chat
  // fires an immediate ping via wireChatOpenRefresh; this keeps it fresh while
  // the chat stays open.
  pingTimer = setInterval(pingActivePeer, PING_INTERVAL_MS);

  // Fall a peer to "last seen" once its proof-of-life ages past the threshold.
  staleCheckTimer = setInterval(checkStalePresence, 30_000);

  // Drop pings that never got a pong so the pending map can't grow unbounded.
  sweepTimer = setInterval(sweepPendingPings, PING_TIMEOUT_MS);

  // Ping (and re-assert) whenever a chat opens.
  wireChatOpenRefresh();

  console.log(`${LOG_PREFIX} initialized for ${pubkey.slice(0, 8)}... (ping/pong)`);
}

/**
 * Register a contact's pubkey for presence tracking. Records the pubkey→peerId
 * map so an incoming ping/pong can be resolved to the right contact. Idempotent.
 */
export function trackPeerPresence(pubkey: string, peerId: number): void {
  pubkeyToPeerId.set(pubkey, peerId);
  console.log(`${LOG_PREFIX} tracking ${pubkey.slice(0, 8)} → peer ${peerId} (total tracked: ${pubkeyToPeerId.size})`);
}

/**
 * Populate the tracking set from the authoritative contact mapping store
 * (`getAllMappings`). Decouples tracking from the Contacts UI render so it works
 * on first load and keeps up with contacts added later. Idempotent.
 */
async function refreshTrackedContacts(): Promise<void> {
  try {
    const {getAllMappings} = await import('@lib/phantomchat/virtual-peers-db');
    const mappings = await getAllMappings();
    let added = 0;
    for(const m of mappings) {
      if(!pubkeyToPeerId.has(m.pubkey)) added++;
      pubkeyToPeerId.set(m.pubkey, m.peerId);
    }
    if(added > 0) {
      console.log(`${LOG_PREFIX} loaded ${added} contact(s) from mapping store (total tracked: ${pubkeyToPeerId.size})`);
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} refreshTrackedContacts failed:`, (err as Error)?.message);
  }
}

/**
 * Called when a message is received from a contact. A delivered message is
 * itself proof the peer is alive, so refresh their liveness.
 */
export function onPeerActivity(pubkey: string): void {
  markAlive(pubkey);
}

/**
 * A peer PINGED us. They can reach us and want to know if we can reach them.
 * They are demonstrably alive, so mark them online. (chat-api sends the pong.)
 */
export function onRemotePing(fromPubkey: string): void {
  console.log(`${LOG_PREFIX} ← ping from ${fromPubkey.slice(0, 8)} (peer alive)`);
  markAlive(fromPubkey);
}

/**
 * A peer answered one of our PINGs with a PONG. This is the authoritative
 * proof-of-delivery signal: the peer received our gift-wrap, so the real
 * message path to them is alive. Correlate by nonce (defensive — a pong from a
 * tracked peer is trusted regardless) and flip the badge to a true online.
 */
export function onRemotePong(fromPubkey: string, nonce: string): void {
  const pending = nonce ? pendingPings.get(nonce) : undefined;
  if(pending) {
    pendingPings.delete(nonce);
    if(pending.pubkey !== fromPubkey) {
      console.debug(`${LOG_PREFIX} pong nonce/author mismatch — ignoring`);
      return;
    }
  }
  // Only honor pongs from peers we actually track (and, if we had a pending
  // ping for this nonce, that the author matched). An untracked author with no
  // matching nonce is noise.
  if(!pubkeyToPeerId.has(fromPubkey)) return;
  console.log(`${LOG_PREFIX} ← pong from ${fromPubkey.slice(0, 8)} (delivery path alive)`);
  markAlive(fromPubkey);
}

/** Record proof-of-life for a peer and flip its badge online. */
function markAlive(pubkey: string): void {
  const now = Date.now();
  lastAlive.set(pubkey, now);
  const peerId = pubkeyToPeerId.get(pubkey);
  if(peerId) updatePeerStatus(peerId, 'online', Math.floor(now / 1000));
}

/**
 * Send a presence PING to a peer over the gift-wrap path and record the nonce
 * so the matching pong can be correlated.
 */
async function sendPing(pubkey: string): Promise<void> {
  if(!pubkey || pubkey === ownPubkey) return;
  try {
    const chatAPI = (window as any).__phantomchatChatAPI;
    const pool = chatAPI?.relayPool;
    if(!pool?.isConnected?.() || typeof pool.publishPresence !== 'function') return;

    const nonce = (typeof crypto !== 'undefined' && crypto.randomUUID) ?
      crypto.randomUUID() :
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingPings.set(nonce, {pubkey, sentAt: Date.now()});

    await pool.publishPresence(pubkey, nonce, 'ping');
    console.log(`${LOG_PREFIX} → ping ${pubkey.slice(0, 8)} (nonce ${nonce.slice(0, 8)})`);
  } catch(err) {
    console.debug(`${LOG_PREFIX} ping failed:`, (err as Error)?.message);
  }
}

/** Re-probe the currently-open chat's peer (60s cadence). */
function pingActivePeer(): void {
  if(activePeerPubkey) void sendPing(activePeerPubkey);
}

/**
 * Drop pings that never got a pong. Doesn't itself mark anyone offline — that's
 * checkStalePresence's job once proof-of-life ages out — it just bounds the
 * pending map.
 */
function sweepPendingPings(): void {
  const now = Date.now();
  for(const [nonce, info] of pendingPings) {
    if(now - info.sentAt > PING_TIMEOUT_MS) pendingPings.delete(nonce);
  }
}

/**
 * Update a P2P peer's status in tweb's user system.
 *
 * CRITICAL: the status must be written to the WORKER's appUsersManager, because
 * that is the store the topbar/profile read back through `getUser` when a chat
 * (re)opens. We update both the worker (authoritative for readers) AND the
 * main-thread mirror (immediate reactive refresh).
 */
function updatePeerStatus(peerId: number, status: 'online' | 'offline', timestamp: number): void {
  const onlineUntil = timestamp + Math.floor(OFFLINE_THRESHOLD_MS / 1000);

  // (1) Worker store — the source of truth the topbar reads on chat open.
  let workerCalled = false;
  try {
    const updateStatus = rootScope.managers?.appUsersManager?.updateP2PUserStatus;
    if(updateStatus) {
      workerCalled = true;
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
  if(!apiManagerProxy) {
    console.log(`${LOG_PREFIX} setStatus peer ${peerId}=${status}: workerCall=${workerCalled} mirror=NO_PROXY`);
    return;
  }

  const peerIdValue: PeerId = peerId.toPeerId(false);
  const peer = apiManagerProxy.getPeer(peerIdValue);
  if(!peer || peer._ !== 'user') {
    console.log(`${LOG_PREFIX} setStatus peer ${peerId}=${status}: workerCall=${workerCalled} mirror=NO_USER(${peer?._ ?? 'null'})`);
    return;
  }

  if(status === 'online') {
    (peer as any).status = {_: 'userStatusOnline', expires: onlineUntil};
  } else {
    (peer as any).status = {_: 'userStatusOffline', was_online: timestamp};
  }

  import('@stores/peers').then(({reconcilePeer}) => {
    reconcilePeer(peerIdValue, peer);
  }).catch((e) => console.debug('[PhantomChatPresence] peer reconcile failed:', e?.message));

  rootScope.dispatchEvent('user_update' as any, peerId);
}

/**
 * Catch-up on chat open: set the active peer (so the 60s loop probes them),
 * re-assert any recent proof-of-life instantly, then fire an immediate ping so
 * the badge reflects reality without waiting for the next interval.
 */
async function refreshPeerOnOpen(peerId: number): Promise<void> {
  // Resolve this peerId back to its pubkey.
  let pubkey: string | undefined;
  for(const [pk, pid] of pubkeyToPeerId) {
    if(pid === peerId) { pubkey = pk; break; }
  }
  if(!pubkey) {
    // Not a tracked P2P peer (group/other) — stop probing on chat switch.
    activePeerPubkey = null;
    return;
  }

  activePeerPubkey = pubkey;
  console.log(`${LOG_PREFIX} chat-open: peer ${peerId} (${pubkey.slice(0, 8)}) — pinging`);

  // Re-assert known liveness first so the badge updates instantly if we already
  // have a recent proof-of-life for this peer.
  const known = lastAlive.get(pubkey);
  if(known && Date.now() - known <= OFFLINE_THRESHOLD_MS) {
    updatePeerStatus(peerId, 'online', Math.floor(known / 1000));
  }

  // Then probe for the truth.
  void sendPing(pubkey);
}

/**
 * Hook a chat-open signal so presence is probed when the user enters a
 * conversation. Call once from initPresence.
 */
function wireChatOpenRefresh(): void {
  rootScope.addEventListener('peer_changed' as any, (payload: any) => {
    const peerId: number | undefined = typeof payload === 'number' ? payload : payload?.peerId;
    if(typeof peerId !== 'number') return;
    void refreshPeerOnOpen(peerId);
  });
}

/**
 * Fall a peer to offline once its proof-of-life ages past the threshold. With a
 * 60s ping cadence this means ~3 unanswered pings before the badge drops.
 */
function checkStalePresence(): void {
  const now = Date.now();
  for(const [pubkey, lastSeen] of lastAlive) {
    if(now - lastSeen > OFFLINE_THRESHOLD_MS) {
      const peerId = pubkeyToPeerId.get(pubkey);
      if(peerId) updatePeerStatus(peerId, 'offline', Math.floor(lastSeen / 1000));
      lastAlive.delete(pubkey);
    }
  }
}

/**
 * Clean up on page unload.
 */
export function destroyPresence(): void {
  if(pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if(staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
  if(sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  lastAlive.clear();
  pubkeyToPeerId.clear();
  pendingPings.clear();
  activePeerPubkey = null;
  ownPubkey = null;
}
