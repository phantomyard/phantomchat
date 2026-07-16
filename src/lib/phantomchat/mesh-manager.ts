import {getRtcConfig, DATA_CHANNEL_NAME, DATA_CHANNEL_OPTIONS, SignalMessage} from '@lib/phantomchat/webrtc-config';
import {logSwallow} from '@lib/phantomchat/log-swallow';

const MAX_CONNECTIONS = 50;
const PING_INTERVAL = 30000;
const PING_TIMEOUT = 90000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 10000];

export type PeerStatus = 'connected' | 'connecting' | 'disconnected';

export interface MeshCallbacks {
  /**
   * Publish a WebRTC signal to a peer. Wire-compatible with phantombot's node:
   * ChatAPI.publishSignal NIP-44-encrypts + signs it as a kind-21050 event.
   */
  sendSignal: (recipientPubkey: string, signal: SignalMessage) => Promise<void>;
  onPeerMessage: (pubkey: string, message: string) => void;
  onPeerConnected: (pubkey: string) => void;
  onPeerDisconnected: (pubkey: string) => void;
  /** Fired on the rising edge of verification (first PONG after open), so the
   * P2P badge can repaint the instant a channel is proven live. Optional. */
  onPeerVerified?: (pubkey: string) => void;
}

interface PeerState {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: PeerStatus;
  sessionId: string;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setTimeout> | null;
  pingTimeoutTimer: ReturnType<typeof setTimeout> | null;
  lastPongTime: number;
  latency: number;
  pingSentTime: number;
  // True once setRemoteDescription has resolved for this peer. ICE candidates
  // may only be applied after the remote description exists, so candidates that
  // arrive earlier are buffered (see pendingCandidates) and flushed here.
  remoteDescriptionSet: boolean;
  // True once at least one PING/PONG round-trip has completed since the data
  // channel opened — i.e. bidirectional liveness is PROVEN, not merely assumed
  // from the channel firing `open`. The P2P badge (#61 R3) reads this via
  // isVerified() so green means "rock-solid direct channel", never just "opened
  // a moment ago and might already be a zombie". Reset to false on every fresh
  // connection/reconnect; set true on the first PONG.
  verified: boolean;
}

export class MeshManager {
  private peers: Map<string, PeerState> = new Map();
  // Per-peer ICE candidates that arrived before the peer existed or before its
  // remote description was set. Relays can reorder kind-21050 events, so a
  // candidate can land ahead of the offer/answer. We buffer here (mirroring the
  // phantombot node) and flush after setRemoteDescription — without this, early
  // candidates are dropped or applied too soon and the connection goes flaky.
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private callbacks: MeshCallbacks;
  // Factory for the RTCConfiguration used on every peer connection. Defaults to
  // the TURN-relay privacy config. The #61 ladder passes getRtcConfigDirect so
  // capability-gated peers connect directly (host + STUN-reflexive candidates,
  // no third-party TURN relay) — matching the phantombot node's ICE config.
  private rtcConfig: () => RTCConfiguration;
  // Our own pubkey (hex), lowercased. Decides the initiator/responder role per
  // peer, IDENTICALLY to the node (src/p2p/node.ts amInitiator): the peer with
  // the SMALLER pubkey is the sole offerer. Without this glare rule a PWA and a
  // node could both offer (or both wait), and no connection ever forms.
  private readonly ourPubkey: string;

  constructor(callbacks: MeshCallbacks, rtcConfig: () => RTCConfiguration = getRtcConfig, ourPubkey = '') {
    this.callbacks = callbacks;
    this.rtcConfig = rtcConfig;
    this.ourPubkey = (ourPubkey || '').toLowerCase();
  }

  /** True when WE are the sole initiator for this peer (smaller pubkey offers). */
  private amInitiator(peerPubkey: string): boolean {
    return this.ourPubkey < peerPubkey.toLowerCase();
  }

