/**
 * Unified transport layer for Nostra.chat
 * Composes WebRTC peer connections and Nostr signaling
 * into a single PeerTransport API
 */

import {Logger, logger} from '@lib/logger';
import {PeerChannel} from './peer';
import {PerfectNegotiation, createImpoliteNegotiation} from './peerNegotiation';
import {createNostraPeerConnection} from './peer';
import {NostrSignaler} from './signaling';

/**
 * Message format for transport layer
 */
export interface TransportMessage {
  id: string;
  from: string;
  to: string;
  payload: string;
  timestamp: number;
}

/**
 * Transport connection states
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

/**
 * Failure reasons for the failed state
 */
export type FailureReason = 'ice_timeout' | 'signaling_timeout';

/**
 * Transport configuration options
 */
export interface TransportOptions {
  /** Own OwnID for targeting messages */
  ownId: string;
  /** Nostr relay WebSocket URL (default: wss://relay.damus.io) */
  relayUrl?: string;
  /** ICE connection timeout in ms (default: 5000) */
  iceTimeout?: number;
  /** Signaling timeout in ms (default: 5000) */
  signalingTimeout?: number;
}

/**
 * PeerTransport - Unified transport layer for P2P messaging
 *
 * Provides a simple API that:
 * 1. Tries WebRTC connection via Nostr signaling
 * 2. Handles reconnection and keepalive automatically
 */
export class PeerTransport {
  private options: Required<TransportOptions>;
  private log: Logger;

  // Transport state
  private state: TransportState = 'disconnected';
  private failureReason: FailureReason | null = null;

  // Core components
  private signaler: NostrSignaler;

  // WebRTC components
  private peerConnection: RTCPeerConnection | null = null;
  private negotiation: PerfectNegotiation | null = null;
  private peerChannel: PeerChannel | null = null;

  // Active peer
  private connectedPeerId: string | null = null;

  // Handlers
  private messageHandlers: Array<(msg: TransportMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];

  // Message queuing
  private pendingMessages: TransportMessage[] = [];
  private messageIdCounter = 0;

  // Keepalive
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongTime = 0;
  private readonly KEEPALIVE_INTERVAL = 30000; // 30 seconds
  private readonly PONG_TIMEOUT = 35000; // 35 seconds

  // Reconnection
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private readonly RECONNECT_DELAYS = [2000, 4000, 8000]; // Exponential backoff
  private reconnectTargetId: string | null = null;

  // Pending signaling
  private pendingOfferSdp: string | null = null;

  /**
   * Create a new PeerTransport instance
   */
  constructor(options: TransportOptions) {
    this.options = {
      ownId: options.ownId,
      relayUrl: options.relayUrl ?? 'wss://relay.damus.io',
      iceTimeout: options.iceTimeout ?? 5000,
      signalingTimeout: options.signalingTimeout ?? 5000
    };

    this.log = logger('PeerTransport');

    // Initialize NostrSignaler
    this.signaler = new NostrSignaler(this.options.relayUrl, this.options.ownId);

    // Expose for debug inspection
    if(typeof window !== 'undefined') {
      (window as any).__nostraTransport = this;
    }

    this.log('created with options:', {
      ownId: this.options.ownId.slice(0, 8) + '...',
      relayUrl: this.options.relayUrl
    });
  }

  /**
   * Connect to a peer by their OwnID
   * Initiates WebRTC connection via Nostr signaling
   */
  async connect(peerOwnId: string): Promise<void> {
    if(this.state === 'connected' || this.state === 'connecting') {
      this.log.warn('already connected or connecting');
      return;
    }

    this.reconnectTargetId = peerOwnId;
    this.reconnectAttempts = 0;

    await this.attemptConnect(peerOwnId);
  }

  /**
   * Internal connect attempt with reconnection support
   */
  private async attemptConnect(peerOwnId: string): Promise<void> {
    this.setState('connecting');
    this.failureReason = null;
    this.connectedPeerId = peerOwnId;

    try {
      // Initialize and connect the signaler
      await this.signaler.initialize();
      this.signaler.connect();

      // Set up signaling handlers
      this.setupSignalingHandlers();

      // Start WebRTC connection attempt
      await this.initiateWebRTCConnection(peerOwnId);
    } catch(err) {
      this.log.error('WebRTC connection failed:', err);
      this.handleConnectionFailure('ice_timeout');
    }
  }

