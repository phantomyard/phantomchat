/**
 * PhantomChat.chat Bridge
 *
 * Singleton that provides bidirectional translation between Nostr pubkeys/eventIds
 * and Telegram virtual peer IDs/message IDs.
 *
 * Forward mapping (pubkey → peerId, eventId → mid) is deterministic via SHA-256.
 * Reverse mapping (peerId → pubkey) requires IndexedDB due to hash irreversibility.
 */

import type {User} from '@layer';
import {initVirtualPeersDB, storeMapping, getPubkey, getAllMappings} from './virtual-peers-db';
import {NostrRelayPool, DEFAULT_RELAYS, loadCanonicalRelays, RelayConfig} from './nostr-relay-pool';
import {OfflineQueue} from './offline-queue';
import {MeshManager} from '@lib/phantomchat/mesh-manager';
import {MessageRouter} from '@lib/phantomchat/message-router';
import {isSignalKind, parseSignalContent} from '@lib/phantomchat/mesh-signaling';
import {getRtcConfigDirect} from '@lib/phantomchat/webrtc-config';
import {PeerCapabilityRegistry} from '@lib/phantomchat/transport/capability';
import {CapabilityIngestor} from '@lib/phantomchat/transport/capability-ingest';
import {LocalWsTransport} from '@lib/phantomchat/transport/local-ws-transport';
import {TransportSelector} from '@lib/phantomchat/transport/transport-selector';
import rootScope from '@lib/rootScope';
import {swallowHandler} from '@lib/phantomchat/log-swallow';

// Virtual ID ranges — all use BigInt to avoid floating-point precision loss
export const VIRTUAL_PEER_BASE = BigInt(10 ** 15);
export const VIRTUAL_PEER_RANGE = BigInt(9 * 10 ** 15);
export const VIRTUAL_MID_BASE = BigInt(10 ** 12);
export const VIRTUAL_MID_RANGE = BigInt(9 * 10 ** 15);

/**
 * Synchronous range check: returns true if peerId is in the virtual peer range.
 * Does not require an async DB lookup.
 */
export function isVirtualPeerSync(peerId: number): boolean {
  return peerId >= Number(VIRTUAL_PEER_BASE);
}

/**
 * Extended User interface for P2P peers with Nostr pubkey and avatar data.
 */
export interface P2PUser extends User.user {
  p2pPubkey: string;
  p2pAvatar: string;
}

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

export class PhantomChatBridge {
  private static _instance: PhantomChatBridge | null = null;

  private _initialized = false;
  private _userPubkey: string | null = null;

  /** In-memory cache: pubkey → peerId (avoid recomputing SHA-256 on repeated calls) */
  private pubkeyCache = new Map<string, number>();

  /** In-memory cache: eventId → mid */
  private midCache = new Map<string, number>();

  /** Relay pool and queue references */
  private _relayPool: NostrRelayPool | null = null;
  private _offlineQueue: OfflineQueue | null = null;

  private constructor() {}

  static getInstance(): PhantomChatBridge {
    const win = typeof window !== 'undefined' ? window as any : null;
    if(win?.__phantomchatBridgeInstance) {
      PhantomChatBridge._instance = win.__phantomchatBridgeInstance;
      return PhantomChatBridge._instance;
    }
    if(!PhantomChatBridge._instance) {
      PhantomChatBridge._instance = new PhantomChatBridge();
      if(win) win.__phantomchatBridgeInstance = PhantomChatBridge._instance;
    }
    return PhantomChatBridge._instance;
  }

