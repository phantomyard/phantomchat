/**
 * Nostr-based signaling for WebRTC peer connections
 * Uses Nostr relays as a decentralized pub/sub system for exchanging
 * SDP offers, answers, and ICE candidates between browser tabs
 */

import {Logger, logger} from '@lib/logger';
import * as secp256k1 from '@noble/secp256k1';
import {loadIdentity, StoredIdentity} from './identity';

// Use the sync sign function which uses the built-in sha256
const {sign, getPublicKey, etc} = secp256k1;

/**
 * Nostr event kinds for WebRTC signaling
 * Following NIP-73 convention for WebRTC signaling
 */
export const NOSTR_SIGNALING_KINDS = {
  OFFER: 30078,
  ANSWER: 30079,
  ICE_CANDIDATE: 30080
} as const;

/**
 * Signaling event types for internal use
 */
export type SignalingEventType = 'offer' | 'answer' | 'ice';

export interface SignalingEvent {
  type: SignalingEventType;
  peerId: string;
  payload: string;
  timestamp: number;
}

/**
 * Nostr event as sent to relays
 */
interface NostrEvent {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

/**
 * Nostr signer callback types
 */
export type OnOfferHandler = (peerId: string, sdp: string) => void;
export type OnAnswerHandler = (peerId: string, sdp: string) => void;
export type OnIceCandidateHandler = (peerId: string, candidate: string) => void;

/**
 * WebSocket connection states
 */
type WsState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * NostrSignaler - Decentralized signaling via Nostr relays
 *
 * Uses Nostr as a pub/sub relay to exchange WebRTC signaling data
 * (SDP offers, answers, ICE candidates) between browser tabs without
 * requiring a central signaling server.
 */
export class NostrSignaler {
  private relayUrl: string;
  private ownId: string = '';
  private privateKey: Uint8Array = new Uint8Array();
  private publicKey: string = '';
  private ws: WebSocket | null = null;
  private connectionState: WsState = 'disconnected';
  private log: Logger;

  private offerHandler: OnOfferHandler | null = null;
  private answerHandler: OnAnswerHandler | null = null;
  private iceHandler: OnIceCandidateHandler | null = null;

  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private readonly reconnectDelays = [1000, 2000, 4000]; // Exponential backoff
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private subscriptionId = 'nostra-signal';
  private activeSubscriptions = new Set<string>();

  private identity: StoredIdentity | null = null;

  /**
   * Create a new NostrSignaler
   * @param relayUrl - WebSocket URL of the Nostr relay (default: wss://relay.damus.io)
   * @param ownId - The OwnID of this peer (used for targeting messages)
   */
  constructor(relayUrl: string = 'wss://relay.damus.io', ownId?: string) {
    this.relayUrl = relayUrl;
    if(ownId) {
      this.ownId = ownId;
    }
    this.log = logger('NostrSignaler');

    // Expose for debug inspection
    if(typeof window !== 'undefined') {
      (window as any).__nostraSignaler = this;
    }
  }

  /**
   * Initialize the signer with identity from storage
   * Must be called before connecting
   */
  async initialize(): Promise<void> {
    this.log('initializing with relay:', this.relayUrl);

    try {
      this.identity = await loadIdentity();

      if(!this.identity) {
        throw new Error('No identity found. Please create or import an identity first.');
      }

      this.ownId = this.identity.ownId;

      // Convert base64 private key to Uint8Array for secp256k1
      this.privateKey = this.base64ToBytes(this.identity.privateKey);

      // Derive public key from private key
      // getPublicKey returns 33-byte compressed public key
      const pubKeyBytes = getPublicKey(this.privateKey);
      // Remove compression prefix (first byte 0x02 or 0x03) to get 32-byte x-coordinate
      this.publicKey = etc.bytesToHex(pubKeyBytes.slice(1));

      this.log('initialized for OwnID:', this.ownId, 'pubkey:', this.publicKey.slice(0, 8) + '...');
    } catch(err) {
      this.log.error('initialization failed:', err);
      throw err;
    }
  }

  /**
   * Connect to the Nostr relay
   */
  connect(): void {
    if(this.connectionState === 'connected' || this.connectionState === 'connecting') {
      this.log('already connected or connecting');
      return;
    }

    this.log('connecting to relay:', this.relayUrl);
    this.setConnectionState('connecting');

    try {
      this.ws = new WebSocket(this.relayUrl);

      this.ws.onopen = () => {
        this.log('connected to relay');
        this.setConnectionState('connected');
        this.reconnectAttempts = 0;

        // Re-subscribe to existing subscriptions after reconnect
        this.resubscribeAll();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        this.log.error('WebSocket error:', error);
      };

      this.ws.onclose = (event) => {
        this.log('relay connection closed:', event.code, event.reason);
        this.handleDisconnect();
      };
    } catch(err) {
      this.log.error('failed to create WebSocket:', err);
      this.handleDisconnect();
    }
  }

  /**
   * Disconnect from the relay
   */
  disconnect(): void {
    this.log('disconnecting');

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
    this.activeSubscriptions.clear();
  }

