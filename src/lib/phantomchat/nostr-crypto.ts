import * as nip44 from 'nostr-tools/nip44';
import {generateSecretKey, getPublicKey, finalizeEvent, getEventHash, verifyEvent} from 'nostr-tools/pure';
import {getSharedSecret, etc as secpEtc} from '@noble/secp256k1';
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
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
  // Also wipe the v2 symmetric key cache
  symmetricKeyCache.clear();
}

// ==================== PhantomChat Protocol v2 — Symmetric Key Cache ====================

/**
 * In-memory cache of derived AES-256-GCM symmetric keys, keyed by the peer's
 * hex public key. Each entry holds a Web Crypto CryptoKey (non-extractable,
 * hardware-backed on most devices) derived via one ECDH + HKDF-SHA256.
 *
 * Populated lazily on first encrypt/decrypt per peer, wiped on logout.
 * Entries are also evicted on identity change (logout clears the whole map).
 */
const symmetricKeyCache: Map<string, CryptoKey> = new Map();

/**
 * Derive or retrieve a cached AES-256-GCM symmetric key for a peer.
 *
 * The key is derived from one ECDH shared secret between `localSk` and
 * `peerPubHex`, then HKDF-expanded with SHA-256 under info="pc-v2" to
 * 32 bytes (256 bits). Both sides derive the same key independently.
 *
 * @param localSk    - Local party's secp256k1 secret key (Uint8Array, 32 bytes)
 * @param peerPubHex - Peer's hex-encoded compressed public key (66-char "03/04" + 64 hex)
 * @returns `{ raw: Uint8Array; key: CryptoKey }` — the derived symmetric key
 */
export async function getSymmetricKey(
  localSk: Uint8Array,
  peerPubHex: string
): Promise<{raw: Uint8Array; key: CryptoKey}> {
  // Cache key: sorted pair of pubkeys (ECDH is commutative, so ECDH(skA, pkB) == ECDH(skB, pkA))
  const localPubHex = getPublicKey(localSk);
  const cacheKey = localPubHex < peerPubHex ? `${localPubHex}:${peerPubHex}` : `${peerPubHex}:${localPubHex}`;

  // Check if we have a CryptoKey cached (most common path)
  const cachedKey = symmetricKeyCache.get(cacheKey);
  if(cachedKey) {
    return {raw: new Uint8Array(0), key: cachedKey}; // raw unused in hot path
  }

  // ECDH: derive shared secret from (localSk, peerPub)
  // nostr-tools getPublicKey returns x-only (32 bytes hex, no prefix).
  // @noble/secp256k1 getSharedSecret expects compressed point (33 bytes with 02/03 prefix).
  // Nostr convention: x-only keys always use even y → prefix 0x02.
  const peerPubBytes = new Uint8Array([0x02, ...secpEtc.hexToBytes(peerPubHex)]);
  const sharedSecret = getSharedSecret(localSk, peerPubBytes);

  // HKDF-SHA256 → 32-byte symmetric key. getSharedSecret returns a 33-byte
  // compressed point (02/03 prefix + x-coordinate). The prefix byte differs
  // depending on which side computes ECDH, so we MUST use only the 32-byte
  // x-coordinate (shared_secret_x) to ensure both sides derive the same key.
  const sharedSecretX = sharedSecret.slice(1);
  const info = new TextEncoder().encode('pc-v2');
  const rawKey = hkdf(sha256, sharedSecretX, undefined, info, 32);

  // Import as AES-GCM CryptoKey (extractable so we can cache raw bytes if needed later)
  const key = await crypto.subtle.importKey(
    'raw', rawKey, {name: 'AES-GCM', length: 256}, true,
    ['encrypt', 'decrypt']
  );

  symmetricKeyCache.set(cacheKey, key);
  return {raw: rawKey, key};
}

/**
 * Pre-derive and cache AES-256-GCM symmetric keys for a list of known peers.
 * Call at startup (before subscription) so inbound v2 messages can be decrypted
 * even though the sender used ephemeral envelope signing (event.pubkey is a
 * throwaway key, so we can't derive from the event alone).
 *
 * Each peer is one ECDH + HKDF + importKey (~2ms). For 50 peers ≈ 100ms.
 */
