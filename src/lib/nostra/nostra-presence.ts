/**
 * Nostra.chat Presence Module
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
import {DEFAULT_RELAYS} from './nostr-relay-pool';
import {logSwallow} from './log-swallow';

const LOG_PREFIX = '[NostraPresence]';

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

/** WebSocket connections for presence subscription */
const presenceWs: WebSocket[] = [];

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

  console.log(`${LOG_PREFIX} initialized for ${pubkey.slice(0, 8)}...`);
}

/**
 * Register a contact's pubkey for presence tracking.
 * Also starts a lightweight presence subscription if not already active.
 */
export function trackPeerPresence(pubkey: string, peerId: number): void {
  pubkeyToPeerId.set(pubkey, peerId);

  // Start presence subscription for this contact
  subscribePresenceFor(pubkey);
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
    const chatAPI = (window as any).__nostraChatAPI;
    const pool = chatAPI?.relayPool;
    if(pool && pool.isConnected()) {
      await pool.publishRawEvent(event);
    }
  } catch(err) {
    console.debug(`${LOG_PREFIX} heartbeat publish failed:`, err);
  }
}

/**
 * Subscribe to kind 30315 events from a specific contact.
 * Uses a lightweight WebSocket connection to the first available relay.
 */
function subscribePresenceFor(pubkey: string): void {
  // Only open one subscription per relay set
  if(presenceWs.length > 0) {
    // Re-subscribe with updated authors list
    resubscribeAll();
    return;
  }

  const relayUrl = DEFAULT_RELAYS[0]?.url;
  if(!relayUrl) return;

  try {
    const ws = new WebSocket(relayUrl);
    const subId = 'presence-' + Math.random().toString(36).slice(2, 8);

    ws.onopen = () => {
      const authors = Array.from(pubkeyToPeerId.keys());
      const filter = {
        'kinds': [KIND_STATUS],
        authors,
        '#d': ['general'],
        'since': Math.floor(Date.now() / 1000) - 300
      };
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if(msg[0] === 'EVENT' && msg[2]) {
          handlePresenceEvent(msg[2]);
        }
      } catch{
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      // Silently fail — presence is optional
    };

    presenceWs.push(ws);
  } catch{
    // WebSocket not available or relay down
  }
}

/**
 * Re-subscribe with updated authors list on existing WS connections.
 */
function resubscribeAll(): void {
  const authors = Array.from(pubkeyToPeerId.keys());
  if(authors.length === 0) return;

  for(const ws of presenceWs) {
    if(ws.readyState !== WebSocket.OPEN) continue;

    const subId = 'presence-' + Math.random().toString(36).slice(2, 8);
    const filter = {
      'kinds': [KIND_STATUS],
      authors,
      '#d': ['general'],
      'since': Math.floor(Date.now() / 1000) - 300
    };
    ws.send(JSON.stringify(['REQ', subId, filter]));
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
 */
function updatePeerStatus(peerId: number, status: 'online' | 'offline', timestamp: number): void {
  const apiManagerProxy = MOUNT_CLASS_TO.apiManagerProxy;
  if(!apiManagerProxy) return;

  const peerIdValue: PeerId = peerId.toPeerId(false);
  const peer = apiManagerProxy.getPeer(peerIdValue);
  if(!peer || peer._ !== 'user') return;

  if(status === 'online') {
    (peer as any).status = {
      _: 'userStatusOnline',
      expires: timestamp + Math.floor(OFFLINE_THRESHOLD_MS / 1000)
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
  }).catch((e) => console.debug('[NostraPresence] peer reconcile failed:', e?.message));

  // Notify topbar/profile to refresh status string
  rootScope.dispatchEvent('user_update' as any, peerId);
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
  for(const ws of presenceWs) {
    try { ws.close(); } catch(e) { logSwallow('Presence.destroy.wsClose', e); }
  }
  presenceWs.length = 0;
  lastActivity.clear();
  pubkeyToPeerId.clear();
  ownPubkey = null;
  ownPrivkey = null;
}