  /**
   * Publish a WebRTC offer (SDP)
   * @param sdp - The SDP offer string
   * @param targetPeerId - Optional target peer ID (if omitted, broadcast to all)
   */
  async publishOffer(sdp: string, targetPeerId?: string): Promise<void> {
    await this.publishEvent(
      NOSTR_SIGNALING_KINDS.OFFER,
      sdp,
      targetPeerId ? [['p', this.hexToNpub(targetPeerId)]] : []
    );
  }

  /**
   * Subscribe to incoming WebRTC offers
   * Calls the registered onOffer handler when offers are received
   */
  subscribeOffers(): void {
    if(this.activeSubscriptions.has('offers')) {
      this.log('already subscribed to offers');
      return;
    }

    this.log('subscribing to offers');

    const filter: Record<string, unknown> = {
      'kinds': [NOSTR_SIGNALING_KINDS.OFFER],
      '#p': [this.publicKey] // Only receive events addressed to us
    };

    this.sendSubscription('offers', filter);
    this.activeSubscriptions.add('offers');
  }

  /**
   * Publish a WebRTC answer (SDP)
   * @param sdp - The SDP answer string
   * @param targetPeerId - The peer ID to send the answer to
   */
  async publishAnswer(sdp: string, targetPeerId: string): Promise<void> {
    await this.publishEvent(
      NOSTR_SIGNALING_KINDS.ANSWER,
      sdp,
      [['p', this.hexToNpub(targetPeerId)]]
    );
  }

  /**
   * Subscribe to incoming WebRTC answers
   * Calls the registered onAnswer handler when answers are received
   */
  subscribeAnswers(): void {
    if(this.activeSubscriptions.has('answers')) {
      this.log('already subscribed to answers');
      return;
    }

    this.log('subscribing to answers');

    const filter: Record<string, unknown> = {
      'kinds': [NOSTR_SIGNALING_KINDS.ANSWER],
      '#p': [this.publicKey]
    };

    this.sendSubscription('answers', filter);
    this.activeSubscriptions.add('answers');
  }

  /**
   * Publish an ICE candidate
   * @param candidate - The ICE candidate JSON string
   * @param targetPeerId - Optional target peer ID
   */
  async publishIceCandidate(candidate: string, targetPeerId?: string): Promise<void> {
    await this.publishEvent(
      NOSTR_SIGNALING_KINDS.ICE_CANDIDATE,
      candidate,
      targetPeerId ? [['p', this.hexToNpub(targetPeerId)]] : []
    );
  }

  /**
   * Subscribe to incoming ICE candidates
   * Calls the registered onIceCandidate handler when candidates are received
   */
  subscribeIceCandidates(): void {
    if(this.activeSubscriptions.has('ice')) {
      this.log('already subscribed to ICE candidates');
      return;
    }

    this.log('subscribing to ICE candidates');

    const filter: Record<string, unknown> = {
      'kinds': [NOSTR_SIGNALING_KINDS.ICE_CANDIDATE],
      '#p': [this.publicKey]
    };

    this.sendSubscription('ice', filter);
    this.activeSubscriptions.add('ice');
  }

  /**
   * Register a handler for incoming offers
   */
  onOffer(handler: OnOfferHandler): void {
    this.offerHandler = handler;
  }

  /**
   * Register a handler for incoming answers
   */
  onAnswer(handler: OnAnswerHandler): void {
    this.answerHandler = handler;
  }

  /**
   * Register a handler for incoming ICE candidates
   */
  onIceCandidate(handler: OnIceCandidateHandler): void {
    this.iceHandler = handler;
  }

  /**
   * Get the current WebSocket connection state
   */
  getState(): WsState {
    return this.connectionState;
  }

  /**
   * Get the public key being used for signaling
   */
  getPublicKey(): string {
    return this.publicKey;
  }

  /**
   * Get the OwnID being used for signaling
   */
  getOwnId(): string {
    return this.ownId;
  }

  // ==================== Private Methods ====================

  /**
   * Publish a Nostr event to the relay
   */
  private async publishEvent(
    kind: number,
    content: string,
    extraTags: string[][]
  ): Promise<void> {
    if(this.connectionState !== 'connected') {
      this.log.warn('cannot publish: not connected');
      return;
    }

    const tags: string[][] = [...extraTags];

    const eventData: [number, string, number, number, string[][], string] = [
      0,
      this.publicKey,
      Math.floor(Date.now() / 1000),
      kind,
      tags,
      content
    ];

    // Calculate event ID (SHA-256 of the serialized event data)
    const eventJson = JSON.stringify(eventData);
    const eventHash = await this.sha256(eventJson);
    const eventId = etc.bytesToHex(eventHash);

    // Sign the event hash to create the signature
    // sign() returns 64-byte compact signature as Bytes (Uint8Array)
    const signatureBytes = sign(eventHash, this.privateKey);
    const signatureHex = etc.bytesToHex(signatureBytes);

    const event: NostrEvent = {
      id: eventId,
      pubkey: this.publicKey,
      created_at: eventData[2],
      kind,
      tags,
      content,
      sig: signatureHex
    };

    this.log('publishing event:', {kind, id: eventId.slice(0, 8) + '...'});

    this.ws?.send(JSON.stringify(['EVENT', event]));
  }

