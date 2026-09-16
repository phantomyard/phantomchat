/*
 * PhantomChat.chat — direct-transport selector (issue #61)
 *
 * Picks the direct transport for an outgoing message and, when it is available,
 * pushes a live copy of the wire payload over it. After the #61 simplification
 * there are exactly two transports:
 *
 *   1. webrtc  — browser-native WebRTC data channel, NAT-traversed via ICE
 *                (host / STUN-reflexive / TURN), signaled over Nostr (mesh).
 *   2. relay   — decline; the caller's existing Nostr relay publish is the floor.
 *
 * The former `local-ws` (same-machine `ws://localhost`) and `dht` (Hyperswarm)
 * tiers were REMOVED: localhost only helped when both peers' nodes shared one
 * machine, and the DHT tier was a browser stub that never ran. WebRTC alone
 * covers same-LAN (ICE host candidates) and cross-NAT (STUN/TURN).
 *
 * THE GATE. The direct path only runs for a recipient that has ADVERTISED WebRTC
 * capability. With no advertisement `tryDeliver` returns immediately on the
 * `relay` tier having touched nothing — no probe, no socket, no delay.
 *
 * PARALLEL, NOT REPLACEMENT. This selector is invoked as a fire-and-forget copy
 * alongside the relay publish; it never replaces it. The relay copy stays the
 * source of truth for delivery receipts, retries, the offline queue and multi-
 * device. When the WebRTC channel is live the peer renders whichever copy lands
 * first and dedups the other. Every existing reliability guarantee stays intact
 * while the relay hop leaves the perceived latency once a peer is P2P-capable.
 *
 * THE FRAME. We do NOT invent a bespoke P2P envelope. `tryDeliver` is handed the
 * EXACT kind-1059 gift-wrap events the relay publish just built, and ships the
 * recipient-addressed wrap over WebRTC as a standard Nostr relay wire frame:
 * `["EVENT", wrap]`. The receiver feeds that straight into the same relay-pool
 * ingest a real relay message takes (NostrRelayPool.ingestP2PEvent): the outer
 * wrap id is identical to the relay copy (pre-decrypt dedup drops the second
 * arrival), and the inner rumor id is identical too (post-unwrap dedup as a
 * second net). Reusing the wrap means the P2P copy inherits every existing
 * crypto, signature-verify, presence-filter, receipt and dispatch guarantee.
 *
 * FIRE-AND-FORGET. `tryDeliver` itself is best-effort: a `webrtc` tier means
 * "handed to the data channel". Confirmation is separate — the receiver answers
 * with a `["OK", id, true, "p2p"]` receipt (see p2p-receipts.ts) and
 * `awaitAck` resolves true when it lands. The relay copy stays the floor either
 * way, so a silently-dropped P2P copy is still invisible to the user.
 */

import {logSwallow, swallowHandler} from '@lib/phantomchat/log-swallow';
import {NostrEvent} from '@lib/phantomchat/nostr-relay';
import {PeerCapabilityRegistry, hasAnyCapability} from '@lib/phantomchat/transport/capability';

export type TransportTier = 'webrtc' | 'relay';

export interface DeliveryResult {
  tier: TransportTier;
  delivered: boolean;
}

/** Minimal slice of MeshManager the selector needs (keeps it mockable). */
export interface MeshLike {
  getStatus(pubkey: string): 'connected' | 'connecting' | 'disconnected';
  send(pubkey: string, message: string): boolean;
  connect(pubkey: string): Promise<void>;
  /** True once the channel is open AND a PING/PONG round-trip has proven it live
   * (see MeshManager.isVerified). The badge gates green on this. */
  isVerified(pubkey: string): boolean;
}

export interface TransportSelectorDeps {
  capability: PeerCapabilityRegistry;
  mesh: MeshLike | null;
  /** How long to wait for a WebRTC data channel to come up. Default 1500ms. */
  rtcConnectTimeoutMs?: number;
  /** Poll granularity while waiting for the mesh to connect. Default 50ms. */
  rtcPollMs?: number;
  /** How long `awaitAck` waits for the peer's OK receipt. Default 2000ms. */
  ackTimeoutMs?: number;
}

