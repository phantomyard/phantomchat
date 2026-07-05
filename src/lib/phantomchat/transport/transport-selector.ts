/*
 * PhantomChat.chat — tiered transport selector (issue #61)
 *
 * Picks the fastest available direct transport for an outgoing message and,
 * when one is available, pushes a live copy of the wire payload over it. The
 * ladder, fastest first:
 *
 *   1. local-ws  — same-machine phantombot over ws://localhost (~1ms)
 *   2. webrtc    — LAN host-candidate or remote WebRTC data channel (mesh)
 *   3. dht       — node-to-node Hyperswarm hop (phantombot#258; browser stub)
 *   4. relay     — decline; caller's existing Nostr relay publish is the floor
 *
 * THE GATE. The ladder only runs for a recipient that has ADVERTISED P2P
 * capability. With no advertisement `tryDeliver` returns immediately on the
 * `relay` tier having touched nothing — no probe, no socket, no delay. No client
 * advertises capability until phantombot#258 ships, so today every send skips
 * straight to the relay path exactly as before.
 *
 * PARALLEL, NOT REPLACEMENT. This selector is invoked as a fire-and-forget
 * copy alongside the relay publish; it never replaces it. The relay copy stays
 * the source of truth for delivery receipts, retries, the offline queue and
 * multi-device. When a direct tier is live the peer simply renders whichever
 * copy lands first and dedups the other. That keeps every existing reliability
 * guarantee intact while removing the relay hop from the perceived latency once
 * a peer is P2P-capable.
 *
 * THE FRAME. We do NOT invent a bespoke P2P envelope. `tryDeliver` is handed the
 * EXACT kind-1059 gift-wrap events the relay publish just built, and ships the
 * recipient-addressed wrap over the direct transport as a standard Nostr relay
 * wire frame: `["EVENT", wrap]`. The receiver feeds that straight into the same
 * relay-pool ingest a real relay message takes (see NostrRelayPool.ingestP2PEvent):
 *   - the OUTER wrap id is IDENTICAL to the relay copy, so the pool's pre-decrypt
 *     dedup drops whichever arrives second before it even unwraps — cheapest layer;
 *   - the INNER rumor id is identical too, so the post-unwrap dedup is a second
 *     safety net. The gift-wrap is self-describing (recipient in the p-tag, sender
 *     + rumor id revealed on unwrap), so no sidecar pubkey/rumor-id fields are
 *     needed. Reusing the wrap means the P2P copy inherits every existing crypto,
 *     signature-verify, presence-filter, receipt and dispatch guarantee for free.
 *
 * FIRE-AND-FORGET (review flag). Delivery is best-effort: there is no app-level
 * ack, so a `delivered` tier here is "handed to the transport", not "confirmed
 * rendered". The relay copy is the guaranteed floor, so a silently-dropped P2P
 * copy is invisible to the user (the relay copy still lands). If field data shows
 * the P2P path dropping copies often enough to matter, revisit this with a tiny
 * PC-P2P-ACK{rumorId} round-trip so `delivered` becomes truthful. Tracked in #61.
 */

import {logSwallow, swallowHandler} from '@lib/phantomchat/log-swallow';
import {NostrEvent} from '@lib/phantomchat/nostr-relay';
import {PeerCapabilityRegistry, hasAnyCapability} from '@lib/phantomchat/transport/capability';
import {LocalWsTransport} from '@lib/phantomchat/transport/local-ws-transport';

export type TransportTier = 'local-ws' | 'webrtc' | 'dht' | 'relay';

export interface DeliveryResult {
  tier: TransportTier;
  delivered: boolean;
}

/** Minimal slice of MeshManager the selector needs (keeps it mockable). */
export interface MeshLike {
  getStatus(pubkey: string): 'connected' | 'connecting' | 'disconnected';
  send(pubkey: string, message: string): boolean;
  connect(pubkey: string): Promise<void>;
}

export interface TransportSelectorDeps {
  capability: PeerCapabilityRegistry;
  mesh: MeshLike | null;
  local: LocalWsTransport | null;
  /** How long to wait for the ws://localhost probe. Default 80ms. */
  localTimeoutMs?: number;
  /** How long to wait for a WebRTC data channel to come up. Default 1500ms. */
  rtcConnectTimeoutMs?: number;
  /** Poll granularity while waiting for the mesh to connect. Default 50ms. */
  rtcPollMs?: number;
}

const DEFAULT_LOCAL_TIMEOUT_MS = 80;
const DEFAULT_RTC_CONNECT_TIMEOUT_MS = 1500;
const DEFAULT_RTC_POLL_MS = 50;

export class TransportSelector {
  private deps: TransportSelectorDeps;
  private localTimeoutMs: number;
  private rtcConnectTimeoutMs: number;
  private rtcPollMs: number;

  constructor(deps: TransportSelectorDeps) {
    this.deps = deps;
    this.localTimeoutMs = deps.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
    this.rtcConnectTimeoutMs = deps.rtcConnectTimeoutMs ?? DEFAULT_RTC_CONNECT_TIMEOUT_MS;
    this.rtcPollMs = deps.rtcPollMs ?? DEFAULT_RTC_POLL_MS;
  }

  /**
   * Try to push a live copy of an already-built gift-wrap over the fastest
   * direct transport. `wraps` are the kind-1059 events the relay publish just
   * produced (recipient + self); we ship the recipient-addressed one as an
   * `["EVENT", wrap]` frame. Fire-and-forget from the caller's perspective:
   * never throws, and returns the tier it used (or `relay` when it declined).
   * Safe to `void`.
   */
  async tryDeliver(recipientPubkey: string, wraps: NostrEvent[]): Promise<DeliveryResult> {
    try {
      const caps = this.deps.capability.get(recipientPubkey);

      // THE GATE — no advertisement, no ladder, no cost.
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

      // Tier 1: same-machine ws://localhost.
      if(caps.localWs && this.deps.local) {
        const up = await this.withTimeout(this.deps.local.ensureConnected(), this.localTimeoutMs, false);
        if(up && this.deps.local.send(frame)) {
          return {tier: 'local-ws', delivered: true};
        }
      }

      // Tier 2: LAN/remote WebRTC via the mesh data channel.
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

      // Tier 3: DHT. A browser cannot join a Hyperswarm DHT (no raw UDP); the
      // hop is node-to-node and brokered by phantombot#258. Declines here.
      if(caps.dht) {
        logSwallow('TransportSelector.dhtTierStub', 'dht advertised but browser has no DHT tier');
      }

      // All direct tiers declined → relay floor (the caller already runs it).
      return {tier: 'relay', delivered: false};
    } catch(e) {
      logSwallow('TransportSelector.tryDeliver', e);
      return {tier: 'relay', delivered: false};
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

  private withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        resolve(fallback);
      }, ms);
      promise.then((value) => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (err) => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        logSwallow('TransportSelector.withTimeout', err);
        resolve(fallback);
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
