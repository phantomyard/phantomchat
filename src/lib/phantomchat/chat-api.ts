/**
 * ChatAPI - High-level composition layer for PhantomChat.chat 1:1 chat
 *
 * Wires NostrRelayPool + OfflineQueue + MessageStore + identity into a single
 * send/receive/history API for 1:1 text, image, video, and GIF messaging.
 *
 * All messaging goes through the Nostr relay pool using NIP-17 gift-wrap
 * (kind 1059). No WebRTC in v1.
 *
 * Phase 4 changes:
 * - Gift-wrap pipeline via NostrRelayPool.publish() (delegates wrapping)
 * - IndexedDB message store for persistent chat history
 * - Relay backfill on init/reconnect (MSG-02)
 * - ChatMessageStatus includes 'read' state
 */

import {Logger, logger} from '@lib/logger';
import {NostrRelayPool, PublishResult, DEFAULT_RELAYS} from './nostr-relay-pool';
import {DecryptedMessage} from './nostr-relay';
import {OfflineQueue} from './offline-queue';
import {getMessageStore, StoredMessage} from './message-store';
import {DeliveryTracker} from './delivery-tracker';
import {getMessageRequestStore} from './message-requests';
import {wrapNip17Message} from './nostr-crypto';
import {isControlEvent, getGroupIdFromRumor} from './group-control-messages';
import rootScope from '@lib/rootScope';
import {handleRelayMessage as handleRelayMessageImpl, IncomingEdit} from './chat-api-receive';
import {phantomchatReactionsReceive} from './phantomchat-reactions-receive';
import {setChatAPI as setReactionsChatAPI} from './phantomchat-reactions-publish';

/**
 * Message types supported in chat
 */
export type ChatMessageType = 'text' | 'image' | 'video' | 'gif' | 'file' | 'voice';

/**
 * Delivery status of a message
 */
export type ChatMessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Chat message structure
 */
export interface ChatMessage {
  /** Unique message identifier */
  id: string;
  /** Sender's public key */
  from: string;
  /** Recipient's public key */
  to: string;
  /** Message content type */
  type: ChatMessageType;
  /** Message content - plaintext for text, metadata JSON for file */
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Current delivery status */
  status: ChatMessageStatus;
  /** Nostr relay event ID - set after successful relay publish */
  relayEventId?: string;
  /** File metadata for kind 15 (Blossom media) messages */
  fileMetadata?: {
    url: string;
    sha256: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    keyHex: string;
    ivHex: string;
    duration?: number;
    waveform?: string;
    /** #11: caption typed with the photo/file (rendered as the bubble text) */
    caption?: string;
  };
}

/**
 * Connection state of the ChatAPI
 */
export type ChatState = 'disconnected' | 'connecting' | 'connected';

/**
 * Event callback types
 */
export type MessageCallback = (msg: ChatMessage) => void;
export type StatusChangeCallback = (peerId: string, status: string) => void;

/**
 * ChatAPI - High-level chat API for PhantomChat.chat
 *
 * Provides a simple API that:
 * 1. Manages relay pool connection lifecycle
 * 2. Sends messages via relay pool (NIP-17 gift-wrap internally)
 * 3. Receives messages from relay pool subscription
 * 4. Persists messages to IndexedDB message store
 * 5. Backfills missed messages on init/reconnect (MSG-02)
 */
export class ChatAPI {
  private ownId: string;
  private log: Logger;

  // Core components
  private relayPool: NostrRelayPool;
  private offlineQueue: OfflineQueue | null;
  private deliveryTracker: DeliveryTracker | null = null;

  // Connection state
  private state: ChatState = 'disconnected';
  private activePeer: string | null = null;

  // Message history (in-memory)
  private history: ChatMessage[] = [];

  // ID generation counter
  private messageIdCounter = 0;

  // Event callbacks
  onMessage: MessageCallback | null = null;
  onEditMessage: ((edit: IncomingEdit) => void) | null = null;
  onStatusChange: StatusChangeCallback | null = null;

  /**
   * Create a new ChatAPI instance
   * @param ownId - The user's public key
   */
  constructor(ownId: string);

  /**
   * Create a new ChatAPI instance with dependency injection (for testing)
   * @param ownId - The user's public key
   * @param relayPool - NostrRelayPool instance (mockable)
   * @param offlineQueue - OfflineQueue instance (mockable)
   */
  constructor(
    ownId: string,
    relayPool: NostrRelayPool,
    offlineQueue: OfflineQueue | null
  );

