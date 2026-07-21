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
  // eligibleCount = relays the pool is currently trying to keep connected
  // (active set). Benched relays (flap/connect-fail cooldown) are excluded so
  // consumers like the device-sync all-green hard rule aren't held hostage by
  // a relay we've deliberately benched.
  onStateChange?: (connectedCount: number, totalCount: number, eligibleCount: number) => void;
  /**
   * Pre-decrypted identity — when provided, initialize() skips the encrypted
   * store load + PBKDF2 decrypt (which onboarding already did ~100ms earlier).
   * publicKey is hex, privateKeyHex is 64-char hex string.
   */
  preloadedIdentity?: { publicKey: string; privateKeyHex: string };
  /**
   * Max number of relays to hold an open socket to simultaneously. Defaults to
   * Infinity — we connect to EVERY configured relay. A cap is only used by tests
   * that pin the active set to a specific size. (The old default of 3 caused a
   * mobile deadlock: flaky sockets flapped, all got benched, and the pool sat at
   * zero connections forever. We now connect all + stagger + a liveness floor.)
   */
  maxActiveRelays?: number;
  /**
   * Milliseconds to wait between opening each relay socket. Opening 5+ WebSocket
   * handshakes at once on a cold mobile radio trips an "insufficient resources"
   * ceiling and none survive. Staggering the dials ("one at a time") keeps us
   * under it. Defaults to 0 (open all immediately) so tests stay synchronous;
   * production passes RELAY_DIAL_STAGGER_MS.
   */
  dialStaggerMs?: number;
}

// ─── Constants ─────────────────────────────────────────────────────

