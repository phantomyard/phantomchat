/*
 * PhantomChat.chat — P2P transport capability registry (issue #61)
 *
 * The gate for the whole tiered-transport ladder. A peer's direct-transport
 * tiers (localhost ws, LAN/remote WebRTC, DHT) only activate once that peer has
 * ADVERTISED support for them. Until a peer advertises, `has()` returns false
 * and the transport selector no-ops — every send falls straight through to the
 * existing Nostr relay path with no probing and no added latency.
 *
 * No PhantomChat client advertises P2P capability until the phantombot DHT node
 * (phantomyard/phantombot#258) ships, so this registry is empty for every
 * existing user and the ladder is fully dormant. That is the zero-regression
 * guarantee for this phase: relay-only behaviour is byte-for-byte unchanged.
 */

import IS_WEBRTC_SUPPORTED from '@environment/webrtcSupport';

export interface PeerCapabilities {
  /** Peer can accept a same-machine `ws://localhost` bridge connection. */
  localWs?: boolean;
  /** TCP port the peer's local node listens on for the ws bridge. */
  localWsPort?: number;
  /** Peer can hold a WebRTC data channel (LAN host candidates or remote). */
  webrtc?: boolean;
  /** Peer runs a Hyperswarm DHT node (phantombot#258). */
  dht?: boolean;
}

/**
 * Does this capability set advertise ANY direct transport we can try?
 * A record with every flag false/undefined is treated as "no P2P" and keeps
 * the gate closed for that peer.
 */
export function hasAnyCapability(caps: PeerCapabilities | undefined): boolean {
  if(!caps) return false;
  return Boolean(caps.localWs || caps.webrtc || caps.dht);
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
 * WebRTC data channel but can never run a raw-UDP DHT node or listen on a
 * localhost socket, so `dht` and `localWs` are always false here — those tiers
 * are things the client CONNECTS TO (a local/LAN phantombot), not things it
 * provides. Advertising is additive and inert until a peer reads it.
 */
export function getOwnCapabilities(): PeerCapabilities {
  return {
    localWs: false,
    webrtc: IS_WEBRTC_SUPPORTED,
    dht: false
  };
}