  constructor(
    ownId: string,
    relayPool?: NostrRelayPool,
    offlineQueue?: OfflineQueue | null
  ) {
    this.ownId = ownId;
    this.log = logger('ChatAPI');

    this.log('[ChatAPI] initializing with ownId:', ownId.slice(0, 8) + '...');

    // Use injected dependencies or create real ones
    if(relayPool && offlineQueue) {
      this.relayPool = relayPool;
      this.offlineQueue = offlineQueue;

      // Wire up callbacks on injected pool (DI / test path)
      if(typeof relayPool.setOnMessage === 'function') {
        relayPool.setOnMessage((msg: DecryptedMessage) => this.handleRelayMessage(msg));
      }
      if(typeof relayPool.setOnStateChange === 'function') {
        relayPool.setOnStateChange((connectedCount: number, _totalCount: number) => {
          this.handlePoolStateChange(connectedCount);
        });
      }
    } else {
      // Create real NostrRelayPool
      this.relayPool = new NostrRelayPool({
        relays: [...DEFAULT_RELAYS],
        onMessage: (msg: DecryptedMessage) => this.handleRelayMessage(msg),
        onStateChange: (connectedCount: number, _totalCount: number) => {
          this.handlePoolStateChange(connectedCount);
        }
      });
      this.offlineQueue = new OfflineQueue(this.relayPool);
    }

    // Wire receipt handler from relay pool to delivery tracker
    if(typeof this.relayPool.setOnReceipt === 'function') {
      this.relayPool.setOnReceipt((receipt: {eventId: string; type: 'delivery' | 'read'; from: string}) => {
        if(this.deliveryTracker) {
          // Convert relay receipt format to rumor-like event for handleReceipt
          this.deliveryTracker.handleReceipt({
            kind: 14,
            content: '',
            pubkey: receipt.from,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', receipt.eventId], ['receipt-type', receipt.type]],
            id: `receipt-${Date.now()}`
          });
        }
      });
    }

    // Wire the reactions publish module as early as possible. Previously this
    // was only done inside initGlobalSubscription(), which is fire-and-forget
    // and can be overtaken by an early sendReaction coming through the VMT
    // bridge — observed as "ChatAPI not wired" in FIND-bbf8efa8. Doing it in
    // the constructor makes wiring deterministic without waiting on the relay
    // pool to connect.
    setReactionsChatAPI(this as any);

    // Expose for debug inspection
    if(typeof window !== 'undefined') {
      (window as any).__phantomchatChatAPI = this;
    }
  }

  /**
   * Connect to a peer by their public key.
   *
   * If a global subscription is already active (from initGlobalSubscription),
   * this is a lightweight operation: we just update `activePeer` without
   * tearing down the relay pool. The relay pool uses a SINGLE subscription
   * for all messages, so switching peers does not require resubscribing.
   *
   * Tearing down the pool here would kill the global subscription and cause
   * the sender to miss their own self-echo (which breaks the bubble render
   * on send, as the P2P shortcut relies on the echo path).
   *
   * @param peerOwnId - The peer's public key
   */
  async connect(peerOwnId: string): Promise<void> {
    if(this.state === 'connected' || this.state === 'connecting') {
      if(this.activePeer === peerOwnId) {
        this.log('[ChatAPI] already connected/connecting to peer');
        return;
      }
      // Reuse existing connection: the global subscription already covers
      // all incoming messages. Just switch the active peer for delivery
      // tracking context — do NOT tear down the pool.
      this.log('[ChatAPI] switching active peer to:', peerOwnId.slice(0, 8) + '...');
      this.activePeer = peerOwnId;
      if(this.onStatusChange) {
        this.onStatusChange(peerOwnId, 'connected');
      }
      return;
    }

    this.log('[ChatAPI] connecting to peer:', peerOwnId.slice(0, 8) + '...');
    this.setState('connecting');
    this.activePeer = peerOwnId;

    try {
      // Initialize relay pool (connects to all relays)
      await this.relayPool.initialize();

      // Initialize delivery tracker with pool's identity
      try {
        const poolPrivateKey = this.relayPool.getPrivateKey?.();
        if(poolPrivateKey) {
          this.deliveryTracker = new DeliveryTracker({
            privateKey: poolPrivateKey,
            publicKey: this.ownId,
            publishFn: async(events: any[]) => {
              for(const event of events) {
                await this.relayPool.publishRawEvent(event);
              }
            }
          });
        }
      } catch(err) {
        this.log.warn('[ChatAPI] delivery tracker init failed (non-fatal):', err);
      }

      // Subscribe to relay messages
      this.relayPool.subscribeMessages();

      this.setState('connected');
      this.log('[ChatAPI] connected to peer:', peerOwnId.slice(0, 8) + '...');

      // Notify status change
      if(this.onStatusChange) {
        this.onStatusChange(peerOwnId, 'connected');
      }

      // Trigger relay backfill in background (MSG-02)
      this.backfillConversations().catch((err) => {
        this.log.error('[ChatAPI] backfill failed:', err);
      });
    } catch(err) {
      this.log.error('[ChatAPI] connection failed:', err);
      this.setState('disconnected');
      throw err;
    }
  }