  /**
   * Initialize the bridge with the current user's pubkey.
   * Opens IndexedDB, pre-loads existing mappings, and initializes the relay transport.
   */
  async init(userPubkey: string): Promise<void> {
    this._userPubkey = userPubkey;
    await initVirtualPeersDB();

    // Pre-load all existing mappings into the pubkeyCache
    const mappings = await getAllMappings();
    for(const m of mappings) {
      this.pubkeyCache.set(m.pubkey, m.peerId);
    }

    // Fetch the canonical relay list (served at /relays.json — the single
    // source of truth shared with phantombot). Falls back to the hardcoded
    // DEFAULT_RELAYS when the fetch fails (offline / 404 / malformed).
    const canonical = await loadCanonicalRelays();

    // Bootstrap relay pool
    this.initTransport(canonical ?? undefined);

    this._initialized = true;
  }

  /**
   * Initialize NostrRelayPool and OfflineQueue.
   *
   * The relay pool always connects via direct WebSocket — the relay transport
   * opens immediately. The app remains usable while the pool connects: chats
   * read from the local IndexedDB store and outgoing messages queue in
   * OfflineQueue.
   */
  private initTransport(relays?: RelayConfig[]): void {
    const pool = new NostrRelayPool({
      relays: [...(relays ?? DEFAULT_RELAYS)],
      onMessage: () => {
        // Message routing is handled by Phase 4
      }
    });

    const queue = new OfflineQueue(pool);

    this._relayPool = pool;
    this._offlineQueue = queue;

    // Expose for topbar and debug
    if(typeof window !== 'undefined') {
      (window as any).__phantomchatPool = pool;
    }

    console.log('[PhantomChatBridge] transport init: direct WebSocket (Tor removed), relays:', (relays ?? DEFAULT_RELAYS).length);
    pool.initialize().catch(() => {});

    // Initialize mini-relay worker
    if(typeof window !== 'undefined') {
      const miniRelayWorker = new Worker(
        new URL('./mini-relay.worker.ts', import.meta.url),
        {type: 'module'}
      );

      miniRelayWorker.postMessage({
        type: 'init',
        contactPubkeys: []
      });

      miniRelayWorker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if(msg.type === 'send') {
          console.log('[MiniRelay] outgoing message to', msg.peerId);
        }
      };

      (window as any).__phantomchatMiniRelayWorker = miniRelayWorker;

      rootScope.addEventListener('phantomchat_contact_accepted', () => {
        const contacts = (window as any).__phantomchatContacts || [];
        miniRelayWorker.postMessage({type: 'update-contacts', contactPubkeys: contacts});
      });

      // Per-peer P2P capability registry — THE GATE for the #61 ladder. Starts
      // empty; the CapabilityIngestor below is what fills it, by reading each
      // contact's kind-30078 advert (phantombot#258). Until an advert lands the
      // gate stays closed and sends fall straight through to the relay path.
      const capability = new PeerCapabilityRegistry();
      (window as any).__phantomchatCapability = capability;

      // Client-side capability INGESTION (phantomchat#61 companion to
      // phantombot#258). Polls each contact's replaceable capability advert off
      // the relays and populates the registry above, activating the ladder for
      // peers that run a phantombot P2P node. ChatAPI may not exist yet (built
      // before OR after the bridge), so it is resolved lazily on each poll.
      const capabilityIngestor = new CapabilityIngestor({
        registry: capability,
        getChatAPI: () => (window as any).__phantomchatChatAPI,
        getContacts: () => (window as any).__phantomchatContacts || []
      });
      (window as any).__phantomchatCapabilityIngestor = capabilityIngestor;
      // Refresh once the contact list is known, then on a timer to pick up node
      // restarts and expire stale adverts. Backfill fires after contacts load.
      rootScope.addEventListener('phantomchat_backfill_complete', () => {
        capabilityIngestor.refreshAll().catch(swallowHandler('PhantomChatBridge.capabilityRefresh'));
      });
      capabilityIngestor.start();

      // Initialize mesh manager. Uses the direct (host-candidate, no third-party
      // TURN) RTC config so capability-gated peers connect node-to-node on the
      // LAN — satisfying #61's "only Pages + relays, no other infra" constraint.
      const meshManager = new MeshManager({
        sendSignal: async(recipientPubkey, signal) => {
          const chatAPI = (window as any).__phantomchatChatAPI;
          if(chatAPI) {
            await chatAPI.publishSignal?.(recipientPubkey, signal.content);
          }
        },
        onPeerMessage: (pubkey, message) => {
          miniRelayWorker.postMessage({type: 'peer-message', peerId: pubkey, data: message});
          // #61: a P2P-delivered message is a standard `["EVENT", wrap]` frame.
          // Feed the wrap through the SAME relay-pool ingest a relay message
          // takes so it unwraps, dedups (against the relay copy) and renders
          // through one code path. Non-EVENT frames (mesh control) are ignored
          // here and handled by the mini-relay worker above.
          try {
            const frame = JSON.parse(message);
            if(Array.isArray(frame) && frame[0] === 'EVENT' && frame[1]) {
              const pool = (window as any).__phantomchatPool;
              pool?.ingestP2PEvent?.(frame[1]);
            }
          } catch(err) {
            swallowHandler('PhantomChatBridge.onPeerMessage')(err);
          }
        },
        onPeerConnected: (pubkey) => {
          miniRelayWorker.postMessage({type: 'peer-connected', peerId: pubkey, pubkey});
          rootScope.dispatchEvent('phantomchat_mesh_peer_connected', {pubkey, latency: -1});
        },
        onPeerDisconnected: (pubkey) => {
          miniRelayWorker.postMessage({type: 'peer-disconnected', peerId: pubkey});
          rootScope.dispatchEvent('phantomchat_mesh_peer_disconnected', {pubkey});
        }
      }, getRtcConfigDirect);

      // Initialize message router
      const messageRouter = new MessageRouter({
        meshManager,
        relayPublish: async(event) => {
          const pool = (window as any).__phantomchatPool;
          if(pool) {
            try {
              await pool.publish(event);
              return true;
            } catch{
              return false;
            }
          }
          return false;
        },
        getContactsForPeer: (_pubkey) => {
          return (window as any).__phantomchatContacts || [];
        }
      });

      // Tiered transport selector (#61): localhost ws → LAN/remote WebRTC → DHT
      // stub → relay floor. Attached to ChatAPI as the fire-and-forget P2P
      // fast-path. Gated by `capability`, so it is a no-op until peers advertise.
      const localTransport = new LocalWsTransport();
      const transportSelector = new TransportSelector({
        capability,
        mesh: meshManager,
        local: localTransport
      });

      // Attach the selector to ChatAPI. ChatAPI exposes itself on
      // window.__phantomchatChatAPI in its constructor; it may be built before
      // OR after the bridge, so wire it now if present and again on backfill
      // (a real event that always fires once ChatAPI is live). Until attached,
      // ChatAPI.transportSelector stays null → pure relay, no regression.
      const attachSelector = () => {
        const api = (window as any).__phantomchatChatAPI;
        if(api && !api.transportSelector) api.transportSelector = transportSelector;
      };
      attachSelector();
      rootScope.addEventListener('phantomchat_backfill_complete', attachSelector);

      // Expose for debugging
      (window as any).__phantomchatMeshManager = meshManager;
      (window as any).__phantomchatMessageRouter = messageRouter;
      (window as any).__phantomchatTransportSelector = transportSelector;

      // Handle incoming signals from gift-wrap messages
      rootScope.addEventListener('phantomchat_new_message', (e) => {
        const msg = e.message as any;
        if(msg?.rumorKind && isSignalKind(msg.rumorKind)) {
          // #61 rollout safety: only accept an incoming OFFER from a peer that
          // has advertised P2P capability. During a mixed-version rollout an
          // un-upgraded peer still dials ungated with TURN-relay ICE candidates;
          // answering with our host-only direct config yields no candidate pairs
          // and would silently kill that pair's existing direct-mesh fast path.
          // Answers/ICE for a session WE initiated are unaffected (we only gate
          // offers). No peer advertises until phantombot#258, so today every
          // inbound offer is ignored — matching current relay-only behaviour.
          const signal = parseSignalContent(msg.content);
          if(signal?.action === 'offer' && !capability.has(e.senderPubkey)) return;
          meshManager.handleSignal(e.senderPubkey, msg.content);
        }
      });

      // Auto-connect to contacts after backfill — GATED by capability (#61).
      // Previously this fired a WebRTC offer at EVERY contact unconditionally.
      // Now a peer is only dialed if it has advertised P2P capability, so no
      // signaling traffic or connection attempt happens for the all-relay peers
      // that make up 100% of the network until phantombot#258 ships.
      rootScope.addEventListener('phantomchat_backfill_complete', () => {
        const contacts = (window as any).__phantomchatContacts || [];
        for(const pubkey of contacts) {
          if(!capability.has(pubkey)) continue;
          setTimeout(() => {
            meshManager.connect(pubkey).catch(swallowHandler('PhantomChatBridge.autoConnectMesh'));
          }, Math.random() * 5000);
        }
      });
    }
  }

  /**
   * Publish NIP-65 relay list at identity initialization.
   * Call this after the keypair is created/loaded.
   */
  publishNip65(privateKey: Uint8Array): void {
    if(this._relayPool) {
      this._relayPool.publishNip65(privateKey);
    }
  }

  /** Get the relay pool instance */
  getRelayPool(): NostrRelayPool | null {
    return this._relayPool;
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Map a Nostr hex pubkey to a deterministic Telegram virtual peer ID.
   *
   * Algorithm:
   * 1. Convert pubkey hex to bytes
   * 2. Take first 8 bytes → SHA-256 digest → first 8 bytes of hash
   * 3. Interpret as big-endian uint64 → BigInt
   * 4. result = VIRTUAL_PEER_BASE + (hash_value % VIRTUAL_PEER_RANGE)
   * 5. Convert to Number for tweb compatibility
   */
  /**
   * Synchronous "is this pubkey already a known peer" check, served purely
   * from the in-memory pubkeyCache (preloaded with every mapping at init,
   * line ~107). A fast path for hot per-message gates (e.g. isKnownContact)
   * that would otherwise hit IndexedDB on every incoming message. A miss falls
   * back to the authoritative DB read at the call site, so this is only ever a
   * speedup — never the source of truth. (Deleted mappings are not evicted, so
   * at worst this over-reports "known", which only relaxes the auto-add gate,
   * never the block gate.)
   */
  hasPeerMapping(pubkey: string): boolean {
    return this.pubkeyCache.has(pubkey);
  }

  async mapPubkeyToPeerId(pubkey: string): Promise<number> {
    // Defense-in-depth: reject non-pubkey inputs loudly rather than letting
    // `hexToBytes(undefined)` fail with `Cannot read properties of undefined
    // (reading 'length')`. Real Nostr pubkeys are 64 lowercase-hex chars.
    // Callers that iterate conversationIds MUST filter out group-conv ids
    // (32 hex, no colon) before calling this — this guard only prevents the
    // crash when that filter is missing. See getContacts/getDialogs in
    // virtual-mtproto-server.ts.
    if(typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) {
      throw new Error(`mapPubkeyToPeerId: invalid pubkey input (expected 64-hex, got ${typeof pubkey === 'string' ? `${pubkey.length} chars` : typeof pubkey})`);
    }

    // Check cache first
    if(this.pubkeyCache.has(pubkey)) {
      return this.pubkeyCache.get(pubkey)!;
    }

    const pubkeyBytes = hexToBytes(pubkey);
    // Hash the FULL pubkey bytes (not just first 8) for consistency
    const hashBuffer = await crypto.subtle.digest('SHA-256', pubkeyBytes);
    const hashBytes = new Uint8Array(hashBuffer);
    const hashBigInt = bigEndianUint64(hashBytes);

    const peerId = Number(VIRTUAL_PEER_BASE + (hashBigInt % VIRTUAL_PEER_RANGE));

    // Store in cache for subsequent calls
    this.pubkeyCache.set(pubkey, peerId);

    return peerId;
  }

  /**
   * Map a Nostr event ID (hex or text) to a deterministic virtual message ID.
   * The mid encodes the timestamp in the high bits so that SlicedArray's
   * descending numeric sort produces chronological order:
   *   mid = timestamp * 1_000_000 + (hash % 1_000_000)
   * The hash suffix disambiguates messages within the same second.
   * Max value: ~1_712_345_678 * 1e6 + 999_999 ≈ 1.71e15 — within JS safe integer range (2^53-1 ≈ 9.0e15).
   */
  async mapEventIdToMid(eventId: string, timestamp: number): Promise<number> {
    const cacheKey = `${eventId}:${timestamp}`;
    if(this.midCache.has(cacheKey)) {
      return this.midCache.get(cacheKey)!;
    }

    // Detect hex vs text: hex event IDs are 64 chars of [0-9a-f]
    const isHex = /^[0-9a-f]+$/i.test(eventId) && eventId.length >= 8;
    const eventBytes = isHex ?
      hexToBytes(eventId) :
      new TextEncoder().encode(eventId);
    // Hash the FULL event ID (not just first 8 bytes — short text IDs like
    // "chat-xxx-0" would collide since they share the same prefix)
    const hashBuffer = await crypto.subtle.digest('SHA-256', eventBytes);
    const hashBytes = new Uint8Array(hashBuffer);
    const hashBigInt = bigEndianUint64(hashBytes);

    const TIMESTAMP_MULTIPLIER = BigInt(1_000_000);
    const ts = BigInt(Math.floor(timestamp));
    const mid = Number(ts * TIMESTAMP_MULTIPLIER + (hashBigInt % TIMESTAMP_MULTIPLIER));

    this.midCache.set(cacheKey, mid);

    return mid;
  }

  /**
   * Reverse lookup: given a virtual peer ID, return the associated Nostr pubkey.
   * Delegates to IndexedDB — returns null if the peerId has not been stored.
   */
  async reverseLookup(peerId: number): Promise<string | null> {
    return getPubkey(peerId);
  }

  /**
   * Store a pubkey ↔ peerId mapping in IndexedDB and in-memory cache.
   * Call this after deriving a peerId to persist the reverse lookup entry.
   */
  async storePeerMapping(
    pubkey: string,
    peerId: number,
    displayName?: string
  ): Promise<void> {
    await storeMapping(pubkey, peerId, displayName);
    // Ensure cache is also populated so future lookups hit memory
    this.pubkeyCache.set(pubkey, peerId);
  }

  /**
   * Rebuild the pubkey↔peerId reverse-mapping from locally stored message
   * history. Heals installs whose mappings never reached IndexedDB — e.g. a
   * peer we only ever *received* from (before the receive-path persistence
   * fix), or an account reloaded from a stored identity. Without this, the
   * Virtual MTProto send path drops silently at its `!peerPubkey` guard
   * ("VMT returned no phantomchatMid") for every such peer, while receiving
   * keeps working because the pubkey comes straight off the inbound event.
   *
   * Conversation IDs are `[pubkeyA, pubkeyB].sort().join(':')` (see
   * MessageStore.getConversationId), so each 1:1 id carries exactly two
   * 64-hex pubkeys. We split, drop our own pubkey, and persist a mapping for
   * every remaining peer not already cached. Anything that isn't two
   * colon-joined 64-hex pubkeys (e.g. group-conv ids) is skipped. Wholly
   * best-effort — a single failure never blocks identity load.
   *
   * @returns the number of mappings newly persisted.
   */
  async backfillPeerMappingsFromHistory(ownPubkey: string): Promise<number> {
    let restored = 0;
    try {
      const {getMessageStore} = await import('./message-store');
      const conversationIds = await getMessageStore().getAllConversationIds();
      const seen = new Set<string>();

      for(const conversationId of conversationIds) {
        const parts = conversationId.split(':');
        // Only 1:1 conversations encode exactly two pubkeys. Skip the rest.
        if(parts.length !== 2) continue;

        for(const pubkey of parts) {
          if(pubkey === ownPubkey || seen.has(pubkey)) continue;
          seen.add(pubkey);
          if(!/^[0-9a-f]{64}$/i.test(pubkey)) continue;
          // Already mapped (init pre-loaded IndexedDB into pubkeyCache).
          if(this.pubkeyCache.has(pubkey)) continue;

          try {
            const peerId = await this.mapPubkeyToPeerId(pubkey);
            await this.storePeerMapping(pubkey, peerId);
            restored++;
          } catch(err) {
            console.warn('[PhantomChatBridge] backfill mapping failed for peer:', err);
          }
        }
      }
    } catch(err) {
      console.warn('[PhantomChatBridge] backfillPeerMappingsFromHistory failed (non-fatal):', err);
    }

    if(restored > 0) {
      console.log('[PhantomChatBridge] backfilled', restored, 'peer mapping(s) from message history');
    }
    return restored;
  }

  /**
   * Derive a deterministic CSS gradient avatar from a Nostr pubkey.
   * Uses the first 6 hex chars of SHA-256(pubkey) as the HSL hue.
   * Returns a valid CSS linear-gradient string.
   */
  async deriveAvatarFromPubkey(pubkey: string): Promise<string> {
    const pubkeyBytes = hexToBytes(pubkey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', pubkeyBytes);
    const hashBytes = new Uint8Array(hashBuffer);

    // Use first 6 hex chars of the hash as hue (2 hex chars → 1 byte → 0-255 → 0-360)
    const hue = Math.round((hashBytes[0] * 360) / 256);
    const hue2 = (hue + 40) % 360;

    return `linear-gradient(135deg, hsl(${hue}, 70%, 60%), hsl(${hue2}, 70%, 45%))`;
  }

  /**
   * Synchronous avatar derivation using only the first 8 bytes of the pubkey.
   * Faster for cases where async crypto.subtle is not acceptable.
   */
  deriveAvatarFromPubkeySync(pubkey: string): string {
    const pubkeyBytes = hexToBytes(pubkey);
    // Simple hash of the first 8 bytes using typed array methods
    let hash = 0;
    for(let i = 0; i < 8; i++) {
      hash = ((hash << 5) - hash + pubkeyBytes[i]) | 0;
    }
    const hue = Math.abs(hash) % 360;
    const hue2 = (hue + 40) % 360;
    return `linear-gradient(135deg, hsl(${hue}, 70%, 60%), hsl(${hue2}, 70%, 45%))`;
  }

  /**
   * Create a synthetic tweb User object for a P2P peer.
   */
  createSyntheticUser(
    pubkey: string,
    peerId: number,
    displayName?: string
  ): P2PUser {
    const firstName = displayName ?? 'P2P User';
    const avatar = this.deriveAvatarFromPubkeySync(pubkey);

    return {
      _: 'user',
      id: peerId,
      pFlags: {},
      first_name: firstName,
      p2pPubkey: pubkey,
      p2pAvatar: avatar
    };
  }
}

/**
 * True when the given peerId is a PhantomChat P2P peer (derived from a Nostr
 * pubkey), false when it's a regular tweb peerId. P2P peerIds fall inside
 * [VIRTUAL_PEER_BASE, VIRTUAL_PEER_BASE + VIRTUAL_PEER_RANGE) per the
 * SHA-256 mapping in mapPubkeyToPeerId above. The threshold check is exact
 * because VIRTUAL_PEER_BASE is a well-defined constant >= 1e15.
 */
export function isP2PPeer(peerId: number): boolean {
  if(!Number.isFinite(peerId)) return false;
  return peerId >= 1e15;
}