  /**
   * Set up Nostr signaling event handlers
   */
  private setupSignalingHandlers(): void {
    // Handle incoming offers
    this.signaler.onOffer(async(fromPeerId, sdp) => {
      this.log('received offer from:', fromPeerId.slice(0, 8) + '...');

      // If we're not the initiator and this is the peer we're connecting to
      if(fromPeerId === this.connectedPeerId && !this.pendingOfferSdp) {
        await this.handleIncomingOffer(fromPeerId, sdp);
      }
    });

    // Handle incoming answers
    this.signaler.onAnswer(async(fromPeerId, sdp) => {
      this.log('received answer from:', fromPeerId.slice(0, 8) + '...');

      if(fromPeerId === this.connectedPeerId && this.pendingOfferSdp) {
        await this.handleIncomingAnswer(sdp);
      }
    });

    // Handle ICE candidates
    this.signaler.onIceCandidate(async(fromPeerId, candidateJson) => {
      if(fromPeerId === this.connectedPeerId && this.negotiation) {
        try {
          const candidate = JSON.parse(candidateJson);
          await this.negotiation.addIceCandidate(candidate);
        } catch(err) {
          this.log.warn('failed to add ICE candidate:', err);
        }
      }
    });
  }

  /**
   * Initiate WebRTC connection by creating and publishing an offer
   */
  private async initiateWebRTCConnection(peerOwnId: string): Promise<void> {
    this.log('initiating WebRTC connection to:', peerOwnId.slice(0, 8) + '...');

    // Create peer connection and negotiation
    const {connection} = createNostraPeerConnection();
    this.peerConnection = connection;
    this.negotiation = createImpoliteNegotiation(connection);

    // Subscribe to answers before creating offer
    this.signaler.subscribeAnswers();
    this.signaler.subscribeIceCandidates();

    // Set up data channel handler
    connection.addEventListener('datachannel', (event) => {
      this.log('received data channel from peer');
      this.peerChannel = new PeerChannel(event.channel, this.log);
      this.setupPeerChannelHandlers();
    });

    // Create data channel (initiator creates it)
    const dataChannel = connection.createDataChannel('data', {ordered: true});
    this.peerChannel = new PeerChannel(dataChannel, this.log);
    this.setupPeerChannelHandlers();

    // Set up ICE candidate handler
    connection.addEventListener('icecandidate', (event) => {
      if(event.candidate && this.connectedPeerId) {
        const candidateJson = JSON.stringify(event.candidate.toJSON());
        this.signaler.publishIceCandidate(candidateJson, this.connectedPeerId);
      }
    });

    // Set up connection state handler
    connection.addEventListener('connectionstatechange', () => {
      this.log('connection state:', connection.connectionState);

      if(connection.connectionState === 'failed') {
        this.log.error('ICE connection failed');
        this.handleConnectionFailure('ice_timeout');
      }
    });

    // Create and publish offer
    const offerSdp = await this.negotiation.createOffer();
    this.pendingOfferSdp = offerSdp;

    // Publish the offer to Nostr
    await this.signaler.publishOffer(offerSdp, peerOwnId);
    this.signaler.subscribeOffers();

    // Wait for answer with timeout
    await this.waitForAnswer(peerOwnId);
  }

