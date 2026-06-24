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

class NostrUnwrapClient {
  private worker: Worker | null = null;
  private workerUsable = false;
  private triedSpawn = false;
  private workerKey: Uint8Array | null = null;
  private seq = 0;
  private readonly pending = new Map<number, PendingEntry>();

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
        this.pending.delete(id);
        clearTimeout(entry.timer);
        unwrapV2(entry.event, entry.sk).then(
          (r) => entry.resolve(r as Rumor),
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
  private degrade(): void {
    this.workerUsable = false;
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

  /** Terminate the worker and clear state (call on logout/lock). */
  dispose(): void {
    try { this.worker?.terminate(); } catch{ /* ignore */ }
    this.worker = null;
    this.workerUsable = false;
    this.triedSpawn = false;
    this.workerKey = null;
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
  }
  return singleton;
}

export function disposeNostrUnwrapClient(): void {
  singleton?.dispose();
}

export type {NostrUnwrapClient};
