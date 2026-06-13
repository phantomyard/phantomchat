import * as nip44 from 'nostr-tools/nip44';
import {generateSecretKey, getPublicKey, finalizeEvent, getEventHash, verifyEvent} from 'nostr-tools/pure';
// nip17.unwrapEvent and nip17.wrapManyEvents are intentionally not imported:
// we do a manual verifying unwrap (see `unwrapNip17Message`) and wrap with
// the lower-level nip59 API to control p-tag routing.
import {createRumor as createNip59Rumor, createSeal as createNip59Seal, createWrap as createNip59Wrap} from 'nostr-tools/nip59';
// nostr-tools NostrEvent shape used by nip17/nip59 functions
export type NTNostrEvent = {kind: number; content: string; pubkey: string; created_at: number; tags: string[][]; id: string; sig: string};

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
  id: string;
}

export interface SignedEvent extends UnsignedEvent {
  sig: string;
}

/**
 * In-memory conversation key cache.
 *
 * Two layers to avoid leaking the raw private-key hex into a Map key string
 * (JS strings are immutable and unzeroable — any cache key containing the
 * privhex keeps the secret alive for the Map's lifetime):
 *
 *   outer: WeakMap<senderPriv Uint8Array, innerMap>
 *   inner: Map<recipientPubHex, conversationKey>
 *
 * The outer WeakMap is keyed by object identity of the sender's secret-key
 * buffer, so the hex is never materialized. When callers drop their
 * reference to the buffer (e.g. `privateKeyBytes = null` on logout), the
 * WeakMap entry becomes eligible for GC automatically.
 */
const conversationKeyCache: WeakMap<Uint8Array, Map<string, Uint8Array>> = new WeakMap();

// Strong-ref counterpart used ONLY for `clearConversationKeyCache()` to walk
// every inner map. WeakMap has no iteration API, and on logout we want a
// best-effort wipe of the derived keys regardless of whether the outer
// Uint8Array is still reachable. We hold Uint8Arrays here so the entries are
// released when the caller also releases their reference, except during the
// brief window between logout and GC — which is acceptable.
const clearRegistry: Set<Map<string, Uint8Array>> = new Set();

/**
 * Clear the conversation key cache (call on logout/lock).
 * Wipes every cached conversation key for every sender.
 */
export function clearConversationKeyCache(): void {
  for(const inner of clearRegistry) {
    // Zero each derived key in place before dropping the Map — these keys
    // are 32 bytes of NIP-44 ECDH secret.
    for(const v of inner.values()) {
      try { v.fill(0); } catch{ /* not a writable view — ignore */ }
    }
    inner.clear();
  }
  clearRegistry.clear();
}

/**
 * Get or compute a NIP-44 conversation key for a sender/recipient pair.
 * Cached per-sender by object identity, per-recipient by hex pubkey.
 */
export function getConversationKey(senderPriv: Uint8Array, recipientPubHex: string): Uint8Array {
  let inner = conversationKeyCache.get(senderPriv);
  if(!inner) {
    inner = new Map<string, Uint8Array>();
    conversationKeyCache.set(senderPriv, inner);
  }
  // Ensure this inner map is tracked for wipe-on-logout. It's idempotent to
  // re-add (Set dedups) and guarantees that a post-`clear()` re-use still
  // registers the map so the next clear() wipes it too.
  clearRegistry.add(inner);
  const cached = inner.get(recipientPubHex);
  if(cached) {
    return cached;
  }
  const convKey = nip44.v2.utils.getConversationKey(senderPriv, recipientPubHex);
  inner.set(recipientPubHex, convKey);
  return convKey;
}

/**
 * Encrypt plaintext using NIP-44 v2.
 */
export function nip44Encrypt(plaintext: string, conversationKey: Uint8Array): string {
  return nip44.v2.encrypt(plaintext, conversationKey);
}

/**
 * Decrypt ciphertext using NIP-44 v2.
 */