  /**
   * Wait for answer from the peer with timeout
   */
  private async waitForAnswer(peerOwnId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.log.warn('signaling timeout waiting for answer');
        reject(new Error('Signaling timeout'));
      }, this.options.signalingTimeout);

      // Check for answer periodically
      const checkInterval = setInterval(async() => {
        if(this.pendingOfferSdp === null || this.state === 'connected') {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // Handler will be called when answer arrives
      this.signaler.onAnswer(async(fromPeerId, sdp) => {
        if(fromPeerId === peerOwnId && this.pendingOfferSdp) {
          clearTimeout(timeout);
          clearInterval(checkInterval);

          try {
            await this.handleIncomingAnswer(sdp);
            resolve();
          } catch(err) {
            reject(err);
          }
        }
      });
    });
  }

  /**
   * Handle incoming WebRTC offer (when peer initiates)
   */
  private async handleIncomingOffer(fromPeerId: string, sdp: string): Promise<void> {
    if(!this.negotiation) return;

    const answerSdp = await this.negotiation.receiveOffer(sdp);
    await this.signaler.publishAnswer(answerSdp, fromPeerId);
  }

  /**
   * Handle incoming WebRTC answer
   */
  private async handleIncomingAnswer(sdp: string): Promise<void> {
    if(!this.negotiation) {
      throw new Error('No negotiation in progress');
    }

    await this.negotiation.receiveAnswer(sdp);
    this.pendingOfferSdp = null;

    // Wait for data channel to open or ICE to complete
    await this.waitForConnection();
  }

  /**
   * Wait for WebRTC connection to be established
   */
  private async waitForConnection(): Promise<void> {
    if(!this.peerConnection) {
      throw new Error('No peer connection');
    }

    const connection = this.peerConnection;

    // Check if already connected
    if(connection.connectionState === 'connected' || connection.iceConnectionState === 'connected') {
      this.onWebRTCConnected();
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.log.warn('ICE connection timeout');
        reject(new Error('ICE connection timeout'));
      }, this.options.iceTimeout);

      const checkState = () => {
        if(connection.connectionState === 'connected' ||
           connection.iceConnectionState === 'connected') {
          clearTimeout(timeout);
          connection.removeEventListener('connectionstatechange', checkState);
          connection.removeEventListener('iceconnectionstatechange', checkState);
          resolve();
        }
      };

      connection.addEventListener('connectionstatechange', checkState);
      connection.addEventListener('iceconnectionstatechange', checkState);
    });
  }

  /**
   * Called when WebRTC connection is successfully established
   */
  private onWebRTCConnected(): void {
    this.log('WebRTC connection established');
    this.pendingOfferSdp = null;
    this.setState('connected');
    this.startKeepalive();
    this.flushPendingMessages();
  }

  /**
   * Handle connection failure and initiate fallback or reconnection
   */
  private async handleConnectionFailure(reason: FailureReason): Promise<void> {
    this.log.error('connection failed:', reason);
    this.failureReason = reason;

    // Stop keepalive
    this.stopKeepalive();

    // Clean up WebRTC
    this.cleanupWebRTC();

    // Check if we should retry or fail
    if(this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      this.setState('reconnecting');

      const delay = this.RECONNECT_DELAYS[this.reconnectAttempts - 1] || 8000;
      this.log(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);

      await this.delay(delay);

      if(this.reconnectTargetId) {
        await this.attemptConnect(this.reconnectTargetId);
      }
    } else {
      // All retries exhausted, set to failed
      this.log.error('all reconnection attempts exhausted');
      this.setState('failed');
    }
  }

  /**
   * Set up peer channel event handlers
   */
  private setupPeerChannelHandlers(): void {
    if(!this.peerChannel) return;

    this.peerChannel.onOpen(() => {
      this.log('peer channel opened');
      this.onWebRTCConnected();
    });

    this.peerChannel.onMessage((data) => {
      this.handleReceivedMessage(data);
    });

    this.peerChannel.onClose(() => {
      this.log('peer channel closed');
      if(this.state === 'connected') {
        this.handleConnectionFailure('ice_timeout');
      }
    });

    this.peerChannel.onError((err) => {
      this.log.error('peer channel error:', err);
    });
  }

  /**
   * Handle received message data
   */
  private handleReceivedMessage(data: string): void {
    // Check for ping/pong
    if(data === 'ping') {
      this.lastPongTime = Date.now();
      this.send('pong');
      return;
    }

    if(data === 'pong') {
      this.lastPongTime = Date.now();
      return;
    }

    // Try to parse as TransportMessage
    try {
      const message: TransportMessage = JSON.parse(data);
      this.log.debug('received message:', message.id, 'from:', message.from.slice(0, 8) + '...');

      // Deliver to handlers
      for(const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch(err) {
          this.log.error('message handler error:', err);
        }
      }
    } catch(err) {
      // Not a structured message, create one
      const message: TransportMessage = {
        id: this.generateMessageId(),
        from: this.connectedPeerId || 'unknown',
        to: this.options.ownId,
        payload: data,
        timestamp: Date.now()
      };

      for(const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch(err) {
          this.log.error('message handler error:', err);
        }
      }
    }
  }

  /**
   * Send a message to the connected peer
   * @param message - String message to send
   * @returns true if sent, false if queued
   */
  send(message: string): boolean {
    // Queue if not connected
    if(this.state !== 'connected') {
      this.log.debug('queuing message (not connected)');
      this.queueMessage(message);
      return false;
    }

    // Send via active channel
    if(this.peerChannel && this.peerChannel.isOpen) {
      const sent = this.peerChannel.send(message);
      if(!sent) {
        this.queueMessage(message);
      }
      return sent;
    }

    this.queueMessage(message);
    return false;
  }

  /**
   * Queue a message for later delivery
   */
  private queueMessage(payload: string): void {
    const message: TransportMessage = {
      id: this.generateMessageId(),
      from: this.options.ownId,
      to: this.connectedPeerId || 'unknown',
      payload,
      timestamp: Date.now()
    };

    this.pendingMessages.push(message);
    this.log.debug('message queued, pending:', this.pendingMessages.length);
  }

  /**
   * Flush queued messages after connection is established
   */
  private flushPendingMessages(): void {
    if(this.pendingMessages.length === 0) return;

    this.log.debug('flushing', this.pendingMessages.length, 'pending messages');

    for(const msg of this.pendingMessages) {
      const data = JSON.stringify(msg);
      if(this.peerChannel && this.peerChannel.isOpen) {
        this.peerChannel.send(data);
      }
    }

    this.pendingMessages = [];
  }

  /**
   * Register a handler for incoming messages
   * @param handler - Function to call with each message
   */
  onMessage(handler: (msg: TransportMessage) => void): void {
    this.messageHandlers.push(handler);

    // Flush pending messages on first handler registration
    if(this.state === 'connected' && this.pendingMessages.length > 0) {
      this.flushPendingMessages();
    }
  }

  /**
   * Register a handler for state changes
   * @param handler - Function to call with each state
   */
  onStateChange(handler: (state: TransportState) => void): void {
    this.stateHandlers.push(handler);
  }

  /**
   * Get the current transport state
   */
  getState(): TransportState {
    return this.state;
  }

  /**
   * Get the failure reason if in failed state
   */
  getFailureReason(): FailureReason | null {
    return this.failureReason;
  }

  /**
   * Get the OwnID of the connected peer
   */
  getConnectedPeerId(): string | null {
    return this.connectedPeerId;
  }

  /**
   * Disconnect from the peer and clean up resources
   */
  disconnect(): void {
    this.log('disconnecting');

    this.stopKeepalive();
    this.cleanupWebRTC();

    this.signaler.disconnect();

    this.pendingMessages = [];
    this.connectedPeerId = null;
    this.reconnectTargetId = null;
    this.reconnectAttempts = 0;

    this.setState('disconnected');
  }

  /**
   * Clean up WebRTC resources
   */
  private cleanupWebRTC(): void {
    if(this.peerChannel) {
      try {
        this.peerChannel.close();
      } catch(err) {
        this.log.warn('peer channel close error:', err);
      }
      this.peerChannel = null;
    }

    if(this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch(err) {
        this.log.warn('peer connection close error:', err);
      }
      this.peerConnection = null;
    }

    this.negotiation = null;
    this.pendingOfferSdp = null;
  }

  /**
   * Start ping/pong keepalive
   */
  private startKeepalive(): void {
    this.stopKeepalive();

    this.lastPongTime = Date.now();

    this.keepaliveInterval = setInterval(() => {
      if(this.state !== 'connected') {
        this.stopKeepalive();
        return;
      }

      // Send ping
      this.send('ping');

      // Check for pong timeout
      if(Date.now() - this.lastPongTime > this.PONG_TIMEOUT) {
        this.log.warn('keepalive timeout, connection may be dead');
        this.handleConnectionFailure('ice_timeout');
      }
    }, this.KEEPALIVE_INTERVAL);

    this.log.debug('keepalive started, interval:', this.KEEPALIVE_INTERVAL, 'ms');
  }

  /**
   * Stop ping/pong keepalive
   */
  private stopKeepalive(): void {
    if(this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Update transport state and notify handlers
   */
  private setState(state: TransportState): void {
    if(this.state !== state) {
      this.log('state:', state);
      this.state = state;

      for(const handler of this.stateHandlers) {
        try {
          handler(state);
        } catch(err) {
          this.log.error('state handler error:', err);
        }
      }
    }
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now()}-${this.messageIdCounter++}`;
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a PeerTransport instance
 */
export function createPeerTransport(options: TransportOptions): PeerTransport {
  return new PeerTransport(options);
}