  /**
   * Send a subscription request to the relay
   */
  private sendSubscription(subId: string, filter: Record<string, unknown>): void {
    if(this.connectionState !== 'connected') {
      this.log.warn('cannot subscribe: not connected');
      return;
    }

    const subscription = ['REQ', `${this.subscriptionId}-${subId}`, filter];
    this.ws?.send(JSON.stringify(subscription));
  }

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
          const [, event] = message as [string, NostrEvent];
          this.handleEvent(event);
          break;
        }
        case 'EOSE': {
          // End of stored events - subscription complete
          this.log.debug('EOSE received');
          break;
        }
        case 'NOTICE': {
          const [, notice] = message as [string, string];
          this.log('relay notice:', notice);
          break;
        }
        default:
          this.log.debug('unknown message type:', type);
      }
    } catch(err) {
      this.log.error('failed to parse message:', err);
    }
  }

  /**
   * Handle incoming Nostr events
   */
  private handleEvent(event: NostrEvent): void {
    // Ignore our own events
    if(event.pubkey === this.publicKey) {
      return;
    }

    const peerId = this.npubToHex(event.pubkey);

    switch(event.kind) {
      case NOSTR_SIGNALING_KINDS.OFFER:
        this.log('received offer from:', peerId.slice(0, 8) + '...');
        if(this.offerHandler) {
          this.offerHandler(peerId, event.content);
        }
        break;

      case NOSTR_SIGNALING_KINDS.ANSWER:
        this.log('received answer from:', peerId.slice(0, 8) + '...');
        if(this.answerHandler) {
          this.answerHandler(peerId, event.content);
        }
        break;

      case NOSTR_SIGNALING_KINDS.ICE_CANDIDATE:
        this.log('received ICE candidate from:', peerId.slice(0, 8) + '...');
        if(this.iceHandler) {
          this.iceHandler(peerId, event.content);
        }
        break;

      default:
        this.log.debug('unknown event kind:', event.kind);
    }

    // Emit debug signal if enabled
    if(typeof window !== 'undefined' && localStorage.getItem('pg:transport:debug') === '1') {
      (window as any).__nostraLastSignalingEvent = {
        kind: event.kind,
        peerId,
        content: event.content.slice(0, 100),
        timestamp: Date.now()
      };
    }
  }

  /**
   * Handle disconnection and initiate reconnection if needed
   */
  private handleDisconnect(): void {
    if(this.connectionState === 'disconnected') {
      return;
    }

    this.setConnectionState('reconnecting');

    if(this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = this.reconnectDelays[this.reconnectAttempts];
      this.reconnectAttempts++;

      this.log('reconnecting in', delay, 'ms (attempt', this.reconnectAttempts, 'of', this.maxReconnectAttempts, ')');

      this.reconnectTimeout = setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      this.log.error('max reconnection attempts reached, giving up');
      this.setConnectionState('disconnected');
    }
  }

  /**
   * Re-subscribe to all active subscriptions after reconnection
   */
  private resubscribeAll(): void {
    for(const subId of this.activeSubscriptions) {
      this.log('resubscribing:', subId);
      // Re-send subscription based on kind
      this.resubscribeKind(subId);
    }
  }

  /**
   * Re-subscribe to a specific kind
   */
  private resubscribeKind(subId: string): void {
    let kind: number;
    switch(subId) {
      case 'offers':
        kind = NOSTR_SIGNALING_KINDS.OFFER;
        break;
      case 'answers':
        kind = NOSTR_SIGNALING_KINDS.ANSWER;
        break;
      case 'ice':
        kind = NOSTR_SIGNALING_KINDS.ICE_CANDIDATE;
        break;
      default:
        return;
    }

    const filter: Record<string, unknown> = {
      'kinds': [kind],
      '#p': [this.publicKey]
    };

    this.sendSubscription(subId, filter);
  }

  /**
   * Update connection state and log changes
   */
  private setConnectionState(state: WsState): void {
    if(this.connectionState !== state) {
      this.log('connection state:', state);
      this.connectionState = state;
    }
  }

  /**
   * Convert hex public key to npub format (bech32)
   * Simplified implementation - real implementation would use bech32 encoding
   */
  private hexToNpub(hex: string): string {
    // For simplicity, we use hex directly
    // Real implementation would convert to bech32 npub1... format
    return hex;
  }

  /**
   * Convert npub format to hex
   * Simplified implementation - real implementation would decode bech32
   */
  private npubToHex(npub: string): string {
    // For simplicity, we assume hex input
    // Real implementation would decode bech32
    return npub;
  }

  /**
   * Convert base64 string to Uint8Array
   */
  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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
 * Create a NostrSignaler instance
 * @param relayUrl - WebSocket URL of the Nostr relay
 * @param ownId - OwnID for targeting messages
 */
export function createNostrSignaler(relayUrl?: string, ownId?: string): NostrSignaler {
  return new NostrSignaler(relayUrl, ownId);
}