// E2E tests can override relays by setting window.__phantomchatTestRelays before
// the app loads (via Playwright addInitScript). Production uses the hardcoded list.
const _testRelays = typeof window !== 'undefined' && (window as any).__phantomchatTestRelays;
export const DEFAULT_RELAYS: RelayConfig[] = Array.isArray(_testRelays) ? _testRelays : [
  {url: 'wss://nostr.mom', read: true, write: true},
  {url: 'wss://relay.nostr.com', read: true, write: true},
  {url: 'wss://relay.nostr.hu', read: true, write: true},
  {url: 'wss://relay.primal.net', read: true, write: true},
  {url: 'wss://relay.damus.io', read: true, write: true},
  {url: 'wss://nos.lol', read: true, write: true},
  {url: 'wss://relay.nostr.info', read: true, write: true}
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

// Consecutive unwrap failures tolerated for a single wrap before it is PARKED
// (claim kept, no further retries) until the next resume trigger. Caps the
// 15s-poll re-unwrap loop for a deterministically-bad wrap; see releaseWrapId.
const WRAP_RETRY_LIMIT = 3;
// NIP-59 gift wrap. Re-fetch queries are pinned to this kind so a stray id can
// never pull a non-wrap event into the unwrap path.
const GIFTWRAP_KIND = 1059;
// Safety valve on the targeted-re-fetch queue (see markWrapForRefetch). The set
// is drained every poll tick, so this only bites under something pathological.
const MAX_PENDING_WRAP_REFETCH = 500;
// Recovery sweep cadence. Tops the active set back up and re-dials any active
// relay whose socket died without self-reconnecting. Kept short-ish so a fully
// benched pool (all relays cooling down) is re-evaluated promptly — the liveness
// floor in superviseConnections guarantees ≥1 relay is always dialing, but this
// sweep is the backstop that revives the rest as their cooldowns expire.
const POOL_RECOVERY_INTERVAL_MS = 20_000;
// Delay between opening each relay socket. We connect to EVERY relay, but not all
// at once: a burst of simultaneous WebSocket handshakes on a cold mobile radio
// trips an "insufficient resources" ceiling and none survive, leaving the app
// stuck at "reconnecting". Dialing one at a time (~350ms apart) stays under the
// ceiling. This is the production value; tests default to 0 for determinism.
export const RELAY_DIAL_STAGGER_MS = 350;
// Consecutive failed socket attempts (transitions into 'reconnecting' WITHOUT an
// intervening 'connected') before we bench an ACTIVE relay and promote a standby
// in its place. This is the "swap to another relay" failover: a relay the device
// simply can't reach (blocked, down, TLS-refused) stops hogging a slot so a
// reachable standby can take it. A relay that connects fine then blips clears
// this counter on 'connected', so a healthy relay is never benched for a blip.
const RELAY_FAILOVER_THRESHOLD = 3;
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
  private onStateChangeCb?: (connectedCount: number, totalCount: number, eligibleCount: number) => void;

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

  // Consecutive unwrap failures per wrap id. Bounds the retry loop for a wrap
  // that fails deterministically (see releaseWrapId) without making the drop
  // permanent — cleared on every resume trigger (resetWrapRetryBudget).
  private wrapFailures: Map<string, number> = new Map();

  // Wrap ids that were released (or un-parked) and therefore need a TARGETED
  // re-fetch, because the watermark may already have advanced past them and no
  // since-query will ever ask for them again. See refetchPendingWraps().
  private pendingWrapRefetch: Set<string> = new Set();
  private refetchInFlight = false;

  // Pool recovery
  private recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Catch-up poll (delivery backbone — recovers wraps the live push dropped)
  private backfillPollInterval: ReturnType<typeof setInterval> | null = null;
  private backfillPollInFlight = false;

  // Resume state for a backfill that ran out of pages before exhausting the
  // range. `backfillCursor` is the `until` to continue from next tick;
  // `backfillGapOpen` freezes the watermark meanwhile, because "caught up" is
  // not true while wraps older than the cursor remain unfetched.
  private backfillCursor: number | undefined = undefined;
  private backfillGapOpen = false;

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
  private relayHealth: Map<string, {connectedAt: number; flaps: number; cooldownUntil: number; lastState: string; failedConnects: number}> = new Map();

  // Enable/disable per-relay (Phase 3)
  private enabled: Map<string, boolean> = new Map();

  // Connection supervisor. `activeUrls` is the set of relays we currently hold
  // (or are dialing) an open socket to — capped at `maxActiveRelays`. Everything
  // configured but not in this set is on standby (no socket). A relay is removed
  // from activeUrls when it's benched (flap cooldown or repeated connect
  // failure), which frees a slot for `superviseConnections()` to fill from
  // standby. This is the "connect to a few, swap on failure" model.
  private activeUrls: Set<string> = new Set();
  private maxActiveRelays: number;
  private dialStaggerMs: number;
  // Pending staggered-dial timers, cleared on disconnect so a deferred open
  // can't resurrect a socket after teardown.
  private dialTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // Identity key for NIP-65 signing
  private privateKeyBytes: Uint8Array | null = null;
  private _preloadedIdentity?: { publicKey: string; privateKeyHex: string };

  // Debounced state notification — batches multiple relay state changes into
  // a single dispatch cycle so 5 relays reconnecting don't fire 5+ DOM updates
  // in quick succession.
  private notifyStateChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_DEBOUNCE_MS = 200;

  // Resume-trigger handlers — named arrow fields so the reference is stable
  // across add/removeEventListener calls. Arrow fields bind `this` at
  // construction time, so no .bind() needed (and .bind() would create a new
  // function on each call, breaking removeEventListener).
  private onVisibilityChange = (): void => {
    if(typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.resetWrapRetryBudget();
    }
  };
  private onOnline = (): void => {
    this.resetWrapRetryBudget();
  };

  constructor(options: RelayPoolOptions) {
    this.log = logger('NostrRelayPool');
    this.configs = options.relays ? [...options.relays] : [];
    this.onMessageCb = options.onMessage;
    this.onStateChangeCb = options.onStateChange;
    this._preloadedIdentity = options.preloadedIdentity;
    // Default: connect to EVERY relay (Infinity). A finite cap is opt-in (tests).
    this.maxActiveRelays = options.maxActiveRelays != null ?
      Math.max(1, options.maxActiveRelays) :
      Number.POSITIVE_INFINITY;
    this.dialStaggerMs = Math.max(0, options.dialStaggerMs ?? 0);
  }

  // ─── Callback setters (for DI / test path) ─────────────────────

  setOnMessage(cb: (msg: DecryptedMessage) => void): void {
    this.onMessageCb = cb;
  }

  setOnStateChange(cb: (connectedCount: number, totalCount: number) => void): void {
    this.onStateChangeCb = cb;
  }

  /**
   * Register an ADDITIONAL state-change listener without displacing the primary
   * `onStateChangeCb` (which chat-api owns). Used by device-sync to re-advertise
   * its digest the moment connectivity is restored. Fires on the same debounced
   * flush as the primary callback.
   */
  addStateChangeListener(cb: (connectedCount: number, totalCount: number, eligibleCount: number) => void): void {
    this._stateChangeListeners.push(cb);
  }

  /**
   * Drop a listener registered via `addStateChangeListener`. The pool outlives its
   * subscribers (device-sync is torn down and re-inited on every account switch),
   * so registration has to be reversible or stale callbacks accumulate here.
   */
  removeStateChangeListener(cb: (connectedCount: number, totalCount: number, eligibleCount: number) => void): void {
    const i = this._stateChangeListeners.indexOf(cb);
    if(i !== -1) this._stateChangeListeners.splice(i, 1);
  }
  private _stateChangeListeners: Array<(connectedCount: number, totalCount: number, eligibleCount: number) => void> = [];

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
  private _onPresenceCb?: (presence: {type: 'ping' | 'pong'; from: string; nonce: string}) => void;
  private _onDigestCb?: (digest: {deviceId: string; conv: string; count: number; latestId: string; sentAt?: number}) => void;
  private _onSyncReqCb?: (req: {deviceId: string; targetId: string; conv: string; haveIds: string[]; recentOnly?: boolean; limit?: number; sentAt?: number}) => void;
  private _onSyncResCb?: (res: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean; sentAt?: number}) => void;

  /**
   * Register a callback for presence PING / PONG control envelopes. These ride
   * the SAME kind-1059 gift-wrap path as real messages (so a returned pong
   * proves the actual delivery path is alive, not a side-channel), but they are
   * intercepted in `handleIncomingMessage` and NEVER surfaced as chat bubbles.
   * The pool's normal rumor-id dedup applies, so each ping/pong fires once.
   */
  setOnPresence(cb: (presence: {type: 'ping' | 'pong'; from: string; nonce: string}) => void): void {
    this._onPresenceCb = cb;
  }

  /**
   * Register a callback for device-sync DIGEST control envelopes. Unlike presence
   * (which targets a peer), a digest is SELF-addressed: a device advertises "for
   * conversation X I hold `count` messages, newest is `latestId`" so our OWN other
   * devices can detect they're behind and pull the gap. Rides the kind-1059
   * gift-wrap path (private, repeats like the typing pulse so a late-connecting
   * device catches the next beat) and is intercepted before ever becoming a bubble.
   * Only fires for digests authored by us (our other device); our own echo is
   * filtered out by deviceId inside the device-sync module.
   *
   * `sentAt` is the AUTHORING device's wall-clock (ms) taken from the envelope
   * payload. Control envelopes are STORED gift-wraps, so a reconnecting device
   * replays the entire backlog of them — `sentAt` is what lets the device-sync
   * module tell a live pulse from a replayed one and drop the latter.
   *
   * Pass `null` to UNWIRE — device-sync does this on destroy, so a control envelope
   * replayed after logout has nothing to run instead of reaching a stale handler.
   */
  setOnDigest(cb: ((digest: {deviceId: string; conv: string; count: number; latestId: string; sentAt?: number}) => void) | null): void {
    this._onDigestCb = cb ?? undefined;
  }

  /**
   * Register a callback for device-sync REQUEST envelopes (a behind device asking
   * a fuller device for the rows it's missing). Self-authored like the digest, so
   * only fires for msg.from === self; the device-sync module ignores requests not
   * targeted at its own deviceId. Pass `null` to unwire (see `setOnDigest`).
   */
  setOnSyncRequest(cb: ((req: {deviceId: string; targetId: string; conv: string; haveIds: string[]; recentOnly?: boolean; limit?: number; sentAt?: number}) => void) | null): void {
    this._onSyncReqCb = cb ?? undefined;
  }

  /**
   * Register a callback for device-sync RESPONSE envelopes (the fuller device
   * returning the missing rows). Self-authored; the device-sync module ingests
   * only responses targeted at its own deviceId, strict-union. Pass `null` to unwire
   * (see `setOnDigest`).
   */
  setOnSyncResponse(cb: ((res: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean; sentAt?: number}) => void) | null): void {
    this._onSyncResCb = cb ?? undefined;
  }

  /**
   * Publish a SELF-addressed device-sync digest for one conversation. Wraps the
   * envelope `{type:'device-digest', ...}` to our OWN pubkey so it reaches our
   * other devices' `#p == self` subscription (never the peer). Best-effort: a
   * digest is advisory — a dropped one is re-sent on the next pulse.
   */
  async publishSelfDigest(payload: {deviceId: string; conv: string; count: number; latestId: string}): Promise<void> {
    await this.publishSelfControl({
      type: 'device-digest',
      deviceId: payload.deviceId,
      conv: payload.conv,
      count: payload.count,
      latestId: payload.latestId
    });
  }

  /**
   * Device-sync REQUEST: "I'm behind on conversation `conv`; here are the eventIds
   * I already hold (`haveIds`). Whichever of my devices is `targetId`, send me the
   * rows I'm missing." Self-addressed like the digest, so only our own devices see
   * it. Best-effort — a dropped request is re-issued on the next digest/typing edge.
   */
  async publishSyncRequest(payload: {deviceId: string; targetId: string; conv: string; haveIds: string[]; recentOnly?: boolean; limit?: number}): Promise<void> {
    await this.publishSelfControl({
      type: 'device-sync-req',
      deviceId: payload.deviceId,
      targetId: payload.targetId,
      conv: payload.conv,
      haveIds: payload.haveIds,
      // Optional: bound the reconcile to the last `limit` rows of the conversation
      // (used by the sync-before-render barrier so an incoming message waits on a
      // cheap recent catch-up, never a full-history pull).
      ...(payload.recentOnly ? {recentOnly: true} : {}),
      ...(typeof payload.limit === 'number' ? {limit: payload.limit} : {})
    });
  }

  /**
   * Device-sync RESPONSE: the fuller device answers a request with the full rows
   * the requester was missing, chunked (`seq`/`last`) so a big backlog doesn't
   * exceed one gift-wrap. Self-addressed; `targetId` is the requesting device.
   */
  async publishSyncResponse(payload: {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean}): Promise<void> {
    await this.publishSelfControl({
      type: 'device-sync-res',
      deviceId: payload.deviceId,
      targetId: payload.targetId,
      conv: payload.conv,
      rows: payload.rows,
      seq: payload.seq,
      last: payload.last
    });
  }

  /**
   * Wrap a control envelope to our OWN pubkey (both NIP-17 wraps are p-tagged to
   * us; we publish the self wrap) and fan it out to every enabled write relay.
   * Shared by all self-addressed device-sync envelopes (digest / request /
   * response). Best-effort per relay — these are advisory and re-sent on retry.
   */
  private async publishSelfControl(envelope: Record<string, unknown>): Promise<void> {
    if(!this.privateKeyBytes) return;
    const payload = JSON.stringify({...envelope, timestamp: Date.now()});

    let selfWrap: NostrEvent | undefined;
    try {
      const {wraps} = wrapNip17Message(this.privateKeyBytes, this.publicKey, payload);
      selfWrap = (wraps[1] ?? wraps[0]) as unknown as NostrEvent;
    } catch(err) {
      this.log.debug('[NostrRelayPool] self-control wrap failed:', err);
      return;
    }
    if(!selfWrap) return;

    const writeEntries = this.relayEntries.filter(e =>
      e.config.write && this.enabled.get(e.config.url) !== false
    );
    for(const entry of writeEntries) {
      try {
        entry.instance.publishRawEvent(selfWrap);
      } catch{
        // best-effort per relay; device-sync control envelopes are advisory
      }
    }
  }

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

    this.registerResumeTriggers();

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

    for(const timer of this.dialTimers) {
      clearTimeout(timer);
    }
    this.dialTimers.clear();

    for(const entry of this.relayEntries) {
      entry.instance.disconnect();
    }

    // Remove resume-trigger listeners so a disconnected pool stops
    // responding to tab-foreground / network-online events. Guarded by
    // the flag so double-disconnect or pre-register disconnect is a no-op.
    if(this.resumeTriggersRegistered) {
      if(typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
      }
      if(typeof window !== 'undefined') {
        window.removeEventListener('online', this.onOnline);
      }
      this.resumeTriggersRegistered = false;
    }

    this.relayEntries = [];
    this.activeUrls.clear();
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
   * Ingest a gift-wrap that arrived over a DIRECT P2P transport (issue #61)
   * rather than a relay socket. The frame is a standard `["EVENT", wrap]`; the
   * caller passes the raw wrap here and we run it through the identical ingest a
   * relay-delivered event takes — the shared pre-decrypt dedup gate, NIP-17
   * unwrap, and dispatch to the registered onMessage/onReceipt/onRawEvent
   * handlers. Because the pool's dedup is keyed by the OUTER wrap id and the
   * INNER rumor id — both identical to the relay copy — whichever copy (relay or
   * P2P) arrives second is dropped for free. Any initialised relay entry works:
   * they all share this pool's dedup gate, message handler and identity. No-ops
   * (and stays silent) if the pool has no initialised relay yet. Never throws.
   */
  async ingestP2PEvent(rawEvent: NostrEvent): Promise<void> {
    try {
      if(!rawEvent || typeof rawEvent !== 'object' || !rawEvent.id) return;
      // Pick any relay whose identity is loaded (non-empty pubkey) — it can
      // unwrap. All entries share the pool-wide dedup + onMessage handler, so
      // routing through one dispatches exactly once pool-wide.
      const entry = this.relayEntries.find(e => e.instance.getPublicKey?.());
      if(!entry) return;
      await entry.instance.ingestExternalEvent(rawEvent);
    } catch(err) {
      swallowHandler('NostrRelayPool.ingestP2PEvent')(err);
    }
  }

  /**
   * Re-wrap a previously-published rumor in a FRESH outer gift-wrap and publish
   * it to all write relays. Used by the delivery-retry layer: the rumor id is
   * preserved (receiver dedups → no double message) but the outer kind-1059
   * event id is new, so relays re-forward it to an already-live subscriber —
   * which a verbatim resend of the original wrap cannot do. Returns the freshly
   * minted wraps (mainly for tests/inspection). Best-effort per relay.
   */
  async rewrapAndPublish(recipientPubkey: string, rumor: UnsignedEvent): Promise<PublishResult> {
    if(!this.privateKeyBytes) {
      return {successes: [], failures: [{url: 'wrap', error: 'no private key available for re-wrap'}]};
    }

    const successes: string[] = [];
    const failures: {url: string; error: string}[] = [];

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
        successes.push(wrap.id);
      } catch(err) {
        failures.push({
          url: entry.config.url,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return {successes, failures, rumorId: rumor.id, wraps: [wrap], rumor};
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
   * Publish a presence PING or PONG to `recipientPubkey`. Builds the phantomchat
   * envelope `{type:'presence-ping'|'presence-pong', nonce, ...}`, NIP-17-wraps
   * it, and publishes ONLY the recipient wrap (wraps[0]) — never the self-wrap:
   * a presence probe is point-to-point, our own other devices have no use for
   * it, and skipping the self-wrap avoids us ping-ponging with ourselves. Rides
   * the kind-1059 path on purpose so a pong proves the real message path is live.
   * Best-effort: resolves even if all relays fail (presence is advisory).
   */
  async publishPresence(
    recipientPubkey: string,
    nonce: string,
    kind: 'ping' | 'pong'
  ): Promise<void> {
    if(!this.privateKeyBytes) return;
    const envelope = JSON.stringify({
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `presence-${Date.now()}`,
      from: this.publicKey,
      to: recipientPubkey,
      type: kind === 'ping' ? 'presence-ping' : 'presence-pong',
      nonce,
      content: '',
      timestamp: Date.now()
    });

    let recipientWrap: NostrEvent | undefined;
    try {
      const {wraps} = wrapNip17Message(this.privateKeyBytes, recipientPubkey, envelope);
      recipientWrap = wraps[0] as unknown as NostrEvent;
    } catch(err) {
      this.log.debug('[NostrRelayPool] presence wrap failed:', err);
      return;
    }
    if(!recipientWrap) return;

    const writeEntries = this.relayEntries.filter(e =>
      e.config.write && this.enabled.get(e.config.url) !== false
    );
    for(const entry of writeEntries) {
      try {
        entry.instance.publishRawEvent(recipientWrap);
      } catch{
        // best-effort per relay; presence is advisory
      }
    }
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
    return (await this.queryRawEventsWithMeta(filter)).events;
  }

  /**
   * Like queryRawEvents, but also reports how many read relays actually
   * ANSWERED the query (resolved without throwing) vs merely being enrolled.
   *
   * The distinction matters for authoritative-absence decisions (CrdtSync):
   * an empty `events` array only means "no such event exists" if at least one
   * relay actually responded (`responded > 0`). If every read relay's query
   * threw/timed out (`responded === 0`), an empty result means "nobody
   * answered" — a transport failure, NOT a confirmed absence — even if a
   * stale socket is still flagged connected. Callers must not seed/publish
   * stale local state off a zero-responded read.
   */
  async queryRawEventsWithMeta(filter: Record<string, unknown>): Promise<{events: NostrEvent[]; responded: number; queried: number}> {
    const readEntries = this.relayEntries.filter(e =>
      e.config.read && this.enabled.get(e.config.url) !== false
    );

    const seenIds = new Set<string>();
    const results: NostrEvent[] = [];
    let responded = 0;

    const promises = readEntries.map(async(entry) => {
      try {
        const events = await entry.instance.queryRawEvents(filter);
        responded++;
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
    return {events: results, responded, queried: readEntries.length};
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

    // Connect now if there's a free active slot; otherwise it waits on standby
    // and the supervisor promotes it when an active relay is benched.
    void this.superviseConnections();

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
    this.activeUrls.delete(url);
    this.persistRelayConfig();
    // Removing an active relay frees a slot — pull a standby up to keep target.
    void this.superviseConnections();
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
    // "Disabled" excludes a relay from publish/read fan-out but keeps its socket
    // — it is a policy flag, not a physical disconnect. Slot accounting is
    // unaffected (a disabled-but-connected relay still holds its socket).
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
    // ...and the rollback, so a wrap whose processing dies is not poisoned in
    // the seen-set and can be retried by a replay.
    instance.setEventRelease?.((eventId) => this.releaseWrapId(eventId));
    // ...and the success signal, so a wrap that unwraps cleanly stops carrying
    // the failure strikes it accrued while the worker/network was broken.
    instance.setEventCommit?.((eventId) => this.commitWrapId(eventId));

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
          // RESUME TRIGGER: a socket that just came back is the strongest signal
          // that whatever was breaking unwraps (frozen worker, dead network) has
          // cleared. Give parked wraps a fresh retry budget BEFORE the backfill
          // runs, so the backfill can actually re-deliver them.
          this.resetWrapRetryBudget();
          this.backfillRelay({config, instance}).catch(
            swallowHandler('NostrRelayPool.reconnectBackfill')
          );
        }
      }
      this.trackRelayHealth(config.url, instance.getState());
      this.notifyStateChange();
      // Top up the active set: a relay just dropped/benched may have freed a
      // slot a standby should fill. Cheap no-op when already at target.
      void this.superviseConnections();
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

  /**
   * Hand a claimed wrap id back to the seen-set (see `claimWrapId`).
   *
   * `claimWrapId` is a CLAIM, not a COMMIT: the relay marks a wrap id as seen
   * before it unwraps, so a duplicate copy from a second relay skips the
   * (expensive) crypto. If the unwrap then fails, the wrap was never delivered
   * — and leaving its id in the set means every later replay is deduped away.
   * The message is on the relay, retrievable, and permanently invisible to this
   * session. Only a reload clears it. Releasing the claim closes that hole.
   */
  public releaseWrapId(eventId: string): void {
    // Bound the retry loop, but never permanently.
    //
    // An unconditional release re-opens a known freeze (FIND-poll-reunwrap): a
    // deterministically-corrupt wrap sitting near the watermark is re-fetched by
    // the 15s catch-up poll, fails, is released, re-fetched... forever, and the
    // re-unwrap storm saturates the worker. So we cap consecutive failures per
    // wrap and PARK it (keep the claim) once the cap is hit — the hot loop dies.
    //
    // But the cap must NOT be the terminal verdict. Failures here are not
    // independent trials: a frozen/backgrounded worker fails EVERY wrap it
    // touches, in a burst, so one background episode would burn a 3-strike
    // budget in ~45s and silently drop a perfectly good message — which is the
    // original bug wearing a hat. Instead the counters reset on RESUME
    // (visibility/online/reconnect — see resetWrapRetryBudget), the moments the
    // environmental cause has plausibly cleared and a retry is newly
    // informative. Net: corrupt wrap => <=N attempts per resume (bounded CPU);
    // transient wrap => always recovers on the next resume, no reload needed.
    //
    // A count can't distinguish "bad wrap" from "sleeping device" — only the
    // error can. A future pass should make DETERMINISTIC errors (malformed rumor
    // JSON, AEAD failure) terminal and leave everything else retryable; the cap
    // is the coarse stand-in until then.
    const failures = (this.wrapFailures.get(eventId) ?? 0) + 1;
    this.wrapFailures.set(eventId, failures);
    if(failures >= WRAP_RETRY_LIMIT) {
      this.log.warn(
        '[NostrRelayPool] wrap failed', failures, 'times; parking until resume:', eventId.slice(0, 8)
      );
      return; // keep the claim — no retry until resetWrapRetryBudget()
    }

    if(!this.seenWrapIds.delete(eventId)) return;
    const idx = this.seenWrapOrder.lastIndexOf(eventId);
    if(idx !== -1) this.seenWrapOrder.splice(idx, 1);

    // Re-admitting the id to the seen-set only makes the wrap CLAIMABLE. It does
    // not make it REACHABLE: every replay path queries `since >= watermark-fuzz`,
    // and the watermark advances on any delivered message, so as soon as one
    // later message unwraps cleanly this wrap sits below the floor and no query
    // will ever mention it again. Mark it for targeted re-fetch by id.
    this.markWrapForRefetch(eventId);
  }

  /**
   * Queue a wrap id for targeted re-fetch, bounding the queue.
   *
   * The cap is a safety valve, not a policy: the set only ever holds wraps we
   * released within the last poll tick (refetchPendingWraps drains it), so in
   * practice it stays tiny. If something pathological floods it, drop the OLDEST
   * ids — a stale pending id is worth less than a fresh one, and the LRU
   * seen-set has the same shape.
   */
  private markWrapForRefetch(eventId: string): void {
    this.pendingWrapRefetch.add(eventId);
    while(this.pendingWrapRefetch.size > MAX_PENDING_WRAP_REFETCH) {
      const oldest = this.pendingWrapRefetch.values().next().value;
      if(oldest === undefined) break;
      this.pendingWrapRefetch.delete(oldest);
    }
  }

  /**
   * A claimed wrap unwrapped cleanly — forget its failure history.
   *
   * The counters are meant to measure CONSECUTIVE failures (a hot retry loop on
   * a wrap that cannot be unwrapped). A wrap that failed twice under a frozen
   * worker and then succeeded has proven the failures were environmental, so
   * keeping its strikes would park it a failure early next time — and leave the
   * entry in a map that otherwise only shrinks on resume, while `seenWrapIds`
   * is LRU-capped. Cheap to clear, honest to clear.
   */
  private commitWrapId(eventId: string): void {
    this.wrapFailures.delete(eventId);
    // Delivered — it no longer needs chasing. Without this a wrap that failed
    // once and then succeeded would generate an ids-query on every 15s tick for
    // the rest of the session.
    this.pendingWrapRefetch.delete(eventId);
  }

  /**
   * Clear the per-wrap retry budget and un-park everything it parked.
   *
   * Called on the resume triggers (visibilitychange -> visible, online, relay
   * reconnect). These are precisely the moments when the reason an unwrap was
   * failing — frozen worker, dead socket, no network — has plausibly gone away,
   * so a wrap we parked deserves a fresh set of attempts. Without this, parking
   * is indistinguishable from the poisoning this whole PR exists to remove.
   */
  /**
   * Register the DOM resume triggers that refresh the wrap retry budget.
   *
   * A backgrounded PWA is the environment that produces the failures we park on
   * (frozen unwrap worker), and coming back to the foreground / regaining the
   * network is the environment ceasing to be broken. Idempotent, and guarded for
   * non-DOM contexts (worker/test).
   */
  private resumeTriggersRegistered = false;
  private registerResumeTriggers(): void {
    if(this.resumeTriggersRegistered) return;
    if(typeof document === 'undefined' && typeof window === 'undefined') return;
    this.resumeTriggersRegistered = true;

    if(typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    if(typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
    }
  }

  public resetWrapRetryBudget(): void {
    if(this.wrapFailures.size === 0) return;
    let unparked = 0;
    for(const [eventId, failures] of this.wrapFailures) {
      if(failures < WRAP_RETRY_LIMIT) continue;
      // Parked: the claim was kept, so drop it now to make the wrap replayable.
      if(this.seenWrapIds.delete(eventId)) {
        const idx = this.seenWrapOrder.lastIndexOf(eventId);
        if(idx !== -1) this.seenWrapOrder.splice(idx, 1);
        // Same trap as releaseWrapId: un-parking clears a flag, it does not make
        // the wrap reachable. A parked wrap is BY DEFINITION old (it has been
        // failing for a while), so the watermark is almost certainly above it.
        // Un-parking without re-fetching is a no-op dressed as a recovery.
        this.markWrapForRefetch(eventId);
        unparked++;
      }
    }
    this.wrapFailures.clear();
    if(unparked > 0) {
      this.log('[NostrRelayPool] resume: un-parked', unparked, 'failed wrap(s) for retry');
    }
    // Resume is exactly when the environment that broke these unwraps (frozen
    // worker, dead socket, no network) has plausibly healed — go and get them
    // now rather than waiting up to 15s for the next poll tick.
    void this.refetchPendingWraps();
  }

  /**
   * Go and re-fetch the wraps we released, BY ID.
   *
   * This is the other half of releaseWrapId. Releasing the dedup claim says "you
   * may process this wrap again"; nothing in the system ever offers it again,
   * because every replay path is a since-query and the watermark has moved on.
   * The wrap id is the one piece of information that survives the failure — so
   * use it: ask the relays for exactly these ids, and push whatever comes back
   * through the normal ingest path (claim gate, unwrap, dispatch).
   *
   * WHY NOT JUST LOWER THE WATERMARK. A floor at the oldest failed wrap would
   * also reach it — and would re-request every wrap newer than it, on every tick,
   * for as long as the wrap kept failing. A deterministically-corrupt wrap would
   * hold the window open forever and turn each poll into a history replay. An
   * ids-query costs one REQ and is bounded by the number of wraps that actually
   * failed. Precision beats a wider net.
   *
   * ATTEMPT-ONCE, SELF-HEALING. The pending set is drained on attempt, not on
   * success: if the re-fetched wrap fails to unwrap again, releaseWrapId puts it
   * straight back (until the retry budget parks it), and if the relay no longer
   * has it, it simply falls out. No id can loop forever, and none is dropped
   * while it is still failing.
   */
  private async refetchPendingWraps(): Promise<void> {
    if(this.refetchInFlight) return;
    if(this.pendingWrapRefetch.size === 0) return;

    const readEntries = this.relayEntries.filter(
      e => e.config.read && e.instance.getState() === 'connected'
    );
    // Nobody can answer. Ignorance is not absence — keep the ids and retry on a
    // later tick, rather than draining the set into the void.
    if(readEntries.length === 0) return;

    this.refetchInFlight = true;
    const ids = [...this.pendingWrapRefetch];
    this.pendingWrapRefetch.clear();

    try {
      this.log('[NostrRelayPool] re-fetching', ids.length, 'released wrap(s) by id');
      for(const entry of readEntries) {
        try {
          const events = await entry.instance.queryRawEvents({
            ids,
            kinds: [GIFTWRAP_KIND]
          });
          for(const event of events) {
            // Identical path a socket-delivered wrap takes — claim gate included,
            // so a copy another relay already delivered is not unwrapped twice.
            await entry.instance.ingestExternalEvent(event);
          }
        } catch(err) {
          // A relay that throws told us nothing. Put the ids back so a later tick
          // can try again; do not let one bad relay strand the wrap.
          this.log.warn('[NostrRelayPool] wrap re-fetch failed on', entry.config.url, err);
          ids.forEach((id) => this.markWrapForRefetch(id));
        }
      }
    } finally {
      this.refetchInFlight = false;
    }
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

    // Presence PING/PONG interception. These ride the gift-wrap path but are
    // control envelopes, not chat: route them to the presence callback and stop
    // — they must never reach onMessageCb (no bubble, no auto-add, no delivery
    // receipt) and must not advance lastSeenTimestamp (a presence probe is not a
    // message and shouldn't move the backfill watermark). Self-sent presence is
    // ignored (we don't track our own liveness). Dedup above already ran, so a
    // replayed ping/pong is consumed once.
    const presence = this.parsePresenceEnvelope(msg);
    if(presence) {
      if(msg.from !== this.publicKey && this._onPresenceCb) {
        try {
          this._onPresenceCb({type: presence.type, from: msg.from, nonce: presence.nonce});
        } catch(err) {
          this.log.error('[NostrRelayPool] presence handler threw:', err);
        }
      }
      return;
    }

    // Device-sync DIGEST interception. Like presence, it rides the gift-wrap path
    // but is a control envelope, not chat: route to the digest callback and stop
    // (no bubble, no delivery receipt, no watermark advance). A digest is ALWAYS
    // self-authored (our own other device advertising what it holds), so unlike
    // presence we require msg.from === self. The device-sync module drops our own
    // echo by deviceId.
    const digest = this.parseDigestEnvelope(msg);
    if(digest) {
      if(msg.from === this.publicKey && this._onDigestCb) {
        try {
          this._onDigestCb(digest);
        } catch(err) {
          this.log.error('[NostrRelayPool] digest handler threw:', err);
        }
      }
      return;
    }

    // Device-sync REQUEST / RESPONSE interception. Same self-authored control-
    // envelope contract as the digest: only honor msg.from === self, never surface
    // as a bubble. The device-sync module owns targeting (deviceId) and strict-union.
    const syncReq = this.parseSyncRequestEnvelope(msg);
    if(syncReq) {
      if(msg.from === this.publicKey && this._onSyncReqCb) {
        try {
          this._onSyncReqCb(syncReq);
        } catch(err) {
          this.log.error('[NostrRelayPool] sync-request handler threw:', err);
        }
      }
      return;
    }

    const syncRes = this.parseSyncResponseEnvelope(msg);
    if(syncRes) {
      if(msg.from === this.publicKey && this._onSyncResCb) {
        try {
          this._onSyncResCb(syncRes);
        } catch(err) {
          this.log.error('[NostrRelayPool] sync-response handler threw:', err);
        }
      }
      return;
    }

    // Update lastSeenTimestamp — UNLESS a backfill gap is still open.
    //
    // The watermark is a claim: "everything at or below this has been
    // delivered." A truncated backfill (page cap hit with the range
    // unexhausted) means that claim is false — there are older wraps we have
    // NOT fetched yet. Advancing to the newest message we happen to have
    // decrypted would move the floor above them, and since every replay path
    // (live REQ `since`, catch-up poll, reconnect backfill) is keyed off this
    // watermark, they'd be permanently out of reach. Exactly the failure Robert
    // flagged, just reached through the pool instead of the relay.
    //
    // So while `backfillGapOpen` is set we deliver the message but hold the
    // watermark still. backfillRecent() resumes the walk from its saved cursor
    // on the next tick and clears the flag when the range is finally exhausted;
    // the watermark then jumps forward normally.
    if(msg.timestamp > this.lastSeenTimestamp && !this.backfillGapOpen) {
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

  /**
   * Cheap classifier: is this decrypted message a device-sync digest envelope?
   * Returns the parsed digest, or null for anything else (chat text, presence,
   * non-JSON). Only JSON content carrying our `device-digest` type matches, so a
   * normal message or a presence ping returns null and flows on.
   */
  private parseDigestEnvelope(msg: DecryptedMessage): {deviceId: string; conv: string; count: number; latestId: string; sentAt?: number} | null {
    const content = msg.content;
    // Fast reject: digest envelopes always contain the marker substring.
    if(typeof content !== 'string' || content.indexOf('device-digest') === -1) return null;
    try {
      const env = JSON.parse(content);
      if(env?.type !== 'device-digest') return null;
      if(typeof env.deviceId !== 'string' || typeof env.conv !== 'string') return null;
      return {
        deviceId: env.deviceId,
        conv: env.conv,
        count: typeof env.count === 'number' ? env.count : 0,
        latestId: typeof env.latestId === 'string' ? env.latestId : '',
        // `publishSelfControl` always stamps `timestamp` (ms). Surfacing it lets the
        // device-sync module drop replayed backlog envelopes.
        ...(typeof env.timestamp === 'number' ? {sentAt: env.timestamp} : {})
      };
    } catch{
      // not JSON — a plain message
    }
    return null;
  }

  /**
   * Cheap classifier: is this decrypted message a device-sync REQUEST envelope?
   * Returns the parsed request, or null. Only self-authored JSON carrying our
   * `device-sync-req` type matches.
   */
  private parseSyncRequestEnvelope(msg: DecryptedMessage): {deviceId: string; targetId: string; conv: string; haveIds: string[]; recentOnly?: boolean; limit?: number; sentAt?: number} | null {
    const content = msg.content;
    if(typeof content !== 'string' || content.indexOf('device-sync-req') === -1) return null;
    try {
      const env = JSON.parse(content);
      if(env?.type !== 'device-sync-req') return null;
      if(typeof env.deviceId !== 'string' || typeof env.targetId !== 'string' || typeof env.conv !== 'string') return null;
      return {
        deviceId: env.deviceId,
        targetId: env.targetId,
        conv: env.conv,
        haveIds: Array.isArray(env.haveIds) ? env.haveIds.filter((x: unknown) => typeof x === 'string') : [],
        ...(env.recentOnly === true ? {recentOnly: true} : {}),
        ...(typeof env.limit === 'number' ? {limit: env.limit} : {}),
        ...(typeof env.timestamp === 'number' ? {sentAt: env.timestamp} : {})
      };
    } catch{
      // not JSON — a plain message
    }
    return null;
  }

  /**
   * Cheap classifier: is this decrypted message a device-sync RESPONSE envelope?
   * Returns the parsed response, or null. Only self-authored JSON carrying our
   * `device-sync-res` type matches. Row shape is validated by the device-sync module.
   */
  private parseSyncResponseEnvelope(msg: DecryptedMessage): {deviceId: string; targetId: string; conv: string; rows: unknown[]; seq: number; last: boolean; sentAt?: number} | null {
    const content = msg.content;
    if(typeof content !== 'string' || content.indexOf('device-sync-res') === -1) return null;
    try {
      const env = JSON.parse(content);
      if(env?.type !== 'device-sync-res') return null;
      if(typeof env.deviceId !== 'string' || typeof env.targetId !== 'string' || typeof env.conv !== 'string') return null;
      return {
        deviceId: env.deviceId,
        targetId: env.targetId,
        conv: env.conv,
        rows: Array.isArray(env.rows) ? env.rows : [],
        seq: typeof env.seq === 'number' ? env.seq : 0,
        last: env.last === true,
        ...(typeof env.timestamp === 'number' ? {sentAt: env.timestamp} : {})
      };
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
    this.activeUrls.clear();

    // Create an entry for EVERY configured relay so they're all addressable,
    // but only open a socket to the first `maxActiveRelays`. The remainder stay
    // on standby (no socket) until a slot frees — see superviseConnections().
    for(const config of this.configs) {
      this.relayEntries.push(this.createRelayEntry(config));
    }

    await this.superviseConnections();
    this.notifyStateChange();
  }

  /**
   * Open a socket to a relay, optionally after a stagger delay. Claiming the slot
   * (activeUrls.add) is done by the CALLER, synchronously, before this runs — so
   * a concurrent supervise pass counts the slot as taken and doesn't over-dial.
   * The actual initialize()+connect() may be deferred (staggered) so a burst of
   * dials doesn't slam a cold mobile radio; every deferred open re-checks that
   * the relay is still active (not benched/removed during the delay).
   */
  private openRelaySocket(entry: RelayEntry, delayMs: number): void {
    const url = entry.config.url;
    const open = () => {
      if(!this.activeUrls.has(url)) return; // benched/removed during the stagger
      entry.instance.initialize().then(() => {
        if(!this.activeUrls.has(url)) return;
        if(this.isSubscribedFlag && entry.config.read) {
          entry.instance.pendingSubscribe = true;
        }
        entry.instance.connect();
      }).catch((err) => {
        this.log.error('[NostrRelayPool] failed to open relay socket:', url, err);
      });
    };
    if(delayMs > 0) {
      const timer = setTimeout(() => {
        this.dialTimers.delete(timer);
        open();
      }, delayMs);
      this.dialTimers.add(timer);
    } else {
      open();
    }
  }

  /**
   * Keep every eligible relay holding a socket (up to `maxActiveRelays`, which is
   * Infinity by default — connect to ALL relays). Slots are held by membership in
   * `activeUrls` (benching removes a url, freeing its slot). Newly-opened sockets
   * are STAGGERED (`dialStaggerMs` apart) so we never fan out a burst of
   * handshakes at once. Skips user-disabled relays and those serving a
   * flap/failover cooldown.
   *
   * Liveness floor: the pool must NEVER sit with zero relays dialing. If every
   * relay is benched (all cooling down) the normal promote loop would skip them
   * all and the app would hang at "reconnecting" forever — the exact bug the old
   * hard cap caused. So when nothing is active we force-revive the relay whose
   * cooldown expires soonest, ignoring its cooldown, guaranteeing there is always
   * one relay trying. It self-heals the instant connectivity returns; if it keeps
   * failing it rotates (each failover-bench sets a fresh cooldown, moving another
   * relay to "soonest").
   */
  private async superviseConnections(): Promise<void> {
    const now = Date.now();
    const toOpen: RelayEntry[] = [];

    // Re-dial any ACTIVE relay whose socket fully dropped and isn't
    // self-reconnecting (state 'disconnected'), unless it's benched. Active
    // relays normally self-heal via their own reconnect loop; this covers a
    // socket that died without arming one.
    for(const entry of this.relayEntries) {
      if(!this.activeUrls.has(entry.config.url)) continue;
      if(entry.instance.getState() !== 'disconnected') continue;
      const health = this.relayHealth.get(entry.config.url);
      if(health && health.cooldownUntil > now) continue;
      toOpen.push(entry);
    }

    // Promote standby relays up to target (default: all of them), claiming each
    // slot synchronously so counting stays race-free across the stagger delay.
    let need = this.maxActiveRelays - this.activeUrls.size;
    for(const entry of this.relayEntries) {
      if(need <= 0) break;
      const url = entry.config.url;
      if(this.activeUrls.has(url)) continue;             // already active/dialing
      if(this.enabled.get(url) === false) continue;      // user-disabled
      const health = this.relayHealth.get(url);
      if(health && health.cooldownUntil > now) continue; // benched, cooling down
      this.activeUrls.add(url);
      toOpen.push(entry);
      need--;
    }

    // Liveness floor: if nothing is active/dialing, force-revive the
    // soonest-cooldown relay so the pool can never deadlock at zero connections.
    if(this.activeUrls.size === 0) {
      const candidates = this.relayEntries.filter(
        (e) => this.enabled.get(e.config.url) !== false
      );
      if(candidates.length) {
        candidates.sort((a, b) => {
          const ca = this.relayHealth.get(a.config.url)?.cooldownUntil ?? 0;
          const cb = this.relayHealth.get(b.config.url)?.cooldownUntil ?? 0;
          return ca - cb;
        });
        const revive = candidates[0];
        this.log('[NostrRelayPool] all relays benched — liveness revive of', revive.config.url);
        this.activeUrls.add(revive.config.url);
        toOpen.push(revive);
      }
    }

    // Open the collected sockets one at a time (staggered).
    toOpen.forEach((entry, i) => this.openRelaySocket(entry, i * this.dialStaggerMs));
  }

  /**
   * Bench an active relay and free its slot so a standby can take over. Used by
   * both failure paths (flap cooldown, repeated connect failure). Sets a cooldown
   * so the recovery sweep won't immediately re-promote the same sick relay, drops
   * it from the active set, and hard-disconnects to stop its own retry loop.
   */
  private benchRelay(url: string, cooldownMs: number): void {
    const health = this.relayHealth.get(url);
    if(health) health.cooldownUntil = Date.now() + cooldownMs;
    this.activeUrls.delete(url);
    this.relayEntries.find((e) => e.config.url === url)?.instance.disconnect();
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
      // Reach back to the WATERMARK, not to a fixed wall-clock window.
      //
      // This poll is the delivery backbone — the thing that recovers a wrap the
      // live socket never pushed. A fixed `now - 90s` window silently assumed
      // the client is always awake to catch it. A PWA is not: freeze the tab
      // (background it, sleep the phone, lose the network) for longer than 90s
      // and the window slides clean past everything that arrived during the
      // gap. The message stays on the relay, retrievable, and the one component
      // whose job is to retrieve it is looking at the wrong 90 seconds. That is
      // the "Kai went quiet until I reloaded" bug.
      //
      // `catchUpSince()` is the honest lower bound: it tracks the newest event
      // we have actually PROCESSED (not wall-clock), so it cannot skip a gap no
      // matter how long we were asleep. We still floor the window at 90s so a
      // freshly-advanced watermark doesn't shrink the poll to nothing and lose
      // the out-of-order/clock-skew margin the fixed window was giving us.
      //
      // Cost of being wrong in this direction is a few duplicate wraps, which
      // the dedup LRU eats for free. Cost of being wrong in the other direction
      // is a lost message. The reach-back is bounded by SUBSCRIBE_REPLAY_LIMIT
      // inside getMessages(), so even a very stale watermark can't pull
      // unbounded history — and one successful tick advances the watermark,
      // which collapses the window back to normal.
      const recentWindow = Math.floor(Date.now() / 1000) - RECENT_BACKFILL_WINDOW_SEC;
      const watermark = this.catchUpSince();
      const since = watermark === undefined ?
        recentWindow :
        Math.min(recentWindow, watermark);
      const readEntries = this.relayEntries.filter(
        e => e.config.read && e.instance.getState() === 'connected'
      );

      // The walk is PAGINATED (see NostrRelay.getMessagesPaged): a single
      // limit-capped REQ returns only the NEWEST page of the range, so on a gap
      // wider than the limit the oldest wraps are dropped on the floor. Resume
      // from `backfillCursor` when the previous tick ran out of pages, so a deep
      // backlog drains across ticks rather than being re-fetched from the top
      // (which would loop on the same newest page forever and never reach the
      // messages that are actually missing).
      const resumeFrom = this.backfillCursor;
      let deepestUnclosed: number | undefined;

      // FETCH EVERYTHING FIRST, THEN DECIDE, THEN DISPATCH.
      //
      // The gap flag has to be set BEFORE any message is handed to
      // handleIncomingMessage, because that is what advances the watermark.
      // Dispatching as each relay lands and only raising the flag afterwards
      // lets the newest message of a truncated walk move the watermark on its
      // way past — which is precisely the "advanced past an unclosed gap" bug
      // this is here to prevent. (Caught by its own test: the walk truncated at
      // t0+500 and the watermark still jumped to t0+900.)
      const pages = await Promise.all(readEntries.map(async(entry) => {
        try {
          return await entry.instance.getMessagesPaged(since, resumeFrom);
        } catch(err) {
          this.log.error('[NostrRelayPool] catch-up poll failed for:', entry.config.url, err);
          return null;
        }
      }));

      for(const page of pages) {
        if(page?.outcome === 'truncated' && page.oldestReached !== undefined) {
          // Resume at the NEWEST of the truncated relays' cursors. Cheaper to
          // re-fetch overlap (the claim gate eats it) than to skip a region a
          // slower relay hasn't handed us yet.
          deepestUnclosed = deepestUnclosed === undefined ?
            page.oldestReached :
            Math.max(deepestUnclosed, page.oldestReached);
        }
      }

      // GAP STATE MAY ONLY BE CLEARED BY A WALK THAT REACHED THE BOTTOM.
      //
      // Recomputing the flag from scratch each tick (`gapOpen = deepestUnclosed
      // !== undefined`) treats "nobody reported truncation" as proof the range
      // was exhausted. It isn't — it is equally what a tick that LEARNED NOTHING
      // looks like: every relay threw, every page timed out, or no read relay was
      // connected at all. Clearing on that throws the resume cursor away and
      // unfreezes the watermark over wraps we never fetched; the next dispatched
      // message then drags `lastSeenTimestamp` past them, and since every replay
      // path (live REQ `since`, catch-up poll, reconnect backfill) keys off that
      // watermark, the backlog below it is unreachable by all of them. Reload-only
      // recovery — the exact bug this PR exists to kill, reached via the resume
      // path. And it fires hardest on a just-woken device: relays not yet
      // reconnected, sockets erroring, first query slow — the one moment a deep
      // gap is actually open.
      //
      // So: truncation is evidence (gap open). Exhaustion is evidence (gap
      // closed). Everything else is ignorance — leave the state exactly as it was
      // and look again next tick. Absence of a signal is not the signal.
      if(deepestUnclosed !== undefined) {
        this.backfillCursor = deepestUnclosed;
        this.backfillGapOpen = true;
        this.log.warn(
          '[NostrRelayPool] backfill gap still open below', deepestUnclosed,
          '- holding watermark, resuming next tick'
        );
      } else if(pages.some(p => p?.outcome === 'exhausted')) {
        // Positive evidence: a relay walked the range to the bottom. Gap closed.
        this.backfillCursor = undefined;
        this.backfillGapOpen = false;
      } else if(this.backfillGapOpen) {
        this.log.warn(
          '[NostrRelayPool] backfill tick learned nothing (no relay reached the bottom of the range)',
          '- preserving open gap below', this.backfillCursor
        );
      }

      for(const page of pages) {
        if(!page) continue;
        for(const msg of page.messages) {
          this.handleIncomingMessage(msg);
        }
      }

      // The since-walk above can only reach wraps ABOVE the watermark. Anything
      // we released that now sits below it is invisible to that walk by
      // construction, so chase those explicitly by id. Runs every tick, so a
      // failed unwrap recovers within one poll interval — no resume event needed.
      await this.refetchPendingWraps();
    } finally {
      this.backfillPollInFlight = false;
    }
  }

  private recoverFailedRelays(): void {
    // Active relays self-reconnect; benched relays sit on standby with a
    // cooldown. Recovery is simply topping the active set back up to target —
    // superviseConnections() promotes standby relays whose cooldown has expired.
    void this.superviseConnections();
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
      health = {connectedAt: -1, flaps: 0, cooldownUntil: 0, lastState: 'disconnected', failedConnects: 0};
      this.relayHealth.set(url, health);
    }

    const now = Date.now();
    const wasConnected = health.lastState === 'connected';
    health.lastState = state;

    if(state === 'connected') {
      health.connectedAt = now;
      health.failedConnects = 0; // reachable again — clear the failover streak
      return;
    }

    // Failover: a relay entering 'reconnecting' without ever having connected is
    // a failed socket attempt. After RELAY_FAILOVER_THRESHOLD of these in a row,
    // bench this ACTIVE relay and let a standby take its slot — a relay the
    // device simply can't reach shouldn't monopolise one of the few live slots.
    // (A relay that connected then dropped has failedConnects reset to 0 above,
    // so a healthy relay's blip never trips this.)
    if(state === 'reconnecting' && !wasConnected) {
      health.failedConnects = (health.failedConnects || 0) + 1;
      if(this.activeUrls.has(url) && health.failedConnects >= RELAY_FAILOVER_THRESHOLD) {
        health.failedConnects = 0;
        this.log('[NostrRelayPool] relay unreachable — failing over off', url);
        this.benchRelay(url, RELAY_COOLDOWN_BASE_MS);
        return;
      }
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
    this.log(
      '[NostrRelayPool] relay flapping — cooling down', url,
      'for', Math.round(backoff / 1000), 's (flaps:', health.flaps + ')'
    );
    // Bench for the cooldown window: frees the slot for a standby AND stops the
    // instance's own auto-reconnect loop.
    this.benchRelay(url, backoff);
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
    const connected = this.getConnectedCount();
    const total = this.relayEntries.length;
    // Eligible = active (non-benched) relays. A benched relay re-enters the
    // eligible set when the recovery sweep revives it past cooldown, at which
    // point it must connect before all-green can fire again.
    const eligible = this.relayEntries.filter((e) => this.activeUrls.has(e.config.url)).length;
    if(this.onStateChangeCb) {
      this.onStateChangeCb(connected, total, eligible);
    }
    for(const cb of this._stateChangeListeners) {
      try {
        cb(connected, total, eligible);
      } catch(err) {
        this.log.debug('[NostrRelayPool] extra state-change listener threw:', err);
      }
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
