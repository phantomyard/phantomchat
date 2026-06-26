/**
 * Nostr Relay Storage - NIP-17 gift-wrapped message storage and retrieval
 *
 * Provides offline message storage via Nostr relays using kind 1059 gift-wrapped
 * direct messages (NIP-17). Messages are encrypted with NIP-44 inside a
 * rumor(14) -> seal(13) -> gift-wrap(1059) envelope for metadata privacy.
 *
 * Migration history:
 * - Phase 2: NIP-04 removed, all encryption moved to NIP-44
 * - Phase 4: Kind 4 removed, all messaging moved to NIP-17 gift-wrap (kind 1059)
 */

import {Logger, logger} from '@lib/logger';
import * as secp256k1 from '@noble/secp256k1';
import {wrapV2, wrapNip17Message, isV2Event} from './nostr-crypto';
import {getNostrUnwrapClient} from './nostr-unwrap-client';
import {finalizeEvent, verifyEvent} from 'nostr-tools/pure';
import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from './key-storage';
import {importFromStored} from './nostr-identity';
import {logSwallow, swallowHandler} from './log-swallow';

// Use the etc namespace for utility functions
const {bytesToHex, hexToBytes} = secp256k1.etc;

/**
 * NIP-17 gift-wrap event kind (kind 1059)
 */
export const NOSTR_KIND_GIFTWRAP = 1059;

/**
 * Kind 0 metadata event
 */
export const NOSTR_KIND_METADATA = 0;

/**
 * NIP-25 reaction event (kind 7) — plaintext, referenced via e/p tags.
 */
export const NOSTR_KIND_REACTION = 7;

/**
 * NIP-09 delete event (kind 5) — used by PhantomChat to retract a kind-7 reaction.
 */
export const NOSTR_KIND_DELETE = 5;

/**
 * Typing indicator (kind 20001) — a NIP-16 EPHEMERAL event (range 20000–29999).
 * Relays do NOT store ephemeral events; they only fan them out to connected
 * subscribers. That makes typing perfect as a transient signal: it cannot be
 * replayed on reconnect and self-expires the instant nobody is listening. The
 * sender (phantombot, or any PhantomChat peer) p-tags the recipient; the
 * recipient injects a native `updateUserTyping` (three-dots, 6s auto-expiry).
 * Must match phantombot's `NOSTR_KIND_TYPING`.
 */
export const NOSTR_KIND_TYPING = 20001;

/**
 * NIP-38 user-status / presence (kind 30315, parameterized-replaceable). A peer
 * (phantombot, or any PhantomChat client) republishes one of these on a ~60s
 * heartbeat, p-tagged to us and carrying `["status","online"]`. We treat each as
 * a liveness beat: the contact shows a REAL "Online" while beats arrive and
 * flips to "last seen at HH:MM" once they stop past the offline threshold. Like
 * typing it's plaintext (not gift-wrapped) and routed through the raw-event
 * handler. Must match phantombot's `NOSTR_KIND_PRESENCE`.
 */
export const NOSTR_KIND_PRESENCE = 30315;

/**
 * Decrypted message structure returned by getMessages.
 * After NIP-17 migration, includes rumor kind and tags for routing.
 */
export interface DecryptedMessage {
  id: string;
  from: string;
  content: string;
  timestamp: number;
  /** Rumor kind: 14 = text DM, 15 = file message */
  rumorKind?: number;
  /** Rumor tags (e.g., receipt-type, file metadata) */
  tags?: string[][];
}

/**
 * Generic Nostr event
 */
export interface NostrEvent {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

/**
 * Singleton relay instance for publishing events.
 * Set by NostrRelay.initialize() when the relay connects.
 */
let activeRelay: NostrRelay | null = null;

/**
 * Publish a kind 0 metadata event to the active relay.
 * Used by identity settings to update profile information.
 */
export async function publishKind0Metadata(metadata: {
  name?: string;
  display_name?: string;
  nip05?: string;
  about?: string;
  picture?: string;
  website?: string;
  lud16?: string;
}): Promise<string> {
  if(!activeRelay) {
    throw new Error('No active relay connection. Connect to a relay first.');
  }

  return activeRelay.publishMetadataEvent(metadata);
}

/**
 * Publish a signed event to the active relay.
 */
export async function publishEvent(event: NostrEvent): Promise<void> {
  if(!activeRelay) {
    throw new Error('No active relay connection. Connect to a relay first.');
  }

  activeRelay.sendRawEvent(event);
}

/**
 * NostrRelay - NIP-44 encrypted message storage and retrieval
 *
 * Stores encrypted direct messages on Nostr relays as kind 1059 gift-wrap events.
 * When the recipient comes online, messages can be retrieved and unwrapped.
 */
export class NostrRelay {
  private relayUrl: string;
  private ws: WebSocket | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  private log: Logger;

  // Identity
  private privateKey: Uint8Array = new Uint8Array();
  private publicKey: string = '';
  private ownId: string = '';

  // Message handler
  private onMessageHandler: ((message: DecryptedMessage) => void) | null = null;