  /**
   * Begin negotiation with a peer. Glare-free (mirrors the node): the initiator
   * (smaller pubkey) creates the offer; the responder (larger pubkey) can't
   * offer, so it nudges the initiator with a `hello` and waits for the offer.
   */
  async connect(pubkey: string): Promise<void> {
    if(this.peers.has(pubkey)) {
      const existing = this.peers.get(pubkey);
      if(existing.status === 'connected' || existing.status === 'connecting') return;
    }

    if(this.peers.size >= MAX_CONNECTIONS) {
      throw new Error(`Max connections (${MAX_CONNECTIONS}) reached`);
    }

    // Responder role: we don't create the PeerConnection here — we ask the
    // initiator to offer and let handleOffer() build the PC when the offer lands.
    if(!this.amInitiator(pubkey)) {
      await this.callbacks.sendSignal(pubkey, {t: 'hello'});
      return;
    }

    await this.startOffer(pubkey);
  }

  /** Initiator path: build the PC + data channel and publish the offer. */
  private async startOffer(pubkey: string): Promise<void> {
    if(this.peers.has(pubkey)) {
      const existing = this.peers.get(pubkey);
      if(existing.status === 'connected' || existing.status === 'connecting') return;
    }

    const sessionId = `${pubkey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pc = new RTCPeerConnection(this.rtcConfig());
    const dc = pc.createDataChannel(DATA_CHANNEL_NAME, DATA_CHANNEL_OPTIONS);

    const state: PeerState = {
      pc,
      dc,
      status: 'connecting',
      sessionId,
      reconnectAttempts: 0,
      reconnectTimer: null,
      pingTimer: null,
      pingTimeoutTimer: null,
      lastPongTime: 0,
      latency: -1,
      pingSentTime: 0,
      remoteDescriptionSet: false,
      verified: false
    };

    this.peers.set(pubkey, state);
    this.setupDataChannel(pubkey, dc);
    this.setupPeerConnection(pubkey, pc);

    const offer = await pc.createOffer();
    if(!this.peers.has(pubkey) || this.peers.get(pubkey)!.sessionId !== sessionId) return;
    await pc.setLocalDescription(offer);
    if(!this.peers.has(pubkey) || this.peers.get(pubkey)!.sessionId !== sessionId) return;

    await this.callbacks.sendSignal(pubkey, {t: 'offer', sdp: pc.localDescription.sdp});
  }

  async handleSignal(fromPubkey: string, signal: SignalMessage): Promise<void> {
    if(!signal) return;

    if(signal.t === 'hello') {
      // We were nudged to initiate. Only act if we are in fact the initiator.
      if(this.amInitiator(fromPubkey)) {
        await this.startOffer(fromPubkey).catch((e) => logSwallow('MeshManager.helloOffer', e));
      }
      return;
    }

    if(signal.t === 'offer') {
      await this.handleOffer(fromPubkey, signal);
    } else if(signal.t === 'answer') {
      await this.handleAnswer(fromPubkey, signal);
    } else if(signal.t === 'candidate') {
      await this.handleIceCandidate(fromPubkey, signal);
    } else if(signal.t === 'bye') {
      this.disconnect(fromPubkey);
    }
  }

  private async handleOffer(fromPubkey: string, signal: SignalMessage & {t: 'offer'}): Promise<void> {
    if(this.peers.size >= MAX_CONNECTIONS) return;

    const pc = new RTCPeerConnection(this.rtcConfig());

    const sessionId = `${fromPubkey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const state: PeerState = {
      pc,
      dc: null,
      status: 'connecting',
      sessionId,
      reconnectAttempts: 0,
      reconnectTimer: null,
      pingTimer: null,
      pingTimeoutTimer: null,
      lastPongTime: 0,
      latency: -1,
      pingSentTime: 0,
      remoteDescriptionSet: false,
      verified: false
    };

    this.peers.set(fromPubkey, state);

    pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
      const dc = event.channel;
      state.dc = dc;
      this.setupDataChannel(fromPubkey, dc);
    });

    this.setupPeerConnection(fromPubkey, pc);

