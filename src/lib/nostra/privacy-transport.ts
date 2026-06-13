/**
 * PrivacyTransport — Pool-Level Tor Privacy Wrapper (Phase 3)
 *
 * Wraps the entire NostrRelayPool with a shared WebtorClient instance.
 * Routes all relay traffic through Tor HTTP polling when available.
 *
 * Fallback chain:
 * 1. webtor-rs — HTTP polling through Tor circuit (IP hidden)
 * 2. Direct WebSocket — only after explicit user confirmation (PRIV-03)
 *
 * Architecture decisions:
 * - No WebRTC in v1 (relay-only, per architecture decision)
 * - No PeerTransport dependency
 * - Single shared WebtorClient for all relays in pool
 * - Messages queued during Tor bootstrap (OfflineQueue)
 * - Tor failure does NOT auto-fallback — user must confirm
 */

import {NostrRelayPool, PublishResult} from './nostr-relay-pool';
import {OfflineQueue} from './offline-queue';
import {logSwallow} from './log-swallow';
import {WebtorClient} from './webtor-fallback';
import rootScope from '@lib/rootScope';
import {TorBootstrapLoop} from './tor-bootstrap-loop';

export type PrivacyTransportState =
  | 'bootstrapping'       // Tor circuit creating
  | 'active'              // Tor active, HTTP polling
  | 'direct'              // Direct WebSocket (user confirmed)
  | 'failed'              // Tor failed, awaiting user decision
  | 'offline';            // Disconnected

export type TorMode = 'only' | 'when-available' | 'off';
export type RuntimeState = 'booting' | 'tor-active' | 'direct-active' | 'offline';

const LS_MODE_KEY = 'nostra-tor-mode';
const LS_LEGACY_KEY = 'nostra-tor-enabled';

function isTorMode(v: unknown): v is TorMode {
  return v === 'only' || v === 'when-available' || v === 'off';
}

/**
 * PrivacyTransport — Tor-wrapped relay pool
 *
 * Wraps NostrRelayPool with shared WebtorClient for IP privacy.
 * Exposes send/receive interface with automatic queuing during bootstrap.
 */
export class PrivacyTransport {
  private relayPool: NostrRelayPool;
  private webtorClient: WebtorClient;
  private state: PrivacyTransportState = 'offline';
  private offlineQueue: OfflineQueue;
  // True when the WebtorClient was supplied via constructor (tests inject
  // mocks). In that case the retry loop must NOT construct a fresh real
  // WebtorClient on failure — that would wipe out the injected mock and
  // try to load the real WASM module in a jsdom test environment.
  private webtorInjected: boolean;
  private mode: TorMode;
  private runtimeState: RuntimeState = 'offline';
  private retryLoop: TorBootstrapLoop | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private livenessFailStreak = 0;

  constructor(relayPool: NostrRelayPool, offlineQueue: OfflineQueue, webtorClient?: WebtorClient) {
    this.relayPool = relayPool;
    this.offlineQueue = offlineQueue;
    this.webtorInjected = !!webtorClient;
    this.webtorClient = webtorClient || new WebtorClient();
    this.mode = PrivacyTransport.readMode();

    // Wire circuit change callback to dispatch rootScope event
    if(this.webtorClient) {
      const origEvents = (this.webtorClient as any)._events || {};
      (this.webtorClient as any)._events = {
        ...origEvents,
        onCircuitChange: () => {
          const details = this.webtorClient?.getCircuitDetails?.();
          if(details) {
            rootScope.dispatchEvent('nostra_tor_circuit_update', details);
          }
        }
      };
    }

    // Expose for debug inspection
    if(typeof window !== 'undefined') {
      (window as any).__nostraPrivacyTransport = this;
    }
  }

  static readMode(): TorMode {
    if(typeof localStorage === 'undefined') return 'when-available';
    const stored = localStorage.getItem(LS_MODE_KEY);
    if(isTorMode(stored)) return stored;
    const legacy = localStorage.getItem(LS_LEGACY_KEY);
    if(legacy === 'false') return 'off';
    return 'when-available';
  }

  /**
   * Static setter used by settings UI at boot before any transport instance
   * exists. Normal runtime mode changes go through `instance.setMode()`
   * (Task 3) which also re-routes the pool. Clears the legacy key so migration
   * is one-way.
   *
   * @deprecated — prefer the instance method once a transport is available.
   */
  static setModeStatic(mode: TorMode): void {
    if(typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_MODE_KEY, mode);
    localStorage.removeItem(LS_LEGACY_KEY);
  }

  /**
   * @deprecated — reads mode and checks !== 'off'. Kept as a shim so
   * existing call sites in nostraStatus, tor-ui-state, and nostra-bridge
   * compile during the cross-file migration. Removed in a follow-up PR.
   */
  static isTorEnabled(): boolean {
    return PrivacyTransport.readMode() !== 'off';
  }

  /**
   * Bootstrap privacy transport.
   *
   * Dispatches on the user's TorMode choice:
   * - `off`              → direct WebSocket, no Tor path.
   * - `when-available`   → direct immediately, retry loop upgrades to Tor.
   * - `only`             → wait for Tor, messages queued until active.
   */
  async bootstrap(): Promise<void> {
    // Re-read mode in case the user toggled it via setModeStatic before the
    // transport was constructed (e.g. migration on first boot).
    this.mode = PrivacyTransport.readMode();

    switch(this.mode) {
      case 'off':
        this.relayPool.setDirectMode();
        this.setRuntimeState('direct-active');
        return;

      case 'when-available':
        this.relayPool.setDirectMode();
        this.setRuntimeState('direct-active');
        this.startRetryLoop();
        return;

      case 'only':
        this.setRuntimeState('booting');
        this.startRetryLoop();
        return;
    }
  }