export function nip44Decrypt(ciphertext: string, conversationKey: Uint8Array): string {
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

// ==================== NIP-17 Gift-Wrap API (nostr-tools/nip17) ====================

/**
 * Wrap a text message as NIP-17 gift-wrap events for recipient AND sender (self-send).
 * Returns the kind 1059 events and the canonical rumor id.
 *
 * The rumor id is the SHA-256 hash of the canonical rumor (kind 14, unsigned)
 * as defined by NIP-01. It is the SAME on sender and receiver after unwrap,
 * which is why it is the authoritative key for kind-7 reactions, kind-5
 * deletions, and kind-25 receipts — all of which must carry a 64-hex `e` tag.
 *
 * Bug #3 (FIND-4e18d35d): the sender used to save its own-message rows keyed
 * by the app-level message id (chat-XXX-N), which diverged from the receiver
 * side keyed by rumor id. That broke reaction delivery because the sender-side
 * e-tag was not 64 hex and strfry rejected it (NIP-01 fixed-size rule). Callers
 * on the sender side must now save their row with `eventId = rumorId` so both
 * ends converge on the same identity.
 *
 * Uses manual rumor → seal → gift-wrap pipeline instead of nostr-tools/nip17
 * `wrapManyEvents` because that function generates incorrect `#p` tags
 * (uses random pubkeys instead of the recipient's pubkey), preventing relay
 * routing and message delivery.
 *
 * @param senderSk - Sender's secret key (Uint8Array)
 * @param recipientPubHex - Recipient's hex public key
 * @param content - Message text content
 * @param replyTo - Optional reply reference {eventId, relayUrl?}
 * @returns `{wraps, rumorId}` — two kind 1059 events (recipient + self) and the 64-hex rumor id
 */
export function wrapNip17Message(
  senderSk: Uint8Array,
  recipientPubHex: string,
  content: string,
  replyTo?: {eventId: string; relayUrl?: string}
): {wraps: NTNostrEvent[]; rumorId: string} {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [['p', recipientPubHex]];
  if(replyTo) {
    tags.push(['e', replyTo.eventId, replyTo.relayUrl || '', 'reply']);
  }

  // Create rumor (kind 14, unsigned). `createRumor` populates `.id` via
  // `getEventHash` — we propagate that id to callers so sender-side stores
  // can key by the SAME id the receiver will see after unwrap.
  const rumor = createRumor(content, senderSk, tags);

  // Create seal + gift-wrap for recipient
  const recipientSeal = createSeal(rumor, senderSk, recipientPubHex);
  const recipientWrap = createGiftWrap(recipientSeal, recipientPubHex);

  // Create seal + gift-wrap for self (multi-device recovery)
  const selfSeal = createSeal(rumor, senderSk, senderPubHex);
  const selfWrap = createGiftWrap(selfSeal, senderPubHex);

  return {
    wraps: [recipientWrap, selfWrap] as unknown as NTNostrEvent[],
    rumorId: rumor.id
  };
}

/**
 * Error thrown by `unwrapNip17Message` when a verification step fails.
 * Callers can distinguish verification drops from transport/parse errors.
 */
export class GiftWrapVerificationError extends Error {
  readonly code: 'wrap_sig' | 'seal_sig' | 'pubkey_binding' | 'rumor_id';
  constructor(code: 'wrap_sig' | 'seal_sig' | 'pubkey_binding' | 'rumor_id', message: string) {
    super(message);
    this.name = 'GiftWrapVerificationError';
    this.code = code;
  }
}

/**
 * Unwrap a kind 1059 gift-wrap event to recover the rumor.
 *
 * Security checks (each failure throws `GiftWrapVerificationError`):
 *   a. `verifyEvent(wrap)` — wrap Schnorr signature valid.
 *   b. NIP-44 decrypt wrap with recipient key to get seal (kind 13).
 *   c. `verifyEvent(seal)` — seal Schnorr signature valid.
 *   d. NIP-44 decrypt seal with recipient key + seal.pubkey to get rumor.
 *   e. `rumor.pubkey === seal.pubkey` — prevents a malicious sender from
 *      sealing a rumor with `pubkey = victim` under their own signing key
 *      (nostr-tools/nip17 + nip59 do NOT enforce this binding).
 *   f. `getEventHash(rumor) === rumor.id` — rumor id matches its canonical
 *      hash (prevents replaying or tampering with the id field).
 *
 * @param event - Kind 1059 gift-wrap event
 * @param recipientSk - Recipient's secret key (Uint8Array)
 * @returns The unwrapped rumor {kind, content, pubkey, created_at, tags, id}
 */
export function unwrapNip17Message(
  event: NTNostrEvent,
  recipientSk: Uint8Array
): {kind: number; content: string; pubkey: string; created_at: number; tags: string[][]; id: string} {
  // (a) Verify wrap signature — drops forged events from hostile relays.
  if(!verifyEvent(event as any)) {
    throw new GiftWrapVerificationError('wrap_sig', 'gift-wrap signature invalid');
  }

  // (b) Decrypt wrap → seal
  const wrapConvKey = getConversationKey(recipientSk, event.pubkey);
  const sealJson = nip44Decrypt(event.content, wrapConvKey);
  const seal = JSON.parse(sealJson) as SignedEvent;

  // (c) Verify seal signature
  if(!verifyEvent(seal as any)) {
    throw new GiftWrapVerificationError('seal_sig', 'seal signature invalid');
  }

  // (d) Decrypt seal → rumor (using the seal.pubkey as the DH counterpart)
  const sealConvKey = getConversationKey(recipientSk, seal.pubkey);
  const rumorJson = nip44Decrypt(seal.content, sealConvKey);
  const rumor = JSON.parse(rumorJson) as UnsignedEvent;

  // (e) Bind rumor.pubkey to seal.pubkey — anti-impersonation.
  if(rumor.pubkey !== seal.pubkey) {
    throw new GiftWrapVerificationError(
      'pubkey_binding',
      `rumor.pubkey (${rumor.pubkey.slice(0, 8)}...) does not match seal.pubkey (${seal.pubkey.slice(0, 8)}...)`
    );
  }

  // (f) Verify rumor.id matches its canonical hash (no sig — rumors are unsigned).
  const expectedId = getEventHash(rumor as any);
  if(rumor.id !== expectedId) {
    throw new GiftWrapVerificationError('rumor_id', 'rumor id does not match canonical hash');
  }

  return rumor as {kind: number; content: string; pubkey: string; created_at: number; tags: string[][]; id: string};
}

/**
 * Wrap an edit message as NIP-17 gift-wraps (one for recipient, one for self).
 *
 * The rumor carries a marker tag `['nostra-edit', <originalAppMessageId>]` that
 * receivers detect to update the existing message instead of inserting a new one.
 *
 * The original ID is the application-level message ID (chat-XXX-N), not the
 * Nostr rumor hex — keeps lookup symmetric between sender and receiver stores.
 *
 * @param senderSk - Sender's secret key (Uint8Array)
 * @param recipientPubHex - Recipient's hex public key
 * @param originalAppMessageId - App-level ID of the original message (chat-XXX-N)
 * @param newPlaintext - New message content (full JSON envelope, same shape as a fresh send)
 * @returns Array of two kind 1059 events: [recipientWrap, selfWrap]
 */
export function wrapNip17Edit(
  senderSk: Uint8Array,
  recipientPubHex: string,
  originalAppMessageId: string,
  newPlaintext: string
): NTNostrEvent[] {
  const senderPubHex = getPublicKey(senderSk);
  const rumorEvent = createNip59Rumor({
    kind: 14,
    content: newPlaintext,
    tags: [
      ['p', recipientPubHex],
      ['nostra-edit', originalAppMessageId]
    ]
  }, senderSk);

  const recipientSeal = createNip59Seal(rumorEvent, senderSk, recipientPubHex);
  const recipientWrap = createNip59Wrap(recipientSeal, recipientPubHex);

  const selfSeal = createNip59Seal(rumorEvent, senderSk, senderPubHex);
  const selfWrap = createNip59Wrap(selfSeal, senderPubHex);

  return [recipientWrap, selfWrap] as unknown as NTNostrEvent[];
}

/**
 * Wrap a delivery/read receipt as NIP-17 gift-wrap for the recipient only (no self-send).
 *
 * Creates a kind 14 rumor with empty content, receipt-type tag, and 'e' tag
 * referencing the original event. Wrapped as a single gift-wrap for the recipient.
 *
 * @param senderSk - Sender's secret key (Uint8Array)
 * @param recipientPubHex - Recipient's hex public key
 * @param originalEventId - Event ID of the message being receipted
 * @param receiptType - 'delivery' or 'read'
 * @returns Array with single kind 1059 event
 */
export function wrapNip17Receipt(
  senderSk: Uint8Array,
  recipientPubHex: string,
  originalEventId: string,
  receiptType: 'delivery' | 'read'
): NTNostrEvent[] {
  // Use nip59 lower-level API for custom rumor tags (nip17 wrapEvent
  // doesn't support arbitrary rumor tags)
  const rumorEvent = createNip59Rumor({
    kind: 14,
    content: '',
    tags: [
      ['e', originalEventId],
      ['receipt-type', receiptType],
      ['p', recipientPubHex]
    ]
  }, senderSk);

  const seal = createNip59Seal(rumorEvent, senderSk, recipientPubHex);
  const giftWrap = createNip59Wrap(seal, recipientPubHex);

  return [giftWrap];
}

// ==================== Legacy NIP-17 API (deprecated) ====================

/**
 * @deprecated Use `wrapNip17Message` instead. Will be removed in a future version.
 *
 * Create an unsigned rumor event (NIP-17 kind 14).
 * The rumor is NOT signed — it has an id but no sig.
 */
export function createRumor(
  content: string,
  senderSk: Uint8Array,
  tags?: string[][]
): UnsignedEvent {
  const pubkey = getPublicKey(senderSk);
  const event = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: tags || [],
    content,
    pubkey
  };
  const id = getEventHash(event);
  return {...event, id};
}

