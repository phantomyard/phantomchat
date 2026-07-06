/*
 * PhantomChat.chat — P2P capability INGESTION (phantomchat#61 / phantomyard/phantombot#258)
 *
 * The other half of the #61 gate. `capability.ts` owns the empty
 * PeerCapabilityRegistry that keeps the transport ladder dormant; NOTHING ever
 * called `registry.set(...)`, so `has(peer)` was always false and every send
 * fell through to the Nostr relay. This module is the missing feeder: it reads a
 * peer's capability ADVERTISEMENT off the relays and populates the registry, so
 * the ladder finally activates for peers that run a phantombot P2P node.
 *
 * THE WIRE CONTRACT (must match phantombot `src/p2p/capability.ts` exactly).
 * A node publishes a NIP-78 addressable app-data event under the persona pubkey:
 *   - kind    30078
 *   - `d` tag "phantomchat-p2p"
 *   - content JSON {localWs, localWsPort, webrtc, dht}
 * It is REPLACEABLE (re-published on each node start supersedes the previous),
 * PUBLIC/unencrypted (capability is not a secret and we must read it before any
 * encrypted channel exists), and stamped with `created_at` at publish time.
 *
 * EXPIRY. phantombot publishes the advert ONCE per node start and does not
 * re-advertise on a timer, so a node that ran and then died leaves its advert on
 * the relays indefinitely (replaceable events persist). We therefore trust an
 * advert only while it is younger than CAPABILITY_TTL_MS, re-poll periodically to
 * pick up restarts, and evict (registry.clear) any peer whose latest advert is
 * missing, malformed, all-false, or stale. The ladder is fire-and-forget with a
 * relay floor, so a slightly-stale advert only costs a bounded background probe —
 * never a lost or delayed message. See FOLLOW-UP in the PR body: once phantombot
 * re-advertises on an interval, CAPABILITY_TTL_MS can be tightened to a real
 * liveness signal.
 */

import {PeerCapabilities, PeerCapabilityRegistry, hasAnyCapability} from '@lib/phantomchat/transport/capability';
import {logSwallow, swallowHandler} from '@lib/phantomchat/log-swallow';

/** NIP-78 addressable app-data kind carrying the capability advert. */
export const CAPABILITY_KIND = 30078;

/** The `d` tag that namespaces the capability advert within kind 30078. */
export const CAPABILITY_D_TAG = 'phantomchat-p2p';

/**
 * How long an advert is trusted after its `created_at`. Generous on purpose:
 * phantombot only advertises at node start (no periodic re-publish), so an
 * always-on node may carry an hours-old timestamp while still perfectly live.
 * Expiring too eagerly would wrongly drop a live node back to relay-only. 7 days
 * bounds how long a decommissioned node lingers while never dropping a running
 * one. Tighten once the bot re-advertises on a timer (see module header).
 */
export const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How often to re-poll every contact's advert (picks up restarts + expiry). */
export const CAPABILITY_REFRESH_MS = 10 * 60 * 1000;

/** A relay/query event carrying (at least) the fields we parse. `pubkey` is
 * absent from `queryLatestEvent` results because we always query BY author, so
 * the caller already knows whose advert this is. */
export interface CapabilityAdvertEvent {
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}

/**
 * Parse a capability advert event into `{caps, createdAt}`, or null when it is
 * not a well-formed advert. Mirrors phantombot `parseCapabilityEvent`'s coercion
 * field-for-field so client and bot agree on the shape. Never throws.
 */
export function parseCapabilityAdvert(
  event: CapabilityAdvertEvent | null | undefined
): {caps: PeerCapabilities, createdAt: number} | null {
  if(!event) return null;
  try {
    if(event.kind !== CAPABILITY_KIND) return null;
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const hasDTag = tags.some((t) => t[0] === 'd' && t[1] === CAPABILITY_D_TAG);
    if(!hasDTag) return null;

    const parsed = JSON.parse(event.content) as Partial<PeerCapabilities>;
    if(typeof parsed !== 'object' || parsed === null) return null;

    return {
      caps: {
        localWs: Boolean(parsed.localWs),
        localWsPort: typeof parsed.localWsPort === 'number' ? parsed.localWsPort : 0,
        webrtc: Boolean(parsed.webrtc),
        dht: Boolean(parsed.dht)
      },
      createdAt: typeof event.created_at === 'number' ? event.created_at : 0
    };
  } catch(err) {
    logSwallow('capability-ingest.parseCapabilityAdvert', err);
    return null;
  }
}

/**
 * Is an advert stamped `createdAtSeconds` (Nostr seconds) still within its TTL
 * as of `nowMs` (ms)? A future-dated advert (clock skew) is treated as fresh.
 */