export async function warmSymmetricKeyCache(
  localSk: Uint8Array,
  peerPubHexes: string[]
): Promise<void> {
  await Promise.all(
    peerPubHexes.map((peerPubHex) => getSymmetricKey(localSk, peerPubHex))
  );
}

/**
 * Try to decrypt ciphertext with every cached symmetric key. AES-GCM auth
 * tag rejection is instant (~µs) so even 50+ cached keys is sub-millisecond.
 *
 * Returns the plaintext + the cache key (sorted pubkey pair) on success,
 * or null if no key matched.
 *
 * Used by unwrapV2 because ephemeral envelope signing means event.pubkey
 * is a throwaway key — we can't derive the symmetric key from it directly.
 */
async function decryptWithAnyCachedKey(
  ciphertext: string
): Promise<{plaintext: string; cacheKey: string} | null> {
  for(const [cacheKey, symmetricKey] of symmetricKeyCache) {
    try {
      const plaintext = await decryptV2(ciphertext, symmetricKey);
      return {plaintext, cacheKey};
    } catch{
      // Wrong key — AES-GCM auth tag mismatch, try next
    }
  }
  return null;
}

/**
 * Base64url-encode a Uint8Array (NIP-44 compatible, no padding).
 */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for(let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url-decode a string to Uint8Array (NIP-44 compatible).
 */
function base64urlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while(b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * PhantomChat Protocol v2: encrypt plaintext using AES-256-GCM.
 *
 * Cost: ~0.005ms (hardware AES-NI) + 1× random IV generation.
 * Compared to NIP-44 v2: ~12ms (2× ECDH + XChaCha20-Poly1305).
 *
 * @param plaintext     - The message text to encrypt
 * @param symmetricKey  - The AES-256-GCM CryptoKey from `getSymmetricKey`
 * @returns base64url-encoded ciphertext with 12-byte IV prepended
 */
export async function encryptV2(
  plaintext: string,
  symmetricKey: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv}, symmetricKey, encoded
  );
  // Prepend IV (12 bytes) + ciphertext
  const result = new Uint8Array(iv.length + new Uint8Array(cipherBuf).length);
  result.set(iv, 0);
  result.set(new Uint8Array(cipherBuf), iv.length);
  return base64urlEncode(result);
}

/**
 * PhantomChat Protocol v2: decrypt ciphertext using AES-256-GCM.
 *
 * @param ciphertext    - base64url-encoded ciphertext (IV prepended) from `encryptV2`
 * @param symmetricKey  - The AES-256-GCM CryptoKey from `getSymmetricKey`
 * @returns Decrypted plaintext string
 */
export async function decryptV2(
  ciphertext: string,
  symmetricKey: CryptoKey
): Promise<string> {
  const data = base64urlDecode(ciphertext);
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const plainBuf = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv}, symmetricKey, encrypted
  );
  return new TextDecoder().decode(plainBuf);
}

/**
 * PhantomChat Protocol v2: wrap a message.
 *
 * Creates a kind-14 rumor → encrypts with AES-256-GCM → publishes as a
 * signed kind-1059 event. The published event carries the sender's real
 * pubkey (no ephemeral key), a ['v', 'pc-v2'] version tag, and the
 * encrypted rumor JSON as content.
 *
 * Per-message cost: 1× AES-GCM encrypt (~0.005ms) + 1× Schnorr sign (~1ms)
 * = ~1ms total. Compared to NIP-17: ~12ms.
 *
 * @param senderSk       - Sender's secret key (Uint8Array)
 * @param recipientPubHex - Recipient's hex public key
 * @param content        - Message text content
 * @param replyTo        - Optional reply reference {eventId, relayUrl?}
 * @returns `{event, rumorId}` — signed kind-1059 event + the rumor id
 */