/**
 * @deprecated Use `wrapNip17Message` instead. Will be removed in a future version.
 *
 * Create a sealed event (NIP-17 kind 13).
 * Encrypts the rumor JSON with NIP-44, signs with sender's key.
 * Uses randomized created_at within past 48 hours for metadata protection.
 */
export function createSeal(
  rumor: UnsignedEvent,
  senderSk: Uint8Array,
  recipientPk: string
): SignedEvent {
  const convKey = getConversationKey(senderSk, recipientPk);
  const encryptedContent = nip44Encrypt(JSON.stringify(rumor), convKey);

  const randomOffset = Math.floor(Math.random() * 48 * 60 * 60);
  const created_at = Math.floor(Date.now() / 1000) - randomOffset;

  const sealTemplate = {
    kind: 13,
    created_at,
    tags: [] as string[][],
    content: encryptedContent
  };

  return finalizeEvent(sealTemplate, senderSk) as unknown as SignedEvent;
}

/**
 * @deprecated Use `wrapNip17Message` instead. Will be removed in a future version.
 *
 * Create a gift-wrapped event (NIP-17 kind 1059).
 * Uses an ephemeral key to wrap the seal, tagged with recipient pubkey.
 * Uses randomized created_at for metadata protection.
 */
export function createGiftWrap(
  seal: SignedEvent,
  recipientPk: string
): SignedEvent {
  const ephemeralSk = generateSecretKey();
  const convKey = getConversationKey(ephemeralSk, recipientPk);
  const encryptedContent = nip44Encrypt(JSON.stringify(seal), convKey);

  const randomOffset = Math.floor(Math.random() * 48 * 60 * 60);
  const created_at = Math.floor(Date.now() / 1000) - randomOffset;

  const wrapTemplate = {
    kind: 1059,
    created_at,
    tags: [['p', recipientPk]],
    content: encryptedContent
  };

  return finalizeEvent(wrapTemplate, ephemeralSk) as unknown as SignedEvent;
}

