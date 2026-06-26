/*
 * Main-thread client for the NIP-17 gift-wrap unwrap worker.
 *
 * Singleton: one worker per app (one user, one key) so the worker's NIP-44
 * conversation-key cache is shared across every relay connection in the pool.
 *
 * Hang-proof by design. The worker offload exists purely to keep the UI thread
 * free; correctness must never depend on the worker being alive. So:
 *   - If `Worker` is unavailable (vitest/node/SSR) or spawning throws, every
 *     unwrap runs synchronously on the calling thread via `unwrapNip17Message`.
 *   - If a round-trip exceeds `UNWRAP_TIMEOUT_MS` (wedged/lost worker), that one
 *     event falls back to a synchronous unwrap and a late worker reply is
 *     ignored. `unwrapNip17Message` is a pure function, so re-running it is safe.
 *   - On `worker.onerror`, the worker is dropped and all subsequent (and pending)
 *     unwraps go synchronous.
 *
 * This is the lesson from cryptoMessagePort: an invoke that posts to a port with
 * no listener hangs forever. Here there is always a synchronous floor.
 */
import {unwrapNip17Message, unwrapV2, isV2Event, GiftWrapVerificationError, type NTNostrEvent} from './nostr-crypto';

type Rumor = {kind: number; content: string; pubkey: string; created_at: number; tags: string[][]; id: string};

interface PendingEntry {
  resolve: (rumor: Rumor) => void;
  reject: (err: Error) => void;
  event: NTNostrEvent;
  sk: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

// Generous ceiling: the worker serialises crypto, so a deep backfill drains in
// N×(a few ms). 8s never trips under real load but guarantees no permanent hang
// if the worker dies silently.
const UNWRAP_TIMEOUT_MS = 8000;

// Worker-death recovery. Previously a single `worker.onerror` wedged the client
// in synchronous-fallback mode for the life of the tab — every later unwrap ran
// on the main thread, which is exactly the freeze we're hunting. Instead we let
// the worker be respawned, but bounded: at most MAX_WORKER_RESPAWNS fresh spawns,
// and never within RESPAWN_COOLDOWN_MS of the last crash so a crash-looping
// worker can't thrash the main thread. Past the cap we stay synchronous for good.
const MAX_WORKER_RESPAWNS = 3;
const RESPAWN_COOLDOWN_MS = 30000;

class NostrUnwrapClient {
  private worker: Worker | null = null;
  private workerUsable = false;
  private triedSpawn = false;
  private workerKey: Uint8Array | null = null;
  private seq = 0;
  private lastDegradeAt = 0;
  private degradeCount = 0;
  private readonly pending = new Map<number, PendingEntry>();

  // Dev/prod breadcrumb: which fallback paths actually fire in the wild. Read
  // live via `window.__unwrapStats()`. Cheap counters — no logging on the hot
  // per-message path; only the rare bad paths (degrade, timeout) console.warn.
  readonly stats = {
    syncFallback: 0,   // unwrap ran on the main thread (no usable worker)
    timeout: 0,        // worker round-trip blew past UNWRAP_TIMEOUT_MS
    degrade: 0,        // worker errored and was dropped
    respawn: 0,        // a fresh worker was spawned after a death
    cacheMissBounce: 0 // v2 no_matching_key retried on the main thread
  };