export async function wrapV2(
  senderSk: Uint8Array,
  recipientPubHex: string,
  content: string,
  replyTo?: {eventId: string; relayUrl?: string}
): Promise<{event: NTNostrEvent; rumorId: string; senderPubkey: string}> {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [['p', recipientPubHex], ['v', 'pc-v2']];
  if(replyTo) {
    tags.push(['e', replyTo.eventId, replyTo.relayUrl || '', 'reply']);
  }

  // Create rumor (kind 14, unsigned) — same structure as NIP-17 rumor
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
    pubkey: senderPubHex
  };
  const rumorId = getEventHash(rumor as any);
  (rumor as any).id = rumorId;

  // Derive shared symmetric key (cached after first call per peer)
  const {key: symmetricKey} = await getSymmetricKey(senderSk, recipientPubHex);

  // Assign id after hashing
  const rumorWithId = {...rumor, id: rumorId};

  // Encrypt rumor JSON with AES-256-GCM
  const encryptedContent = await encryptV2(JSON.stringify(rumorWithId), symmetricKey);

  // Sign outer event with a FRESH EPHEMERAL keypair per message (NIP-17
  // parity). This prevents relays from building an A→B social graph from
  // signed event.pubkey edges. Sender authenticity lives inside the encrypted
  // rumor (rumor.pubkey), verified on unwrap via getEventHash + cache key.
  const ephemeralSk = generateSecretKey();
  const eventTemplate = {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encryptedContent
  };
  const event = finalizeEvent(eventTemplate, ephemeralSk) as unknown as NTNostrEvent;

  // Return the REAL sender pubkey alongside the event + rumor id. The outer
  // event is signed with a throwaway ephemeral key (envelope privacy), so
  // `event.pubkey` is NOT the sender. Callers that reconstruct a synthetic
  // rumor for the delivery-retry layer MUST use this `senderPubkey`, otherwise
  // the receiver's counterparty binding check rejects the rewrapped rumor
  // (Bug: worker cache isolation / wrong rumor pubkey).
  return {event, rumorId, senderPubkey: senderPubHex};
}

/**
 * PhantomChat Protocol v2: unwrap a message.
 *
 * Verifies the kind-1059 signature, derives the shared symmetric key, and
 * decrypts the content to recover the rumor.
 *
 * @param event       - Kind-1059 event with ['v', 'pc-v2'] tag
 * @param recipientSk - Recipient's secret key (Uint8Array)
 * @returns The unwrapped rumor {kind, content, pubkey, created_at, tags, id}
 */
export async function unwrapV2(
  event: NTNostrEvent,
  _recipientSk: Uint8Array
): Promise<{kind: number; content: string; pubkey: string; created_at: number; tags: string[][]; id: string}> {
  // Verify kind-1059 Schnorr signature
  if(!verifyEvent(event as any)) {
    throw new GiftWrapVerificationError('wrap_sig', 'v2 event signature invalid');
  }

  // Ephemeral envelope signing: event.pubkey is a throwaway key, not the
  // real sender. We can't use it for key derivation. Instead, try all cached
  // symmetric keys until one decrypts successfully (AES-GCM auth tag rejects
  // wrong keys instantly). The cache key is the sorted pubkey pair, so after
  // decrypt we verify rumor.pubkey matches one of them.
  const result = await decryptWithAnyCachedKey(event.content);
  if(!result) {
    throw new GiftWrapVerificationError(
      'no_matching_key',
      'v2: no cached symmetric key could decrypt the content'
    );
  }
  const {plaintext: rumorJson, cacheKey} = result;
  const rumor = JSON.parse(rumorJson);

  // Anti-impersonation: rumor.pubkey must be the counterparty (the other
  // party in the shared-key pair) or our own pubkey for a genuine self-send.
  // Binding to just the counterparty (not "either key") closes the window
  // where a contact could craft rumor.pubkey = myPubkey for self-attribution.
  const myPubHex = getPublicKey(_recipientSk);
  const [pk1, pk2] = cacheKey.split(':');
  const counterparty = pk1 === myPubHex ? pk2 : pk1;
  if(rumor.pubkey !== counterparty && rumor.pubkey !== myPubHex) {
    throw new GiftWrapVerificationError(
      'pubkey_binding',
      `v2 rumor.pubkey (${rumor.pubkey?.slice(0, 8)}...) does not match counterparty or self`
    );
  }

  // Verify rumor.id matches canonical content hash (prevents dedup/receipt poisoning)
  const expectedId = getEventHash(rumor as any);
  if(rumor.id !== expectedId) {
    throw new GiftWrapVerificationError(
      'rumor_id',
      `v2 rumor.id (${rumor.id?.slice(0, 8)}...) does not match canonical hash (${expectedId.slice(0, 8)}...)`
    );
  }

  return rumor as {kind: number; content: string; pubkey: string; created_at: number; tags: string[][]; id: string};
}

