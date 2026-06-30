/**
 * NostrRelayPool — manages connections to multiple Nostr relays simultaneously.
 *
 * Publishes events to all connected relays, subscribes to events from all
 * relays with automatic deduplication, handles per-relay reconnection,
 * pool-level recovery, and history backfill.
 */

import {Logger, logger} from '@lib/logger';
import {NostrRelay, DecryptedMessage, NostrEvent} from './nostr-relay';
import {wrapNip17Message, wrapEditV2, wrapNip17Edit, rewrapNip17Message, rewrapV2, isLegacyWrap, warmSymmetricKeyCache, UnsignedEvent} from './nostr-crypto';
import {getNostrWrapClient} from './nostr-wrap-client';
import {getNostrUnwrapClient} from './nostr-unwrap-client';
import {getMessageStore} from './message-store';
import {buildNip65Event} from './nip65';
import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from './key-storage';
import {importFromStored} from './nostr-identity';
import rootScope from '@lib/rootScope';
import {swallowHandler} from './log-swallow';

// ─── Types ─────────────────────────────────────────────────────────

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface PublishResult {
  successes: string[];
  failures: {url: string; error: string}[];
  /**
   * 64-char hex rumor id of the NIP-17 payload that was published. Same value
   * on sender and receiver, so it is the authoritative key for cross-peer
   * lookups (kind-7 `e` tag, kind-5 deletion target, kind-25 receipt target).
   *
   * Present only for `publish()` / `publishEdit()`. Absent for `publishRawEvent()`
   * (generic pre-signed payloads without a rumor) and for the legacy
   * `storeMessage` fallback.
   *
   * Callers on the sender side should save the outgoing row with
   * `eventId = rumorId` and `appMessageId = <local chat-XXX-N id>` — see
   * Bug #3 (FIND-4e18d35d) for the divergence this aligns.
   */
  rumorId?: string;
  /**
   * The signed kind-1059 gift-wrap events that were published (recipient +
   * self wraps). Present only for `publish()`.
   *
   * NOTE: the delivery-retry layer no longer re-publishes these verbatim — a
   * relay will not re-forward a duplicate outer event id to an already-live
   * subscriber, so an identical resend can never rescue a ghosted message.
   * Retry re-wraps `rumor` (below) into a FRESH outer event instead.
   */
  wraps?: NostrEvent[];
  /**
   * The immutable inner rumor (kind 14) of the published payload. Returned so
   * the delivery-retry layer can re-wrap the SAME rumor — preserving its id so
   * the receiver dedups — in a fresh outer gift-wrap that the relay WILL
   * re-forward. Present only for `publish()`.
   */
  rumor?: UnsignedEvent;
}

export interface RelayPoolOptions {
  relays?: RelayConfig[];
  onMessage: (msg: DecryptedMessage) => void;
  onStateChange?: (connectedCount: number, totalCount: number) => void;
  /**
   * Pre-decrypted identity — when provided, initialize() skips the encrypted
   * store load + PBKDF2 decrypt (which onboarding already did ~100ms earlier).
   * publicKey is hex, privateKeyHex is 64-char hex string.
   */
  preloadedIdentity?: { publicKey: string; privateKeyHex: string };
}

// ─── Constants ─────────────────────────────────────────────────────

// E2E tests can override relays by setting window.__phantomchatTestRelays before
// the app loads (via Playwright addInitScript). Production uses the hardcoded list.
const _testRelays = typeof window !== 'undefined' && (window as any).__phantomchatTestRelays;
export const DEFAULT_RELAYS: RelayConfig[] = Array.isArray(_testRelays) ? _testRelays : [
  {url: 'wss://relay.damus.io', read: true, write: true},
  {url: 'wss://nos.lol', read: true, write: true},
  {url: 'wss://relay.primal.net', read: true, write: true},
  {url: 'wss://nostr.mom', read: true, write: true},
  {url: 'wss://nostr.data.haus', read: true, write: true}
];

/**
 * Canonical relay list, served as a static file at `/relays.json`. This is the
 * single source of truth shared with the phantombot server (which fetches the
 * same URL over HTTP on startup), so the relay set is maintained in exactly one
 * place. The hardcoded DEFAULT_RELAYS above is a build-time fallback used only
 * when the fetch fails (offline, 404, malformed) — it must stay in sync as a
 * disaster net but is not authoritative at runtime.
 *
 * Shape: `{ "relays": ["wss://...", ...] }`. Returns null on any failure so the
 * caller can fall back to DEFAULT_RELAYS.
 */
export async function loadCanonicalRelays(): Promise<RelayConfig[] | null> {
  // Tests pin relays via window.__phantomchatTestRelays — never fetch then.
  if(typeof window !== 'undefined' && Array.isArray((window as any).__phantomchatTestRelays)) {
    return null;
  }
  try {
    const res = await fetch('/relays.json', {cache: 'no-cache'});
    if(!res.ok) return null;
    const data = await res.json();
    const urls: unknown = data?.relays;
    if(!Array.isArray(urls)) return null;
    const valid = urls.filter((u): u is string => typeof u === 'string' && u.startsWith('wss://'));
    const configs: RelayConfig[] = valid.map((url) => ({url, read: true, write: true}));
    return configs.length > 0 ? configs : null;
  } catch{
    return null;
  }
}

