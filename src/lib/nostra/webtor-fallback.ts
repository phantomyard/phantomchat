/**
 * WebtorClient — webtor-rs WASM wrapper
 *
 * Mirrors the TorWasmClient interface exactly so PrivacyTransport can use
 * either as interchangeable fallback transports.
 *
 * webtor-rs is MIT licensed, built from privacy-ethereum/webtor-rs.
 * API: TorClient.create(options) + bootstrap() + fetch(url)
 *
 * Note: webtor-rs uses 'snowflakeWebRtc()' bridge — browsers can't run
 * Snowflake without a WebRTC proxy. In headless/test envs without network
 * access to Snowflake, bootstrap will fail. This is expected behavior.
 */

import initWebtor, {TorClient, TorClientOptions, setDebugEnabled, setLogCallback} from '/webtor/webtor_wasm';
import {logSwallow} from './log-swallow';
import {
  getCachedConsensus,
  saveCachedConsensus,
  getCachedMicrodescs,
  saveCachedMicrodescs
} from './tor-consensus-cache';

// ---------------------------------------------------------------------------
// Fresh Tor consensus shim
// ---------------------------------------------------------------------------
//
// webtor-rs fetches its cached Tor consensus + microdescriptors from a static
// site (https://privacy-ethereum.github.io/webtor-rs) which is updated rarely.
// A stale consensus has out-of-date relay keys, so circuit construction fails
// at the middle hop with "Circuit-extension handshake authentication failed".
//
// We install a one-time fetch shim that:
//   1. Rewrites the stale github.io URLs to /webtor/* served from public/
//   2. Serves from Cache Storage (tor-consensus-cache) when a recent copy
//      is available so subsequent launches skip the network + parse hot path
//
// The shim is idempotent and only patches in browser contexts.
let _fetchShimInstalled = false;
function installConsensusFetchShim() {
  if(_fetchShimInstalled) return;
  if(typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  _fetchShimInstalled = true;

  const STALE_PREFIX = 'https://privacy-ethereum.github.io/webtor-rs/';
  const LOCAL_PREFIX = '/webtor/';
  const CONSENSUS_KEY = STALE_PREFIX + 'consensus.txt.br';
  const MICRODESCS_KEY = STALE_PREFIX + 'microdescriptors.txt.br';
  // Local copies use a .bin suffix so Vite (and other static hosts) do NOT
  // auto-add Content-Encoding: br, which would make the browser pre-decode
  // the body before the WASM sees it.
  const REWRITE: Record<string, string> = {
    [CONSENSUS_KEY]: LOCAL_PREFIX + 'consensus.br.bin',
    [MICRODESCS_KEY]: LOCAL_PREFIX + 'microdescriptors.br.bin'
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = (async(input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if(typeof input === 'string') url = input;
    else if(input instanceof URL) url = input.toString();
    else url = (input as Request).url;

    const replacement = REWRITE[url];
    if(!replacement) {
      return origFetch(input as any, init);
    }

    // Cache hit? Hand the arti fetch the stored Response directly.
    if(url === CONSENSUS_KEY) {
      const cached = await getCachedConsensus();
      if(cached) {
        console.debug('[WebtorClient] consensus shim: consensus cache hit');
        return cached;
      }
    } else if(url === MICRODESCS_KEY) {
      const cached = await getCachedMicrodescs();
      if(cached) {
        console.debug('[WebtorClient] consensus shim: microdescs cache hit');
        return cached;
      }
    }

    // Cache miss — fetch the fresh local copy and populate the cache.
    console.debug('[WebtorClient] consensus shim: rewriting', url, '→', replacement);
    const resp = await origFetch(replacement, init);
    if(resp.ok) {
      if(url === CONSENSUS_KEY) void saveCachedConsensus(resp);
      else if(url === MICRODESCS_KEY) void saveCachedMicrodescs(resp);
    }
    return resp;
  }) as typeof window.fetch;
}

// ---------------------------------------------------------------------------
// Types matching TorWasmClient interface
// ---------------------------------------------------------------------------

export type TorState = 'idle' | 'bootstrapping' | 'ready' | 'error';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ---------------------------------------------------------------------------
// Circuit status
// ---------------------------------------------------------------------------

interface CircuitStatus {
  healthy: boolean;
  readyCircuits: number;
  totalCircuits: number;
  failedCircuits: number;
  creatingCircuits: number;
}

export interface TorWasmEvents {
  onStateChange?: (state: TorState, error?: string) => void;
  onNostrEvent?: (event: NostrEvent) => void;
  onCircuitChange?: (status: CircuitStatus) => void;
}

export interface TorPrivacyClient {
  init(): Promise<void>;
  bootstrap(timeout_ms?: number): Promise<void>;
  fetch(url: string, options?: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<string>;
  subscribeNostr(relayUrl: string, subscriptionId: string, filters?: Record<string, unknown>): void;
  unsubscribeNostr(subscriptionId: string): void;
  is_ready(): boolean;
  isReady(): boolean;
  getStatus(): TorState;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// WebtorClient
// ---------------------------------------------------------------------------

export class WebtorClient implements TorPrivacyClient {
  private _client: TorClient | null = null;
  private _state: TorState = 'idle';
  private _events: TorWasmEvents;
  private _pollingIntervals: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _activeSubscriptions: Map<string, { lastPolled: number; filters: Record<string, unknown> }> = new Map();
  private _initPromise: Promise<void> | null = null;
  private _bootstrapPromise: Promise<void> | null = null;
  private _moduleReady = false;
  private _pollTimeout = 2000; // ms between Nostr polls (matches TorWasmClient)
  private _circuitDetails: {
    guard: string;
    middle: string;
    exit: string;
    latency: number;
    exitIp: string;
    healthy: boolean;
  } | null = null;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Constructor matches TorWasmClient signature.
   * @param events Callbacks for state, Nostr events, circuit health
   * @param _bridgeUrl Ignored (webtor-rs uses Snowflake WebRTC internally)
   */
  constructor(events: TorWasmEvents = {}, _bridgeUrl: string | null = null) {
    this._events = events;
    // bridgeUrl is ignored — webtor-rs uses snowflakeWebRtc() internally
  }

  /**
   * Initialize webtor-rs WASM module. Safe to call multiple times.
   */
  async init(): Promise<void> {
    if(this._initPromise) return this._initPromise;
    this._initPromise = this._init();
    return this._initPromise;
  }

  private async _init(): Promise<void> {
    installConsensusFetchShim();
    console.debug('[WebtorClient] Initializing webtor-rs WASM module...');
    await initWebtor();
    try {
      if(typeof setDebugEnabled === 'function') setDebugEnabled(true);
      if(typeof setLogCallback === 'function') {
        setLogCallback((level: string, target: string, msg: string) => {
          console.debug(`[webtor-rs:${level}] ${target}: ${msg}`);
        });
      }
    } catch(e) {
      console.warn('[WebtorClient] could not enable debug logging:', e);
    }
    this._moduleReady = true;
    console.debug('[WebtorClient] webtor-rs module ready');
  }

  /**
   * Bootstrap Tor circuit via Snowflake WebRTC.
   * Matches TorWasmClient.bootstrap() signature.
   *
   * @param timeout_ms Bootstrap timeout in milliseconds (default 60s)
   */
  async bootstrap(timeout_ms = 60000): Promise<void> {
    if(this._bootstrapPromise) return this._bootstrapPromise;

    // No-op if already ready
    if(this._state === 'ready' && this._client !== null) {
      console.log('[WebtorClient] already bootstrapped');
      return Promise.resolve();
    }

    this._setState('bootstrapping');

    this._bootstrapPromise = (async() => {
      try {
        await this.init();

        console.debug('[WebtorClient] Creating TorClient via Snowflake WebRTC...');
        this._setState('bootstrapping');

        const options = (TorClientOptions as any).snowflakeWebRtc ?
          (TorClientOptions as any).snowflakeWebRtc()
          .withConnectionTimeout(60_000)
          .withCircuitTimeout(120_000)
          .withCreateCircuitEarly(true) :
          new (TorClientOptions as any)();

        this._client = (TorClient as any).create ?
          await (TorClient as any).create(options) :
          new TorClient(options as any);

        // Wait for first circuit to be ready
        console.debug('[WebtorClient] Waiting for Tor circuit...');
        await this._waitForCircuit(timeout_ms);

        this._setState('ready');
        console.info('[WebtorClient] webtor-rs connected via Tor circuit');

        // Start circuit health polling (for onCircuitChange events)
        await this._startCircuitPolling();
        // Best-effort exit IP probe, bounded so a stuck arti exit doesn't
        // stall bootstrap indefinitely. Real Tor exits can take a few
        // seconds on the first fetch; mocked clients resolve instantly.
        await Promise.race([
          this._fetchExitIp(),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000))
        ]);
      } catch(err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        console.error('[WebtorClient] bootstrap failed:', msg, stack);
        this._setState('error', msg);
        throw err;
      }
    })();

    return this._bootstrapPromise;
  }

  private async _waitForCircuit(timeoutMs: number): Promise<void> {
    if(!this._client) return;

    const deadline = Date.now() + timeoutMs;
    const client: any = this._client;
    let attempt = 0;
    let lastErr: unknown = null;

    // Retry loop: waitForCircuit can fail mid-build (e.g. "Circuit closed"
    // when extending to a hop). When that happens we explicitly trigger a
    // new circuit via updateCircuit() and retry until the deadline.
    while(Date.now() < deadline) {
      attempt++;
      const remaining = deadline - Date.now();
      if(remaining <= 0) break;

      // Check current status — maybe a circuit became ready since last attempt
      try {
        const status = await client.getCircuitStatus();
        if(status?.has_ready_circuits) {
          console.debug('[WebtorClient] Circuit ready:', {
            ready: status.ready ?? status.ready_circuits,
            total: status.total ?? status.total_circuits,
            attempt
          });
          return;
        }
      } catch{
        // status query may fail right after a failed circuit — ignore
      }

      try {
        if(typeof client.waitForCircuit === 'function') {
          const waitPromise = client.waitForCircuit() as Promise<void>;
          const attemptTimeout = Math.min(remaining, 20_000);
          const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`waitForCircuit attempt timed out after ${attemptTimeout}ms`)), attemptTimeout);
          });
          await Promise.race([waitPromise, timeoutPromise]);
          console.debug(`[WebtorClient] Circuit ready (attempt ${attempt})`);
          return;
        } else {
          // No waitForCircuit — fall back to polling getCircuitStatus
          await this._delay(500);
          continue;
        }
      } catch(err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WebtorClient] circuit attempt ${attempt} failed: ${msg}`);

        // Actively trigger a new circuit before retrying
        if(typeof client.updateCircuit === 'function' && Date.now() < deadline) {
          try {
            const updateDeadline = Math.min(60_000, deadline - Date.now());
            console.debug(`[WebtorClient] requesting new circuit (deadline ${updateDeadline}ms)`);
            await client.updateCircuit(updateDeadline);
          } catch(updateErr) {
            const upMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
            console.warn(`[WebtorClient] updateCircuit failed: ${upMsg}`);
          }
        }

        await this._delay(1000);
      }
    }

    const lastErrMsg = lastErr instanceof Error ? lastErr.message : (lastErr ? String(lastErr) : 'unknown');
    throw new Error(`webtor-rs: circuit not ready after ${timeoutMs}ms across ${attempt} attempts (lastErr=${lastErrMsg})`);
  }

  private async _startCircuitPolling(): Promise<void> {
    const poll = async() => {
      if(!this._client) return;
      try {
        const status = await this._client.getCircuitStatus();
        const healthy = (status as any).has_ready_circuits && ((status as any).ready > 0 || (status as any).ready_circuits > 0);

        // JsCircuitStatus does not expose relay fingerprints — fetch them
        // separately via getCircuitRelays(). Tests still inject `status.nodes`
        // for convenience, so we fall back to that shape when present.
        let nodes: string[] = (status as any).nodes || [];
        if(nodes.length === 0 && healthy && typeof (this._client as any).getCircuitRelays === 'function') {
          try {
            const relays = await (this._client as any).getCircuitRelays();
            if(Array.isArray(relays)) {
              nodes = relays.map((r: any) => {
                if(typeof r === 'string') return r;
                return r?.fingerprint ?? r?.rsa_id ?? r?.id ?? r?.nickname ?? '';
              });
            }
          } catch(err) {
            console.debug('[WebtorClient] getCircuitRelays failed:', err);
          }
        }

        this._circuitDetails = {
          guard: nodes[0] || '',
          middle: nodes[1] || '',
          exit: nodes[2] || '',
          latency: this._circuitDetails?.latency ?? -1,
          exitIp: this._circuitDetails?.exitIp ?? '',
          healthy
        };

        this._events.onCircuitChange?.({
          healthy: (status as any).has_ready_circuits,
          readyCircuits: (status as any).ready ?? (status as any).ready_circuits,
          totalCircuits: (status as any).total ?? (status as any).total_circuits,
          failedCircuits: (status as any).failed ?? (status as any).failed_circuits,
          creatingCircuits: (status as any).creating ?? (status as any).creating_circuits
        });
      } catch{
        // Circuit polling errors are non-fatal
      }
    };

    // Await the first poll so callers (and tests) can rely on
    // _circuitDetails being populated when bootstrap() returns.
    await poll();
    this._pollingIntervals.set('circuit', setInterval(poll, 10_000) as any);
  }

  // ---------------------------------------------------------------------------
  // HTTP fetch (matches TorWasmClient interface)
  // ---------------------------------------------------------------------------

  /**
   * Fetch a URL through the Tor circuit.
   *
   * Matches TorWasmClient.fetch(url, options) → string interface.
   *
   * Single attempt — callers (test code, relay polls, etc.) own their retry
   * policy. Wrapping the WASM client in a JS retry+timeout race here saturates
   * the underlying tunnel because abandoned promises don't free the stream
   * inside arti, leaving subsequent fetches to pile up against a wedged client.
   */
  async fetch(url: string, options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  } = {}): Promise<string> {
    if(!this._client || this._state !== 'ready') {
      throw new Error('WebtorClient not ready. Call bootstrap() first.');
    }

    const {method = 'GET', headers, body} = options;
    const client: any = this._client;

    if(method === 'POST' && body !== undefined) {
      const headersJson = JSON.stringify(headers ?? {});
      const r = await client.post(url, new TextEncoder().encode(
        JSON.stringify({headers: headersJson, body})
      ));
      return typeof r.text === 'function' ? r.text() : (typeof r.body_string === 'function' ? r.body_string() : '');
    }

    const r = await client.fetch(url);
    return typeof r.text === 'function' ? r.text() : (typeof r.body_string === 'function' ? r.body_string() : '');
  }

  // ---------------------------------------------------------------------------
  // Nostr subscription (matches TorWasmClient interface)
  // ---------------------------------------------------------------------------

  subscribeNostr(relayUrl: string, subscriptionId: string, filters: Record<string, unknown> = {}): void {
    if(this._state !== 'ready') {
      console.warn('[WebtorClient] not ready for Nostr subscription');
      return;
    }

    // Remove existing subscription if re-subscribing
    this.unsubscribeNostr(subscriptionId);

    const req = {
      subscriptionId,
      filters,
      lastPolled: Math.floor(Date.now() / 1000) - 60
    };
    this._activeSubscriptions.set(subscriptionId, req);

    const poll = async() => {
      if(this._state !== 'ready') return;

      try {
        const since = req.lastPolled;
        const params = new URLSearchParams();
        if(filters['authors']) params.set('authors', filters['authors'] as string);
        if(filters['kinds']) params.set('kinds', String(filters['kinds']));
        params.set('since', String(since));

        const url = `${relayUrl}/?${params.toString()}`;
        const body = await this.fetch(url);

        let events: NostrEvent[] = [];
        try {
          events = JSON.parse(body);
        } catch{
          // Empty or invalid response — ignore
        }

        if(Array.isArray(events) && events.length > 0) {
          const maxCreated = Math.max(...events.map(e => e.created_at ?? 0));
          req.lastPolled = maxCreated + 1;

          for(const event of events) {
            this._events.onNostrEvent?.(event);
          }
          console.debug(`[WebtorClient] Nostr: ${events.length} new events from ${relayUrl}`);
        }
      } catch(err) {
        console.warn(`[WebtorClient] Nostr poll error for ${subscriptionId}:`, err);
      }

      // Schedule next poll
      const intervalId = setTimeout(poll, this._pollTimeout);
      this._pollingIntervals.set(subscriptionId, intervalId);
    };

    // Start polling immediately
    const intervalId = setTimeout(poll, 100);
    this._pollingIntervals.set(subscriptionId, intervalId);
    console.debug(`[WebtorClient] Nostr subscription started: ${subscriptionId} → ${relayUrl}`);
  }

  unsubscribeNostr(subscriptionId: string): void {
    const intervalId = this._pollingIntervals.get(subscriptionId);
    if(intervalId !== undefined) {
      clearTimeout(intervalId);
      this._pollingIntervals.delete(subscriptionId);
    }
    this._activeSubscriptions.delete(subscriptionId);
    console.debug(`[WebtorClient] Nostr subscription stopped: ${subscriptionId}`);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  is_ready(): boolean {
    return this._state === 'ready' && this._client !== null;
  }

  // Alias (PrivacyTransport uses isReady() in some paths)
  isReady(): boolean {
    return this.is_ready();
  }

  getStatus(): TorState {
    return this._state;
  }

  public getCircuitDetails() {
    return this._circuitDetails;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    // Clear all polling intervals
    for(const intervalId of this._pollingIntervals.values()) {
      clearTimeout(intervalId);
    }
    this._pollingIntervals.clear();
    this._activeSubscriptions.clear();

    if(this._client) {
      const client: any = this._client;
      // Abort any in-flight operations before close so close() can't hang on
      // a stuck circuit/fetch.
      try { if(typeof client.abort === 'function') client.abort(); } catch(e) { logSwallow('WebtorFallback.abort', e); }
      try {
        await Promise.race([
          client.close(),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
      } catch{
        // Ignore close errors
      }
      this._client = null;
    }

    this._state = 'idle';
    this._setState('idle');
    this._bootstrapPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _fetchExitIp() {
    // Best-effort only. Plain HTTP because arti's TLS stack frequently
    // fails handshake negotiation against modern HTTPS endpoints.
    try {
      const body = await this.fetch('http://icanhazip.com/');
      const m = body.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
      if(m && this._circuitDetails) {
        this._circuitDetails.exitIp = m[0];
      }
    } catch(_e) {
      // Best-effort — never throw
    }
  }

  private _setState(state: TorState, error?: string): void {
    this._state = state;
    this._events.onStateChange?.(state, error);
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