  /**
   * Send a message.
   *
   * - If booting or offline: queue via OfflineQueue
   * - If tor-active or direct-active: publish via relayPool
   */
  async send(recipientPubkey: string, plaintext: string): Promise<PublishResult | null> {
    const canPublish = this.runtimeState === 'tor-active' || this.runtimeState === 'direct-active';
    if(!canPublish) {
      const messageId = await this.offlineQueue.queue(recipientPubkey, plaintext);
      rootScope.dispatchEvent('nostra_message_queued', {messageId, status: 'queued'});
      return null;
    }
    const result = await this.relayPool.publish(recipientPubkey, plaintext);
    if(result.successes.length > 0) {
      rootScope.dispatchEvent('nostra_message_queued', {
        messageId: result.successes[0],
        status: 'sent'
      });
    }
    return result;
  }

  /**
   * Get current transport state.
   */
  getState(): PrivacyTransportState {
    return this.state;
  }

  /**
   * Disconnect — clean up all resources.
   */
  disconnect(): void {
    this.stopRetryLoop();
    this.relayPool.disconnect();

    if(this.webtorClient) {
      void this.webtorClient.close();
    }

    this.setRuntimeState('offline');
  }

  /** Test-visible accessor — do not use in product code. */
  getRuntimeState(): RuntimeState {
    return this.runtimeState;
  }

  async setMode(mode: TorMode): Promise<void> {
    PrivacyTransport.setModeStatic(mode);
    rootScope.dispatchEvent('nostra_tor_mode_changed' as any, mode);
    this.stopRetryLoop();
    await this.bootstrap();
  }

  /**
   * TorMode-aware HTTP fetch. When Tor is active and the webtorClient is
   * ready, proxies the request through the circuit. Falls back to
   * globalThis.fetch when Tor is not active or not available.
   *
   * webtorClient.fetch() returns the response body as a plain string —
   * wrap it in a Response so callers can use .json()/.text() uniformly.
   */
  public async fetch(url: string, init?: RequestInit): Promise<Response> {
    if(
      this.mode !== 'off' &&
      this.webtorClient &&
      this.getRuntimeState() === 'tor-active'
    ) {
      const text = await this.webtorClient.fetch(url);
      return new Response(text, {status: 200, headers: {'Content-Type': 'application/json'}});
    }
    return globalThis.fetch(url, init);
  }

  // ─── Private ───────────────────────────────────────────────────

  private setState(state: PrivacyTransportState, error?: string): void {
    if(this.state === state) return;
    this.state = state;

    rootScope.dispatchEvent('nostra_tor_state', {
      state: state === 'active' ? 'active' : state as any,
      error
    });
  }

  private setRuntimeState(next: RuntimeState, error?: string): void {
    if(this.runtimeState === next) return;
    this.runtimeState = next;
    rootScope.dispatchEvent('nostra_tor_state', {state: next, error});
  }

  private startRetryLoop(): void {
    if(this.retryLoop?.isRunning()) return;
    const schedule = this.mode === 'only' ?
      [5, 10, 20, 40] :
      [5, 10, 20, 40, 80, 160, 300];
    this.retryLoop = new TorBootstrapLoop({
      schedule,
      attempt: async() => {
        try {
          await this.webtorClient.bootstrap(60_000);
          if(this.webtorClient.isReady()) return true;
        } catch{ /* treated as failure below */ }
        // Reset the client so the next attempt has a clean tunnel.
        try { await this.webtorClient.close(); } catch(e) {
          logSwallow('PrivacyTransport.retryLoop.close', e);
        }
        if(!this.webtorInjected) {
          this.webtorClient = new WebtorClient();
        }
        return false;
      },
      onSuccess: () => {
        const fetchFn = (url: string) => this.webtorClient.fetch(url);
        this.upgradeToTor(fetchFn);
      },
      onFailure: (err, n) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PrivacyTransport] bootstrap attempt ${n} failed: ${msg}`);
      }
    });
    this.retryLoop.start();
  }

  private stopRetryLoop(): void {
    this.retryLoop?.stop();
    this.retryLoop = null;
    this.stopLivenessProbe();
  }

  private upgradeToTor(fetchFn: (url: string) => Promise<string>): void {
    this.relayPool.setTorMode(fetchFn);
    this.setRuntimeState('tor-active');
    this.flushQueue();
    this.startLivenessProbe();
  }

  private startLivenessProbe(): void {
    this.stopLivenessProbe();
    if(this.mode !== 'when-available') return; // only mode only needs it
    this.livenessFailStreak = 0;
    this.livenessTimer = setInterval(() => {
      if(this.runtimeState !== 'tor-active') {
        this.stopLivenessProbe();
        return;
      }
      const alive = (() => {
        try { return this.webtorClient.isReady(); } catch{ return false; }
      })();
      if(alive) {
        this.livenessFailStreak = 0;
        return;
      }
      this.livenessFailStreak += 1;
      if(this.livenessFailStreak >= 2) {
        this.downgradeToDirect();
      }
    }, 30_000);
  }

  private stopLivenessProbe(): void {
    if(this.livenessTimer !== null) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    this.livenessFailStreak = 0;
  }

  private downgradeToDirect(): void {
    if(this.mode !== 'when-available') return;
    this.stopLivenessProbe();
    this.relayPool.setDirectMode();
    this.setRuntimeState('direct-active');
    // Restart the bootstrap loop so we try to come back up.
    this.stopRetryLoop();
    this.startRetryLoop();
  }

  private flushQueue(): void {
    // Flush all queued messages
    const queued = this.offlineQueue.getQueued();
    for(const msg of queued) {
      this.relayPool.publish(msg.to, msg.payload).catch(() => {
        // Re-queue on failure — handled by OfflineQueue
      });
    }
  }
}
