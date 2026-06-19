/*
 * NIP-17 gift-wrap WRAP worker — the outbound counterpart to the unwrap worker.
 *
 * Wrapping a NIP-17 message is the single most expensive thing PhantomChat does
 * on the SEND path: per publish it runs 2× NIP-44 encrypt + 2× Schnorr sign +
 * 2× ECDH (one ephemeral). Run on the main thread, a send freezes the UI for
 * the duration — the user sees nothing happen, clicks again, and duplicates.
 *
 * This worker holds the sender secret key (sent once via {type:'key'}) and
 * answers per-message wrap requests with the signed kind-1059 gift-wrap events.
 * The key never leaves the same-origin worker (the page already holds it).
 */
import {wrapNip17Message, type NTNostrEvent, type UnsignedEvent} from './nostr-crypto';

const ctx = self as any as DedicatedWorkerGlobalScope;

let senderSk: Uint8Array | null = null;

ctx.addEventListener('message', (e: MessageEvent) => {
  const data = e.data;

  if(data?.type === 'key') {
    senderSk = data.sk as Uint8Array;
    return;
  }

  const {id, recipientPubHex, plaintext, replyTo} = data as {
    id: number;
    recipientPubHex: string;
    plaintext: string;
    replyTo?: {eventId: string; relayUrl?: string};
  };

  if(!senderSk) {
    ctx.postMessage({id, error: {message: 'wrap worker: no key set'}});
    return;
  }

  try {
    const result = wrapNip17Message(senderSk, recipientPubHex, plaintext, replyTo);
    ctx.postMessage({
      id,
      wraps: result.wraps,
      rumorId: result.rumorId,
      rumor: result.rumor
    });
  } catch(err) {
    ctx.postMessage({id, error: {message: (err as Error)?.message || String(err)}});
  }
});