  /**
   * Initialize relay pool and subscribe to incoming messages globally.
   * Call this at boot so messages from ANY peer are received,
   * not just from peers connected via connect().
   * Also initializes the delivery tracker so receipts work without
   * needing to open a specific chat first.
   */
  async initGlobalSubscription(): Promise<void> {
    await this.relayPool.initialize();

    // Initialize delivery tracker with pool's identity (same as connect() does).
    // Without this, incoming delivery/read receipts are silently ignored and
    // outgoing checkmarks stay at single (✓) forever.
    try {
      const poolPrivateKey = this.relayPool.getPrivateKey?.();
      if(poolPrivateKey && !this.deliveryTracker) {
        this.deliveryTracker = new DeliveryTracker({
          privateKey: poolPrivateKey,
          publicKey: this.ownId,
          publishFn: async(events: any[]) => {
            for(const event of events) {
              await this.relayPool.publishRawEvent(event);
            }
          }
        });
      }
    } catch(err) {
      this.log.warn('[ChatAPI] delivery tracker init failed (non-fatal):', err);
    }

    this.relayPool.subscribeMessages();

    // WU-3: wait for the subscription to actually go live (relay EOSE) before
    // the kind-1059 backfill below, so a cold client doesn't backfill into a
    // not-yet-live subscription and miss the gap. whenSubscribed() is
    // timeout-guarded (resolves false on timeout) so boot NEVER hangs, and we
    // do not branch on the result. typeof-guarded for injected test pools.
    if(typeof (this.relayPool as any).whenSubscribed === 'function') {
      await this.relayPool.whenSubscribed(8000);
    }

    // Wire kind-7 / kind-5 routing for NIP-25 reactions. The relay pool
    // dedupes by event.id; the receive module handles author verification,
    // out-of-order buffering, and store persistence + dispatch.
    this.relayPool.setOnRawEvent((event) => {
      if(event.kind === 7) {
        phantomchatReactionsReceive.onKind7(event as any).catch((err) => {
          this.log.warn('[ChatAPI] reactions onKind7 failed:', err);
        });
        return;
      }
      if(event.kind === 5) {
        phantomchatReactionsReceive.onKind5(event as any).catch((err) => {
          this.log.warn('[ChatAPI] reactions onKind5 failed:', err);
        });
        return;
      }
    });
    phantomchatReactionsReceive.setOwnPubkey(this.ownId);
    phantomchatReactionsReceive.setMessageResolver(async(eventId) => {
      const {getMessageStore} = await import('./message-store');
      const store = getMessageStore();
      const row = await store.getByEventId(eventId);
      if(!row) return undefined;
      if(row.mid === undefined || row.twebPeerId === undefined) return undefined;
      return {mid: row.mid, peerId: row.twebPeerId};
    });

    this.backfillConversations().catch((e) => this.log('[ChatAPI] backfill failed:', e?.message));
    this.log('[ChatAPI] global relay subscription active');
  }

