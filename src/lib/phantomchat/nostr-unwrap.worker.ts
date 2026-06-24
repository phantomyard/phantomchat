/*
 * NIP-17 gift-wrap unwrap worker.
 *
 * Unwrapping a gift-wrap is the single most expensive thing PhantomChat does on
 * a hot path: per kind-1059 event it runs 2× secp256k1 Schnorr verify (wrap +
 * seal) and 2× NIP-44 ECDH (wrap→seal, seal→rumor). Run on the page main
 * thread, a backfill burst (cold load) or steady bot traffic saturates the CPU
 * and the UI stops reacting — opening a chat queues behind the crypto (measured
 * 1.3–6.7s vs 12–48ms when the thread is idle).
 *
 * This worker moves that crypto off the main thread. It holds the recipient
 * secret key (sent once at init via {type:'key'}) and answers per-event unwrap
 * requests {id, event} with either {id, rumor} or {id, error:{code?, message}}.
 * The error `code` mirrors GiftWrapVerificationError so the client can rebuild
 * the same error type a synchronous unwrap would have thrown.
 *
 * The key never leaves the same-origin worker (the page already holds it).
 */
import {unwrapNip17Message, unwrapV2, isV2Event, GiftWrapVerificationError, warmSymmetricKeyCache, type NTNostrEvent} from './nostr-crypto';

const ctx = self as any as DedicatedWorkerGlobalScope;

// Recipient secret key. Set via {type:'key'} before any unwrap request — message
// ordering to a single worker is preserved, so the key always lands first.
let recipientSk: Uint8Array | null = null;

// v2 unwrap derives the shared symmetric key from THIS worker's module-level
// cache (it can't derive from the event — the outer envelope is ephemeral). That
// cache starts empty in the worker isolate, so without warming every v2 unwrap
// fails `no_matching_key` and bounces back to the main thread, freezing the UI on
// a cold-load backfill. `{type:'warm', peers}` pre-derives the known-peer keys
// here. v2 unwraps await the in-flight warm so an early backfill burst doesn't
// race ahead of an empty cache.
let warmPromise: Promise<void> = Promise.resolve();

ctx.addEventListener('message', (e: MessageEvent) => {
  const data = e.data;

  if(data?.type === 'key') {
    recipientSk = data.sk as Uint8Array;
    return;
  }

  if(data?.type === 'warm') {
    const peers = data.peers as string[];
    if(recipientSk && Array.isArray(peers) && peers.length) {
      // Chain so concurrent warms serialise; a miss is non-fatal (it just falls
      // back to a one-time main-thread unwrap via the client's self-heal).
      warmPromise = warmPromise.then(() => warmSymmetricKeyCache(recipientSk!, peers)).catch(() => {});
    }
    return;
  }

  const {id, event} = data as {id: number; event: NTNostrEvent};

  if(!recipientSk) {
    ctx.postMessage({id, error: {message: 'unwrap worker: no key set'}});
    return;
  }

  try {
    // Route v2 (AES-256-GCM) vs legacy NIP-17 (NIP-44) based on ['v', 'pc-v2'] tag
    if(isV2Event(event)) {
      // Wait for any in-flight warm so the cache is populated before we scan it.
      warmPromise.then(() => unwrapV2(event, recipientSk!)).then(
        (rumor) => ctx.postMessage({id, rumor}),
        (err) => {
          const code = err instanceof GiftWrapVerificationError ? err.code : undefined;
          ctx.postMessage({id, error: {code, message: (err as Error)?.message || String(err)}});
        }
      );
    } else {
      const rumor = unwrapNip17Message(event, recipientSk);
      ctx.postMessage({id, rumor});
    }
  } catch(err) {
    const code = err instanceof GiftWrapVerificationError ? err.code : undefined;
    ctx.postMessage({id, error: {code, message: (err as Error)?.message || String(err)}});
  }
});
