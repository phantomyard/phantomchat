/**
 * Nostra.chat Bridge
 *
 * Singleton that provides bidirectional translation between Nostr pubkeys/eventIds
 * and Telegram virtual peer IDs/message IDs.
 *
 * Forward mapping (pubkey → peerId, eventId → mid) is deterministic via SHA-256.
 * Reverse mapping (peerId → pubkey) requires IndexedDB due to hash irreversibility.
 */

import type {User} from '@layer';
import {initVirtualPeersDB, storeMapping, getPubkey, getAllMappings} from './virtual-peers-db';
import {NostrRelayPool, DEFAULT_RELAYS} from './nostr-relay-pool';
import {OfflineQueue} from './offline-queue';
import {PrivacyTransport} from './privacy-transport';
import {MeshManager} from '@lib/nostra/mesh-manager';
import {MessageRouter} from '@lib/nostra/message-router';
import {isSignalKind} from '@lib/nostra/mesh-signaling';
import rootScope from '@lib/rootScope';
import {swallowHandler} from '@lib/nostra/log-swallow';

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

export class NostraBridge {
  private static _instance: NostraBridge | null = null;

  private _initialized = false;
  private _userPubkey: string | null = null;

  /** In-memory cache: pubkey → peerId (avoid recomputing SHA-256 on repeated calls) */
  private pubkeyCache = new Map<string, number>();

  /** In-memory cache: eventId → mid */
  private midCache = new Map<string, number>();

  /** Relay pool, transport, and queue references */
  private _relayPool: NostrRelayPool | null = null;
  private _privacyTransport: PrivacyTransport | null = null;
  private _offlineQueue: OfflineQueue | null = null;

  private constructor() {}

  static getInstance(): NostraBridge {
    const win = typeof window !== 'undefined' ? window as any : null;
    if(win?.__nostraBridgeInstance) {
      NostraBridge._instance = win.__nostraBridgeInstance;
      return NostraBridge._instance;
    }
    if(!NostraBridge._instance) {
      NostraBridge._instance = new NostraBridge();
      if(win) win.__nostraBridgeInstance = NostraBridge._instance;
    }
    return NostraBridge._instance;
  }

  /**
   * Initialize the bridge with the current user's pubkey.
   * Opens IndexedDB, pre-loads existing mappings, and bootstraps PrivacyTransport.
   */
  async init(userPubkey: string): Promise<void> {
    this._userPubkey = userPubkey;
    await initVirtualPeersDB();

    // Pre-load all existing mappings into the pubkeyCache
    const mappings = await getAllMappings();
    for(const m of mappings) {
      this.pubkeyCache.set(m.pubkey, m.peerId);
    }

    // Bootstrap relay pool + privacy transport
    this.initTransport();

    this._initialized = true;
  }

