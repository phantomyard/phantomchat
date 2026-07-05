export interface TurnServerConfig {
  urls: string;
  username: string;
  credential: string;
}

// Default TURN server — must use TURNS (TLS on 443) for Tor compatibility
// Standard TURN uses UDP which Tor cannot proxy
const DEFAULT_TURN: TurnServerConfig = {
  urls: 'turns:turn.phantomchat.chat:443',
  username: 'phantomchat',
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

/**
 * Direct, TURN-free RTC config for the capability-gated P2P ladder (issue #61).
 *
 * The default `getRtcConfig()` forces `iceTransportPolicy: 'relay'` — every
 * candidate goes through the third-party TURN server `turn.phantomchat.chat`.
 * That is deliberate for the privacy/Tor posture (it never exposes host IPs) but
 * it CANNOT satisfy the #61 constraint of "only the GitHub Pages PWA + selected
 * Nostr relays, no other infra": a TURN-relayed channel still depends on a
 * third-party box and never gives a true direct LAN hop.
 *
 * This config uses `iceTransportPolicy: 'all'` with NO ICE servers, so ICE
 * gathers host (and mDNS) candidates only and two peers on the same LAN connect
 * directly, node-to-node, with zero third-party infrastructure. The trade-off is
 * explicit and intended: a direct P2P channel reveals local network candidates
 * to the (already trusted, contact-listed) peer. It is only used for peers that
 * advertised P2P capability, never for the default relay path.
 */
export function getRtcConfigDirect(): RTCConfiguration {
  return {
    iceServers: [],
    iceTransportPolicy: 'all',
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