  // Raw event handler — fires for non-giftwrap kinds that the subscription
  // filter allows through (kind-7 reactions, kind-5 deletes). Plaintext
  // Nostr events are NOT unwrapped since they have no rumor envelope.
  private onRawEventHandler: ((event: NostrEvent) => void) | null = null;

  // Receipt handler (delivery/read receipts)
  private onReceiptHandler: ((receipt: {eventId: string; type: 'delivery' | 'read'; from: string}) => void) | null = null;

  // Pre-decrypt dedup gate. Returns true the FIRST time an event id is seen and
  // false thereafter. Set by the pool to a SHARED (pool-wide) seen-set so that
  // the SAME gift-wrap arriving from multiple relays — or replayed on a
  // reconnect backfill — is verified + NIP-44-decrypted ONCE, not once per
  // relay. Gift-wrap unwrap is the dominant main-thread cost (secp256k1), so
  // skipping it for duplicates before any crypto runs is the single biggest
  // snappiness win. No-op (everything processed) when unset.
  private claimEvent: ((eventId: string) => boolean) | null = null;

  // State change callback — notifies pool when relay connects/disconnects
  public onStateChange: ((state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting') => void) | null = null;

  // Latency update callback — fires whenever measureLatency updates latencyMs.
  // Pool re-dispatches as phantomchat_relay_state.
  public onLatencyUpdate: ((latencyMs: number) => void) | null = null;

  // Subscription management
  private subscriptionId: string = '';
  private isSubscribed: boolean = false;
  public pendingSubscribe: boolean = false;
  // WU-3: resolves when the relay sends EOSE for the message subscription
  // (the "live from here" marker). null until subscribeMessages() arms it.
  private subscriptionReady: {promise: Promise<boolean>; resolve: (v: boolean) => void} | null = null;

  // Reconnection — fast retries first, then persistent backoff.
  // After the initial burst (1s, 2s, 4s), retries continue every 10s
  // indefinitely. A relay glitch should not permanently kill the subscription.
  private reconnectAttempts: number = 0;
  private readonly reconnectBurstDelays: number[] = [1000, 2000, 4000];
  private readonly reconnectBackoffMs: number = 10000;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Outbound publish buffer (FIND-3786a35f / double-message fix). A DM sent
  // while the socket is still mid-connect (cold page load — the SW reconnects
  // every relay WS and presence beats only start landing once they're OPEN)
  // used to throw out of publishRawEvent and be silently dropped: the relay
  // pool's publish() recorded a per-relay failure but had NO retry layer
  // despite safeSend's comment claiming one. Net effect: the FIRST message in a
  // fresh session vanished, the second (sockets now OPEN) went through — the
  // "have to message Lena twice" bug. Fix: buffer STORED events (gift-wraps,
  // deletes, reactions, metadata) when the socket isn't OPEN and flush them on
  // the next onopen. Ephemeral events (typing/presence, kind 20000–29999) are
  // worthless once stale, so they are NOT buffered.
  private pendingPublishes: {payload: string; expiresAt: number}[] = [];
  private readonly maxPendingPublishes: number = 50;
  private readonly pendingPublishTtlMs: number = 30000;

  // Latency tracking
  private latencyMs: number = -1;
  public directLatencyMs: number = -1;
  private latencyInterval: ReturnType<typeof setInterval> | null = null;
  private readonly latencyRefreshMs: number = 60000;

  /**
   * Create a new NostrRelay
   * @param relayUrl - WebSocket URL of the Nostr relay
   */
  constructor(relayUrl: string = 'wss://relay.damus.io') {
    this.relayUrl = relayUrl;
    this.log = logger('NostrRelay');
    this.subscriptionId = `phantomchat-msgs-${Date.now()}`;

    // Expose for debug inspection
    if(typeof window !== 'undefined') {
      (window as any).__phantomchatNostrRelay = this;
    }
  }

  /**
   * Initialize the relay with identity from IndexedDB
   */
  async initialize(): Promise<void> {
    this.log('[NostrRelay] initializing with relay:', this.relayUrl);

    try {
      // Load from new encrypted identity store
      const record = await loadEncryptedIdentity();
      if(!record) {
        throw new Error('No identity found. Please create or import an identity first.');
      }

      const browserKey = await loadBrowserKey();
      if(!browserKey) {
        throw new Error('Browser key missing — cannot decrypt identity.');
      }

      const {seed, nsec} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
      const identity = importFromStored({seed, nsec});

      this.ownId = identity.npub;

      // Convert hex private key to Uint8Array
      this.privateKey = hexToBytes(identity.privateKey);

      // Derive 32-byte x-only public key from private key
      this.publicKey = identity.publicKey;

      // Register as active relay for publishEvent/publishKind0Metadata
      activeRelay = this;

      this.log('[NostrRelay] initialized for npub:', this.ownId.slice(0, 12) + '...', 'pubkey:', this.publicKey.slice(0, 8) + '...');
    } catch(err) {
      this.log.error('[NostrRelay] initialization failed:', err);
      throw err;
    }
  }

  /**
   * Connect to the Nostr relay
   */
  connect(): void {
    if(this.connectionState === 'connected' || this.connectionState === 'connecting') {
      this.log('[NostrRelay] already connected or connecting');
      return;
    }

    this.log('[NostrRelay] connecting to relay:', this.relayUrl);
    this.setConnectionState('connecting');

    try {
      this.ws = new WebSocket(this.relayUrl);

      this.ws.onopen = () => {
        this.log('[NostrRelay] connected to relay');
        this.setConnectionState('connected');
        this.reconnectAttempts = 0;

        // Subscribe if we were subscribed before OR if pool wants subscription
        if(this.isSubscribed || this.pendingSubscribe) {
          this.pendingSubscribe = false;
          this.subscribeMessages();
        }

        // Flush any stored-event publishes buffered while the socket was
        // opening (the double-message / first-DM-dropped fix).
        this.flushPendingPublishes();

        this.startLatencyRefresh();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        this.log.error('[NostrRelay] WebSocket error:', error);
      };

      this.ws.onclose = (event) => {
        this.log('[NostrRelay] relay connection closed:', event.code, event.reason);
        this.handleDisconnect();
      };
    } catch(err) {
      this.log.error('[NostrRelay] failed to create WebSocket:', err);
      this.handleDisconnect();
    }
  }

  /**
   * Send a payload only if the underlying WebSocket is OPEN.
   *
   * Why: callers reach this from `setTimeout` closures (query timeouts) and
   * from state-change cascades (`onopen`/`onclose` → pool → backfill). Between
   * scheduling and firing the socket can transition to CONNECTING (during
   * reconnect) or CLOSING — calling `send()` then throws `InvalidStateError`.
   * Skipping silently is correct: a CLOSE on a stale subscription is a no-op
   * for the remote, and publishes that race a reconnect are retried by the
   * relay pool's higher-level retry layer.
   */
  private safeSend(payload: string): boolean {
    const ws = this.ws;
    if(ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      return true;
    }
    return false;
  }

  /**
   * Disconnect from the relay
   */
  disconnect(): void {
    this.log('[NostrRelay] disconnecting');

    this.stopLatencyRefresh();
    this.setLatency(-1);

    if(this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if(this.ws) {
      this.ws.onclose = null; // Prevent reconnection logic
      this.ws.close();
      this.ws = null;
    }

    this.setConnectionState('disconnected');
    this.isSubscribed = false;
    this.subscriptionReady?.resolve(false);
    this.subscriptionReady = null;

    // Unregister as active relay
    if(activeRelay === this) {
      activeRelay = null;
    }
  }

  /**
   * Store an encrypted message on the relay via NIP-17 gift-wrap.
   *
   * Wraps the plaintext as kind 14 rumor -> kind 13 seal -> kind 1059 gift-wrap
   * and publishes ALL resulting events (recipient wrap + self-send wrap).
   *
   * @param recipientPubkey - Recipient's hex public key (32-byte x-coordinate)
   * @param plaintext - Message content to encrypt
   * @returns Event ID of the recipient's gift-wrap event
   */
  async storeMessage(recipientPubkey: string, plaintext: string): Promise<string> {
    if(this.connectionState !== 'connected') {
      this.log.warn('[NostrRelay] cannot publish: not connected');
      throw new Error('Not connected to relay');
    }

    this.log('[NostrRelay] storing gift-wrapped message for:', recipientPubkey.slice(0, 8) + '...');

    try {
      // Use v2 (AES-256-GCM) with legacy fallback
      let wraps;
      try {
        const {event} = await wrapV2(this.privateKey, recipientPubkey, plaintext);
        wraps = [event];
      } catch{
        // Fallback to legacy NIP-17 wrap
        wraps = wrapNip17Message(this.privateKey, recipientPubkey, plaintext).wraps;
      }

      // Publish ALL wraps to relay (self-send + recipient)
      for(const wrap of wraps) {
        this.safeSend(JSON.stringify(['EVENT', wrap]));
      }

      // Return the first event ID (recipient wrap)
      const eventId = wraps[0]?.id || '';
      this.log('[NostrRelay] published', wraps.length, 'gift-wrap event(s), ID:', eventId.slice(0, 8) + '...');

      return eventId;
    } catch(err) {
      this.log.error('[NostrRelay] failed to store message:', err);
      throw err;
    }
  }

  /**
   * Retrieve messages from the relay addressed to us
   *
   * Queries the relay for kind 1059 gift-wrap events where we're the recipient,
   * decrypts each message, and returns them.
   *
   * @param since - Optional Unix timestamp to query messages after
   * @returns Array of decrypted messages
   */
  async getMessages(since?: number): Promise<DecryptedMessage[]> {
    if(this.connectionState !== 'connected') {
      this.log.warn('[NostrRelay] cannot query: not connected');
      return [];
    }

    this.log('[NostrRelay] querying messages', since ? `since ${since}` : '(all)');

    // Build filter for kind 1059 gift-wrap events
    const filter: Record<string, unknown> = {
      'kinds': [NOSTR_KIND_GIFTWRAP],
      '#p': [this.publicKey]
    };

    if(since) {
      filter.since = since;
    }

    // Send query with a unique subscription ID
    const queryId = `phantomchat-query-${Date.now()}`;
    const collected: DecryptedMessage[] = [];

    // Create a promise that resolves on EOSE or times out after 10s
    const result = await new Promise<DecryptedMessage[]>((resolve) => {
      const timeout = setTimeout(() => {
        this.log.warn('[NostrRelay] query timeout for:', queryId, 'returning', collected.length, 'partial results');
        this.queryResolvers.delete(queryId);
        this.safeSend(JSON.stringify(['CLOSE', queryId]));
        resolve(collected);
      }, 10_000);

      this.queryResolvers.set(queryId, {
        events: collected,
        inflight: [],
        resolve: (events) => {
          clearTimeout(timeout);
          resolve(events);
        }
      });

      this.safeSend(JSON.stringify(['REQ', queryId, filter]));
    });

    this.log('[NostrRelay] query complete:', result.length, 'messages');
    return result;
  }

  /**
   * Generic raw query — returns unwrapped NostrEvents matching a filter.
   * Unlike getMessages(), this does NOT assume gift-wrap and does not decrypt.
   * Used for querying replaceable events (e.g., kind 30078 folder snapshots).
   */
  async queryRawEvents(filter: Record<string, unknown>): Promise<NostrEvent[]> {
    if(this.connectionState !== 'connected') {
      return [];
    }

    const queryId = `phantomchat-raw-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const collected: NostrEvent[] = [];

    return new Promise<NostrEvent[]>((resolve) => {
      const timeout = setTimeout(() => {
        this.rawQueryResolvers.delete(queryId);
        this.safeSend(JSON.stringify(['CLOSE', queryId]));
        resolve(collected);
      }, 10_000);

      this.rawQueryResolvers.set(queryId, {
        events: collected,
        resolve: (events) => {
          clearTimeout(timeout);
          resolve(events);
        }
      });

      this.safeSend(JSON.stringify(['REQ', queryId, filter]));
    });
  }

  /**
   * Subscribe to incoming messages
   *
   * Sets up a subscription to receive kind 1059 gift-wrap events addressed to us
   * in real-time as they arrive on the relay.
   */
  subscribeMessages(): void {
    if(this.isSubscribed) {
      this.log('[NostrRelay] already subscribed to messages');
      return;
    }

    if(this.connectionState !== 'connected') {
      this.log.warn('[NostrRelay] cannot subscribe: not connected');
      return;
    }

    this.log('[NostrRelay] subscribing to messages');

    const filter: Record<string, unknown> = {
      // No NOSTR_KIND_PRESENCE (30315): presence was removed, so we don't ask
      // relays for peers' status heartbeats — that's wasted bandwidth + crypto.
      'kinds': [NOSTR_KIND_GIFTWRAP, NOSTR_KIND_REACTION, NOSTR_KIND_DELETE, NOSTR_KIND_TYPING],
      '#p': [this.publicKey]
    };

    // WU-3: arm the readiness barrier BEFORE sending REQ, and only mark
    // subscribed if the REQ actually went out. Previously isSubscribed was set
    // unconditionally even when safeSend dropped the frame (socket not OPEN),
    // so a cold client believed it was subscribed and silently missed the
    // first events. Callers can await whenSubscribed() for the relay's EOSE.
    this.armSubscriptionReady();
    if(!this.safeSend(JSON.stringify(['REQ', this.subscriptionId, filter]))) {
      this.log.warn('[NostrRelay] subscribeMessages: REQ not sent (socket not open); will retry');
      return;
    }
    this.isSubscribed = true;
  }

  /** WU-3: (re)arm the EOSE readiness deferred. */
  private armSubscriptionReady(): void {
    let resolve!: (v: boolean) => void;
    const promise = new Promise<boolean>((r) => {resolve = r;});
    this.subscriptionReady = {promise, resolve};
  }

  /**
   * WU-3: resolve true once the relay has sent EOSE for the message
   * subscription (live events are now flowing), or false on timeout / when not
   * subscribed. Never rejects or hangs — safe to await on the boot path.
   */
  whenSubscribed(timeoutMs = 8000): Promise<boolean> {
    if(!this.subscriptionReady) return Promise.resolve(this.isSubscribed);
    return Promise.race([
      this.subscriptionReady.promise,
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))
    ]);
  }

  /**
   * Unsubscribe from messages
   */
  unsubscribeMessages(): void {
    if(!this.isSubscribed) {
      return;
    }

    this.log('[NostrRelay] unsubscribing from messages');

    this.safeSend(JSON.stringify(['CLOSE', this.subscriptionId]));
    this.isSubscribed = false;
  }

  /**
   * Register a handler for incoming messages
   */
  onMessage(handler: (message: DecryptedMessage) => void): void {
    this.onMessageHandler = handler;
  }

  /**
   * Install the shared pre-decrypt dedup gate (see `claimEvent`). The pool wires
   * this to a pool-wide LRU so duplicate wraps across relays/replays skip all
   * crypto.
   */
  setEventDedup(fn: (eventId: string) => boolean): void {
    this.claimEvent = fn;
  }

  /**
   * Register a handler for raw (non-giftwrap) events — currently kind-7
   * reactions and kind-5 deletes that the subscription filter admits.
   */
  onRawEvent(handler: (event: NostrEvent) => void): void {
    this.onRawEventHandler = handler;
  }

  /**
   * Register a handler for delivery/read receipts
   */
  onReceipt(handler: (receipt: {eventId: string; type: 'delivery' | 'read'; from: string}) => void): void {
    this.onReceiptHandler = handler;
  }

  /**
   * Publish a pre-built signed event to the relay.
   * Used by relay pool to publish pre-wrapped gift-wrap events.
   */
  publishRawEvent(event: NostrEvent): void {
    const payload = JSON.stringify(['EVENT', event]);

    // Fast path: socket OPEN → send live.
    if(this.connectionState === 'connected' && this.safeSend(payload)) {
      return;
    }

    // Socket not OPEN (cold-load connecting, or a reconnect race). Ephemeral
    // events (typing/presence) are pointless once stale — preserve the old
    // throw-and-drop behaviour. Stored events MUST NOT be lost: buffer and
    // flush on reconnect so a message sent while the socket is still opening
    // still reaches the relay.
    const isEphemeral = event.kind >= 20000 && event.kind < 30000;
    if(isEphemeral) {
      throw new Error('Not connected to relay');
    }

    this.bufferPendingPublish(payload);
  }

  /**
   * Queue a stored-event payload for delivery on the next successful connect.
   * Bounded by count and TTL so a long offline stretch can't grow unbounded or
   * flush hopelessly-stale events. Kicks a connect if we're fully disconnected.
   */
  private bufferPendingPublish(payload: string): void {
    const now = Date.now();
    // Evict expired before appending.
    this.pendingPublishes = this.pendingPublishes.filter(p => p.expiresAt > now);
    this.pendingPublishes.push({payload, expiresAt: now + this.pendingPublishTtlMs});
    // Drop oldest if over cap.
    while(this.pendingPublishes.length > this.maxPendingPublishes) {
      this.pendingPublishes.shift();
    }
    this.log('[NostrRelay] buffered publish (socket not open); pending:', this.pendingPublishes.length);
    // Make sure something is driving us back to connected.
    if(this.connectionState === 'disconnected') {
      this.connect();
    }
  }

  /**
   * Flush buffered stored-event publishes after the socket reopens. Expired
   * entries are discarded; anything that re-races a flapping socket is kept for
   * the next onopen. Called from the onopen handler.
   */
  private flushPendingPublishes(): void {
    if(this.pendingPublishes.length === 0) return;
    const now = Date.now();
    const queued = this.pendingPublishes;
    this.pendingPublishes = [];
    let flushed = 0;
    let dropped = 0;
    for(const p of queued) {
      if(p.expiresAt <= now) {
        dropped++;
        continue;
      }
      if(this.safeSend(p.payload)) {
        flushed++;
      } else {
        // Socket flapped between onopen and here — requeue for the next open.
        this.pendingPublishes.push(p);
      }
    }
    if(flushed || dropped) {
      this.log(`[NostrRelay] flushed ${flushed} buffered publish(es), dropped ${dropped} expired`);
    }
  }

  /**
   * Get the current connection state
   */
  getState(): string {
    return this.connectionState;
  }

  /**
   * Get the public key being used
   */
  getPublicKey(): string {
    return this.publicKey;
  }

  /**
   * Publish a kind 0 metadata event
   */
  async publishMetadataEvent(metadata: Record<string, string | undefined>): Promise<string> {
    if(this.connectionState !== 'connected') {
      throw new Error('Not connected to relay');
    }

    // Clean undefined values
    const cleanMeta: Record<string, string> = {};
    for(const [k, v] of Object.entries(metadata)) {
      if(v !== undefined) cleanMeta[k] = v;
    }

    const eventTemplate = {
      kind: NOSTR_KIND_METADATA,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: JSON.stringify(cleanMeta)
    };

    const signedEvent = finalizeEvent(eventTemplate, this.privateKey);
    if(!this.safeSend(JSON.stringify(['EVENT', signedEvent]))) {
      throw new Error('Not connected to relay');
    }

    const eventId = (signedEvent as any).id || '';
    this.log('[NostrRelay] published metadata event:', eventId.slice(0, 8) + '...');
    return eventId;
  }

  /**
   * Send a raw signed event to the relay
   */
  sendRawEvent(event: NostrEvent): void {
    if(this.connectionState !== 'connected') {
      throw new Error('Not connected to relay');
    }

    if(!this.safeSend(JSON.stringify(['EVENT', event]))) {
      throw new Error('Not connected to relay');
    }
  }

  /**
   * Measure relay latency.
   * Sends a REQ with limit:0, times the EOSE response.
   * @returns Latency in ms, or -1 if unreachable
   */
  async measureLatency(): Promise<number> {
    if(this.connectionState !== 'connected' || !this.ws) {
      this.setLatency(-1);
      return -1;
    }

    const ws = this.ws;
    const start = performance.now();
    const pingId = `ping-${Date.now()}`;

    return new Promise<number>((resolve) => {
      let settled = false;
      const origHandler = ws.onmessage;

      const cleanup = (latency: number) => {
        if(settled) return;
        settled = true;
        clearTimeout(timeout);
        // Only restore if our wrapper is still the live handler — a nested
        // measureLatency call or a mode switch may have replaced it.
        if(ws.onmessage === wrapper) {
          ws.onmessage = origHandler;
        }
        // Tell the relay we're done with this sub. Swallow errors — the ws
        // may be closing.
        try {
          ws.send(JSON.stringify(['CLOSE', pingId]));
        } catch(e) { logSwallow('NostrRelay.measureLatency.closePing', e); }
        if(latency >= 0) this.directLatencyMs = latency;
        this.setLatency(latency);
        resolve(latency);
      };

      const timeout = setTimeout(() => cleanup(-1), 5000);

      const wrapper = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data);
          if(msg[0] === 'EOSE' && msg[1] === pingId) {
            cleanup(Math.round(performance.now() - start));
            return;
          }
        } catch{
          // ignore parse errors
        }
        origHandler?.call(ws, event);
      };

      ws.onmessage = wrapper;

      try {
        ws.send(JSON.stringify(['REQ', pingId, {kinds: [0], limit: 0}]));
      } catch{
        cleanup(-1);
      }
    });
  }

  /**
   * Record a new latency value and notify listeners (pool → UI).
   */
  private setLatency(value: number): void {
    this.latencyMs = value;
    this.onLatencyUpdate?.(value);
  }

  /**
   * Kick off an initial latency measurement and schedule periodic refreshes.
   * Safe to call multiple times — previous interval is cleared first.
   */
  private startLatencyRefresh(): void {
    this.stopLatencyRefresh();
    setTimeout(() => {
      this.measureLatency().catch(swallowHandler('NostrRelay.measureLatency.initial'));
    }, 500);
    this.latencyInterval = setInterval(() => {
      this.measureLatency().catch(swallowHandler('NostrRelay.measureLatency.interval'));
    }, this.latencyRefreshMs);
  }

  private stopLatencyRefresh(): void {
    if(this.latencyInterval) {
      clearInterval(this.latencyInterval);
      this.latencyInterval = null;
    }
  }

  /**
   * Get the last measured latency.
   */
  getLatency(): number {
    return this.latencyMs;
  }

  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  getConnectionState(): string {
    return this.connectionState;
  }

  // ==================== Private Methods ====================

  // Pending query resolvers: queryId -> {collected events, resolve fn, inflight}
  // `inflight` holds the per-event unwrap promises: unwrap is now async (worker
  // offload), so EVENT handlers may still be populating `events` when EOSE
  // arrives. EOSE awaits these before resolving so a query never returns a
  // half-decrypted result set.
  private queryResolvers: Map<string, {
    events: DecryptedMessage[];
    resolve: (events: DecryptedMessage[]) => void;
    inflight: Promise<void>[];
  }> = new Map();

  // Pending raw query resolvers (non-giftwrap queries): queryId -> {events, resolve}
  private rawQueryResolvers: Map<string, {
    events: NostrEvent[];
    resolve: (events: NostrEvent[]) => void;
  }> = new Map();

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      if(!Array.isArray(message)) {
        return;
      }

      const type = message[0];

      switch(type) {
        case 'EVENT': {
          const [, subId, event] = message as [string, string, NostrEvent];
          // Check if this event belongs to a pending query
          const queryResolver = this.queryResolvers.get(subId);
          const rawResolver = this.rawQueryResolvers.get(subId);
          if(queryResolver) {
            // Track the async unwrap so EOSE can await it (see EOSE handler).
            queryResolver.inflight.push(this.collectQueryEvent(event, queryResolver.events));
          } else if(rawResolver) {
            rawResolver.events.push(event);
          } else {
            this.handleEvent(event);
          }
          break;
        }
        case 'EOSE': {
          const [, subId] = message as [string, string];
          // Resolve any pending query for this subscription
          const queryResolver = this.queryResolvers.get(subId);
          const rawResolver = this.rawQueryResolvers.get(subId);
          if(queryResolver) {
            this.log('[NostrRelay] EOSE received for query:', subId, 'with', queryResolver.events.length, 'events');
            // Close the query subscription
            this.safeSend(JSON.stringify(['CLOSE', subId]));
            this.queryResolvers.delete(subId);
            // Wait for in-flight async unwraps to finish landing in `events`
            // before resolving — collectQueryEvent is now async (worker
            // offload). The unwrap promises never reject (errors are caught and
            // logged inside collectQueryEvent), so Promise.all is safe.
            Promise.all(queryResolver.inflight).then(() => queryResolver.resolve(queryResolver.events));
          } else if(rawResolver) {
            this.log('[NostrRelay] EOSE received for raw query:', subId, 'with', rawResolver.events.length, 'events');
            this.safeSend(JSON.stringify(['CLOSE', subId]));
            this.rawQueryResolvers.delete(subId);
            rawResolver.resolve(rawResolver.events);
          } else if(subId === this.subscriptionId) {
            this.log.debug('[NostrRelay] message subscription live (EOSE)');
            this.subscriptionReady?.resolve(true);
          } else {
            this.log.debug('[NostrRelay] EOSE received for subscription:', subId);
          }
          break;
        }
        case 'NOTICE': {
          const [, notice] = message as [string, string];
          this.log('[NostrRelay] relay notice:', notice);
          break;
        }
        case 'OK': {
          // Per NIP-01 ["OK", <event-id>, <accepted>, <message>] — relays use
          // this to accept/reject a published event. We previously dropped these
          // silently, which hid Bug #3 for weeks: strfry was rejecting kind-7
          // reactions with `unexpected size for fixed-size tag: e` and nothing
          // surfaced in the console. Now rejections are a warning so misrouted
          // publishes are immediately visible in dev and in CI logs.
          const [, okEventId, accepted, reason] = message as [string, string, boolean, string?];
          if(accepted === false) {
            this.log.warn('[NostrRelay] relay REJECTED event', okEventId?.slice(0, 8) + '...', 'reason:', reason || '(no reason)');
          } else {
            this.log.debug('[NostrRelay] relay accepted event:', okEventId?.slice(0, 8) + '...');
          }
          break;
        }
        default:
          this.log.debug('[NostrRelay] unknown message type:', type);
      }
    } catch(err) {
      this.log.error('[NostrRelay] failed to parse message:', err);
    }
  }

  /**
   * Collect and unwrap a gift-wrap event into the query results array
   */
  private async collectQueryEvent(event: NostrEvent, collected: DecryptedMessage[]): Promise<void> {
    if(!event.content || !event.pubkey || event.kind !== NOSTR_KIND_GIFTWRAP) {
      return;
    }

    try {
      // Unwrap off the main thread when a worker is available. The wrap's
      // Schnorr signature is verified inside the unwrap (step a) before any
      // decryption, so the previous main-thread `verifyEvent` pre-check was a
      // redundant second verify and is gone. A forged wrap rejects and is
      // caught below.
      const rumor = await getNostrUnwrapClient().unwrap(event as any, this.privateKey);

      // Skip receipt messages for query results
      const receiptTag = rumor.tags?.find((t: string[]) => t[0] === 'receipt-type');
      if(receiptTag) return;

      collected.push({
        id: rumor.id || event.id || '',
        from: rumor.pubkey,
        content: rumor.content,
        timestamp: rumor.created_at,
        rumorKind: rumor.kind,
        tags: rumor.tags
      });
    } catch(err) {
      this.log.error('[NostrRelay] failed to unwrap query event:', err);
    }
  }

  /**
   * Handle incoming Nostr events - unwrap NIP-17 gift-wrap (kind 1059)
   *
   * Gift-wraps use ephemeral pubkeys, so we cannot filter by event.pubkey.
   * Instead, we unwrap the event and check the rumor's pubkey to identify
   * self-sent messages vs. messages from others.
   */
  private async handleEvent(event: NostrEvent): Promise<void> {
    // Ignore events without required fields (kind-7 reactions allow empty
    // content in theory, but NIP-25 defines content as the reaction emoji
    // so in practice it is always set; kind-5 delete has content='' but
    // still has pubkey).
    if(!event.pubkey) {
      this.log.warn('[NostrRelay] received event missing pubkey');
      return;
    }

    // Pre-decrypt dedup: the SAME event (gift-wrap OR raw reaction/delete/typing)
    // is delivered by every connected relay and replayed on reconnect
    // backfills. Claim its id against the pool-wide seen-set and bail BEFORE the
    // expensive Schnorr verify + NIP-44 decrypt for any duplicate — one wrap is
    // unwrapped once, not once per relay. The downstream rumor-id dedup in the
    // pool still handles the recipient-vs-self double.
    if(event.id && this.claimEvent && !this.claimEvent(event.id)) {
      return;
    }

    // Route plaintext non-giftwrap kinds (reactions, deletes, typing) through
    // the raw-event handler after verifying the signature. These do not go
    // through NIP-17 unwrap — they carry their referent in e/p tags. Typing
    // (kind 20001, NIP-16 ephemeral) was being dropped at the gift-wrap-only
    // gate below, so the three-dots indicator never fired.
    if(event.kind === NOSTR_KIND_REACTION || event.kind === NOSTR_KIND_DELETE || event.kind === NOSTR_KIND_TYPING) {
      if(!verifyEvent(event as any)) {
        this.log.warn('[NostrRelay] dropping non-giftwrap event with invalid signature, kind:', event.kind, 'pubkey:', event.pubkey.slice(0, 8) + '...');
        return;
      }
      if(this.onRawEventHandler) {
        try {
          this.onRawEventHandler(event);
        } catch(err) {
          this.log.error('[NostrRelay] raw event handler threw:', err);
        }
      }
      return;
    }

    // Only process kind 1059 gift-wrap events beyond this point
    if(event.kind !== NOSTR_KIND_GIFTWRAP) {
      this.log.debug('[NostrRelay] ignoring non-gift-wrap event kind:', event.kind);
      return;
    }

    // Gift-wraps require content — other kinds may not, but we only
    // reach this branch for kind 1059.
    if(!event.content) {
      this.log.warn('[NostrRelay] received incomplete gift-wrap event');
      return;
    }

    try {
      // Unwrap NIP-17 gift-wrap to get the rumor, off the main thread when a
      // worker is available. The unwrap itself verifies the wrap's Schnorr
      // signature (step a) before any decryption — a hostile relay's forged
      // kind-1059 is dropped there (rejects with GiftWrapVerificationError,
      // caught below) — so the previous main-thread `verifyEvent` pre-check was
      // a redundant second verify and is gone. The cheap pre-decrypt dedup gate
      // (claimEvent, above) still runs on this thread so duplicates never reach
      // the worker.
      const rumor = await getNostrUnwrapClient().unwrap(event as any, this.privateKey);

      // Check if this is a self-sent message (for multi-device sync)
      const isSelfSent = rumor.pubkey === this.publicKey;

      this.log('[NostrRelay] unwrapped gift-wrap, rumor kind:', rumor.kind,
        'from:', rumor.pubkey.slice(0, 8) + '...',
        isSelfSent ? '(self-sent)' : '');

      // Route based on rumor kind and tags
      const receiptTag = rumor.tags?.find((t: string[]) => t[0] === 'receipt-type');

      if(receiptTag) {
        // Receipt message (delivery or read confirmation)
        const eTag = rumor.tags?.find((t: string[]) => t[0] === 'e');
        if(eTag && this.onReceiptHandler) {
          this.onReceiptHandler({
            eventId: eTag[1],
            type: receiptTag[1] as 'delivery' | 'read',
            from: rumor.pubkey
          });
        }
        return;
      }

      // Text message (kind 14) or file message (kind 15)
      const decryptedMessage: DecryptedMessage = {
        id: rumor.id || event.id || '',
        from: rumor.pubkey,
        content: rumor.content,
        timestamp: rumor.created_at,
        rumorKind: rumor.kind,
        tags: rumor.tags
      };

      // Emit via handler
      if(this.onMessageHandler) {
        this.onMessageHandler(decryptedMessage);
      }

      // Emit debug signal if enabled
      if(typeof window !== 'undefined' && localStorage.getItem('pg:transport:debug') === '1') {
        (window as any).__phantomchatLastRelayMessage = {
          id: decryptedMessage.id,
          from: decryptedMessage.from.slice(0, 8) + '...',
          timestamp: Date.now()
        };
      }
    } catch(err) {
      this.log.error('[NostrRelay] failed to unwrap gift-wrap:', err);
      // Don't throw - just log the error and skip this message
    }
  }

  /**
   * Handle disconnection and initiate reconnection if needed
   */
  private handleDisconnect(): void {
    if(this.connectionState === 'disconnected') {
      return;
    }

    // The socket is gone, and any REQ subscription on the relay died with it.
    // Clear isSubscribed and arm pendingSubscribe so the NEXT onopen sends a
    // FRESH REQ. Previously isSubscribed stayed true across a reconnect, so
    // onopen's `subscribeMessages()` hit the `if(this.isSubscribed) return`
    // guard and never re-sent the REQ — after an idle disconnect the client
    // believed it was subscribed but no live subscription existed on the new
    // socket, so inbound DMs silently stopped until a full page reload. This
    // is the root cause of the "ignores the first message after idle" bug.
    // (Live DMs are NIP-17 single-shot with no redundancy, unlike groups which
    // are gift-wrapped per-member across all relays, so the dead sub was
    // invisible on group chats.) The pool runs a since-backfill on reconnect
    // to recover anything that landed during the dead window.
    if(this.isSubscribed || this.pendingSubscribe) {
      this.isSubscribed = false;
      this.pendingSubscribe = true;
    }
    // A pending readiness barrier can never resolve on a dead socket — settle
    // it false so any awaiter unblocks instead of hanging until timeout.
    this.subscriptionReady?.resolve(false);
    this.subscriptionReady = null;

    this.stopLatencyRefresh();
    this.setLatency(-1);
    this.setConnectionState('reconnecting');

    // Fast burst for the first few attempts, then steady backoff.
    // Never give up — only an explicit disconnect() call stops retries.
    const delay = this.reconnectAttempts < this.reconnectBurstDelays.length ?
      this.reconnectBurstDelays[this.reconnectAttempts] :
      this.reconnectBackoffMs;
    this.reconnectAttempts++;

    this.log('[NostrRelay] reconnecting in', delay, 'ms (attempt', this.reconnectAttempts + ')');

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Update connection state
   */
  private setConnectionState(state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'): void {
    if(this.connectionState !== state) {
      this.log('[NostrRelay] connection state:', state);
      this.connectionState = state;
      this.onStateChange?.(state);
    }
  }

  /**
   * SHA-256 hash using Web Crypto API
   */
  private async sha256(message: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hashBuffer);
  }
}

/**
 * Create a NostrRelay instance
 * @param relayUrl - WebSocket URL of the Nostr relay
 */
export function createNostrRelay(relayUrl?: string): NostrRelay {
  return new NostrRelay(relayUrl);
}

// ==================== Utility Functions ====================

/**
 * Convert Uint8Array to base64 string
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for(let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
