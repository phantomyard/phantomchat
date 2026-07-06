/*
 * PhantomChat.chat — LOCAL NODE port discovery (phantomchat#61 / phantomyard/phantombot#258)
 *
 * The loopback (Tier 1) transport dials the SAME-machine phantombot node over
 * `ws://localhost:<port>`. That port used to be hardcoded (47100) on both sides.
 * It no longer is: every node binds an OS-EPHEMERAL port so any number of
 * personas can run on one machine with zero collisions. So the PWA has to
 * DISCOVER its local node's port instead of assuming one.
 *
 * WHERE THE PORT COMES FROM. The node publishes its capability advert (kind
 * 30078, `d`-tag `phantomchat-p2p`) under our OWN pubkey. The capability
 * BOOLEANS in that advert are public; the concrete reachability — the bound
 * loopback port and the host's LAN IPs — is carried in a SELF-ENCRYPTED `enc`
 * field (NIP-44, encrypted by the node to its own pubkey). Only we, holding the
 * same nsec, can decrypt it, so the port/IP never travel a relay in the clear.
 *
 * This module reads our OWN self-advert, decrypts `enc`, and points the shared
 * LocalWsTransport at the discovered port. It is the self-facing sibling of
 * `capability-ingest.ts` (which reads CONTACTS' adverts for the ladder gate);
 * this one reads only our own, and only for the port.
 */

import {getConversationKey, nip44Decrypt} from '@lib/phantomchat/nostr-crypto';
import {logSwallow, swallowHandler} from '@lib/phantomchat/log-swallow';
import {
  CAPABILITY_D_TAG,
  CAPABILITY_KIND,
  CAPABILITY_REFRESH_MS,
  CAPABILITY_TTL_MS,
  isAdvertFresh,
  type CapabilityAdvertEvent,
  type CapabilityChatAPI
} from '@lib/phantomchat/transport/capability-ingest';

const HEX64 = /^[0-9a-f]{64}$/i;

/** The owner-private reachability carried self-encrypted in the advert's `enc`. */
export interface SelfReachability {
  /** The loopback port our local node actually bound (OS-ephemeral). */
  localWsPort: number;
  /** The host's non-internal IPv4 LAN addresses (informational). */
  lanIps: string[];
}

/**
 * Decrypt and parse OUR OWN advert's self-encrypted reachability blob. Returns
 * `{reach, createdAt}` or null when the event is not our well-formed advert or
 * the blob can't be decrypted (wrong key, corrupt, missing). Never throws.
 *
 * Mirrors phantombot `parseCapabilityEvent(event, ourSk)`: the `enc` field is
 * NIP-44 v2, keyed by the self conversation key `(ourSecretKey -> ourPubkey)`.
 */
export function parseSelfReachability(
  event: CapabilityAdvertEvent | null | undefined,
  ownPubkeyHex: string,
  secretKey: Uint8Array
): {reach: SelfReachability, createdAt: number} | null {
  if(!event || !secretKey || !HEX64.test(ownPubkeyHex)) return null;
  try {
    if(event.kind !== CAPABILITY_KIND) return null;
    const tags = Array.isArray(event.tags) ? event.tags : [];
    if(!tags.some((t) => t[0] === 'd' && t[1] === CAPABILITY_D_TAG)) return null;

    const parsed = JSON.parse(event.content) as {enc?: unknown};
    if(typeof parsed !== 'object' || parsed === null || typeof parsed.enc !== 'string') return null;

    const selfKey = getConversationKey(secretKey, ownPubkeyHex);
    const reach = JSON.parse(nip44Decrypt(parsed.enc, selfKey)) as Partial<SelfReachability>;
    return {
      reach: {
        localWsPort: typeof reach.localWsPort === 'number' ? reach.localWsPort : 0,
        lanIps: Array.isArray(reach.lanIps) ? reach.lanIps.filter((x) => typeof x === 'string') : []
      },
      createdAt: typeof event.created_at === 'number' ? event.created_at : 0
    };
  } catch(err) {
    logSwallow('local-node-discovery.parseSelfReachability', err);
    return null;
  }
}

export interface LocalNodeDiscoveryDeps {
  /** Lazily resolve ChatAPI (built before OR after the bridge). */
  getChatAPI: () => CapabilityChatAPI | null | undefined;
  /** Our own pubkey (hex) + secret key, or null until an identity is loaded. */
  getOwnKeys: () => {pubkey: string, secretKey: Uint8Array} | null | undefined;
  /** Apply a discovered port to the loopback transport. */
  setPort: (port: number) => void;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Advert TTL. Defaults to CAPABILITY_TTL_MS. */
  ttlMs?: number;
}

/**
 * Discovers the local phantombot node's loopback port from our own self-advert
 * and keeps the LocalWsTransport pointed at it. Wire it up once from the bridge:
 * `refresh()` on backfill and on a timer via `start()`. Best-effort and never
 * throws — a relay hiccup or missing identity is a no-op the next poll retries,
 * and the transport simply keeps its previous (or default) port until then.
 */
export class LocalNodeDiscovery {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: LocalNodeDiscoveryDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private ttlMs(): number {
    return this.deps.ttlMs ?? CAPABILITY_TTL_MS;
  }

  /**
   * Fetch our own latest advert, decrypt the port, and apply it. Returns the
   * discovered port, or null when there's nothing usable (no ChatAPI, no
   * identity, no/stale/undecryptable advert). A stale advert is NOT applied — an
   * always-restarted node re-stamps `created_at`, so staleness means the node is
   * likely gone and its old ephemeral port shouldn't be trusted.
   */
  async refresh(): Promise<number | null> {
    const api = this.deps.getChatAPI();
    const keys = this.deps.getOwnKeys();
    if(!api || !keys?.secretKey || !keys.pubkey) return null;

    let event: CapabilityAdvertEvent | null = null;
    try {
      event = await api.queryLatestEvent({
        'kinds': [CAPABILITY_KIND],
        '#d': [CAPABILITY_D_TAG],
        'authors': [keys.pubkey],
        'limit': 1
      });
    } catch(err) {
      logSwallow('LocalNodeDiscovery.refresh', err);
      return null;
    }

    const parsed = parseSelfReachability(event, keys.pubkey, keys.secretKey);
    if(!parsed || !isAdvertFresh(parsed.createdAt, this.now(), this.ttlMs())) return null;
    if(!Number.isInteger(parsed.reach.localWsPort) || parsed.reach.localWsPort <= 0) return null;

    this.deps.setPort(parsed.reach.localWsPort);
    return parsed.reach.localWsPort;
  }

  /**
   * Begin periodic discovery. Kicks off an immediate `refresh()` then re-polls
   * every `intervalMs` (picks up a node restart on a new ephemeral port).
   * Idempotent — a second call replaces the prior timer. Returns a stop function.
   */
  start(intervalMs: number = CAPABILITY_REFRESH_MS): () => void {
    this.stop();
    void this.refresh().catch(swallowHandler('LocalNodeDiscovery.start'));
    this.timer = setInterval(() => {
      void this.refresh().catch(swallowHandler('LocalNodeDiscovery.tick'));
    }, intervalMs);
    return () => this.stop();
  }

  /** Stop periodic discovery. Safe to call when not started. */
  stop(): void {
    if(this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