/**
 * Check whether a Nostr event is a PhantomChat v2 message.
 * Returns true if the event has a ['v', 'pc-v2'] tag.
 */
export function isV2Event(event: NTNostrEvent): boolean {
  return event.tags?.some((t: string[]) => t[0] === 'v' && t[1] === 'pc-v2') ?? false;
}

/**
 * Check whether a Nostr event is a legacy NIP-17 gift-wrap.
 * Returns true if the event is kind 1059 WITHOUT a ['v', 'pc-v2'] tag.
 */
export function isLegacyWrap(event: NTNostrEvent): boolean {
  return event.kind === 1059 && !isV2Event(event);
}

/**
 * PhantomChat Protocol v2: re-encrypt an existing rumor in a fresh event.
 *
 * Used by the delivery-retry layer. The rumor object (and therefore its .id)
 * is preserved verbatim, so the receiver dedups by rumor id and never renders
 * a duplicate. A fresh kind-1059 event is signed and published so relays
 * re-forward it to an already-live subscription.
 *
 * @param senderSk       - Sender's secret key (Uint8Array)
 * @param recipientPubHex - Recipient's hex public key
 * @param rumor          - The original rumor to re-wrap
 * @returns Fresh signed kind-1059 event with v2 encryption
 */
export async function rewrapV2(
  senderSk: Uint8Array,
  recipientPubHex: string,
  rumor: UnsignedEvent
): Promise<NTNostrEvent> {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [['p', recipientPubHex], ['v', 'pc-v2']];

  // Derive shared symmetric key (cached after first call per peer)
  const {key: symmetricKey} = await getSymmetricKey(senderSk, recipientPubHex);

  // Re-encrypt the same rumor JSON with a fresh IV
  const encryptedContent = await encryptV2(JSON.stringify(rumor), symmetricKey);

  // Sign outer event with a fresh ephemeral keypair per message
  const ephemeralSk = generateSecretKey();
  const eventTemplate = {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encryptedContent
  };
  return finalizeEvent(eventTemplate, ephemeralSk) as unknown as NTNostrEvent;
}

// ==================== NIP-44 Conversation Key (legacy, used by NIP-17 path) ====================

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
): {wraps: NTNostrEvent[]; rumorId: string; rumor: UnsignedEvent} {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [['p', recipientPubHex]];
  if(replyTo) {
    tags.push(['e', replyTo.eventId, replyTo.relayUrl || '', 'reply']);
  }

  // Create rumor (kind 14, unsigned). `createRumor` populates `.id` via
  // `getEventHash` — we propagate that id to callers so sender-side stores
  // can key by the SAME id the receiver will see after unwrap.
  const rumor = createRumor(content, senderSk, tags);

  // Seal + gift-wrap for recipient and self (multi-device recovery).
  const {wraps} = sealAndWrapRumor(rumor, senderSk, recipientPubHex, senderPubHex);

  return {
    wraps,
    rumorId: rumor.id,
    // The immutable rumor is returned so callers (the delivery-retry layer)
    // can RE-wrap the SAME rumor in a FRESH outer gift-wrap. Re-publishing the
    // identical outer event is useless: a relay will not re-forward a duplicate
    // event id to an already-live subscription, so a ghosted first message
    // never self-heals. A fresh wrap has a new outer id (relay forwards it) but
    // the rumor id is unchanged (receiver dedups → never a double).
    rumor
  };
}