const DEDUP_CACHE_MAX = 10_000;
const POOL_RECOVERY_INTERVAL_MS = 60_000;
// Relay health / cooldown. A relay that keeps dropping shortly after it connects
// (a "flap") burns CPU + bandwidth: every reconnect re-arms the subscription and
// fires a since-backfill query, and the relay's own auto-reconnect loop keeps
// retrying forever. After RELAY_FLAP_THRESHOLD flaps we stop its self-reconnect
// and skip it in the pool recovery sweep for an exponentially growing cooldown,
// so a single sick relay can't churn the pool. The other relays carry delivery
// in the meantime (publish is fire-and-forget across connected relays).
const RELAY_FLAP_WINDOW_MS = 30_000;       // connected < this before dropping = a flap
const RELAY_FLAP_THRESHOLD = 3;            // consecutive flaps before cooldown kicks in
const RELAY_COOLDOWN_BASE_MS = 60_000;     // first cooldown span
const RELAY_COOLDOWN_MAX_MS = 15 * 60_000; // cap so a relay is always eventually retried
// Gift-wrap (kind 1059) outer created_at is now the REAL send time — backdating
// was removed (see nostr-crypto.createGiftWrap) because it was the root cause of
// the "first message ghosts" bug: a relay applies a subscription's `since` to
// LIVE events too, and a wrap backdated up to 48h could never be recovered by a
// tight catch-up `since`. With truthful timestamps this only needs to absorb a
// little clock skew / out-of-order delivery, so it shrinks from 48h to minutes.
const GIFTWRAP_FUZZ_WINDOW_SEC = 5 * 60;
// The catch-up poll (the delivery backbone) re-queries connected read relays on
// this cadence and pulls the last RECENT_BACKFILL_WINDOW_SEC of wraps. A relay
// can silently fail to PUSH a freshly-published wrap to our live subscription,
// but the wrap still PERSISTS on the relay — so a periodic PULL recovers it.
// Dedup by rumor id makes the overlap with the live push free.
const BACKFILL_POLL_INTERVAL_MS = 15_000;
const RECENT_BACKFILL_WINDOW_SEC = 90;
const IDB_RELAY_CONFIG_KEY = 'phantomchat-relay-config';
const LS_LAST_SEEN_KEY = 'phantomchat-last-seen-timestamp';

// ─── Relay entry (internal) ────────────────────────────────────────

interface RelayEntry {
  config: RelayConfig;
  instance: NostrRelay;
}

// ─── NostrRelayPool ────────────────────────────────────────────────

export class NostrRelayPool {
  private log: Logger;
  private relayEntries: RelayEntry[] = [];
  private configs: RelayConfig[];
  private onMessageCb: (msg: DecryptedMessage) => void;
  private onStateChangeCb?: (connectedCount: number, totalCount: number) => void;

  // Dedup LRU — keyed by the DECRYPTED rumor/message id (post-unwrap).
  private seenIds: Set<string> = new Set();
  private seenOrder: string[] = [];

  // PRE-decrypt dedup LRU — keyed by the OUTER event id (the gift-wrap / raw
  // event id, before any crypto). Shared across all relay instances so the same
  // wrap from multiple relays or a reconnect replay is verified + decrypted
  // ONCE. This is the main snappiness lever (gift-wrap unwrap = secp256k1 on the
  // main thread). Separate set from `seenIds` because wrap ids and rumor ids are
  // different id spaces.
  private seenWrapIds: Set<string> = new Set();
  private seenWrapOrder: string[] = [];

  // Pool recovery
  private recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Catch-up poll (delivery backbone — recovers wraps the live push dropped)
  private backfillPollInterval: ReturnType<typeof setInterval> | null = null;
  private backfillPollInFlight = false;

  // Identity
  private publicKey: string = '';

  // History backfill
  private lastSeenTimestamp: number = 0;

  // Subscription state
  private isSubscribedFlag: boolean = false;

  // Per-relay "has connected at least once" set. Used to distinguish the FIRST
  // connect (startup — covered by initialize()'s global backfill) from a
  // RE-connect (recovers the idle gap via backfillRelay). Keyed by relay url.
  private relayHasConnected: Set<string> = new Set();

  // Per-relay health for flap detection / cooldown. Keyed by url so it survives
  // RelayEntry recreation across connectAll(). `cooldownUntil` is a Date.now()
  // ms deadline; while it's in the future the pool recovery sweep skips the
  // relay and its self-reconnect has been stopped via disconnect().
  private relayHealth: Map<string, {connectedAt: number; flaps: number; cooldownUntil: number; lastState: string}> = new Map();

  // Enable/disable per-relay (Phase 3)
  private enabled: Map<string, boolean> = new Map();

  // Identity key for NIP-65 signing
  private privateKeyBytes: Uint8Array | null = null;
  private _preloadedIdentity?: { publicKey: string; privateKeyHex: string };

  // Debounced state notification — batches multiple relay state changes into
  // a single dispatch cycle so 5 relays reconnecting don't fire 5+ DOM updates
  // in quick succession.
  private notifyStateChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_DEBOUNCE_MS = 200;

  constructor(options: RelayPoolOptions) {
    this.log = logger('NostrRelayPool');
    this.configs = options.relays ? [...options.relays] : [];
    this.onMessageCb = options.onMessage;
    this.onStateChangeCb = options.onStateChange;
    this._preloadedIdentity = options.preloadedIdentity;
  }

  // ─── Callback setters (for DI / test path) ─────────────────────

  setOnMessage(cb: (msg: DecryptedMessage) => void): void {
    this.onMessageCb = cb;
  }

  setOnStateChange(cb: (connectedCount: number, totalCount: number) => void): void {
    this.onStateChangeCb = cb;
  }

  setOnReceipt(cb: (receipt: {eventId: string; type: 'delivery' | 'read'; from: string}) => void): void {
    // Wire receipt handler to all relay instances
    for(const entry of this.relayEntries) {
      entry.instance.onReceipt(cb);
    }
    // Store for future relays added after this call
    this._onReceiptCb = cb;
  }

  /**
   * Register a callback for plaintext non-giftwrap events (kind-7 reactions,
   * kind-5 deletes). The pool dedupes by `event.id` just like gift-wrap
   * messages, so callers receive each event at most once across all relays.
   */
  setOnRawEvent(cb: (event: NostrEvent) => void): void {
    this._onRawEventCb = cb;
    for(const entry of this.relayEntries) {
      entry.instance.onRawEvent((ev) => this.handleIncomingRawEvent(ev));
    }
  }

  private _onReceiptCb?: (receipt: {eventId: string; type: 'delivery' | 'read'; from: string}) => void;
  private _onRawEventCb?: (event: NostrEvent) => void;

