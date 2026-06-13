import {getRtcConfig, DATA_CHANNEL_NAME, DATA_CHANNEL_OPTIONS, SignalMessage} from '@lib/nostra/webrtc-config';
import {createSignalEvent, parseSignalContent} from '@lib/nostra/mesh-signaling';
import {logSwallow} from '@lib/nostra/log-swallow';

const MAX_CONNECTIONS = 50;
const PING_INTERVAL = 30000;
const PING_TIMEOUT = 90000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 10000];

export type PeerStatus = 'connected' | 'connecting' | 'disconnected';

export interface MeshCallbacks {
  sendSignal: (recipientPubkey: string, signal: {kind: number; content: string}) => Promise<void>;
  onPeerMessage: (pubkey: string, message: string) => void;
  onPeerConnected: (pubkey: string) => void;
  onPeerDisconnected: (pubkey: string) => void;
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
}

export class MeshManager {
  private peers: Map<string, PeerState> = new Map();
  private callbacks: MeshCallbacks;

  constructor(callbacks: MeshCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(pubkey: string): Promise<void> {
    if(this.peers.has(pubkey)) {
      const existing = this.peers.get(pubkey);
      if(existing.status === 'connected' || existing.status === 'connecting') return;
    }

    if(this.peers.size >= MAX_CONNECTIONS) {
      throw new Error(`Max connections (${MAX_CONNECTIONS}) reached`);
    }

    const sessionId = `${pubkey}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pc = new RTCPeerConnection(getRtcConfig());
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
      pingSentTime: 0
    };

    this.peers.set(pubkey, state);
    this.setupDataChannel(pubkey, dc);
    this.setupPeerConnection(pubkey, pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const signal = createSignalEvent({
      action: 'offer',
      sdp: pc.localDescription.sdp,
      sessionId
    });

    await this.callbacks.sendSignal(pubkey, signal);
  }

  async handleSignal(fromPubkey: string, content: string): Promise<void> {
    const signal = parseSignalContent(content);
    if(!signal) return;

    if(signal.action === 'offer') {
      await this.handleOffer(fromPubkey, signal);
    } else if(signal.action === 'answer') {
      await this.handleAnswer(fromPubkey, signal);
    } else if(signal.action === 'ice-candidate') {
      await this.handleIceCandidate(fromPubkey, signal);
    }
  }

  private async handleOffer(fromPubkey: string, signal: SignalMessage): Promise<void> {
    if(this.peers.size >= MAX_CONNECTIONS) return;

    const pc = new RTCPeerConnection(getRtcConfig());

    const state: PeerState = {
      pc,
      dc: null,
      status: 'connecting',
      sessionId: signal.sessionId,
      reconnectAttempts: 0,
      reconnectTimer: null,
      pingTimer: null,
      pingTimeoutTimer: null,
      lastPongTime: 0,
      latency: -1,
      pingSentTime: 0
    };

    this.peers.set(fromPubkey, state);

    pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
      const dc = event.channel;
      state.dc = dc;
      this.setupDataChannel(fromPubkey, dc);
    });

    this.setupPeerConnection(fromPubkey, pc);

    await pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: signal.sdp}));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const responseSignal = createSignalEvent({
      action: 'answer',
      sdp: pc.localDescription.sdp,
      sessionId: signal.sessionId
    });

    await this.callbacks.sendSignal(fromPubkey, responseSignal);
  }

  private async handleAnswer(fromPubkey: string, signal: SignalMessage): Promise<void> {
    const state = this.peers.get(fromPubkey);
    if(!state) return;

    await state.pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: signal.sdp}));
  }

  private async handleIceCandidate(fromPubkey: string, signal: SignalMessage): Promise<void> {
    const state = this.peers.get(fromPubkey);
    if(!state || !signal.candidate) return;

    await state.pc.addIceCandidate(signal.candidate);
  }

  private setupDataChannel(pubkey: string, dc: RTCDataChannel): void {
    dc.addEventListener('open', () => {
      const state = this.peers.get(pubkey);
      if(!state) return;

      state.status = 'connected';
      state.reconnectAttempts = 0;
      state.lastPongTime = Date.now();
      this.callbacks.onPeerConnected(pubkey);
      this.startPing(pubkey);
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

      const signal = createSignalEvent({
        action: 'ice-candidate',
        candidate: event.candidate.toJSON(),
        sessionId: state.sessionId
      });

      try {
        await this.callbacks.sendSignal(pubkey, signal);
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
      const s = this.peers.get(pubkey);
      if(!s || s.status !== 'connected') return;

      if(!s.dc || s.dc.readyState !== 'open') return;

      s.pingSentTime = Date.now();
      s.dc.send('PING');

      s.pingTimeoutTimer = setTimeout(() => {
        const current = this.peers.get(pubkey);
        if(!current || current.status !== 'connected') return;
        this.handleDisconnect(pubkey, true);
      }, PING_TIMEOUT);
    }, PING_INTERVAL);
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
  }

  disconnectAll(): void {
    const pubkeys = Array.from(this.peers.keys());
    for(const pubkey of pubkeys) {
      this.disconnect(pubkey);
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
    } catch{
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