const DEFAULT_RTC_CONNECT_TIMEOUT_MS = 1500;
const DEFAULT_RTC_POLL_MS = 50;
const DEFAULT_ACK_TIMEOUT_MS = 2000;
/** Receipts that arrived before anyone awaited them (bounded, oldest evicted). */
const MAX_EARLY_ACKS = 256;

export class TransportSelector {
  private deps: TransportSelectorDeps;
  private rtcConnectTimeoutMs: number;
  private rtcPollMs: number;
  private ackTimeoutMs: number;
  /** `pubkey:eventId` → resolvers waiting for that peer's receipt. */
  private ackWaiters = new Map<string, Array<(acked: boolean) => void>>();
  /**
   * `pubkey:eventId` of ACCEPTED receipts that landed before `awaitAck` was
   * called. Early rejections are deliberately not stored (phantomchat#146): an
   * unsolicited or re-ordered `["OK", id, false]` must never pre-empt a genuine
   * ack arriving later inside the ack window.
   */
  private earlyAcks = new Set<string>();

  constructor(deps: TransportSelectorDeps) {
    this.deps = deps;
    this.rtcConnectTimeoutMs = deps.rtcConnectTimeoutMs ?? DEFAULT_RTC_CONNECT_TIMEOUT_MS;
    this.rtcPollMs = deps.rtcPollMs ?? DEFAULT_RTC_POLL_MS;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  }

  /**
   * A P2P receipt arrived from `pubkey` for wrap `eventId`. Keyed by peer, so
   * only the peer we actually sent to can confirm a send.
   */
  handleAck(pubkey: string, eventId: string): void {
    this.settleReceipt(pubkey, eventId, true);
  }

  /**
   * A P2P rejection (`["OK", id, false]`) arrived from `pubkey` for `eventId`.
   * Not a delivery, but an answer: an ALREADY-ARMED waiter resolves false now
   * rather than holding the send for the whole ack window (phantomchat#142). A
   * rejection with no waiter yet is discarded (phantomchat#146).
   */
  handleReject(pubkey: string, eventId: string): void {
    this.settleReceipt(pubkey, eventId, false);
  }

  private settleReceipt(pubkey: string, eventId: string, accepted: boolean): void {
    if(!pubkey || !eventId) return;
    const key = `${pubkey}:${eventId}`;
    const waiters = this.ackWaiters.get(key);
    if(waiters) {
      this.ackWaiters.delete(key);
      for(const resolve of waiters) resolve(accepted);
      return;
    }
    // No waiter armed yet. Only an acceptance is remembered; an early rejection
    // is discarded so it can neither settle a later send nor downgrade an ack
    // we already hold (#146). A send then waits out its normal ack window.
    if(!accepted) return;
    // Re-insert so a repeated receipt refreshes its eviction position.
    this.earlyAcks.delete(key);
    this.earlyAcks.add(key);
    if(this.earlyAcks.size > MAX_EARLY_ACKS) {
      const oldest = this.earlyAcks.keys().next().value;
      if(oldest !== undefined) this.earlyAcks.delete(oldest);
    }
  }