  private sameKey(a: Uint8Array | null, b: Uint8Array | null): boolean {
    if(a === b) return true;
    if(!a || !b || a.length !== b.length) return false;
    for(let i = 0; i < a.length; i++) {
      if(a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Spawn the worker on first use and (re)send the key if the identity changed
   * (logout → login). Never throws — failure just leaves the client in
   * synchronous-fallback mode.
   */
  private ensure(sk: Uint8Array): void {
    if(this.triedSpawn) {
      // Re-key on identity change. Comparing bytes (not a hex string) so the
      // private key is never materialised as an unzeroable JS string.
      if(this.workerUsable && !this.sameKey(this.workerKey, sk)) {
        this.workerKey = sk;
        this.worker!.postMessage({type: 'key', sk});
      }
      return;
    }

    // Respawn path: degrade() cleared triedSpawn after a worker death. Hold off
    // until the cooldown elapses (stay synchronous meanwhile so we don't thrash),
    // and give up spawning entirely once we've burned through the respawn cap.
    if(this.degradeCount > 0) {
      if(this.degradeCount > MAX_WORKER_RESPAWNS) return;
      if(Date.now() - this.lastDegradeAt < RESPAWN_COOLDOWN_MS) return;
      this.stats.respawn++;
    }

    this.triedSpawn = true;

    if(typeof Worker === 'undefined') {
      this.workerUsable = false;
      return;
    }

    try {
      this.worker = new Worker(new URL('./nostr-unwrap.worker.ts', import.meta.url), {type: 'module'});
      this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e);
      this.worker.onerror = () => this.degrade();
      this.worker.postMessage({type: 'key', sk});
      this.workerKey = sk;
      this.workerUsable = true;
    } catch{
      this.workerUsable = false;
      this.worker = null;
    }
  }

  private onWorkerMessage(e: MessageEvent): void {
    const {id, rumor, error} = e.data as {id: number; rumor?: Rumor; error?: {code?: string; message: string}};
    const entry = this.pending.get(id);
    if(!entry) return; // already resolved via timeout fallback — ignore late reply
    if(error) {
      // Bug (worker cache isolation): the unwrap worker runs in a separate
      // Web Worker isolate with its OWN empty `symmetricKeyCache`. The main
      // thread warms the cache (warmSymmetricKeyCache / lazy getSymmetricKey),
      // but only `{type:'key', sk}` is ever posted to the worker — the warmed
      // CryptoKeys never cross the isolate boundary. So for a v2 event the
      // worker iterates an empty cache, fails fast with `no_matching_key`, and
      // would reject here — cancelling the 8s timeout fallback that would
      // otherwise retry synchronously on the main thread (where the cache IS
      // warm) and silently dropping the message.
      //
      // Fix: for a v2 `no_matching_key`, retry synchronously on the main
      // thread (warm cache) before rejecting. Only reject if the main-thread
      // retry also fails.
      if(error.code === 'no_matching_key' && isV2Event(entry.event)) {
        this.stats.cacheMissBounce++;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        unwrapV2(entry.event, entry.sk).then(
          (r) => {
            // Self-heal: the worker missed because its cache lacked this peer
            // (a new conversation, or a warm that hadn't landed yet). Teach it
            // the real sender so the NEXT message from them unwraps in-worker
            // instead of bouncing to the main thread again.
            const pubkey = (r as Rumor)?.pubkey;
            if(pubkey && this.workerUsable && this.worker) {
              this.worker.postMessage({type: 'warm', peers: [pubkey]});
            }
            entry.resolve(r as Rumor);
          },
          (err) => entry.reject(err as Error)
        );
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error.code ?
        new GiftWrapVerificationError(error.code as any, error.message) :
        new Error(error.message));
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(rumor as Rumor);
  }

  // Worker died: stop using it and resolve everything in flight synchronously.
  // Clearing triedSpawn lets ensure() respawn a fresh worker (bounded by
  // MAX_WORKER_RESPAWNS + cooldown) instead of pinning every later unwrap to the
  // main thread for the life of the tab — the permanent-degrade freeze.
  private degrade(): void {
    this.workerUsable = false;
    this.stats.degrade++;
    this.lastDegradeAt = Date.now();
    this.degradeCount++;
    this.triedSpawn = false;
    console.warn('[unwrap] worker degraded → synchronous fallback', {...this.stats});
    try { this.worker?.terminate(); } catch{ /* ignore */ }
    this.worker = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for(const entry of entries) {
      clearTimeout(entry.timer);
      // Route v2 vs legacy in synchronous fallback
      if(isV2Event(entry.event)) {
        unwrapV2(entry.event, entry.sk).then(
          (rumor) => entry.resolve(rumor as Rumor),
          (err) => entry.reject(err as Error)
        );
      } else {
        try {
          entry.resolve(unwrapNip17Message(entry.event, entry.sk));
        } catch(err) {
          entry.reject(err as Error);
        }
      }
    }
  }

  /**
   * Unwrap a kind-1059 gift-wrap, off the main thread when possible.
   * Rejects with GiftWrapVerificationError on a failed security check (same
   * contract as the synchronous `unwrapNip17Message`).
   */
  unwrap(event: NTNostrEvent, sk: Uint8Array): Promise<Rumor> {
    this.ensure(sk);

    if(!this.workerUsable || !this.worker) {
      // Synchronous fallback — route v2 vs legacy
      this.stats.syncFallback++;
      if(isV2Event(event)) {
        return unwrapV2(event, sk) as Promise<Rumor>;
      }
      try {
        return Promise.resolve(unwrapNip17Message(event, sk));
      } catch(err) {
        return Promise.reject(err);
      }
    }

    const id = ++this.seq;
    return new Promise<Rumor>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if(!entry) return;
        this.pending.delete(id);
        this.stats.timeout++;
        console.warn('[unwrap] worker round-trip exceeded timeout → synchronous fallback', {...this.stats});
        // Worker too slow / lost this request — unwrap synchronously now and
        // ignore any late reply for this id.
        if(isV2Event(entry.event)) {
          unwrapV2(entry.event, entry.sk).then(
            (rumor) => entry.resolve(rumor as Rumor),
            (err) => entry.reject(err as Error)
          );
        } else {
          try {
            entry.resolve(unwrapNip17Message(entry.event, entry.sk));
          } catch(err) {
            entry.reject(err as Error);
          }
        }
      }, UNWRAP_TIMEOUT_MS);

      this.pending.set(id, {resolve, reject, event, sk, timer});
      this.worker!.postMessage({id, event});
    });
  }

  /**
   * Pre-warm the worker's symmetric-key cache for known peers so v2 unwraps run
   * IN the worker. Without this, every v2 gift-wrap misses the worker's empty
   * cache, bounces back to a synchronous main-thread unwrapV2, and a cold-load
   * backfill of that crypto freezes the UI for seconds. No-op in sync-fallback
   * mode (no worker) — there the main-thread cache, warmed separately, is the
   * one that matters.
   */
  warm(sk: Uint8Array, peers: string[]): void {
    if(!peers.length) return;
    this.ensure(sk); // spawns + keys the worker if needed (key lands before warm)
    if(this.workerUsable && this.worker) {
      this.worker.postMessage({type: 'warm', peers});
    }
  }

  /** Terminate the worker and clear state (call on logout/lock). */
  dispose(): void {
    try { this.worker?.terminate(); } catch{ /* ignore */ }
    this.worker = null;
    this.workerUsable = false;
    this.triedSpawn = false;
    this.workerKey = null;
    this.lastDegradeAt = 0;
    this.degradeCount = 0;
    for(const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}

let singleton: NostrUnwrapClient | null = null;

export function getNostrUnwrapClient(): NostrUnwrapClient {
  if(!singleton) {
    singleton = new NostrUnwrapClient();
    // Live breadcrumb readable from the prod console during a freeze:
    //   window.__unwrapStats()  →  {syncFallback, timeout, degrade, respawn, cacheMissBounce}
    if(typeof window !== 'undefined') {
      (window as any).__unwrapStats = () => singleton!.stats;
    }
  }
  return singleton;
}

export function disposeNostrUnwrapClient(): void {
  singleton?.dispose();
}

export type {NostrUnwrapClient};