  /**
   * Get the private key bytes (for delivery tracker gift-wrap signing).
   * Returns null if not initialized.
   */
  getPrivateKey(): Uint8Array | null {
    return this.privateKeyBytes;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.log('[NostrRelayPool] initializing');

    // Use pre-decrypted identity if provided (avoids redundant PBKDF2 on cold
    // start — onboarding already did this work ~100ms earlier).
    if(this._preloadedIdentity) {
      this.publicKey = this._preloadedIdentity.publicKey;
      if(this._preloadedIdentity.privateKeyHex && this._preloadedIdentity.privateKeyHex.length === 64) {
        const {hexToBytes: h2b} = await import('@noble/secp256k1').then(m => m.etc);
        this.privateKeyBytes = h2b(this._preloadedIdentity.privateKeyHex);
      }
      this._preloadedIdentity = undefined; // free the reference
    } else {
      // Load identity from encrypted store (key-storage)
      try {
        const record = await loadEncryptedIdentity();
        if(record) {
          const browserKey = await loadBrowserKey();
          if(browserKey) {
            const {seed, nsec} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
            const identity = importFromStored({seed, nsec});
            this.publicKey = identity.publicKey;
            if(identity.privateKey && identity.privateKey.length === 64) {
              const {hexToBytes: h2b} = await import('@noble/secp256k1').then(m => m.etc);
              this.privateKeyBytes = h2b(identity.privateKey);
            }
          } else {
            this.log.warn('[NostrRelayPool] no browser key — cannot decrypt identity');
          }
        }
      } catch(err) {
        this.log.warn('[NostrRelayPool] failed to load encrypted identity:', err);
      }
    }

    // Load relay config from IndexedDB if none provided
    if(this.configs.length === 0) {
      const stored = await this.loadRelayConfig();
      this.configs = stored.length > 0 ? stored : [...DEFAULT_RELAYS];
    }

    // Pre-warm the v2 symmetric key cache for every known peer. The unwrap
    // worker runs in its own isolate with an EMPTY symmetricKeyCache — only
    // the main thread's cache is warmed — so inbound v2 events rely on the
    // main thread having derived keys for each contact ahead of time. Ephemeral
    // envelope signing means event.pubkey is a throwaway key, so we cannot
    // derive the symmetric key from the event alone; the cache MUST be warmed
    // per-peer at startup. Deriving is ~2ms/peer; failures are swallowed so a
    // store/identity quirk never blocks connectivity.
    await this.warmV2KeyCache();

    // Load lastSeenTimestamp
    const storedTs = localStorage.getItem(LS_LAST_SEEN_KEY);
    if(storedTs) {
      this.lastSeenTimestamp = parseInt(storedTs, 10) || 0;
    }

    // Connect all relays
    await this.connectAll();

    // Flush any NIP-65 request that was queued before initialization
    // (happens on the Tor-first startup path, where publishNip65 is
    // called while we are still waiting for the circuit to settle).
    if(this._pendingNip65PrivateKey) {
      const pk = this._pendingNip65PrivateKey;
      this._pendingNip65PrivateKey = null;
      this._publishNip65Now(pk);
    }

    // History backfill
    if(this.lastSeenTimestamp > 0) {
      await this.backfill();
    }

    // Start pool recovery
    this.startRecovery();

    // Start the catch-up poll — the delivery backbone that no longer relies on
    // relays pushing live events reliably.
    this.startBackfillPoll();
  }

  /**
   * Pre-derive + cache v2 AES-256-GCM symmetric keys for every known peer.
   *
   * Known peers are recovered from the message store's conversation IDs
   * (`<pkA>:<pkB>` sorted pairs) — each conversation's non-own pubkey is a
   * peer we may receive a v2 gift-wrap from. Best-effort: a store/identity
   * quirk never blocks connectivity (the cache also warms lazily on first
   * encrypt/decrypt per peer).
   */
  private async warmV2KeyCache(): Promise<void> {
    if(!this.privateKeyBytes || !this.publicKey) return;
    try {
      const conversationIds = await getMessageStore().getAllConversationIds();
      const peerPubkeys = new Set<string>();
      for(const convId of conversationIds) {
        const [a, b] = convId.split(':');
        if(a && a !== this.publicKey) peerPubkeys.add(a);
        if(b && b !== this.publicKey) peerPubkeys.add(b);
      }
      if(peerPubkeys.size === 0) return;
      const peers = [...peerPubkeys];
      // Warm BOTH caches: the main thread's (for the sync-fallback path) AND the
      // unwrap worker's. The worker cache is the one that keeps cold-load
      // backfill crypto off the main thread — without it every v2 unwrap bounces
      // back to a synchronous main-thread unwrapV2 and freezes the UI.
      await warmSymmetricKeyCache(this.privateKeyBytes, peers);
      getNostrUnwrapClient().warm(this.privateKeyBytes, peers);
    } catch(err) {
      this.log.warn('[NostrRelayPool] warmV2KeyCache failed (non-fatal):', err);
    }
  }

  disconnect(): void {
    this.log('[NostrRelayPool] disconnecting all relays');

    // Zero + null the private key bytes FIRST, before any other cleanup.
    // A later step could suspend (indexedDB, fetch) and leave the key
    // material alive in memory for an attacker to scrape via debugger /
    // heap inspection. `Uint8Array.fill(0)` overwrites the underlying
    // ArrayBuffer in place; assigning null drops the reference so the
    // next GC reclaims the backing memory.
    if(this.privateKeyBytes) {
      this.privateKeyBytes.fill(0);
      this.privateKeyBytes = null;
    }
    // Also drop any pending NIP-65 replay key — same reason.
    if(this._pendingNip65PrivateKey) {
      this._pendingNip65PrivateKey.fill(0);
      this._pendingNip65PrivateKey = null;
    }

    if(this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }

    if(this.backfillPollInterval) {
      clearInterval(this.backfillPollInterval);
      this.backfillPollInterval = null;
    }

    for(const entry of this.relayEntries) {
      entry.instance.disconnect();
    }

    this.relayEntries = [];
    this.isSubscribedFlag = false;
  }

  // ─── Messaging ─────────────────────────────────────────────────