/**
 * Re-wrap an EXISTING rumor in a fresh gift-wrap pair (recipient + self).
 *
 * Used by the always-on delivery-retry layer. The rumor object — and therefore
 * its `.id` — is preserved verbatim, so the receiver dedups by rumor id and
 * never renders a duplicate. Only the outer kind-1059 wraps are regenerated
 * (new ephemeral key + new outer id each time), which is exactly what makes a
 * relay re-forward the event to a subscriber that already EOSE'd.
 */
export function rewrapNip17Message(
  senderSk: Uint8Array,
  recipientPubHex: string,
  rumor: UnsignedEvent
): NTNostrEvent[] {
  const senderPubHex = getPublicKey(senderSk);
  return sealAndWrapRumor(rumor, senderSk, recipientPubHex, senderPubHex).wraps;
}

/**
 * Shared seal+wrap step: produces [recipientWrap, selfWrap] for a given rumor.
 * Each call regenerates the seals and gift-wraps, so outer ids differ between
 * calls while the inner rumor (and its id) is untouched.
 */
function sealAndWrapRumor(
  rumor: UnsignedEvent,
  senderSk: Uint8Array,
  recipientPubHex: string,
  senderPubHex: string
): {wraps: NTNostrEvent[]} {
  const recipientSeal = createSeal(rumor, senderSk, recipientPubHex);
  const recipientWrap = createGiftWrap(recipientSeal, recipientPubHex);

  const selfSeal = createSeal(rumor, senderSk, senderPubHex);
  const selfWrap = createGiftWrap(selfSeal, senderPubHex);

  return {wraps: [recipientWrap, selfWrap] as unknown as NTNostrEvent[]};
}

/**
 * Error thrown by `unwrapNip17Message` when a verification step fails.
 * Callers can distinguish verification drops from transport/parse errors.
 */
export class GiftWrapVerificationError extends Error {
  readonly code: 'wrap_sig' | 'seal_sig' | 'pubkey_binding' | 'rumor_id' | 'no_matching_key';
  constructor(code: 'wrap_sig' | 'seal_sig' | 'pubkey_binding' | 'rumor_id' | 'no_matching_key', message: string) {
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
 * The rumor carries a marker tag `['phantomchat-edit', <originalAppMessageId>]` that
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
      ['phantomchat-edit', originalAppMessageId]
    ]
  }, senderSk);

  const recipientSeal = createNip59Seal(rumorEvent, senderSk, recipientPubHex);
  const recipientWrap = createNip59Wrap(recipientSeal, recipientPubHex);

  const selfSeal = createNip59Seal(rumorEvent, senderSk, senderPubHex);
  const selfWrap = createNip59Wrap(selfSeal, senderPubHex);

  return [recipientWrap, selfWrap] as unknown as NTNostrEvent[];
}

/**
 * PhantomChat Protocol v2: wrap an edit message.
 *
 * Same rumor structure as `wrapNip17Edit` but encrypted with AES-256-GCM.
 * Returns a single event (no self-wrap needed — the v2 sender publishes
 * one event to all relays, and the client deduplicates by rumor id).
 *
 * @param senderSk         - Sender's secret key (Uint8Array)
 * @param recipientPubHex  - Recipient's hex public key
 * @param originalAppMessageId - App-level ID of the original message (chat-XXX-N)
 * @param newPlaintext     - New message content
 * @returns Single signed kind-1059 event with v2 encryption
 */
export async function wrapEditV2(
  senderSk: Uint8Array,
  recipientPubHex: string,
  originalAppMessageId: string,
  newPlaintext: string
): Promise<NTNostrEvent> {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [
    ['p', recipientPubHex],
    ['phantomchat-edit', originalAppMessageId],
    ['v', 'pc-v2']
  ];

  // Create rumor (kind 14, unsigned)
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: newPlaintext,
    pubkey: senderPubHex
  };
  (rumor as any).id = getEventHash(rumor as any);

  // Derive shared symmetric key (cached)
  const {key: symmetricKey} = await getSymmetricKey(senderSk, recipientPubHex);

  // Encrypt rumor JSON with AES-256-GCM
  const encryptedContent = await encryptV2(JSON.stringify(rumor), symmetricKey);

  // Sign outer event with a fresh ephemeral keypair per message
  const ephemeralSk = generateSecretKey();
  const eventTemplate = {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encryptedContent
  };
  return finalizeEvent(eventTemplate, ephemeralSk) as unknown as NTNostrEvent;
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