    await pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: signal.sdp}));
    if(!this.peers.has(fromPubkey) || this.peers.get(fromPubkey)!.sessionId !== sessionId) return;
    state.remoteDescriptionSet = true;
    await this.flushPendingCandidates(fromPubkey);
    if(!this.peers.has(fromPubkey) || this.peers.get(fromPubkey)!.sessionId !== sessionId) return;

    const answer = await pc.createAnswer();
    if(!this.peers.has(fromPubkey) || this.peers.get(fromPubkey)!.sessionId !== sessionId) return;
    await pc.setLocalDescription(answer);
    if(!this.peers.has(fromPubkey) || this.peers.get(fromPubkey)!.sessionId !== sessionId) return;

    await this.callbacks.sendSignal(fromPubkey, {t: 'answer', sdp: pc.localDescription.sdp});
  }

  private async handleAnswer(fromPubkey: string, signal: SignalMessage & {t: 'answer'}): Promise<void> {
    const state = this.peers.get(fromPubkey);
    if(!state) return;
    const expectedSessionId = state.sessionId;

    await state.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: signal.sdp}));
    if(!this.peers.has(fromPubkey) || this.peers.get(fromPubkey)!.sessionId !== expectedSessionId) return;
    state.remoteDescriptionSet = true;
    await this.flushPendingCandidates(fromPubkey);
  }

  private async handleIceCandidate(fromPubkey: string, signal: SignalMessage & {t: 'candidate'}): Promise<void> {
    if(!signal.candidate) return;

    const init: RTCIceCandidateInit = {
      candidate: signal.candidate,
      sdpMid: signal.sdpMid ?? undefined,
      sdpMLineIndex: signal.sdpMLineIndex ?? undefined
    };

    const state = this.peers.get(fromPubkey);

    // Buffer until the peer exists AND its remote description is set — relays can
    // deliver a candidate before the offer/answer. Applying it early either
    // throws (no remote description) or is lost (no peer). Flushed on
    // setRemoteDescription in the offer/answer paths.
    if(!state || !state.remoteDescriptionSet) {
      const pending = this.pendingCandidates.get(fromPubkey) ?? [];
      pending.push(init);
      this.pendingCandidates.set(fromPubkey, pending);
      return;
    }

    // Guard: ignore stale candidates for a replaced session
    const current = this.peers.get(fromPubkey);
    if(!current || current.sessionId !== state.sessionId) return;

    try {
      await state.pc.addIceCandidate(init);
    } catch(e) { logSwallow('MeshManager.addIceCandidate', e); }
  }

  /** Apply and clear any candidates buffered before the remote description existed. */
  private async flushPendingCandidates(pubkey: string): Promise<void> {
    const pending = this.pendingCandidates.get(pubkey);
    if(!pending || pending.length === 0) return;

    this.pendingCandidates.delete(pubkey);

    const state = this.peers.get(pubkey);
    if(!state) return;

    for(const init of pending) {
      try {
        await state.pc.addIceCandidate(init);
      } catch(e) { logSwallow('MeshManager.flushPendingCandidates', e); }
    }
  }

  private setupDataChannel(pubkey: string, dc: RTCDataChannel): void {
    dc.addEventListener('open', () => {
      const state = this.peers.get(pubkey);
      if(!state) return;

      state.status = 'connected';
      state.reconnectAttempts = 0;
      state.verified = false;
      state.lastPongTime = Date.now();
      this.callbacks.onPeerConnected(pubkey);
      this.startPing(pubkey);
      // Fire one PING immediately so verification (first PONG) lands within a
      // round-trip rather than after the first 30s interval — the badge goes
      // green in ~ms on a healthy channel (#61 R3), not half a minute later.
      this.pingPeer(pubkey);
    });

    dc.addEventListener('message', (event: MessageEvent) => {
      const state = this.peers.get(pubkey);
      if(!state) return;

      const data = event.data as string;

      if(data === 'PING') {
        if(dc.readyState === 'open') {
          dc.send('PONG');
        }
        return;
      }

      if(data === 'PONG') {
        state.lastPongTime = Date.now();
        if(state.pingSentTime > 0) {
          state.latency = Date.now() - state.pingSentTime;
        }
        // First PONG proves a full round-trip: the channel is verified live, so
        // the P2P badge may go green (#61 R3). Notify listeners on the rising
        // edge so the badge repaints the instant liveness is confirmed rather
        // than waiting for its next poll.
        if(!state.verified) {
          state.verified = true;
          this.callbacks.onPeerVerified?.(pubkey);
        }
        if(state.pingTimeoutTimer !== null) {
          clearTimeout(state.pingTimeoutTimer);
          state.pingTimeoutTimer = null;
        }
        return;
      }

      this.callbacks.onPeerMessage(pubkey, data);
    });

    dc.addEventListener('close', () => {
      this.handleDisconnect(pubkey);
    });

    dc.addEventListener('error', () => {
      this.handleDisconnect(pubkey);
    });
  }

  private setupPeerConnection(pubkey: string, pc: RTCPeerConnection): void {
    pc.addEventListener('connectionstatechange', () => {
      if(pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.handleDisconnect(pubkey);
      }
    });

    pc.addEventListener('icecandidate', async(event: RTCPeerConnectionIceEvent) => {
      if(!event.candidate) return;

      const state = this.peers.get(pubkey);
      if(!state) return;
      const expectedSessionId = state.sessionId;

      const c = event.candidate;
      try {
        const current = this.peers.get(pubkey);
        if(!current || current.sessionId !== expectedSessionId) return;
        await this.callbacks.sendSignal(pubkey, {
          t: 'candidate',
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex
        });
      } catch(e) { logSwallow('MeshManager.sendIceCandidate', e); }
    });
  }

  private startPing(pubkey: string): void {
    const state = this.peers.get(pubkey);
    if(!state) return;

    if(state.pingTimer !== null) {
      clearInterval(state.pingTimer);
    }

    state.pingTimer = setInterval(() => {
      this.pingPeer(pubkey);
    }, PING_INTERVAL);
  }

  /**
   * Send one PING on a peer's data channel and arm the PONG-timeout that tears
   * the channel down (→ reconnect) if no PONG returns within PING_TIMEOUT. Used
   * both for the immediate on-open verification ping and every interval ping.
   * No-op unless the peer is connected with an open channel.
   */
  private pingPeer(pubkey: string): void {
    const s = this.peers.get(pubkey);
    if(!s || s.status !== 'connected') return;
    if(!s.dc || s.dc.readyState !== 'open') return;

    // One outstanding ping at a time. Guard BEFORE stamping pingSentTime: if a
    // PONG is still pending, stacking a second PING would advance pingSentTime
    // and skew the latency/verify round-trip against the earlier, unanswered
    // ping. The PONG handler clears the timeout, so the next interval ping sends
    // normally. (Lena review, #68.)
    if(s.pingTimeoutTimer !== null) return;

    s.pingSentTime = Date.now();
    try {
      s.dc.send('PING');
    } catch(e) {
      // Send on a channel that just went bad → treat as a disconnect.
      logSwallow('MeshManager.pingPeer', e);
      this.handleDisconnect(pubkey, true);
      return;
    }

    s.pingTimeoutTimer = setTimeout(() => {
      const current = this.peers.get(pubkey);
      if(!current || current.status !== 'connected') return;
      this.handleDisconnect(pubkey, true);
    }, PING_TIMEOUT);
  }

  /**
   * True only when the peer's data channel is open AND a PING/PONG round-trip
   * has completed since it opened — i.e. the connection is PROVEN live, not just
   * newly-opened. The P2P badge (#61 R3) gates green on this so it never lights
   * for a channel that opened but is already a zombie.
   */
  isVerified(pubkey: string): boolean {
    const state = this.peers.get(pubkey);
    return Boolean(state && state.status === 'connected' && state.verified);
  }

  private stopPing(pubkey: string): void {
    const state = this.peers.get(pubkey);
    if(!state) return;

    if(state.pingTimer !== null) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }

    if(state.pingTimeoutTimer !== null) {
      clearTimeout(state.pingTimeoutTimer);
      state.pingTimeoutTimer = null;
    }
  }

  private handleDisconnect(pubkey: string, fromPingTimeout = false): void {
    const state = this.peers.get(pubkey);
    if(!state) return;

    if(state.status === 'disconnected' && !fromPingTimeout) return;

    this.stopPing(pubkey);

    const wasConnected = state.status === 'connected';
    state.status = 'disconnected';
    state.dc = null;

    try {
      state.pc.close();
    } catch(e) { logSwallow('MeshManager.handleDisconnect.pcClose', e); }

    if(wasConnected) {
      this.callbacks.onPeerDisconnected(pubkey);
    }

    if(state.reconnectAttempts === Infinity) return;

    this.scheduleReconnect(pubkey, state);
  }

  private scheduleReconnect(pubkey: string, state: PeerState): void {
    if(state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
    }

    const delayIndex = Math.min(state.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[delayIndex];

    state.reconnectTimer = setTimeout(async() => {
      const current = this.peers.get(pubkey);
      if(!current || current.reconnectAttempts === Infinity) return;

      current.reconnectAttempts++;
      this.peers.delete(pubkey);
      this.pendingCandidates.delete(pubkey);

      try {
        await this.connect(pubkey);
        const newState = this.peers.get(pubkey);
        if(newState) {
          newState.reconnectAttempts = current.reconnectAttempts;
        }
      } catch(e) { logSwallow('MeshManager.reconnect', e); }
    }, delay);
  }

  disconnect(pubkey: string): void {
    const state = this.peers.get(pubkey);
    if(!state) return;

    state.reconnectAttempts = Infinity;

    if(state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    this.stopPing(pubkey);

    try {
      if(state.dc) state.dc.close();
    } catch(e) { logSwallow('MeshManager.disconnect.dcClose', e); }

    try {
      state.pc.close();
    } catch(e) { logSwallow('MeshManager.disconnect.pcClose', e); }

    state.status = 'disconnected';
    this.peers.delete(pubkey);
    this.pendingCandidates.delete(pubkey);
  }

  disconnectAll(): void {
    const pubkeys = Array.from(this.peers.keys());
    for(const pubkey of pubkeys) {
      this.disconnect(pubkey);
    }
  }

  /**
   * Proactively restart every peer connection.
   *
   * On a network change (tailnet switch, wifi→cellular, VPN up/down) the
   * existing ICE candidate pairs become stale, but the browser may take up to
   * PING_TIMEOUT (90 s) before declaring the connection failed. This method
   * tears down all connections immediately and initiates reconnection.
   * For initiators this creates a fresh RTCPeerConnection right away; for
   * responders (`!amInitiator`) `connect()` sends a hello nudge and waits
   * for the initiator's offer — no new RTCPeerConnection is created until the
   * offer arrives.
   *
   * Relay remains the guaranteed floor throughout the reconnect window.
   */
  restartAll(): void {
    const pubkeys = Array.from(this.peers.keys());

    // Disconnect first (synchronously) to cancel any pending reconnect timers
    // and prevent the old reconnect loop from interfering.
    for(const pubkey of pubkeys) {
      this.disconnect(pubkey);
    }

    // Immediately reconnect with fresh PCs. Fire-and-forget: connect() handles
    // its own errors via logSwallow inside the signal handlers.
    for(const pubkey of pubkeys) {
      this.connect(pubkey).catch((e) => logSwallow('MeshManager.restartAll', e));
    }
  }

  send(pubkey: string, message: string): boolean {
    const state = this.peers.get(pubkey);
    if(!state || state.status !== 'connected' || !state.dc || state.dc.readyState !== 'open') {
      return false;
    }

    try {
      state.dc.send(message);
      return true;
    } catch(e) {
      logSwallow('MeshManager.send', e);
      return false;
    }
  }

  getStatus(pubkey: string): PeerStatus {
    const state = this.peers.get(pubkey);
    if(!state) return 'disconnected';
    return state.status;
  }

  getConnectedPeers(): string[] {
    const result: string[] = [];
    for(const [pubkey, state] of this.peers) {
      if(state.status === 'connected') result.push(pubkey);
    }
    return result;
  }

  getPeerLatency(pubkey: string): number {
    const state = this.peers.get(pubkey);
    if(!state) return -1;
    return state.latency;
  }
}
