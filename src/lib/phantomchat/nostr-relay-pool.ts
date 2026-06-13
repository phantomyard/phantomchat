/**
 * NostrRelayPool — manages connections to multiple Nostr relays simultaneously.
 *
 * Publishes events to all connected relays, subscribes to events from all
 * relays with automatic deduplication, handles per-relay reconnection,
 * pool-level recovery, and history backfill.
 */

import {Logger, logger} from '@lib/logger';
import {NostrRelay, DecryptedMessage, NostrEvent} from './nostr-relay';
import {wrapNip17Message, wrapNip17Edit} from './nostr-crypto';
import {buildNip65Event} from './nip65';
import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from './key-storage';
import {importFromMnemonic} from './nostr-identity';
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
}

export interface RelayPoolOptions {
  relays?: RelayConfig[];
  onMessage: (msg: DecryptedMessage) => void;
  onStateChange?: (connectedCount: number, totalCount: number) => void;
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

const DEDUP_CACHE_MAX = 10_000;
const POOL_RECOVERY_INTERVAL_MS = 60_000;
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

  // Dedup LRU
  private seenIds: Set<string> = new Set();
  private seenOrder: string[] = [];

  // Pool recovery
  private recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Identity
  private publicKey: string = '';

  // History backfill
  private lastSeenTimestamp: number = 0;

  // Subscription state
  private isSubscribedFlag: boolean = false;

  // Enable/disable per-relay (Phase 3)
  private enabled: Map<string, boolean> = new Map();

  // Tor mode state (Phase 3)
  private torFetchFn?: (url: string) => Promise<string>;
  private inTorMode: boolean = false;

  // Identity key for NIP-65 signing
  private privateKeyBytes: Uint8Array | null = null;

  constructor(options: RelayPoolOptions) {
    this.log = logger('NostrRelayPool');
    this.configs = options.relays ? [...options.relays] : [];
    this.onMessageCb = options.onMessage;
    this.onStateChangeCb = options.onStateChange;
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

    // Load identity from encrypted store (key-storage)
    try {
      const record = await loadEncryptedIdentity();
      if(record) {
        const browserKey = await loadBrowserKey();
        if(browserKey) {
          const {seed} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
          const identity = importFromMnemonic(seed);
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

    // Load relay config from IndexedDB if none provided
    if(this.configs.length === 0) {
      const stored = await this.loadRelayConfig();
      this.configs = stored.length > 0 ? stored : [...DEFAULT_RELAYS];
    }

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

      const wrapped = wrapNip17Message(this.privateKeyBytes, recipientPubkey, plaintext, replyTo);
      wraps = wrapped.wraps as unknown as NostrEvent[];
      rumorId = wrapped.rumorId;
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
    return {successes, failures, rumorId};
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
      wraps = wrapNip17Edit(this.privateKeyBytes, recipientPubkey, originalAppMessageId, newPlaintext) as unknown as NostrEvent[];
    } catch(err) {
      return {
        successes: [],
        failures: [{url: 'wrap', error: err instanceof Error ? err.message : String(err)}]
      };
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

  // ─── Tor Mode (Phase 3) ───────────────────────────────────────

  setTorMode(fetchFn: (url: string) => Promise<string>): void {
    this.inTorMode = true;
    this.torFetchFn = fetchFn;
    for(const entry of this.relayEntries) {
      entry.instance.setTorMode(fetchFn);
    }
  }

  setDirectMode(): void {
    this.inTorMode = false;
    this.torFetchFn = undefined;
    for(const entry of this.relayEntries) {
      entry.instance.setDirectMode();
    }
  }

  /**
   * Clear Tor fetchFn without switching mode.
   * Used when Tor is not ready but we're still in Tor mode.
   */
  clearTorFetchFn(): void {
    this.torFetchFn = undefined;
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

    // Notify pool on relay state change so ConnectionStatusComponent updates
    instance.onStateChange = () => {
      this.notifyStateChange();
    };

    // Notify pool on latency update so UI re-dispatches phantomchat_relay_state
    // for this specific url.
    instance.onLatencyUpdate = () => {
      this.notifyRelayUpdate(config.url);
    };

    return {config, instance};
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

    // Update lastSeenTimestamp
    if(msg.timestamp > this.lastSeenTimestamp) {
      this.lastSeenTimestamp = msg.timestamp;
      localStorage.setItem(LS_LAST_SEEN_KEY, String(this.lastSeenTimestamp));
    }

    // Deliver
    this.onMessageCb(msg);
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

  private async backfill(): Promise<void> {
    const readEntries = this.relayEntries.filter(e => e.config.read);

    const promises = readEntries.map(async(entry) => {
      try {
        const messages = await entry.instance.getMessages(this.lastSeenTimestamp);
        for(const msg of messages) {
          this.handleIncomingMessage(msg);
        }
      } catch(err) {
        this.log.error('[NostrRelayPool] backfill failed for:', entry.config.url, err);
      }
    });

    await Promise.all(promises);
  }

  private startRecovery(): void {
    this.recoveryInterval = setInterval(() => {
      this.recoverFailedRelays();
    }, POOL_RECOVERY_INTERVAL_MS);
  }

  private recoverFailedRelays(): void {
    // Pitfall 6: skip recovery when in Tor mode but Tor not ready
    if(this.inTorMode && !this.torFetchFn) {
      this.log('[NostrRelayPool] pool recovery skipped: Tor mode but no fetchFn available');
      return;
    }

    for(const entry of this.relayEntries) {
      if(entry.instance.getState() === 'disconnected') {
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
  }

  private notifyStateChange(): void {
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
    const entry = this.relayEntries.find(e => e.config.url === url);
    if(!entry) return;
    rootScope.dispatchEvent('phantomchat_relay_state', {
      url: entry.config.url,
      connected: entry.instance.getState() === 'connected',
      latencyMs: entry.instance.getLatency(),
      read: entry.config.read,
      write: entry.config.write
    });
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