/**
 * PhantomChat Protocol v2: wrap a delivery/read receipt.
 *
 * Same rumor structure as `wrapNip17Receipt` but encrypted with AES-256-GCM.
 *
 * @param senderSk        - Sender's secret key (Uint8Array)
 * @param recipientPubHex - Recipient's hex public key
 * @param originalEventId - Event ID of the message being receipted
 * @param receiptType     - 'delivery' or 'read'
 * @returns Single signed kind-1059 event with v2 encryption
 */
export async function wrapReceiptV2(
  senderSk: Uint8Array,
  recipientPubHex: string,
  originalEventId: string,
  receiptType: 'delivery' | 'read'
): Promise<NTNostrEvent> {
  const senderPubHex = getPublicKey(senderSk);
  const tags: string[][] = [
    ['e', originalEventId],
    ['receipt-type', receiptType],
    ['p', recipientPubHex],
    ['v', 'pc-v2']
  ];

  // Create rumor (kind 14, unsigned)
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
    pubkey: senderPubHex
  };
  (rumor as any).id = getEventHash(rumor as any);

  // Derive shared symmetric key (cached)
  const {key: symmetricKey} = await getSymmetricKey(senderSk, recipientPubHex);

  // Encrypt rumor JSON with AES-256-GCM
  const encryptedContent = await encryptV2(JSON.stringify(rumor), symmetricKey);

  // Sign outer event with a fresh ephemeral keypair per message
  const ephemeralSk = generateSecretKey();
  const eventTemplate = {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encryptedContent
  };
  return finalizeEvent(eventTemplate, ephemeralSk) as unknown as NTNostrEvent;
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
 *
 * created_at is the REAL send time (no backdating). NIP-17 permits randomizing
 * a seal's timestamp up to 48h into the past for metadata privacy, but the seal
 * is encrypted INSIDE the gift-wrap — a relay/observer never sees it — so
 * backdating the seal bought no privacy at all while making every timestamp a
 * lie. More importantly, truthful timestamps are what let a receiver poll with a
 * tight `since` to catch any message the relay failed to push live (the cause of
 * the "first message ghosts" bug). See createGiftWrap for the same change.
 */
export function createSeal(
  rumor: UnsignedEvent,
  senderSk: Uint8Array,
  recipientPk: string
): SignedEvent {
  const convKey = getConversationKey(senderSk, recipientPk);
  const encryptedContent = nip44Encrypt(JSON.stringify(rumor), convKey);

  const created_at = Math.floor(Date.now() / 1000);

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
 *
 * created_at is the REAL send time (no backdating). The randomized 0–48h
 * backdate this used to apply was the root cause of the "first message ghosts"
 * bug: relays apply a subscription's `since` filter to LIVE events too, so a
 * receiver could not safely poll with a tight `since` to recover a message the
 * relay dropped from its live push — a backdated wrap was timestamped hours
 * before any sane catch-up window. With a truthful timestamp, a short periodic
 * `since = now − ~70s` poll reliably heals any live-push miss. The only thing
 * we forfeit is timing-metadata privacy against a relay operator, which is worth
 * nothing for a closed loop between Andrew and his own agents.
 */
export function createGiftWrap(
  seal: SignedEvent,
  recipientPk: string
): SignedEvent {
  const ephemeralSk = generateSecretKey();
  const convKey = getConversationKey(ephemeralSk, recipientPk);
  const encryptedContent = nip44Encrypt(JSON.stringify(seal), convKey);

  const created_at = Math.floor(Date.now() / 1000);

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
