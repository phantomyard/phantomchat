/*
 * Main-thread client for the NIP-17 gift-wrap WRAP worker.
 *
 * Singleton: one worker per app (one user, one key) so the worker's key is set
 * once and reused for every outbound message.
 *
 * Hang-proof by design — mirrors the unwrap client's contract:
 *   - If `Worker` is unavailable (vitest/node/SSR) or spawning throws, every
 *     wrap runs synchronously on the calling thread via `wrapNip17Message`.
 *   - If a round-trip exceeds `WRAP_TIMEOUT_MS` (wedged/lost worker), that one
 *     wrap falls back to synchronous and a late worker reply is ignored.
 *   - On `worker.onerror`, the worker is dropped and all subsequent (and pending)
 *     wraps go synchronous.
 *
 * `wrapNip17Message` is a pure function, so re-running it is safe.
 */
import {wrapNip17Message, wrapV2, type NTNostrEvent, type UnsignedEvent} from './nostr-crypto';

type WrapResult = {
  wraps: NTNostrEvent[];
  rumorId: string;
  rumor: UnsignedEvent;
};

interface PendingEntry {
  resolve: (result: WrapResult) => void;
  reject: (err: Error) => void;
  sk: Uint8Array;
  recipientPubHex: string;
  plaintext: string;
  replyTo?: {eventId: string; relayUrl?: string};
  timer: ReturnType<typeof setTimeout>;
}

const WRAP_TIMEOUT_MS = 8000;

class NostrWrapClient {
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

  private ensure(sk: Uint8Array): void {
    if(this.triedSpawn) {
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
      this.worker = new Worker(new URL('./nostr-wrap.worker.ts', import.meta.url), {type: 'module'});
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
    const {id, wraps, rumorId, rumor, error} = e.data as {
      id: number;
      wraps?: NTNostrEvent[];
      rumorId?: string;
      rumor?: UnsignedEvent;
      error?: {message: string};
    };
    const entry = this.pending.get(id);
    if(!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if(error) {
      entry.reject(new Error(error.message));
      return;
    }
    entry.resolve({wraps: wraps!, rumorId: rumorId!, rumor: rumor!});
  }

  private degrade(): void {
    this.workerUsable = false;
    try { this.worker?.terminate(); } catch{ /* ignore */ }
    this.worker = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for(const entry of entries) {
      clearTimeout(entry.timer);
      this.wrapSync(entry);
    }
  }

  private wrapSync(entry: PendingEntry): void {
    // Use v2 (AES-256-GCM) with fallback to legacy NIP-17
    wrapV2(entry.sk, entry.recipientPubHex, entry.plaintext, entry.replyTo).then(
      ({event, selfEvent, rumorId, rumor}) => {
        entry.resolve({
          wraps: [event, selfEvent] as unknown as NTNostrEvent[],
          rumorId,
          // Pass the EXACT rumor that was hashed into rumorId through verbatim.
          // Reconstructing it (e.g. with event.created_at) changes the timestamp
          // so getEventHash(rumor) !== rumorId and the receiver rejects retries.
          rumor
        });
      },
      () => {
        // Fallback to legacy NIP-17 if v2 fails
        try {
          const result = wrapNip17Message(entry.sk, entry.recipientPubHex, entry.plaintext, entry.replyTo);
          entry.resolve(result);
        } catch(err) {
          entry.reject(err as Error);
        }
      }
    );
  }

  /**
   * Wrap a NIP-17 message off the main thread when possible.
   * Falls back to synchronous `wrapNip17Message` if the worker is unavailable.
   */
  wrap(
    sk: Uint8Array,
    recipientPubHex: string,
    plaintext: string,
    replyTo?: {eventId: string; relayUrl?: string}
  ): Promise<WrapResult> {
    this.ensure(sk);

    if(!this.workerUsable || !this.worker) {
      // No worker — use v2 directly with legacy fallback
      return wrapV2(sk, recipientPubHex, plaintext, replyTo).then(
        ({event, selfEvent, rumorId, rumor}) => ({
          wraps: [event, selfEvent] as unknown as NTNostrEvent[],
          rumorId,
          // Pass the EXACT rumor that was hashed into rumorId through verbatim,
          // so getEventHash(rumor) === rumorId holds on the receiver's recompute.
          rumor
        }),
        () => {
          // Fallback to legacy NIP-17 if v2 fails
          try {
            return Promise.resolve(wrapNip17Message(sk, recipientPubHex, plaintext, replyTo));
          } catch(err) {
            return Promise.reject(err);
          }
        }
      );
    }

    const id = ++this.seq;
    return new Promise<WrapResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if(!entry) return;
        this.pending.delete(id);
        this.wrapSync(entry);
      }, WRAP_TIMEOUT_MS);

      this.pending.set(id, {resolve, reject, sk, recipientPubHex, plaintext, replyTo, timer});
      this.worker!.postMessage({id, recipientPubHex, plaintext, replyTo});
    });
  }

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

let singleton: NostrWrapClient | null = null;

export function getNostrWrapClient(): NostrWrapClient {
  if(!singleton) {
    singleton = new NostrWrapClient();
  }
  return singleton;
}

export function disposeNostrWrapClient(): void {
  singleton?.dispose();
}

export type {NostrWrapClient, WrapResult};
