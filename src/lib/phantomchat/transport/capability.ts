/*
 * PhantomChat.chat — P2P transport capability registry (issue #61)
 *
 * The gate for the direct-transport path. A peer's WebRTC transport only
 * activates once that peer has ADVERTISED support for it. Until a peer
 * advertises, `has()` returns false and the transport selector no-ops — every
 * send falls straight through to the existing Nostr relay path with no probing
 * and no added latency.
 *
 * SCOPE (issue #61 rewrite). There is exactly ONE direct transport: WebRTC
 * (NAT-traversed via ICE, signaled over Nostr). The former `localWs` (same-
 * machine `ws://localhost`) and `dht` (Hyperswarm) tiers were removed — the
 * localhost tier only helped when both peers' nodes sat on one machine, and the
 * DHT tier was a browser stub that never ran. A peer therefore advertises
 * `{ webrtc: true }` or nothing.
 *
 * WIRE COMPAT. Older node adverts may still carry `localWs`/`localWsPort`/`dht`
 * fields; the parser simply ignores them and reads `webrtc`. New adverts omit
 * them.
 */

import IS_WEBRTC_SUPPORTED from '@environment/webrtcSupport';

export interface PeerCapabilities {
  /** Peer can hold a WebRTC data channel (LAN host candidates, STUN, or TURN). */
  webrtc?: boolean;
}

/**
 * Does this capability set advertise the direct (WebRTC) transport?
 * A record without `webrtc` is treated as "no P2P" and keeps the gate closed.
 */
export function hasAnyCapability(caps: PeerCapabilities | undefined): boolean {
  if(!caps) return false;
  return Boolean(caps.webrtc);
}

export class PeerCapabilityRegistry {
  private caps = new Map<string, PeerCapabilities>();

  /** Record (or replace) a peer's advertised capabilities. */
  set(pubkey: string, caps: PeerCapabilities): void {
    if(!hasAnyCapability(caps)) {
      this.caps.delete(pubkey);
      return;
    }
    this.caps.set(pubkey, caps);
  }

  /** Read a peer's advertised capabilities, or undefined if none. */
  get(pubkey: string): PeerCapabilities | undefined {
    return this.caps.get(pubkey);
  }

  /**
   * The gate. True only if this peer advertised at least one direct transport.
   * Cheap synchronous check so it can guard the hot send path with no cost.
   */
  has(pubkey: string): boolean {
    return this.caps.has(pubkey);
  }

  /** Forget a peer's capabilities (e.g. their node went offline). */
  clear(pubkey: string): void {
    this.caps.delete(pubkey);
  }

  /** Every peer currently known to advertise P2P. */
  advertisedPeers(): string[] {
    return Array.from(this.caps.keys());
  }
}

/**
 * The capabilities THIS browser client can offer to peers. A PWA can hold a
 * WebRTC data channel, so that is the one capability it advertises (when the
 * browser supports WebRTC). Advertising is additive and inert until a peer
 * reads it.
 */
export function getOwnCapabilities(): PeerCapabilities {
  return {
    webrtc: IS_WEBRTC_SUPPORTED
  };
}
