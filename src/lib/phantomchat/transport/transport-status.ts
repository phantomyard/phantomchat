/*
 * PhantomChat.chat — per-peer P2P transport status (issue #52 badge companion)
 *
 * A tiny observable record of "how did the last message to this peer actually
 * go out". The transport ladder (#61 TransportSelector.tryDeliver) already
 * returns a DeliveryResult per send; this module is where the UI-facing summary
 * of that lives so the P2P badge (contact row + chat top bar) can render whether
 * a peer is reachable over a direct transport (local-ws / WebRTC / DHT) versus
 * falling through to the Nostr relay.
 *
 * TWO SIGNALS, ONE VERDICT. A peer counts as "P2P" for the badge when EITHER:
 *   - it has ADVERTISED capability (window.__phantomchatCapability.has) — i.e. it
 *     runs a phantombot P2P node we ingested an advert for; or
 *   - our last real delivery to it actually landed on a direct tier.
 * The advert is the steady-state signal (present before we've sent anything);
 * the last-delivery tier is the confirmation. Either is enough to say "this
 * conversation can go direct", which is what the badge communicates.
 *
 * AUDIT LOGGING. Every recorded tier and every state flip is logged under the
 * `[p2p]` tag so a session can be audited/debugged after the fact — deliberately
 * terse (one line per change, not per send) so it never becomes a firehose.
 */

import type {TransportTier} from '@lib/phantomchat/transport/transport-selector';

const LOG_PREFIX = '[p2p]';

/** The direct (non-relay) tiers. A delivery on any of these is "true P2P". */
const DIRECT_TIERS: ReadonlySet<TransportTier> = new Set<TransportTier>(['local-ws', 'webrtc', 'dht']);

export type P2PState = 'p2p' | 'relay';

interface PeerRecord {
  tier: TransportTier;
  at: number;
}

type Subscriber = () => void;

/**
 * Singleton store of last-known transport per peer (hex pubkey), plus a cheap
 * pub/sub so mounted badges refresh the instant a delivery lands. Capability
 * adverts are read live off `window.__phantomchatCapability` at query time (the
 * ingestor owns that map), so this store only needs to carry the delivery side.
 */
export class TransportStatus {
  private records = new Map<string, PeerRecord>();
  private subscribers = new Set<Subscriber>();

  /** Record the tier a send to `pubkey` used. Logs + notifies only on a flip.
   * Accepts a plain string so callers holding a structural type (ChatAPI's
   * decoupled P2PFastPath) don't need the TransportTier import. */
  record(pubkey: string, tierRaw: TransportTier | string): void {
    if(!pubkey || typeof pubkey !== 'string') return;
    const tier = tierRaw as TransportTier;
    const prev = this.records.get(pubkey);
    this.records.set(pubkey, {tier, at: Date.now()});

    const wasDirect = prev ? DIRECT_TIERS.has(prev.tier) : false;
    const isDirect = DIRECT_TIERS.has(tier);
    if(prev?.tier !== tier) {
      console.log(`${LOG_PREFIX} delivery ${pubkey.slice(0, 8)} via ${tier}${isDirect ? ' (direct)' : ''}`);
    }
    if(wasDirect !== isDirect) this.notify();
  }

  /** The last tier a send to `pubkey` used, or undefined if we've never sent. */
  getTier(pubkey: string): TransportTier | undefined {
    return this.records.get(pubkey)?.tier;
  }

  /** True if our last delivery to `pubkey` landed on a direct (non-relay) tier. */
  deliveredDirect(pubkey: string): boolean {
    const rec = this.records.get(pubkey);
    return rec ? DIRECT_TIERS.has(rec.tier) : false;
  }

  /**
   * The badge verdict for a peer: 'p2p' when it advertised capability OR our
   * last delivery went direct; 'relay' otherwise. Reads the capability registry
   * live so a freshly-ingested advert flips the badge without us plumbing an
   * event through the ingestor.
   */
  stateFor(pubkey: string): P2PState {
    if(!pubkey) return 'relay';
    if(this.deliveredDirect(pubkey)) return 'p2p';
    try {
      const cap = (typeof window !== 'undefined') ? (window as any).__phantomchatCapability : null;
      if(cap && typeof cap.has === 'function' && cap.has(pubkey)) return 'p2p';
    } catch{ /* registry not ready — treat as relay */ }
    return 'relay';
  }

  /** Subscribe to state flips (delivery tier crossing the direct/relay line).
   * Returns an unsubscribe fn. */
  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Nudge subscribers to re-evaluate (used by the badge's capability poll). */
  notify(): void {
    for(const cb of this.subscribers) {
      try { cb(); } catch{ /* a bad subscriber must not break delivery */ }
    }
  }
}

let instance: TransportStatus | null = null;

/** Process-wide singleton, also exposed on window for the badge + debugging. */
export function getTransportStatus(): TransportStatus {
  if(!instance) {
    instance = new TransportStatus();
    if(typeof window !== 'undefined') (window as any).__phantomchatTransportStatus = instance;
  }
  return instance;
}