  /**
   * Resolve true once `recipientPubkey` acknowledges the recipient-addressed
   * wrap in `wraps` over the data channel, false after the ack window (or when
   * there is no such wrap). Never throws.
   */
  awaitAck(recipientPubkey: string, wraps: NostrEvent[]): Promise<boolean> {
    try {
      const wrap = this.pickRecipientWrap(wraps, recipientPubkey);
      if(!wrap?.id) return Promise.resolve(false);
      const key = `${recipientPubkey}:${wrap.id}`;
      if(this.earlyAcks.delete(key)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const list = this.ackWaiters.get(key) ?? [];
        let done = false;
        const finish = (acked: boolean) => {
          if(done) return;
          done = true;
          clearTimeout(timer);
          resolve(acked);
        };
        const timer = setTimeout(() => {
          const current = this.ackWaiters.get(key);
          if(current) {
            const rest = current.filter((r) => r !== finish);
            if(rest.length) this.ackWaiters.set(key, rest);
            else this.ackWaiters.delete(key);
          }
          finish(false);
        }, this.ackTimeoutMs);
        list.push(finish);
        this.ackWaiters.set(key, list);
      });
    } catch(e) {
      logSwallow('TransportSelector.awaitAck', e);
      return Promise.resolve(false);
    }
  }

  /**
   * Try to push a live copy of an already-built gift-wrap over WebRTC. `wraps`
   * are the kind-1059 events the relay publish just produced (recipient + self);
   * we ship the recipient-addressed one as an `["EVENT", wrap]` frame. Fire-and-
   * forget from the caller's perspective: never throws, and returns the tier it
   * used (or `relay` when it declined). Safe to `void`.
   */
  async tryDeliver(recipientPubkey: string, wraps: NostrEvent[]): Promise<DeliveryResult> {
    try {
      const caps = this.deps.capability.get(recipientPubkey);

      // THE GATE — no advertisement, no direct path, no cost.
      if(!hasAnyCapability(caps)) {
        return {tier: 'relay', delivered: false};
      }

      // Ship the wrap ADDRESSED TO THE RECIPIENT (p-tag === recipient). The self
      // wrap is encrypted to our own key and the peer could never unwrap it.
      const wrap = this.pickRecipientWrap(wraps, recipientPubkey);
      if(!wrap) {
        return {tier: 'relay', delivered: false};
      }

      const frame = JSON.stringify(['EVENT', wrap]);

      // WebRTC via the mesh data channel (LAN host candidates, STUN, or TURN).
      if(caps.webrtc && this.deps.mesh) {
        if(this.deps.mesh.getStatus(recipientPubkey) === 'connected') {
          if(this.deps.mesh.send(recipientPubkey, frame)) {
            return {tier: 'webrtc', delivered: true};
          }
        } else if(await this.connectMeshWithTimeout(recipientPubkey)) {
          if(this.deps.mesh.send(recipientPubkey, frame)) {
            return {tier: 'webrtc', delivered: true};
          }
        }
      }

      // The direct path declined → relay floor (the caller already runs it).
      return {tier: 'relay', delivered: false};
    } catch(e) {
      logSwallow('TransportSelector.tryDeliver', e);
      return {tier: 'relay', delivered: false};
    }
  }

  /**
   * The LIVE direct-transport state for a peer, right now — not a historical
   * send. Returns 'webrtc' when there is a VERIFIED-live WebRTC data channel to
   * the peer (open AND a PING/PONG round-trip completed), else null. The P2P
   * badge reads this so green means "there is a rock-solid direct connection to
   * this peer at this moment", and the chip goes dark the instant the channel
   * drops or fails verification — never a stale green from an old send, and
   * never an optimistic green from a channel that opened but is already a zombie.
   */
  liveDirectTier(recipientPubkey: string): TransportTier | null {
    try {
      if(!recipientPubkey) return null;
      if(this.deps.mesh &&
         this.deps.mesh.getStatus(recipientPubkey) === 'connected' &&
         this.deps.mesh.isVerified(recipientPubkey)) {
        return 'webrtc';
      }
      return null;
    } catch(e) {
      logSwallow('TransportSelector.liveDirectTier', e);
      return null;
    }
  }

  /**
   * Choose the gift-wrap addressed to `recipientPubkey` (its p-tag holds the
   * recipient). `publish()` returns both the recipient wrap and a self wrap for
   * multi-device sync; only the recipient wrap is decryptable by the peer. Falls
   * back to a single wrap when there is exactly one (legacy/no self-wrap).
   */
  private pickRecipientWrap(wraps: NostrEvent[], recipientPubkey: string): NostrEvent | null {
    if(!Array.isArray(wraps) || wraps.length === 0) return null;
    const match = wraps.find((w) =>
      Array.isArray(w?.tags) && w.tags.some((t) => t[0] === 'p' && t[1] === recipientPubkey)
    );
    if(match) return match;
    return wraps.length === 1 ? wraps[0] : null;
  }

  /**
   * Kick the mesh to connect and poll until it reports `connected` or the RTC
   * budget elapses. `MeshManager.connect` resolves once the offer is sent, not
   * once the channel is open, so we poll `getStatus` for the real state.
   */
  private async connectMeshWithTimeout(pubkey: string): Promise<boolean> {
    const mesh = this.deps.mesh;
    if(!mesh) return false;

    if(mesh.getStatus(pubkey) === 'connected') return true;

    mesh.connect(pubkey).catch(swallowHandler('TransportSelector.meshConnect'));

    const deadline = Date.now() + this.rtcConnectTimeoutMs;
    while(Date.now() < deadline) {
      if(mesh.getStatus(pubkey) === 'connected') return true;
      await this.sleep(this.rtcPollMs);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
