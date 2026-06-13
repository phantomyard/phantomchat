/**
 * Perfect Negotiation - WebRTC offer/answer exchange pattern
 * Prevents signaling race conditions when both sides can initiate
 * See: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
 */

import {Logger, logger} from '@lib/logger';

/**
 * PerfectNegotiation manages WebRTC SDP offer/answer exchange
 * with the perfect negotiation pattern to avoid signaling races
 *
 * Both sides can initiate, and the isPolite/makingOffer flags
 * ensure that only one side creates an offer at a time
 */
export class PerfectNegotiation {
  private connection: RTCPeerConnection;
  private log: Logger;
  private makingOffer = false;
  private isPolite: boolean;
  private ignoreOffer = false;

  constructor(connection: RTCPeerConnection, isPolite: boolean, log?: Logger) {
    this.connection = connection;
    this.isPolite = isPolite;
    this.log = log || logger('PerfectNegotiation');

    this.log('created', {isPolite});

    // Set up connection event handlers
    this.connection.addEventListener('negotiationneeded', () => this.handleNegotiationNeeded());
    this.connection.addEventListener('icecandidate', (event) => this.handleIceCandidate(event));
  }

  /**
   * Handle negotiationneeded event - create an offer if we're the polite side
   * or if we're not currently making an offer
   */
  private async handleNegotiationNeeded(): Promise<void> {
    this.log('negotiationneeded');

    try {
      // Don't create an offer if we're already making one
      if(this.makingOffer) {
        this.log('already making offer, skipping');
        return;
      }

      // The polite side always wins ties, so they can initiate
      // The impolite side waits for an offer from the polite side
      if(this.isPolite) {
        await this.createOffer();
      } else {
        // For impolite side, only create offer if we're not in stable state
        // waiting for an offer
        this.log('impolite side, waiting for offer from peer');
      }
    } catch(err) {
      this.log.error('negotiationneeded error:', err);
    }
  }

  /**
   * Handle ICE candidate events
   */
  private handleIceCandidate(event: RTCPeerConnectionIceEvent): void {
    if(event.candidate) {
      this.log('icecandidate:', event.candidate.candidate?.slice(0, 50));
    }
  }

  /**
   * Create an SDP offer, set it as local description, and return the SDP string
   */
  async createOffer(): Promise<string> {
    this.log('createOffer');

    try {
      this.makingOffer = true;

      const offer = await this.connection.createOffer();
      await this.connection.setLocalDescription(offer);

      this.log('offer created and set as local description');

      return this.connection.localDescription?.sdp || '';
    } catch(err) {
      this.makingOffer = false;
      this.log.error('createOffer error:', err);
      throw err;
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Receive an SDP offer from the peer
   * If we're polite and the peer initiated, we process it
   * If we're impolite and we initiated, we may ignore it
   */
  async receiveOffer(sdp: string): Promise<string> {
    this.log('receiveOffer', {makingOffer: this.makingOffer, isPolite: this.isPolite});

    try {
      const offer = {type: 'offer' as RTCSdpType, sdp};

      // The key logic from perfect negotiation:
      // If we're making an offer and receive an offer from the peer,
      // the polite side wins and processes the offer, the impolite ignores
      if(this.connection.signalingState !== 'stable') {
        if(!this.isPolite) {
          this.log('impolite: ignoring offer while in', this.connection.signalingState);
          this.ignoreOffer = true;
          return '';
        }
      }

      await this.connection.setRemoteDescription(offer);
      this.ignoreOffer = false;

      // Create and set the answer
      const answer = await this.connection.createAnswer();
      await this.connection.setLocalDescription(answer);

      this.log('answer created and set as local description');

      return this.connection.localDescription?.sdp || '';
    } catch(err) {
      this.log.error('receiveOffer error:', err);
      throw err;
    }
  }

  /**
   * Receive an SDP answer from the peer
   * Ignores answer if we're not expecting one (to avoid races)
   */
  async receiveAnswer(sdp: string): Promise<void> {
    this.log('receiveAnswer', {makingOffer: this.makingOffer});

    try {
      // Ignore answer if we're not making an offer
      // This prevents processing stale answers
      if(!this.makingOffer && this.connection.signalingState === 'stable') {
        this.log('ignoring answer: not expecting one');
        return;
      }

      const answer = {type: 'answer' as RTCSdpType, sdp};
      await this.connection.setRemoteDescription(answer);

      this.log('answer set as remote description');
    } catch(err) {
      this.log.error('receiveAnswer error:', err);
      throw err;
    }
  }

  /**
   * Add an ICE candidate from the peer
   */
  async addIceCandidate(candidate: RTCIceCandidateInit | RTCIceCandidate): Promise<void> {
    try {
      const c = candidate instanceof RTCIceCandidate ?
        candidate :
        new RTCIceCandidate(candidate);

      this.log('addIceCandidate:', c.candidate?.slice(0, 50));

      await this.connection.addIceCandidate(c);
    } catch(err) {
      // Ignore errors from late candidates or candidates after connection closed
      this.log.warn('addIceCandidate error (may be expected):', err);
    }
  }

  /**
   * Check if we should ignore the next offer
   * Used by the impolite side to ignore offers while creating their own
   */
  shouldIgnoreOffer(): boolean {
    return this.ignoreOffer;
  }

  /**
   * Get the current signaling state
   */
  getSignalingState(): RTCSignalingState {
    return this.connection.signalingState;
  }

  /**
   * Get ICE connection state
   */
  getIceConnectionState(): RTCIceConnectionState {
    return this.connection.iceConnectionState;
  }

  /**
   * Get ICE gathering state
   */
  getIceGatheringState(): RTCIceGatheringState {
    return this.connection.iceGatheringState;
  }

  /**
   * Get local description SDP
   */
  getLocalDescription(): string | null {
    return this.connection.localDescription?.sdp || null;
  }

  /**
   * Get remote description SDP
   */
  getRemoteDescription(): string | null {
    return this.connection.remoteDescription?.sdp || null;
  }
}

/**
 * Create a PerfectNegotiation instance for the polite side
 */
export function createPoliteNegotiation(
  connection: RTCPeerConnection,
  log?: Logger
): PerfectNegotiation {
  return new PerfectNegotiation(connection, true, log);
}

/**
 * Create a PerfectNegotiation instance for the impolite side
 */
export function createImpoliteNegotiation(
  connection: RTCPeerConnection,
  log?: Logger
): PerfectNegotiation {
  return new PerfectNegotiation(connection, false, log);
}
