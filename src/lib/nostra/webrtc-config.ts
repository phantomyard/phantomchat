export interface TurnServerConfig {
  urls: string;
  username: string;
  credential: string;
}

// Default TURN server — must use TURNS (TLS on 443) for Tor compatibility
// Standard TURN uses UDP which Tor cannot proxy
const DEFAULT_TURN: TurnServerConfig = {
  urls: 'turns:turn.nostra.chat:443',
  username: 'nostra',
  credential: 'anonymous'
};

export function getRtcConfig(turnOverride?: TurnServerConfig): RTCConfiguration {
  const turn = turnOverride || DEFAULT_TURN;

  return {
    iceServers: [{
      urls: turn.urls,
      username: turn.username,
      credential: turn.credential
    }],
    // CRITICAL: 'relay' = only TURN candidates, no host/srflx (which leak IP)
    iceTransportPolicy: 'relay',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
}

export const DATA_CHANNEL_NAME = 'nostr-relay';

export const DATA_CHANNEL_OPTIONS: RTCDataChannelInit = {
  ordered: true
};

// Signaling kind inside gift-wrap rumor
export const SIGNAL_KIND = 29001;

export interface SignalMessage {
  type: 'webrtc-signal';
  action: 'offer' | 'answer' | 'ice-candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  sessionId: string;
}
