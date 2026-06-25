/*
 * PhantomChat Protocol v2 wrap worker — the outbound counterpart to the unwrap worker.
 *
 * Uses AES-256-GCM (symmetric) instead of NIP-44 (asymmetric) for wrapping.
 * Per-message cost: 1× AES-GCM encrypt + 1× Schnorr sign ≈ 1ms
 * vs legacy NIP-17: 2× ECDH + 2× NIP-44 encrypt + 2× Schnorr sign ≈ 12ms.
 *
 * Falls back to legacy NIP-17 wrap if v2 fails (backward compat).
 * The key never leaves the same-origin worker (the page already holds it).
 */
import {wrapNip17Message, wrapV2, type NTNostrEvent, type UnsignedEvent} from './nostr-crypto';

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

  // PhantomChat v2: use AES-256-GCM (fast, no ephemeral key)
  wrapV2(senderSk, recipientPubHex, plaintext, replyTo).then(
    ({event, rumorId, senderPubkey}) => {
      ctx.postMessage({
        id,
        wraps: [event],
        rumorId,
        rumor: {
          kind: 14,
          content: plaintext,
          // Use the REAL sender pubkey, NOT event.pubkey (which is the
          // throwaway ephemeral signing key). The delivery-retry layer
          // rewraps this rumor; the receiver binds rumor.pubkey to the
          // expected counterparty, so an ephemeral pubkey would be rejected.
          pubkey: senderPubkey,
          created_at: event.created_at,
          tags: event.tags,
          id: rumorId
        } as UnsignedEvent
      });
    },
    (err) => {
      // Fallback: try legacy NIP-17 wrap if v2 fails
      try {
        const result = wrapNip17Message(senderSk!, recipientPubHex, plaintext, replyTo);
        ctx.postMessage({
          id,
          wraps: result.wraps,
          rumorId: result.rumorId,
          rumor: result.rumor
        });
      } catch(fallbackErr) {
        ctx.postMessage({id, error: {message: (fallbackErr as Error)?.message || String(fallbackErr)}});
      }
    }
  );
});
