/**
 * WebRTC peer connection manager for Nostra.chat
 * Extends tweb's createPeerConnection pattern with Nostra.chat-specific ICE configuration
 */

import {Logger, logger} from '@lib/logger';
import createPeerConnection from '@lib/calls/helpers/createPeerConnection';
import createDataChannel from '@lib/calls/helpers/createDataChannel';

/**
 * Nostra.chat-specific ICE configuration with public STUN servers
 */
export const NostraIceConfig: RTCConfiguration = {
  iceServers: [
    {urls: 'stun:stun.l.google.com:19302'},
    {urls: 'stun:stun1.l.google.com:19302'}
  ]
};

/**
 * Create a Nostra.chat-specific RTCPeerConnection with Nostra.chat ICE config
 * and event handlers for ICE, connection state, and negotiation
 */
export function createNostraPeerConnection(
  config?: RTCConfiguration,
  log?: Logger
): {connection: RTCPeerConnection; log: Logger} {
  // Merge Nostra.chat defaults with optional user config
  const mergedConfig: RTCConfiguration = {
    ...NostraIceConfig,
    ...config,
    iceServers: config?.iceServers?.length ?
      config.iceServers :
      NostraIceConfig.iceServers
  };

  if(!log) {
    log = logger('NostraPeerConnection');
  }

  log('creating peer connection with config:', mergedConfig);

  const {connection} = createPeerConnection(mergedConfig, log);

  // Attach Nostra.chat-specific handlers for observability
  connection.addEventListener('icegatheringstatechange', () => {
    log('icegatheringstatechange:', connection.iceGatheringState);

    // Log ICE gathering timeout warning (simplified - real impl would use a timer)
    if(connection.iceGatheringState === 'gathering') {
      // Future: set timeout for ICE gathering
    }
  });

  connection.addEventListener('connectionstatechange', () => {
    log('connectionstatechange:', connection.connectionState);

    // Expose failure state for observability
    if(connection.connectionState === 'failed') {
      log.error('ICE connection failed');
    }
  });

  // Enable debug inspection if requested
  if(typeof window !== 'undefined' && localStorage.getItem('pg:transport:debug') === '1') {
    (window as any).__nostraPeerConnection = connection;
  }

  return {connection, log};
}

/**
 * Type for PeerChannel event handlers
 */
export type PeerChannelMessageHandler = (data: string) => void;
export type PeerChannelOpenHandler = () => void;
export type PeerChannelCloseHandler = () => void;
export type PeerChannelErrorHandler = (e: Event) => void;

/**
 * PeerChannel wraps an RTCDataChannel with message/open/close/error handlers
 * and provides a clean event registration API
 */
export class PeerChannel {
  private channel: RTCDataChannel;
  private log: Logger;
  private _onMessage: PeerChannelMessageHandler | null = null;
  private _onOpen: PeerChannelOpenHandler | null = null;
  private _onClose: PeerChannelCloseHandler | null = null;
  private _onError: PeerChannelErrorHandler | null = null;

  constructor(channel: RTCDataChannel, log?: Logger) {
    this.channel = channel;
    this.log = log || logger('PeerChannel');

    this.log('created channel:', channel.label, 'readyState:', channel.readyState);

    // Attach internal event handlers
    this.channel.addEventListener('open', this.handleOpen.bind(this));
    this.channel.addEventListener('close', this.handleClose.bind(this));
    this.channel.addEventListener('message', this.handleMessage.bind(this));
    this.channel.addEventListener('error', this.handleError.bind(this));

    // Expose for debug inspection
    if(typeof window !== 'undefined' && localStorage.getItem('pg:transport:debug') === '1') {
      (window as any).__nostraPeerChannel = this;
    }
  }

  /**
   * Get the underlying RTCDataChannel
   */
  get dataChannel(): RTCDataChannel {
    return this.channel;
  }

  /**
   * Get the current ready state of the channel
   */
  get readyState(): RTCDataChannelState {
    return this.channel.readyState;
  }

  /**
   * Check if the channel is open and ready to send
   */
  get isOpen(): boolean {
    return this.channel.readyState === 'open';
  }

  /**
   * Register a handler for incoming messages
   */
  onMessage(handler: PeerChannelMessageHandler): void {
    this._onMessage = handler;
  }

  /**
   * Register a handler for channel open event
   */
  onOpen(handler: PeerChannelOpenHandler): void {
    this._onOpen = handler;
  }

  /**
   * Register a handler for channel close event
   */
  onClose(handler: PeerChannelCloseHandler): void {
    this._onClose = handler;
  }

  /**
   * Register a handler for channel error event
   */
  onError(handler: PeerChannelErrorHandler): void {
    this._onError = handler;
  }

  /**
   * Send data over the channel
   * @param data - String or ArrayBuffer to send
   * @returns true if data was queued, false if channel is not open
   */
  send(data: string | ArrayBuffer): boolean {
    if(this.channel.readyState !== 'open') {
      this.log.warn('cannot send: channel not open, state:', this.channel.readyState);
      return false;
    }

    try {
      this.channel.send(data as any);
      return true;
    } catch(err) {
      this.log.error('send error:', err);
      return false;
    }
  }

  /**
   * Close the data channel
   */
  close(): void {
    this.log('closing channel');
    this.channel.close();
  }

  private handleOpen(event: Event): void {
    this.log('channel open');
    if(this._onOpen) {
      this._onOpen();
    }
  }

  private handleClose(event: Event): void {
    this.log('channel close');
    if(this._onClose) {
      this._onClose();
    }
  }

  private handleMessage(event: MessageEvent): void {
    this.log('channel message:', event.data);
    if(this._onMessage) {
      // Handle both string and ArrayBuffer data
      const data = typeof event.data === 'string' ?
        event.data :
        new TextDecoder().decode(event.data);
      this._onMessage(data);
    }
  }

  private handleError(event: Event): void {
    this.log.error('channel error:', event);
    if(this._onError) {
      this._onError(event);
    }
  }
}

/**
 * Create a PeerChannel wrapping the data channel of a peer connection
 * This is used when we're the initiator and create the data channel
 */
export function createPeerChannel(
  connection: RTCPeerConnection,
  label: string = 'data',
  dict?: RTCDataChannelInit,
  log?: Logger
): PeerChannel {
  const channel = createDataChannel(connection, dict, log);
  return new PeerChannel(channel, log);
}

/**
 * Wrap an incoming data channel (from the 'datachannel' event)
 * This is used when we're the responder and receive a data channel
 */
export function wrapPeerChannel(channel: RTCDataChannel, log?: Logger): PeerChannel {
  return new PeerChannel(channel, log);
}