  /**
   * Initialize NostrRelayPool, OfflineQueue, and PrivacyTransport.
   *
   * Privacy-critical ordering:
   *   - Tor enabled (default): start PrivacyTransport.bootstrap() FIRST and
   *     wait until it reaches a settled state ('active', 'direct', or
   *     'failed') before calling pool.initialize(). This guarantees no
   *     WebSocket is ever opened while the Tor circuit is still building.
   *     During bootstrap the app is still usable — chats read from the
   *     local IndexedDB store and outgoing messages queue in OfflineQueue.
   *   - Tor disabled: pool.initialize() runs immediately (legacy path).
   */
  private initTransport(): void {
    const pool = new NostrRelayPool({
      relays: [...DEFAULT_RELAYS],
      onMessage: () => {
        // Message routing is handled by Phase 4
      }
    });

    const queue = new OfflineQueue(pool);
    const transport = new PrivacyTransport(pool, queue);

    this._relayPool = pool;
    this._offlineQueue = queue;
    this._privacyTransport = transport;

    // Expose for topbar and debug
    if(typeof window !== 'undefined') {
      (window as any).__nostraPool = pool;
      (window as any).__nostraTransport = transport;
    }

    const mode = PrivacyTransport.readMode();

    if(mode === 'off') {
      // No Tor path at all — go direct immediately.
      pool.initialize().catch(() => {});
    } else if(mode === 'when-available') {
      // Direct-first path with background Tor upgrade. No banner.
      transport.bootstrap();
      pool.initialize().catch(() => {});
    } else {
      // mode === 'only' — mount the startup banner, wait for Tor before opening the pool.
      if(typeof window !== 'undefined') {
        void this.mountTorStartupBanner();
      }
      transport.bootstrap();
      // Gate pool.initialize until the transport reaches tor-active. We poll via
      // nostra_tor_state because waitUntilSettled is deprecated.
      const onceActive = new Promise<void>((resolve) => {
        const handler = (e: {state: unknown}) => {
          if(e.state === 'tor-active') {
            rootScope.removeEventListener('nostra_tor_state', handler);
            resolve();
          }
        };
        rootScope.addEventListener('nostra_tor_state', handler);
      });
      onceActive.then(() => pool.initialize()).catch(() => {});
    }

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

      (window as any).__nostraMiniRelayWorker = miniRelayWorker;

      rootScope.addEventListener('nostra_contact_accepted', () => {
        const contacts = (window as any).__nostraContacts || [];
        miniRelayWorker.postMessage({type: 'update-contacts', contactPubkeys: contacts});
      });

      // Initialize mesh manager
      const meshManager = new MeshManager({
        sendSignal: async(recipientPubkey, signal) => {
          const chatAPI = (window as any).__nostraChatAPI;
          if(chatAPI) {
            await chatAPI.publishSignal?.(recipientPubkey, signal.content);
          }
        },
        onPeerMessage: (pubkey, message) => {
          miniRelayWorker.postMessage({type: 'peer-message', peerId: pubkey, data: message});
        },
        onPeerConnected: (pubkey) => {
          miniRelayWorker.postMessage({type: 'peer-connected', peerId: pubkey, pubkey});
          rootScope.dispatchEvent('nostra_mesh_peer_connected', {pubkey, latency: -1});
        },
        onPeerDisconnected: (pubkey) => {
          miniRelayWorker.postMessage({type: 'peer-disconnected', peerId: pubkey});
          rootScope.dispatchEvent('nostra_mesh_peer_disconnected', {pubkey});
        }
      });

      // Initialize message router
      const messageRouter = new MessageRouter({
        meshManager,
        relayPublish: async(event) => {
          const pool = (window as any).__nostraPool;
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
          return (window as any).__nostraContacts || [];
        }
      });

      // Expose for debugging
      (window as any).__nostraMeshManager = meshManager;
      (window as any).__nostraMessageRouter = messageRouter;

      // Handle incoming signals from gift-wrap messages
      rootScope.addEventListener('nostra_new_message', (e) => {
        const msg = e.message as any;
        if(msg?.rumorKind && isSignalKind(msg.rumorKind)) {
          meshManager.handleSignal(e.senderPubkey, msg.content);
        }
      });

      // Auto-connect to contacts after backfill
      rootScope.addEventListener('nostra_backfill_complete', () => {
        const contacts = (window as any).__nostraContacts || [];
        for(const pubkey of contacts) {
          setTimeout(() => {
            meshManager.connect(pubkey).catch(swallowHandler('NostraBridge.autoConnectMesh'));
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

  /** Get the privacy transport instance */
  getPrivacyTransport(): PrivacyTransport | null {
    return this._privacyTransport;
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
   * Mount the Tor startup banner on document.body. Lazy-loads the Solid
   * component so the extra weight only lands when Tor is in `only` mode.
   * The banner has no user-facing buttons; the only escape hatch is the
   * Tor mode switch in Privacy & Security.
   */
  private async mountTorStartupBanner(): Promise<void> {
    const transport = this._privacyTransport;
    if(!transport) return;

    const [{default: TorStartupBanner}, {render}] = await Promise.all([
      import('@components/nostra/torStartupBanner'),
      import('solid-js/web')
    ]);

    const bannerEl = document.createElement('div');
    bannerEl.classList.add('tor-startup-banner-mount');
    document.body.append(bannerEl);

    render(() => TorStartupBanner(), bannerEl);
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
 * True when the given peerId is a Nostra P2P peer (derived from a Nostr
 * pubkey), false when it's a regular tweb peerId. P2P peerIds fall inside
 * [VIRTUAL_PEER_BASE, VIRTUAL_PEER_BASE + VIRTUAL_PEER_RANGE) per the
 * SHA-256 mapping in mapPubkeyToPeerId above. The threshold check is exact
 * because VIRTUAL_PEER_BASE is a well-defined constant >= 1e15.
 */
export function isP2PPeer(peerId: number): boolean {
  if(!Number.isFinite(peerId)) return false;
  return peerId >= 1e15;
}
