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
 * This config uses `iceTransportPolicy: 'all'` with public STUN servers, so ICE
 * gathers host candidates (same-LAN direct hop) AND server-reflexive candidates
 * (public IP:port discovered via STUN) for remote-NAT traversal — with zero
 * third-party *relaying* of data (STUN only reflects an address; the media/data
 * still flows peer-to-peer). This matches the phantombot node's ICE config
 * (`stun.l.google.com` in the node's src/config.ts) so a browser PWA and a node
 * negotiate a common candidate. The trade-off is explicit and intended: a direct
 * P2P channel reveals local + reflexive candidates to the (already trusted,
 * contact-listed) peer. It is only used for peers that advertised P2P
 * capability, never for the default relay path.
 *
 * STUN-only (no TURN) means a symmetric-NAT pair with no host route can still
 * fail to connect — those correctly fall back to the relay floor. LAN peers
 * (host candidates) and most home-NAT pairs (srflx) connect directly.
 */
export function getRtcConfigDirect(): RTCConfiguration {
  return {
    iceServers: [
      {urls: 'stun:stun.l.google.com:19302'},
      {urls: 'stun:stun1.l.google.com:19302'}
    ],
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
}

export const DATA_CHANNEL_NAME = 'nostr-relay';

export const DATA_CHANNEL_OPTIONS: RTCDataChannelInit = {
  ordered: true
};

/**
 * WebRTC signaling Nostr kind. MUST equal phantombot's `NOSTR_KIND_P2P_SIGNAL`
 * (see the node's src/p2p/signaling.ts) — a dedicated ephemeral kind (20000–29999)
 * carrying NIP-44-direct-encrypted offer/answer/ICE. NOT a gift-wrap (1059): the
 * two planes stay separate so the chat subscription never tries to unwrap a
 * signal, and relays don't persist stale offers. Signed with the node's/peer's
 * REAL key (both sides already know each other's pubkey), so the recipient
 * derives the NIP-44 conversation key from `event.pubkey`.
 *
 * Was 29001-inside-a-gift-wrap on the PWA side, which NO node ever spoke — that
 * mismatch is exactly why PWA↔node WebRTC signaling never fired. Now unified
 * onto the node's 21050 protocol.
 */
export const SIGNAL_KIND = 21050;

/**
 * A WebRTC signaling message. Wire-compatible with phantombot's `SignalMessage`
 * (node's src/p2p/signaling.ts) — the PWA and the node exchange these verbatim.
 *
 *  - offer/answer carry an SDP blob.
 *  - candidate is a single trickled ICE candidate.
 *  - hello is a glare-avoidance nudge: only the peer with the SMALLER pubkey ever
 *    offers; the larger-pubkey side sends `hello` to ask the initiator to offer.
 *  - bye tears a half-open negotiation down.
 */
export type SignalMessage =
  | {t: 'offer'; sdp: string}
  | {t: 'answer'; sdp: string}
  | {t: 'candidate'; candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null}
  | {t: 'hello'}
  | {t: 'bye'};