/**
 * @deprecated Use `unwrapNip17Message` instead. Will be removed in a future version.
 *
 * Unwrap a gift-wrapped event to recover the seal and rumor.
 * Recipient uses their own secret key to decrypt.
 */
export function unwrapGiftWrap(
  wrap: SignedEvent,
  recipientSk: Uint8Array
): {seal: SignedEvent; rumor: UnsignedEvent} {
  // Decrypt the wrap to get the seal
  const wrapConvKey = getConversationKey(recipientSk, wrap.pubkey);
  const sealJson = nip44Decrypt(wrap.content, wrapConvKey);
  const seal = JSON.parse(sealJson) as SignedEvent;

  // Decrypt the seal to get the rumor
  const sealConvKey = getConversationKey(recipientSk, seal.pubkey);
  const rumorJson = nip44Decrypt(seal.content, sealConvKey);
  const rumor = JSON.parse(rumorJson) as UnsignedEvent;

  return {seal, rumor};
}

// ==================== Group Message Wrapping ====================

/**
 * Wrap a text message as NIP-17 gift-wrap events for N group members + self.
 *
 * Creates a single rumor (kind 14) with p-tags for all members and a
 * ['group', groupId] tag, then gift-wraps it individually for each member
 * and the sender (for multi-device recovery).
 *
 * @param senderSk - Sender's secret key (Uint8Array)
 * @param memberPubkeys - Hex public keys of all group members (excluding sender)
 * @param content - Message text content
 * @param groupId - Group identifier (hex string)
 * @param kind - Rumor kind (default 14)
 * @returns Array of kind 1059 events: memberPubkeys.length + 1 (self-send)
 */
export function wrapGroupMessage(
  senderSk: Uint8Array,
  memberPubkeys: string[],
  content: string,
  groupId: string,
  kind: number = 14
): {wraps: NTNostrEvent[]; rumorId: string} {
  const senderPubHex = getPublicKey(senderSk);
  const allWraps: NTNostrEvent[] = [];

  // Build tags: one p-tag per member + group tag
  const tags: string[][] = memberPubkeys.map(pk => ['p', pk]);
  tags.push(['group', groupId]);

  // Create single rumor (kind 14)
  const rumor = createRumor(content, senderSk, tags);

  // One gift-wrap per member
  for(const memberPk of memberPubkeys) {
    const seal = createSeal(rumor, senderSk, memberPk);
    const wrap = createGiftWrap(seal, memberPk);
    allWraps.push(wrap as unknown as NTNostrEvent);
  }

  // Self-send for multi-device
  const selfSeal = createSeal(rumor, senderSk, senderPubHex);
  const selfWrap = createGiftWrap(selfSeal, senderPubHex);
  allWraps.push(selfWrap as unknown as NTNostrEvent);

  // Return the rumor id alongside the wraps so the sender can key its own
  // outgoing store row by the same id the receiver will see (parallel to
  // wrapNip17Message which made the same change in Phase 2b.3 for DMs).
  return {wraps: allWraps, rumorId: (rumor as any).id as string};
}