export function isAdvertFresh(createdAtSeconds: number, nowMs: number, ttlMs: number): boolean {
  if(!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return false;
  const ageMs = nowMs - createdAtSeconds * 1000;
  return ageMs <= ttlMs;
}

/**
 * Apply a single fetched advert to the registry for `pubkey`. Sets the peer's
 * capabilities when the advert is well-formed, fresh, and advertises at least
 * one transport; otherwise clears the peer (missing / malformed / all-false /
 * stale all collapse to "no P2P", so a peer never lingers). Returns the applied
 * capabilities, or null when the peer was cleared. Pure w.r.t. the registry —
 * no I/O, easy to unit-test both directions of the gate.
 */
export function applyCapabilityAdvert(
  registry: PeerCapabilityRegistry,
  pubkey: string,
  event: CapabilityAdvertEvent | null | undefined,
  nowMs: number,
  ttlMs: number = CAPABILITY_TTL_MS
): PeerCapabilities | null {
  const parsed = parseCapabilityAdvert(event);
  if(!parsed || !isAdvertFresh(parsed.createdAt, nowMs, ttlMs) || !hasAnyCapability(parsed.caps)) {
    registry.clear(pubkey);
    return null;
  }
  registry.set(pubkey, parsed.caps);
  return parsed.caps;
}

/** The slice of ChatAPI the ingestor needs — just the replaceable-event query. */
export interface CapabilityChatAPI {
  queryLatestEvent(filter: {
    kinds: number[];
    '#d'?: string[];
    authors?: string[];
    limit?: number;
  }): Promise<CapabilityAdvertEvent | null>;
}

export interface CapabilityIngestorDeps {
  /** The gate registry this ingestor feeds. */
  registry: PeerCapabilityRegistry;
  /** Lazily resolve ChatAPI — it may be constructed after the bridge, so this is
   * read on each poll rather than captured once. Returns null until it exists. */
  getChatAPI: () => CapabilityChatAPI | null | undefined;
  /** Current contact pubkeys (hex). Only contacts are polled — we never scan
   * strangers. */
  getContacts: () => string[];
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Advert TTL. Defaults to CAPABILITY_TTL_MS. */
  ttlMs?: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Polls contacts' capability adverts and feeds the PeerCapabilityRegistry.
 * Wire it up once from the bridge: `refreshAll()` on backfill and on a timer via
 * `start()`. Every method is best-effort and never throws — a relay hiccup must
 * not break the send path, and a missing ChatAPI is simply a no-op that the next
 * poll retries.
 */
export class CapabilityIngestor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: CapabilityIngestorDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private ttlMs(): number {
    return this.deps.ttlMs ?? CAPABILITY_TTL_MS;
  }

  /**
   * Fetch and apply one peer's latest advert. Queries the single newest kind
   * 30078 / `phantomchat-p2p` event authored by `pubkey` and feeds it through
   * applyCapabilityAdvert (which sets or clears). No-ops (leaving any existing
   * entry untouched) only when ChatAPI is absent or the pubkey is malformed;
   * a successful query with no result clears the peer. Never throws.
   */
  async refreshPeer(pubkey: string): Promise<PeerCapabilities | null> {
    if(!HEX64.test(pubkey)) return null;
    const api = this.deps.getChatAPI();
    if(!api) return null;

    let event: CapabilityAdvertEvent | null = null;
    try {
      event = await api.queryLatestEvent({
        'kinds': [CAPABILITY_KIND],
        '#d': [CAPABILITY_D_TAG],
        'authors': [pubkey],
        'limit': 1
      });
    } catch(err) {
      // A query failure is not evidence the peer lost capability — leave the
      // registry untouched and let the next poll retry.
      logSwallow('CapabilityIngestor.refreshPeer', err);
      return this.deps.registry.get(pubkey) ?? null;
    }

    return applyCapabilityAdvert(this.deps.registry, pubkey, event, this.now(), this.ttlMs());
  }

  /** Refresh every current contact. Best-effort and fully concurrent. */
  async refreshAll(): Promise<void> {
    const contacts = this.dedupeContacts();
    if(contacts.length === 0) return;
    await Promise.allSettled(contacts.map((pk) => this.refreshPeer(pk)));
  }

  /**
   * Begin periodic refresh. Kicks off an immediate `refreshAll()` then re-polls
   * every `intervalMs`. Idempotent — a second call replaces the prior timer.
   * Returns a stop function.
   */
  start(intervalMs: number = CAPABILITY_REFRESH_MS): () => void {
    this.stop();
    void this.refreshAll().catch(swallowHandler('CapabilityIngestor.start'));
    this.timer = setInterval(() => {
      void this.refreshAll().catch(swallowHandler('CapabilityIngestor.tick'));
    }, intervalMs);
    return () => this.stop();
  }

  /** Stop periodic refresh. Safe to call when not started. */
  stop(): void {
    if(this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private dedupeContacts(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for(const pk of this.deps.getContacts()) {
      if(typeof pk !== 'string' || !HEX64.test(pk) || seen.has(pk)) continue;
      seen.add(pk);
      out.push(pk);
    }
    return out;
  }
}