  async publish(
    recipientPubkey: string,
    plaintext: string,
    replyTo?: {eventId: string; relayUrl?: string}
  ): Promise<PublishResult> {
    const successes: string[] = [];
    const failures: {url: string; error: string}[] = [];

    const writeEntries = this.relayEntries.filter(e =>
      e.config.write && this.enabled.get(e.config.url) !== false
    );

    // Wrap once, publish to all relays (avoids wrapping N times for N relays)
    let wraps: NostrEvent[];
    let rumorId: string | undefined;
    let rumor: UnsignedEvent | undefined;
    try {
      if(!this.privateKeyBytes) {
        // Fallback: use storeMessage on individual relays (they wrap internally).
        // Note: this path predates the replyTo plumbing — relays' own wrap path
        // does not carry the reply e-tag. Modern code always has privateKeyBytes
        // set so we never hit this in production; keep it for legacy tests only.
        const promises = writeEntries.map(async(entry) => {
          try {
            const eventId = await entry.instance.storeMessage(recipientPubkey, plaintext);
            successes.push(eventId);
          } catch(err) {
            failures.push({
              url: entry.config.url,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        });
        await Promise.all(promises);
        return {successes, failures};
      }

      const wrapped = await getNostrWrapClient().wrap(this.privateKeyBytes, recipientPubkey, plaintext, replyTo);
      wraps = wrapped.wraps as unknown as NostrEvent[];
      rumorId = wrapped.rumorId;
      rumor = wrapped.rumor;
    } catch(err) {
      return {
        successes: [],
        failures: [{url: 'wrap', error: err instanceof Error ? err.message : String(err)}]
      };
    }

    // Publish all wraps to all write relays
    const promises = writeEntries.map(async(entry) => {
      try {
        for(const wrap of wraps) {
          entry.instance.publishRawEvent(wrap);
        }
        successes.push(wraps[0]?.id || '');
      } catch(err) {
        failures.push({
          url: entry.config.url,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    await Promise.all(promises);
    return {successes, failures, rumorId, wraps, rumor};
  }

  /**
   * Re-wrap a previously-published rumor in a FRESH outer gift-wrap and publish
   * it to all write relays. Used by the delivery-retry layer: the rumor id is
   * preserved (receiver dedups → no double message) but the outer kind-1059
   * event id is new, so relays re-forward it to an already-live subscriber —
   * which a verbatim resend of the original wrap cannot do. Returns the freshly
   * minted wraps (mainly for tests/inspection). Best-effort per relay.
   */
  async rewrapAndPublish(recipientPubkey: string, rumor: UnsignedEvent): Promise<NostrEvent[]> {
    if(!this.privateKeyBytes) return [];

    // Use v2 re-wrap (AES-256-GCM) with fallback to legacy NIP-17
    let wrap: NostrEvent;
    try {
      wrap = await rewrapV2(this.privateKeyBytes, recipientPubkey, rumor) as unknown as NostrEvent;
    } catch{
      // Fallback to legacy NIP-17 re-wrap
      wrap = rewrapNip17Message(this.privateKeyBytes, recipientPubkey, rumor) as unknown as NostrEvent;
    }

    const writeEntries = this.relayEntries.filter(e =>
      e.config.write && this.enabled.get(e.config.url) !== false
    );
    for(const entry of writeEntries) {
      try {
        entry.instance.publishRawEvent(wrap);
      } catch{
        // best-effort per relay; the retry schedule will try again
      }
    }
    return [wrap];
  }

  /**
   * Publish an edit message: wraps a kind 14 rumor carrying the
   * `['phantomchat-edit', originalAppMessageId]` marker tag and publishes both
   * gift-wraps (recipient + self for multi-device echo) to all write relays.
   *
   * Returns the publish result; failures are aggregated per relay just like publish().
   */
  async publishEdit(
    recipientPubkey: string,
    originalAppMessageId: string,
    newPlaintext: string
  ): Promise<PublishResult> {
    if(!this.privateKeyBytes) {
      return {
        successes: [],
        failures: [{url: 'wrap', error: 'no private key available for edit wrap'}]
      };
    }

    let wraps: NostrEvent[];
    try {
      // Use v2 (AES-256-GCM) with legacy fallback
      const v2Event = await wrapEditV2(this.privateKeyBytes, recipientPubkey, originalAppMessageId, newPlaintext);
      wraps = [v2Event] as unknown as NostrEvent[];
    } catch{
      // Fallback to legacy NIP-17 edit wrap
      try {
        wraps = wrapNip17Edit(this.privateKeyBytes, recipientPubkey, originalAppMessageId, newPlaintext) as unknown as NostrEvent[];
      } catch(err) {
        return {
          successes: [],
          failures: [{url: 'wrap', error: err instanceof Error ? err.message : String(err)}]
        };
      }
    }

    const successes: string[] = [];
    const failures: {url: string; error: string}[] = [];

    const writeEntries = this.relayEntries.filter(e =>
      e.config.write && this.enabled.get(e.config.url) !== false
    );

    const promises = writeEntries.map(async(entry) => {
      try {
        for(const wrap of wraps) {
          entry.instance.publishRawEvent(wrap);
        }
        successes.push(wraps[0]?.id || '');
      } catch(err) {
        failures.push({
          url: entry.config.url,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    await Promise.all(promises);
    return {successes, failures};
  }

  /**
   * Publish a pre-signed event to all write-enabled relays.
   * Used for publishing pre-built gift-wrap events.
   */
  async publishRawEvent(event: NostrEvent): Promise<PublishResult> {
    const successes: string[] = [];
    const failures: {url: string; error: string}[] = [];

    const writeEntries = this.relayEntries.filter(e =>
      e.config.write && this.enabled.get(e.config.url) !== false
    );

    for(const entry of writeEntries) {
      try {
        entry.instance.publishRawEvent(event);
        successes.push(event.id || '');
      } catch(err) {
        failures.push({
          url: entry.config.url,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return {successes, failures};
  }

  /**
   * Query all read-enabled relays with a filter and return deduplicated results.
   * Used by ChatAPI for relay backfill.
   */
  async getMessages(filter: {kinds: number[]; '#p'?: string[]; since?: number; limit?: number}): Promise<NostrEvent[]> {
    const readEntries = this.relayEntries.filter(e =>
      e.config.read && this.enabled.get(e.config.url) !== false
    );

    const seenIds = new Set<string>();
    const results: NostrEvent[] = [];

    const promises = readEntries.map(async(entry) => {
      try {
        const messages = await entry.instance.getMessages(filter.since);
        for(const msg of messages) {
          if(msg.id && !seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            // Convert DecryptedMessage to NostrEvent-like structure for backfill
            results.push({
              id: msg.id,
              pubkey: msg.from,
              created_at: msg.timestamp,
              kind: msg.rumorKind || 14,
              tags: msg.tags || [],
              content: msg.content
            });
          }
        }
      } catch(err) {
        this.log.error('[NostrRelayPool] getMessages failed for:', entry.config.url, err);
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Fan-out generic raw query across all enabled read relays.
   * Dedupes by event.id. Used by ChatAPI.queryLatestEvent to fetch
   * replaceable events (e.g., kind 30078 folder snapshots) that
   * getMessages() does not support.
   */
  async queryRawEvents(filter: Record<string, unknown>): Promise<NostrEvent[]> {
    const readEntries = this.relayEntries.filter(e =>
      e.config.read && this.enabled.get(e.config.url) !== false
    );

    const seenIds = new Set<string>();
    const results: NostrEvent[] = [];

    const promises = readEntries.map(async(entry) => {
      try {
        const events = await entry.instance.queryRawEvents(filter);
        for(const ev of events) {
          if(ev.id && !seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            results.push(ev);
          }
        }
      } catch(err) {
        this.log.error('[NostrRelayPool] queryRawEvents failed for:', entry.config.url, err);
      }
    });

    await Promise.all(promises);
    return results;
  }

  subscribeMessages(): void {
    this.isSubscribedFlag = true;
    for(const entry of this.relayEntries) {
      if(entry.config.read) {
        if(entry.instance.getState() === 'connected') {
          entry.instance.subscribeMessages();
        } else {
          // Relay not connected yet — subscribe on open
          entry.instance.pendingSubscribe = true;
        }
      }
    }
  }

  /**
   * WU-3: resolve true once ANY read relay has gone live (sent EOSE for its
   * message subscription), or false on timeout / when no relay is subscribable.
   * Races each relay's per-relay whenSubscribed(); never rejects or hangs — safe
   * to await on the boot path. "ANY relay ready" is the right barrier: the pool
   * dedupes across relays, so the first relay that goes live is enough to stop
   * dropping the first inbound events; waiting for ALL would stall behind the
   * slowest/unreachable relay.
   */
  whenSubscribed(timeoutMs = 8000): Promise<boolean> {
    const readEntries = this.relayEntries.filter((e) =>
      e.config.read && this.enabled.get(e.config.url) !== false
    );
    if(readEntries.length === 0) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if(settled) return;
        settled = true;
        resolve(v);
      };
      let pending = readEntries.length;
      for(const entry of readEntries) {
        entry.instance.whenSubscribed(timeoutMs).then((ready) => {
          if(ready) {
            done(true);
          } else if(--pending === 0) {
            done(false);
          }
        });
      }
      // Hard ceiling — settle even if a relay's whenSubscribed never resolves.
      setTimeout(() => done(false), timeoutMs);
    });
  }

  unsubscribeMessages(): void {
    this.isSubscribedFlag = false;
    for(const entry of this.relayEntries) {
      entry.instance.unsubscribeMessages();
    }
  }

  // ─── Relay management ──────────────────────────────────────────

  addRelay(config: RelayConfig): void {
    // Avoid duplicates
    if(this.configs.find(c => c.url === config.url)) {
      return;
    }

    this.configs.push(config);
    const entry = this.createRelayEntry(config);
    this.relayEntries.push(entry);

    // Initialize and connect (fire-and-forget)
    entry.instance.initialize().then(() => {
      if(this.isSubscribedFlag && config.read) {
        entry.instance.pendingSubscribe = true;
      }
      entry.instance.connect();
    });

    this.persistRelayConfig();
    this.notifyStateChange();
    this.dispatchRelayListChanged();
  }

  removeRelay(url: string): void {
    const idx = this.relayEntries.findIndex(e => e.config.url === url);
    if(idx !== -1) {
      this.relayEntries[idx].instance.disconnect();
      this.relayEntries.splice(idx, 1);
    }

    this.configs = this.configs.filter(c => c.url !== url);
    this.enabled.delete(url);
    this.persistRelayConfig();
    this.notifyStateChange();
    this.dispatchRelayListChanged();
  }

  getRelays(): RelayConfig[] {
    return [...this.configs];
  }

  getConnectedCount(): number {
    return this.relayEntries.filter(e => e.instance.getState() === 'connected').length;
  }

  // ─── State ─────────────────────────────────────────────────────

  getPublicKey(): string {
    return this.publicKey;
  }

  isConnected(): boolean {
    return this.getConnectedCount() > 0;
  }

  getRelayEntries(): RelayEntry[] {
    return this.relayEntries;
  }

  // ─── Enable/Disable (Phase 3) ──────────────────────────────────

  enableRelay(url: string): void {
    this.enabled.set(url, true);
    this.dispatchRelayListChanged();
  }

  disableRelay(url: string): void {
    this.enabled.set(url, false);
    this.dispatchRelayListChanged();
  }

  // ─── Relay States (Phase 3) ───────────────────────────────────

  /**
   * Force an immediate latency measurement on every connected relay.
   * Fire-and-forget — callers can read fresh values via getRelayStates()
   * a short moment later.
   */
  measureAll(): void {
    for(const entry of this.relayEntries) {
      if(entry.instance.getState() === 'connected') {
        entry.instance.measureLatency().catch(swallowHandler('RelayPool.measureAll'));
      }
    }
  }

  getRelayStates(): Array<{url: string; connected: boolean; latencyMs: number; read: boolean; write: boolean; enabled: boolean}> {
    return this.relayEntries.map(entry => ({
      url: entry.config.url,
      connected: entry.instance.getState() === 'connected',
      latencyMs: entry.instance.getLatency(),
      read: entry.config.read,
      write: entry.config.write,
      enabled: this.enabled.get(entry.config.url) !== false
    }));
  }

  // ─── NIP-65 (Phase 3) ────────────────────────────────────────

  publishNip65(privateKey: Uint8Array): void {
    this.privateKeyBytes = privateKey;

    // If the pool hasn't been initialized yet (Tor-first flow defers this
    // until the circuit is ready), stash the request and replay it after
    // initialize() finishes connecting the relays.
    if(this.relayEntries.length === 0) {
      this._pendingNip65PrivateKey = privateKey;
      return;
    }

    this._publishNip65Now(privateKey);
  }

  private _pendingNip65PrivateKey: Uint8Array | null = null;

  private _publishNip65Now(privateKey: Uint8Array): void {
    const enabledConfigs = this.configs.filter(c => this.enabled.get(c.url) !== false);
    const event = buildNip65Event(enabledConfigs, privateKey);

    // Publish on all write-enabled relays
    for(const entry of this.relayEntries) {
      if(entry.config.write && this.enabled.get(entry.config.url) !== false) {
        try {
          entry.instance.sendRawEvent(event);
        } catch{
          // ignore — relay may not be connected
        }
      }
    }
  }

  // ─── Private ───────────────────────────────────────────────────

  private createRelayEntry(config: RelayConfig): RelayEntry {
    const instance = new NostrRelay(config.url);

    // Pre-decrypt dedup: claim each inbound event id against the pool-wide LRU
    // before this instance verifies/decrypts it. Returns true the first time an
    // id is seen (process it) and false for any duplicate (a copy from another
    // relay, or a reconnect replay) so the expensive unwrap runs at most once.
    // Optional-call so test mocks without the method don't break (the real
    // NostrRelay always implements it; nostr-relay.test.ts covers the gate).
    instance.setEventDedup?.((eventId) => this.claimWrapId(eventId));

    // Feed the live subscription a `since` watermark so each (re)connect only
    // replays events since we last saw one — not the entire gift-wrap history.
    // Called at REQ time (incl. onopen re-arm) so it's always fresh.
    instance.liveSubscribeSince = () => this.catchUpSince();

    // Wire up message handler with dedup
    instance.onMessage((msg: DecryptedMessage) => {
      this.handleIncomingMessage(msg);
    });

    // Wire receipt handler if registered
    if(this._onReceiptCb) {
      instance.onReceipt(this._onReceiptCb);
    }

    // Wire raw-event handler (kind-7 reactions, kind-5 deletes) if
    // a consumer is registered. Dedup happens inside handleIncomingRawEvent.
    if(this._onRawEventCb) {
      instance.onRawEvent((ev) => this.handleIncomingRawEvent(ev));
    }

    // Notify pool on relay state change so ConnectionStatusComponent updates.
    // Also detect RE-connects: a fresh REQ only streams events from now
    // forward, so anything that landed while this relay was disconnected
    // (idle WS drop, network blip) is recovered by an explicit since-backfill.
    // First connect is skipped here — initialize() already runs a global
    // backfill at startup.
    instance.onStateChange = () => {
      if(instance.getState() === 'connected') {
        const firstConnect = !this.relayHasConnected.has(config.url);
        this.relayHasConnected.add(config.url);
        if(!firstConnect && this.isSubscribedFlag && config.read) {
          this.backfillRelay({config, instance}).catch(
            swallowHandler('NostrRelayPool.reconnectBackfill')
          );
        }
      }
      this.trackRelayHealth(config.url, instance.getState());
      this.notifyStateChange();
    };

    // Notify pool on latency update so UI re-dispatches phantomchat_relay_state
    // for this specific url.
    instance.onLatencyUpdate = () => {
      this.notifyRelayUpdate(config.url);
    };

    return {config, instance};
  }

  /**
   * Pool-wide pre-decrypt dedup. Returns true the FIRST time `eventId` is seen
   * (caller should process it) and false for every duplicate. Maintains its own
   * bounded LRU so a long-lived session can't grow it without bound.
   */
  private claimWrapId(eventId: string): boolean {
    if(this.seenWrapIds.has(eventId)) return false;
    this.seenWrapIds.add(eventId);
    this.seenWrapOrder.push(eventId);
    while(this.seenWrapOrder.length > DEDUP_CACHE_MAX) {
      const evicted = this.seenWrapOrder.shift()!;
      this.seenWrapIds.delete(evicted);
    }
    return true;
  }

  private handleIncomingMessage(msg: DecryptedMessage): void {
    // Dedup check
    if(this.seenIds.has(msg.id)) {
      return;
    }

    // Add to LRU cache
    this.seenIds.add(msg.id);
    this.seenOrder.push(msg.id);

    // Evict if over capacity
    while(this.seenOrder.length > DEDUP_CACHE_MAX) {
      const evicted = this.seenOrder.shift()!;
      this.seenIds.delete(evicted);
    }

    // Presence PING/PONG envelopes are DROPPED. Presence was removed from the
    // client, but a not-yet-updated bot may still send these over the gift-wrap
    // path — silently discard them so they never become a chat bubble, trigger
    // auto-add, a delivery receipt, or advance the backfill watermark.
    if(this.parsePresenceEnvelope(msg)) {
      return;
    }

    // Update lastSeenTimestamp
    if(msg.timestamp > this.lastSeenTimestamp) {
      this.lastSeenTimestamp = msg.timestamp;
      localStorage.setItem(LS_LAST_SEEN_KEY, String(this.lastSeenTimestamp));
    }

    // Deliver
    this.onMessageCb(msg);
  }

  /**
   * Cheap classifier: is this decrypted message a presence ping/pong envelope?
   * Returns the parsed type + nonce, or null for anything else (chat text, file,
   * delete, edit, non-JSON). Only JSON content carrying our presence `type` is
   * matched, so a normal `{type:'text'}` message returns null and flows on.
   */
  private parsePresenceEnvelope(msg: DecryptedMessage): {type: 'ping' | 'pong'; nonce: string} | null {
    const content = msg.content;
    // Fast reject: presence envelopes always contain the marker substring.
    if(typeof content !== 'string' || content.indexOf('presence-p') === -1) return null;
    try {
      const env = JSON.parse(content);
      if(env?.type === 'presence-ping') return {type: 'ping', nonce: typeof env.nonce === 'string' ? env.nonce : ''};
      if(env?.type === 'presence-pong') return {type: 'pong', nonce: typeof env.nonce === 'string' ? env.nonce : ''};
    } catch{
      // not JSON — a plain message
    }
    return null;
  }

  private handleIncomingRawEvent(event: NostrEvent): void {
    if(!event.id) return;
    // Reuse the same LRU as gift-wrap dedup; event ids are globally unique.
    if(this.seenIds.has(event.id)) return;
    this.seenIds.add(event.id);
    this.seenOrder.push(event.id);
    while(this.seenOrder.length > DEDUP_CACHE_MAX) {
      const evicted = this.seenOrder.shift()!;
      this.seenIds.delete(evicted);
    }
    if(this._onRawEventCb) {
      try {
        this._onRawEventCb(event);
      } catch(err) {
        this.log.error('[NostrRelayPool] raw event handler threw:', err);
      }
    }
  }

  private async connectAll(): Promise<void> {
    this.relayEntries = [];

    const promises = this.configs.map(async(config) => {
      const entry = this.createRelayEntry(config);
      this.relayEntries.push(entry);

      try {
        await entry.instance.initialize();
        entry.instance.connect();
      } catch(err) {
        this.log.error('[NostrRelayPool] failed to connect relay:', config.url, err);
      }
    });

    await Promise.all(promises);
    this.notifyStateChange();
  }

  /**
   * Catch-up `since` for the startup / reconnect backfills. We subtract a small
   * fuzz window from lastSeenTimestamp to absorb clock skew and out-of-order
   * delivery (wrap timestamps are now truthful — no 48h backdate — so this no
   * longer needs to be hours wide). Returns undefined (= fetch all) when we have
   * no watermark yet. Dedup by rumor id makes the overlap harmless.
   */
  private catchUpSince(): number | undefined {
    if(this.lastSeenTimestamp <= 0) return undefined;
    return Math.max(0, this.lastSeenTimestamp - GIFTWRAP_FUZZ_WINDOW_SEC);
  }

  private async backfill(): Promise<void> {
    const readEntries = this.relayEntries.filter(e => e.config.read);
    const since = this.catchUpSince();

    const promises = readEntries.map(async(entry) => {
      try {
        const messages = await entry.instance.getMessages(since);
        for(const msg of messages) {
          this.handleIncomingMessage(msg);
        }
      } catch(err) {
        this.log.error('[NostrRelayPool] backfill failed for:', entry.config.url, err);
      }
    });

    await Promise.all(promises);
  }

  /**
   * Backfill a SINGLE relay after it reconnects. Closes the idle gap: events
   * that arrived while this relay's socket was down are not replayed to a fresh
   * REQ, so we query them explicitly (fuzz-aware `since`) and run them through
   * the normal dedup + dispatch path. Cheap and idempotent — already-seen
   * rumor ids are dropped by the LRU in handleIncomingMessage.
   */
  private async backfillRelay(entry: RelayEntry): Promise<void> {
    if(!entry.config.read) return;
    const since = this.catchUpSince();
    this.log('[NostrRelayPool] reconnect backfill for', entry.config.url, 'since', since ?? '(all)');
    try {
      const messages = await entry.instance.getMessages(since);
      for(const msg of messages) {
        this.handleIncomingMessage(msg);
      }
    } catch(err) {
      this.log.error('[NostrRelayPool] reconnect backfill failed for:', entry.config.url, err);
    }
  }

  private startRecovery(): void {
    this.recoveryInterval = setInterval(() => {
      this.recoverFailedRelays();
    }, POOL_RECOVERY_INTERVAL_MS);
  }

  /**
   * Start the catch-up poll: the delivery backbone. Every
   * BACKFILL_POLL_INTERVAL_MS we re-query each CONNECTED read relay for the last
   * RECENT_BACKFILL_WINDOW_SEC of gift-wraps and run them through the normal
   * dedup + dispatch path. This is what makes delivery robust without depending
   * on relays to PUSH live events reliably: a wrap the live push silently
   * dropped still persists on the relay, so the next poll recovers it. The
   * window is a small FIXED span (not lastSeen-based) so the query stays cheap
   * regardless of how long ago the last message was — deep history is the job of
   * the startup / reconnect backfills, not this poll.
   */
  private startBackfillPoll(): void {
    this.backfillPollInterval = setInterval(() => {
      void this.backfillRecent();
    }, BACKFILL_POLL_INTERVAL_MS);
  }

  /**
   * One catch-up poll tick. Pulls the last RECENT_BACKFILL_WINDOW_SEC of wraps
   * from every connected read relay. Guarded against overlap (a slow relay must
   * not let two polls pile up) and silent on a per-relay failure.
   */
  private async backfillRecent(): Promise<void> {
    if(this.backfillPollInFlight) return;
    if(!this.isSubscribedFlag) return;
    this.backfillPollInFlight = true;
    try {
      const since = Math.floor(Date.now() / 1000) - RECENT_BACKFILL_WINDOW_SEC;
      const readEntries = this.relayEntries.filter(
        e => e.config.read && e.instance.getState() === 'connected'
      );
      const promises = readEntries.map(async(entry) => {
        try {
          const messages = await entry.instance.getMessages(since);
          for(const msg of messages) {
            this.handleIncomingMessage(msg);
          }
        } catch(err) {
          this.log.error('[NostrRelayPool] catch-up poll failed for:', entry.config.url, err);
        }
      });
      await Promise.all(promises);
    } finally {
      this.backfillPollInFlight = false;
    }
  }

  private recoverFailedRelays(): void {
    const now = Date.now();
    for(const entry of this.relayEntries) {
      if(entry.instance.getState() !== 'disconnected') continue;

      // Skip relays still serving a flap cooldown — retrying now would just
      // re-arm a subscription that drops again within seconds.
      const health = this.relayHealth.get(entry.config.url);
      if(health && health.cooldownUntil > now) continue;

      this.log('[NostrRelayPool] pool recovery: retrying', entry.config.url);
      entry.instance.initialize().then(() => {
        if(this.isSubscribedFlag && entry.config.read) {
          entry.instance.pendingSubscribe = true;
        }
        entry.instance.connect();
      }).catch((err) => {
        this.log.error('[NostrRelayPool] pool recovery failed for:', entry.config.url, err);
      });
    }
  }

  /**
   * Flap detection. Called on every relay state transition. A relay that stays
   * connected past RELAY_FLAP_WINDOW_MS is healthy and resets its flap counter;
   * one that drops sooner counts as a flap. After RELAY_FLAP_THRESHOLD
   * consecutive flaps we set an exponentially-growing cooldown AND call
   * disconnect() to stop the instance's own forever-retry loop, so the relay
   * goes quiet until the next recovery sweep past `cooldownUntil` revives it.
   *
   * Side effects (disconnect) run AFTER all health fields are updated so the
   * re-entrant onStateChange('disconnected') disconnect triggers is a no-op.
   */
  private trackRelayHealth(url: string, state: string): void {
    let health = this.relayHealth.get(url);
    if(!health) {
      health = {connectedAt: -1, flaps: 0, cooldownUntil: 0, lastState: 'disconnected'};
      this.relayHealth.set(url, health);
    }

    const now = Date.now();
    const wasConnected = health.lastState === 'connected';
    health.lastState = state;

    if(state === 'connected') {
      health.connectedAt = now;
      return;
    }

    // Only a transition out of a real connected session is a candidate flap.
    // connectedAt uses a -1 sentinel (0 is a valid timestamp under fake clocks).
    if(!wasConnected || health.connectedAt < 0) return;
    const connectedFor = now - health.connectedAt;
    health.connectedAt = -1;

    if(connectedFor >= RELAY_FLAP_WINDOW_MS) {
      health.flaps = 0; // healthy session — clear the streak
      return;
    }

    health.flaps++;
    if(health.flaps < RELAY_FLAP_THRESHOLD) return;

    const backoff = Math.min(
      RELAY_COOLDOWN_BASE_MS * 2 ** (health.flaps - RELAY_FLAP_THRESHOLD),
      RELAY_COOLDOWN_MAX_MS
    );
    health.cooldownUntil = now + backoff;
    this.log(
      '[NostrRelayPool] relay flapping — cooling down', url,
      'for', Math.round(backoff / 1000), 's (flaps:', health.flaps + ')'
    );
    // Stop the instance's own auto-reconnect for the cooldown window.
    this.relayEntries.find((e) => e.config.url === url)?.instance.disconnect();
  }

  private notifyStateChange(): void {
    // Debounce: batch multiple relay changes into a single dispatch cycle.
    // Without this, 5 relays each firing a state change produces 5+ separate
    // `phantomchat_relay_state` event bursts, each triggering DOM updates in
    // ConnectionStatusComponent — causing UI thrash during chat switches.
    if(this.notifyStateChangeTimer) {
      return; // already scheduled
    }
    this.notifyStateChangeTimer = setTimeout(() => {
      this.notifyStateChangeTimer = null;
      this.flushStateChange();
    }, NostrRelayPool.STATE_DEBOUNCE_MS);
  }

  private flushStateChange(): void {
    if(this.onStateChangeCb) {
      this.onStateChangeCb(this.getConnectedCount(), this.relayEntries.length);
    }

    // Dispatch phantomchat_relay_state events for each relay
    for(const entry of this.relayEntries) {
      rootScope.dispatchEvent('phantomchat_relay_state', {
        url: entry.config.url,
        connected: entry.instance.getState() === 'connected',
        latencyMs: entry.instance.getLatency(),
        read: entry.config.read,
        write: entry.config.write
      });
    }
  }

  /**
   * Re-dispatch phantomchat_relay_state for a single relay (e.g. after a latency
   * update). Cheaper than notifyStateChange() when only one value changed.
   */
  private notifyRelayUpdate(url: string): void {
    // Route through the debounced path so a single relay's latency update
    // doesn't produce an immediate out-of-band dispatch that bypasses batching.
    this.notifyStateChange();
  }

  private dispatchRelayListChanged(): void {
    const list = this.configs.map(c => ({
      url: c.url,
      read: c.read,
      write: c.write,
      enabled: this.enabled.get(c.url) !== false
    }));
    rootScope.dispatchEvent('phantomchat_relay_list_changed', list);
  }

  // ─── Persistence ───────────────────────────────────────────────

  private async loadRelayConfig(): Promise<RelayConfig[]> {
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('config', 'readonly');
        const store = tx.objectStore('config');
        const request = store.get(IDB_RELAY_CONFIG_KEY);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const result = request.result;
          resolve(result ? result.value : []);
        };
      });
    } catch{
      // Fallback: try localStorage
      try {
        const stored = localStorage.getItem(IDB_RELAY_CONFIG_KEY);
        return stored ? JSON.parse(stored) : [];
      } catch{
        return [];
      }
    }
  }

  private persistRelayConfig(): void {
    // Fire-and-forget persist
    this.saveRelayConfig(this.configs).catch(() => {
      // Fallback to localStorage
      try {
        localStorage.setItem(IDB_RELAY_CONFIG_KEY, JSON.stringify(this.configs));
      } catch{
        // ignore
      }
    });
  }

  private async saveRelayConfig(configs: RelayConfig[]): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readwrite');
      const store = tx.objectStore('config');
      const request = store.put({id: IDB_RELAY_CONFIG_KEY, value: configs});
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('PhantomChatPool', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        if(!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', {keyPath: 'id'});
        }
      };
    });
  }
}