  /**
   * Publish an arbitrary Nostr event authored by the current user.
   * Signs the provided `{kind, created_at, tags, content}` with the
   * identity held by the relay pool, then fans out to all write relays
   * via publishRawEvent().
   *
   * Used by FoldersSync to publish kind 30078 snapshots.
   */
  async publishEvent(unsigned: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<{id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string; sig: string}> {
    const sk = this.relayPool.getPrivateKey?.();
    if(!sk) {
      throw new Error('[ChatAPI] cannot publish event: relay pool has no private key');
    }
    if(!this.relayPool.isConnected()) {
      // Initialize lazily — callers may invoke this before initGlobalSubscription resolves.
      await this.relayPool.initialize();
    }
    const {finalizeEvent} = await import('nostr-tools/pure');
    const signed = finalizeEvent({
      kind: unsigned.kind,
      created_at: unsigned.created_at,
      tags: unsigned.tags as string[][],
      content: unsigned.content
    }, sk);
    await this.relayPool.publishRawEvent(signed as any);
    return signed as any;
  }

  /**
   * Query relays for the single latest event matching a filter, ordered
   * by created_at descending. Returns null if no events match.
   *
   * Used by FoldersSync to fetch the latest kind 30078 folder snapshot
   * authored by the current user.
   */
  async queryLatestEvent(filter: {
    kinds: number[];
    '#d'?: string[];
    authors?: string[];
    limit?: number;
  }): Promise<{kind: number; created_at: number; content: string; tags: string[][]; id?: string} | null> {
    const authors = filter.authors && filter.authors.length > 0 ?
      filter.authors :
      [this.ownId];
    const req: Record<string, unknown> = {
      kinds: filter.kinds,
      authors,
      limit: filter.limit ?? 1
    };
    if(filter['#d']) req['#d'] = filter['#d'];

    if(!this.relayPool.isConnected()) {
      try {
        await this.relayPool.initialize();
      } catch(err) {
        this.log.warn('[ChatAPI] queryLatestEvent: relay init failed', err);
        return null;
      }
    }

    const events = await this.relayPool.queryRawEvents(req);
    if(!events.length) return null;

    let latest = events[0];
    for(const ev of events) {
      if(ev.created_at > latest.created_at) latest = ev;
    }
    return {
      kind: latest.kind,
      created_at: latest.created_at,
      content: latest.content,
      tags: latest.tags,
      id: latest.id
    };
  }

  /**
   * Disconnect from the current peer
   */
  disconnect(): void {
    this.log('[ChatAPI] disconnecting from peer:', this.activePeer?.slice(0, 8) + '...');

    const wasConnected = this.activePeer;

    this.relayPool.disconnect();

    this.setState('disconnected');
    this.activePeer = null;

    // Notify status change
    if(wasConnected && this.onStatusChange) {
      this.onStatusChange(wasConnected, 'disconnected');
    }
  }

  /**
   * Send a text message
   * @param content - The text content to send
   * @param opts - Optional mirror-coherence metadata so the initial IDB row
   *   carries `mid`/`twebPeerId`/`isOutgoing`. VMT sendMessage passes these
   *   through to eliminate the two-write race that caused FIND-e49755c1
   *   (mirror had mids, IDB row was still partial).
   *
   *   `timestampSec` is the authoritative "now" second captured by the
   *   caller BEFORE send. When provided, the partial IDB row's timestamp
   *   is set to this value so any later `mapEventId(eventId, row.timestamp)`
   *   fallback (used by getDialogs/getHistory/refreshDialogPreview when the
   *   row's mid hasn't merged yet) computes the SAME mid the caller will
   *   later write via its authoritative save. Without this, VMT's
   *   `Math.floor(Date.now()/1000)` captured before sendText can diverge
   *   from ChatAPI's internal `Math.floor(Date.now()/1000)` captured after
   *   relay publish — which silently spawns a second mirror mid with no
   *   IDB row (FIND-e49755c1 residual).
   * @returns The generated message ID
   */
  async sendText(content: string, opts?: {mid?: number; twebPeerId?: number; timestampSec?: number; replyTo?: {eventId: string; relayUrl?: string}}): Promise<string> {
    return this.sendMessage('text', content, opts);
  }

  /**
   * Send a file message (consumed by Plan 02 for Blossom media).
   * Creates a kind 15 rumor content string with file metadata tags.
   *
   * @param type - File type ('image' | 'video' | 'file')
   * @param url - Blossom URL of the uploaded file
   * @param sha256 - SHA-256 hash of the file
   * @param key - Encryption key hex
   * @param iv - Encryption IV hex
   * @param mimeType - MIME type of the file
   * @param size - File size in bytes
   * @param dim - Optional dimensions {width, height}
   * @param extras - Optional metadata (duration/waveform) + mirror-coherence opts
   * @returns The generated message ID
   */
  async sendFileMessage(
    type: 'image' | 'video' | 'file' | 'voice',
    url: string,
    sha256: string,
    key: string,
    iv: string,
    mimeType: string,
    size: number,
    dim?: {width: number; height: number},
    extras?: {duration?: number; waveform?: string; mid?: number; twebPeerId?: number; timestampSec?: number; caption?: string}
  ): Promise<string> {
    const fileContent = JSON.stringify({
      url,
      sha256,
      mimeType,
      size,
      key,
      iv,
      ...(dim ? {width: dim.width, height: dim.height} : {}),
      ...(extras?.duration !== undefined ? {duration: extras.duration} : {}),
      ...(extras?.waveform !== undefined ? {waveform: extras.waveform} : {}),
      // #11: carry the caption so the recipient sees the text typed with the
      // photo/file. The 1:1 path previously dropped it (group path carried it).
      ...(extras?.caption ? {caption: extras.caption} : {})
    });
    const {mid, twebPeerId, timestampSec} = extras || {};
    return this.sendMessage(type as ChatMessageType, fileContent, {mid, twebPeerId, timestampSec});
  }

  /**
   * Internal send implementation
   */
  private async sendMessage(
    type: ChatMessageType,
    content: string,
    opts?: {mid?: number; twebPeerId?: number; timestampSec?: number; replyTo?: {eventId: string; relayUrl?: string}}
  ): Promise<string> {
    const messageId = this.generateMessageId();
    // If caller provided an authoritative seconds-precision timestamp, pin
    // the internal timestamp to it so the partial IDB row's timestamp
    // matches whatever VMT will later stamp on its authoritative save. See
    // FIND-e49755c1 residual analysis: mirror ended up with two mids when
    // these two timestamps landed in different seconds.
    const timestamp = opts?.timestampSec !== undefined ? opts.timestampSec * 1000 : Date.now();
    const peerOwnId = this.activePeer;

    this.log('[ChatAPI] sending message:', type, 'id:', messageId, 'peer:', peerOwnId?.slice(0, 8) + '...');

    // Create the message
    const message: ChatMessage = {
      id: messageId,
      from: this.ownId,
      to: peerOwnId || 'unknown',
      type,
      content,
      timestamp,
      status: 'sending'
    };

    // Add to history
    this.history.push(message);

    // Track delivery state
    if(this.deliveryTracker) {
      this.deliveryTracker.markSending(messageId);
    }

    // Publish first so we can capture the canonical rumor id. The sender row
    // MUST be keyed by that rumor id so kind-7 reactions / kind-5 deletions
    // carry a 64-hex `e` tag accepted by NIP-01 relays, and so the receiver's
    // store (which also keys by rumor id) resolves references bilaterally.
    // See Bug #3 (FIND-4e18d35d) — the prior `eventId = messageId` key caused
    // strfry to reject e-tags with `unexpected size for fixed-size tag: e`.
    let publishedRumorId: string | undefined;
    let publishSucceeded = false;
    if(this.relayPool.isConnected()) {
      try {
        const plaintext = JSON.stringify({
          id: messageId,
          from: this.ownId,
          to: peerOwnId,
          type,
          content,
          timestamp
        });

        const result: PublishResult = await this.relayPool.publish(peerOwnId!, plaintext, opts?.replyTo);
        publishedRumorId = result.rumorId;

        if(result.successes.length > 0) {
          publishSucceeded = true;
          this.log('[ChatAPI] message published to', result.successes.length, 'relay(s):', messageId);
        } else {
          this.log('[ChatAPI] all relays failed, queueing message');
        }
      } catch(err) {
        this.log.error('[ChatAPI] relay publish failed:', err);
      }
    } else {
      this.log('[ChatAPI] relay pool not connected, queueing message');
    }

    // Save to message store after publish so the row can be keyed by rumorId.
    //
    // Identity-triple contract (Phase 2b.1, FIND-e49755c1): every first-write
    // row MUST carry mid + twebPeerId + timestamp computed ONCE at creation.
    // When VMT passes `{twebPeerId, timestampSec}` we compute mid locally via
    // the bridge so the row is authoritative from the first save — no more
    // partial row that later reads would fall back to recompute against.
    //
    // Legacy callers (tests, non-VMT send paths) that don't supply the triple
    // are skipped here; they don't have a coherent mid to store anyway. The
    // relay publish still happens so cross-device self-echo can save the row
    // later with full identity.
    try {
      const store = getMessageStore();
      const conversationId = store.getConversationId(this.ownId, peerOwnId || '');
      const timestampSec = Math.floor(timestamp / 1000);

      // Prefer the canonical rumor id; fall back to the messageId if publish
      // was skipped (offline/no-pool) so the row still has a stable key.
      const rowEventId = publishedRumorId || messageId;

      let rowMid: number | undefined = opts?.mid;
      const twebPeerId = opts?.twebPeerId;
      if(rowMid === undefined && twebPeerId !== undefined) {
        try {
          const {PhantomChatBridge} = await import('./phantomchat-bridge');
          // Bridge hashes eventId+timestamp into a tweb mid. We key by messageId
          // here (not rumorId) to preserve the mid value VMT previously computed
          // so getHistory/getDialogs mirror coherence is unchanged.
          rowMid = await PhantomChatBridge.getInstance().mapEventIdToMid(messageId, timestampSec);
        } catch(e: any) {
          this.log.warn('[ChatAPI] mid compute failed:', e?.message);
        }
      }

      if(rowMid !== undefined && twebPeerId !== undefined) {
        // Resolve replyTo eventId → mid so the sender-side row carries the
        // same identifier the bubble renderer wants (messageReplyHeader.
        // reply_to_msg_id is a tweb mid, not a Nostr event id).
        let replyToMid: number | undefined;
        if(opts?.replyTo?.eventId) {
          try {
            const original = await store.getByEventId(opts.replyTo.eventId);
            if(original) replyToMid = original.mid;
          } catch(e: any) {
            this.log.warn('[ChatAPI] reply_to mid resolve failed:', e?.message);
          }
        }
        const row: StoredMessage = {
          eventId: rowEventId,
          conversationId,
          senderPubkey: this.ownId,
          content,
          type: type === 'text' ? 'text' : 'file',
          timestamp: timestampSec,
          deliveryState: publishSucceeded ? 'sent' : 'sending',
          mid: rowMid,
          twebPeerId,
          isOutgoing: true,
          appMessageId: messageId,
          ...(replyToMid !== undefined ? {replyToMid} : {})
        };
        await store.saveMessage(row);
      } else {
        this.log.warn('[ChatAPI] skipping partial send save — caller did not supply identity triple', {messageId});
      }
    } catch(err) {
      this.log.warn('[ChatAPI] failed to save to message store:', err);
    }

    if(publishSucceeded) {
      // Keep the in-memory `history` view in sync for legacy consumers that
      // read ChatAPI.getHistory() directly.
      const msg = this.history.find((m) => m.id === messageId);
      if(msg) msg.status = 'sent';
      if(this.deliveryTracker) {
        this.deliveryTracker.markSent(messageId);
      }
    } else {
      // Either offline, disconnected, or every relay rejected. Queue the
      // payload for later redelivery. The stored row (if any) has
      // deliveryState='sending' and will transition when the queue flushes.
      await this.queueMessage(messageId, content);
    }

    return messageId;
  }

  /**
   * Edit a previously sent text message in a 1:1 chat.
   *
   * Publishes a new NIP-17 gift-wrap carrying a marker tag
   * `['phantomchat-edit', originalAppMessageId]`. The receiver detects the tag and
   * updates the existing message instead of inserting a new bubble.
   *
   * Locally, the sender updates the original store row in place: same eventId,
   * new content + editedAt. The bubble's `mid`/`timestamp` are preserved so
   * ordering does not shift. Multi-device echo is handled because the wrap
   * publishes to both recipient and self.
   *
   * @param originalAppMessageId - App-level ID of the original message (chat-XXX-N)
   * @param newContent - New text content
   * @returns true on at least one relay success, false otherwise
   */
  async editMessage(originalAppMessageId: string, newContent: string): Promise<boolean> {
    const peerOwnId = this.activePeer;
    if(!peerOwnId) {
      this.log.warn('[ChatAPI] editMessage: no active peer');
      return false;
    }

    const store = getMessageStore();
    let existing: StoredMessage | null = null;
    try {
      existing = await store.getByAppMessageId(originalAppMessageId);
    } catch{
      existing = null;
    }
    if(!existing) {
      this.log.warn('[ChatAPI] editMessage: original not found:', originalAppMessageId);
      return false;
    }
    if(existing.senderPubkey !== this.ownId) {
      this.log.warn('[ChatAPI] editMessage: refusing to edit non-own message');
      return false;
    }

    const editedAt = Math.floor(Date.now() / 1000);
    const plaintext = JSON.stringify({
      id: originalAppMessageId,
      from: this.ownId,
      to: peerOwnId,
      type: 'text',
      content: newContent,
      timestamp: existing.timestamp * 1000,
      editedAt
    });

    // Update local store immediately so the sender's bubble re-renders without
    // waiting for the relay echo. Upsert preserves mid/twebPeerId/isOutgoing.
    try {
      await store.saveMessage({
        ...existing,
        content: newContent,
        editedAt
      });
    } catch(err) {
      this.log.warn('[ChatAPI] editMessage: local store update failed:', err);
    }

    // Update in-memory history mirror as well
    const histEntry = this.history.find(m => m.id === originalAppMessageId);
    if(histEntry) histEntry.content = newContent;

    if(!this.relayPool.isConnected()) {
      this.log.warn('[ChatAPI] editMessage: relay pool not connected; local-only update');
      return false;
    }

    try {
      const result = await this.relayPool.publishEdit(peerOwnId, originalAppMessageId, plaintext);
      if(result.successes.length > 0) {
        this.log('[ChatAPI] edit published to', result.successes.length, 'relay(s):', originalAppMessageId);
        return true;
      }
      this.log.warn('[ChatAPI] editMessage: all relays failed');
      return false;
    } catch(err) {
      this.log.error('[ChatAPI] editMessage: relay publish failed:', err);
      return false;
    }
  }

  /**
   * Load conversation history from IndexedDB message store (instant local cache).
   *
   * @param peerPubkey - Peer's hex public key
   * @param limit - Max messages to return (default 50)
   * @param before - Optional timestamp for pagination
   * @returns Array of stored messages sorted by timestamp desc
   */
  async loadHistory(peerPubkey: string, limit?: number, before?: number): Promise<StoredMessage[]> {
    try {
      const store = getMessageStore();
      const conversationId = store.getConversationId(this.ownId, peerPubkey);
      return await store.getMessages(conversationId, limit, before);
    } catch(err) {
      this.log.error('[ChatAPI] failed to load history:', err);
      return [];
    }
  }

  /**
   * Backfill conversations from relay pool (MSG-02).
   *
   * Called on ChatAPI init and relay reconnect.
   * For each known conversation, queries relays for missed messages
   * using getLatestTimestamp as the `since` filter.
   *
   * Runs in background (non-blocking). Dispatches phantomchat_backfill_complete
   * event when done so display bridge can refresh.
   */
  async backfillConversations(): Promise<void> {
    this.log('[ChatAPI] starting relay backfill');

    try {
      const store = getMessageStore();
      const conversationIds = await store.getAllConversationIds();

      if(conversationIds.length === 0) {
        this.log('[ChatAPI] no conversations to backfill');
        return;
      }

      this.log('[ChatAPI] backfilling', conversationIds.length, 'conversation(s)');

      for(const convId of conversationIds) {
        try {
          const since = await store.getLatestTimestamp(convId);

          // Query relay pool for missed messages
          // Limit to 50 events per conversation to avoid flooding
          await this.relayPool.getMessages({
            'kinds': [1059],
            '#p': [this.ownId],
            'since': since > 0 ? since : undefined,
            'limit': 50
          });
          // Note: actual messages come through the subscription handler
          // and get processed via handleRelayMessage -> dedup by eventId
        } catch(err) {
          this.log.warn('[ChatAPI] backfill failed for conversation:', convId, err);
        }
      }

      // Dispatch completion event
      rootScope.dispatchEvent('phantomchat_backfill_complete', undefined);
      this.log('[ChatAPI] relay backfill complete');
    } catch(err) {
      this.log.error('[ChatAPI] backfill error:', err);
    }
  }

  /**
   * Queue a message for offline delivery
   */
  private async queueMessage(messageId: string, content: string): Promise<void> {
    const peerOwnId = this.activePeer;

    if(!peerOwnId) {
      this.log.warn('[ChatAPI] no active peer, cannot queue message');
      this.updateMessageStatus(messageId, 'failed');
      return;
    }

    if(!this.offlineQueue) {
      this.log.warn('[ChatAPI] no offline queue available');
      this.updateMessageStatus(messageId, 'failed');
      return;
    }

    try {
      await this.offlineQueue.queue(peerOwnId, content);
      this.updateMessageStatus(messageId, 'sent');
      this.log('[ChatAPI] message queued:', messageId);
    } catch(err) {
      this.log.error('[ChatAPI] queue failed:', err);
      this.updateMessageStatus(messageId, 'failed');
    }
  }

  /**
   * Update the status of a message in history and message store.
   *
   * IDENTITY-TRIPLE CONTRACT (Phase 2b.1): this method must only mutate
   * `deliveryState` on the stored row — NEVER touch `mid`, `twebPeerId`, or
   * `timestamp`. Those are immutable after creation. We read the full row from
   * store and re-save it with only `deliveryState` changed, preserving the
   * triple.
   */
  private updateMessageStatus(messageId: string, status: ChatMessageStatus): void {
    const msg = this.history.find(m => m.id === messageId);
    if(msg) {
      msg.status = status;
    }

    // Update in message store (fire-and-forget).
    //
    // Bug #3: sender rows are now keyed by `eventId = rumorId` (64-hex) and
    // carry `appMessageId = chat-XXX-N`. Callers pass the app-level messageId,
    // so look up by `appMessageId` first with a fallback to `eventId` for
    // legacy rows written before the migration (e.g. offline queue with no
    // rumorId captured, or pre-existing installs upgrading).
    const store = getMessageStore();
    const peerOwnId = this.activePeer;
    if(peerOwnId) {
      const conversationId = store.getConversationId(this.ownId, peerOwnId);
      store.getMessages(conversationId, 1).then(msgs => {
        const stored = msgs.find(m => m.appMessageId === messageId) ||
                       msgs.find(m => m.eventId === messageId);
        if(stored) {
          // Explicit identity preservation — mutate ONLY deliveryState.
          const next: StoredMessage = {
            ...stored,
            deliveryState: status === 'failed' ? 'sending' : status as StoredMessage['deliveryState']
          };
          store.saveMessage(next).catch((e) => console.debug('[ChatAPI] delivery state persist failed:', e?.message));
        }
      }).catch((e) => console.debug('[ChatAPI] delivery state lookup failed:', e?.message));
    }
  }

  /**
   * Get the message history
   * @returns Messages sorted by timestamp ascending
   */
  getHistory(): ChatMessage[] {
    return [...this.history].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get the current connection state
   */
  getState(): ChatState {
    return this.state;
  }

  /**
   * Get the active peer's public key
   */
  getActivePeer(): string | null {
    return this.activePeer;
  }

  setActivePeer(pubkey: string): void {
    this.activePeer = pubkey;
  }

  /**
   * Mark a message as read by the current user.
   * Sends a read receipt to the message sender if read receipts are enabled.
   *
   * @param eventId - The relay event ID of the message to mark as read
   * @param senderPubkey - The sender's hex public key
   */
  async markRead(eventId: string, senderPubkey: string): Promise<void> {
    if(!this.deliveryTracker) return;
    await this.deliveryTracker.sendReadReceipt(eventId, senderPubkey);
  }

  /**
   * Get the delivery tracker instance (for external state queries).
   */
  getDeliveryTracker(): DeliveryTracker | null {
    return this.deliveryTracker;
  }

  /**
   * Delete a conversation with 3-level cleanup:
   *
   * Level 1 - Local: Remove all messages from IndexedDB
   * Level 2 - Peer notification: Gift-wrapped delete notification with event IDs
   * Level 3 - Relay: NIP-09 kind 5 deletion request (best-effort)
   *
   * @param peerPubkey - The peer's hex public key
   */
  async deleteConversation(peerPubkey: string): Promise<void> {
    this.log('[ChatAPI] deleteConversation for peer:', peerPubkey.slice(0, 8) + '...');

    const store = getMessageStore();
    const conversationId = store.getConversationId(this.ownId, peerPubkey);

    // Collect event IDs BEFORE deleting (needed for Level 2 and 3)
    let eventIds: string[] = [];
    try {
      const messages = await store.getMessages(conversationId, 1000);
      eventIds = messages.map(m => m.eventId).filter(Boolean);
    } catch(err) {
      this.log.warn('[ChatAPI] failed to collect event IDs for deletion:', err);
    }

    // Level 1: Local deletion — remove all messages from IndexedDB
    try {
      await store.deleteMessages(conversationId);
      this.log('[ChatAPI] Level 1: local messages deleted for conversation:', conversationId);
    } catch(err) {
      this.log.error('[ChatAPI] Level 1 deletion failed:', err);
    }

    // Remove from in-memory history
    this.history = this.history.filter(m => {
      const isConversation = (m.from === peerPubkey && m.to === this.ownId) ||
        (m.from === this.ownId && m.to === peerPubkey);
      return !isConversation;
    });

    // Levels 2 + 3 — peer gift-wrap notification + NIP-09 kind 5 to relays.
    await this.publishMessageDeletions(eventIds, peerPubkey, 'Conversation deleted');

    // Dispatch event for display bridge to remove synthetic dialog
    rootScope.dispatchEvent('phantomchat_conversation_deleted', {peerPubkey, conversationId});

    this.log('[ChatAPI] deleteConversation complete for:', peerPubkey.slice(0, 8) + '...');
  }

  /**
   * Publish a per-message deletion to the wire — both the gift-wrapped
   * peer notification (Level 2) and the public NIP-09 kind-5 (Level 3).
   *
   * Used by deleteConversation (whole-conversation cleanup) and by the
   * Virtual MTProto Server's deleteMessages handler for per-message
   * "Also delete for {peer}" requests. Local IDB removal is the caller's
   * responsibility (Level 1).
   *
   * Both levels are best-effort and log on failure rather than throwing,
   * matching the legacy deleteConversation contract.
   */
  async publishMessageDeletions(
    eventIds: string[],
    peerPubkey: string,
    reasonContent: string = ''
  ): Promise<void> {
    if(eventIds.length === 0) return;
    if(!this.relayPool.getPrivateKey()) return;

    // Level 2: Gift-wrapped peer notification with delete-notification tag.
    try {
      const privateKey = this.relayPool.getPrivateKey()!;
      const deleteContent = JSON.stringify({
        type: 'delete-notification',
        eventIds
      });
      const {wraps} = wrapNip17Message(privateKey, peerPubkey, deleteContent);
      for(const wrap of wraps) {
        await this.relayPool.publishRawEvent(wrap as any);
      }
      this.log('[ChatAPI] Level 2: delete notification sent to peer,', eventIds.length, 'event IDs');
    } catch(err) {
      this.log.warn('[ChatAPI] Level 2 peer notification failed (non-fatal):', err);
    }

    // Level 3: NIP-09 kind 5 deletion request to relays (best-effort).
    try {
      const {finalizeEvent} = await import('nostr-tools/pure');
      const privateKey = this.relayPool.getPrivateKey()!;
      const deletionEvent = finalizeEvent({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: eventIds.map(eid => ['e', eid]),
        content: reasonContent
      }, privateKey);
      await this.relayPool.publishRawEvent(deletionEvent as any);
      this.log('[ChatAPI] Level 3: NIP-09 deletion request published,', eventIds.length, 'event IDs');
    } catch(err) {
      this.log.warn('[ChatAPI] Level 3 NIP-09 deletion failed (non-fatal):', err);
    }
  }

  // ==================== Private Methods ====================

  /**
   * Handle pool state changes (connected relay count changes)
   */
  private handlePoolStateChange(connectedCount: number): void {
    this.log('[ChatAPI] relay pool state change: connectedCount =', connectedCount);

    if(connectedCount > 0) {
      if(this.state !== 'connected' && this.activePeer) {
        this.setState('connected');
        if(this.onStatusChange) {
          this.onStatusChange(this.activePeer, 'connected');
        }
      }

      // Auto-flush offline queue when relays come back
      if(this.offlineQueue && this.activePeer) {
        this.offlineQueue.flush(this.activePeer).catch((err: any) => {
          this.log.error('[ChatAPI] auto-flush failed:', err);
        });
      }

      // Trigger backfill on reconnect (MSG-02)
      this.backfillConversations().catch((err) => {
        this.log.error('[ChatAPI] reconnect backfill failed:', err);
      });
    } else {
      if(this.state !== 'disconnected' && this.activePeer) {
        this.setState('disconnected');
        if(this.onStatusChange) {
          this.onStatusChange(this.activePeer, 'disconnected');
        }
      }
    }
  }

  /**
   * Handle messages received via relay pool subscription.
   * Delegates to chat-api-receive.ts for testability.
   */
  private async handleRelayMessage(msg: DecryptedMessage): Promise<void> {
    this.log('[ChatAPI] received relay message:', msg.id.slice(0, 8) + '...');
    try {
      const result = await handleRelayMessageImpl(msg, {
        ownId: this.ownId,
        history: this.history,
        activePeer: this.activePeer,
        deliveryTracker: this.deliveryTracker,
        offlineQueue: this.offlineQueue,
        onMessage: this.onMessage,
        onEdit: this.onEditMessage,
        log: this.log
      });
      this.log('[ChatAPI] relay message result:', result.action);
    } catch(err) {
      this.log.error('[ChatAPI] failed to handle relay message:', err);
    }
  }

  /**
   * Update internal state
   */
  private setState(state: ChatState): void {
    if(this.state !== state) {
      this.log('[ChatAPI] state:', state);
      this.state = state;
    }
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `chat-${Date.now()}-${this.messageIdCounter++}`;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.log('[ChatAPI] destroying');

    this.relayPool.disconnect();
    if(this.offlineQueue) {
      this.offlineQueue.destroy();
    }

    this.history = [];
    this.activePeer = null;
    this.setState('disconnected');
  }
}

/**
 * Create a ChatAPI instance
 * @param ownId - The user's public key
 */
export function createChatAPI(ownId: string): ChatAPI {
  return new ChatAPI(ownId);
}
