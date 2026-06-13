# Phase 2: Crypto Foundation & Identity - Research

**Researched:** 2026-04-01
**Domain:** Nostr cryptographic identity (NIP-06, NIP-19, NIP-44, NIP-17), encrypted key storage, QR code exchange
**Confidence:** HIGH

## Summary

Phase 2 replaces the existing OwnID-based identity system with standard Nostr keypair identity. The project already has partial crypto infrastructure (BIP-39 wordlist, secp256k1, NIP-04 encryption, IndexedDB stores, QR rendering) but all of it uses a non-standard OwnID scheme that must be migrated to proper Nostr npub/nsec format using NIP-06 derivation paths.

The single most important finding is that **nostr-tools v2.23.3** provides all required NIP implementations (NIP-06, NIP-19, NIP-44, NIP-17/59, NIP-05) with their crypto dependencies (@noble/ciphers, @noble/curves, @noble/hashes, @scure/bip39, @scure/bip32, @scure/base) bundled. This means we can replace the existing hand-rolled crypto code (identity.ts generateSeed, custom BIP-39, custom key derivation) with audited, standard implementations. The existing @noble/secp256k1 v3.0.0 dependency will be superseded by @noble/curves (which nostr-tools depends on).

The existing codebase has solid foundations to build on: IndexedDB storage patterns (three Nostra.chat databases), virtual peer mapping (pubkey-to-peerId bridge), QR code rendering (qr-code-styling v1.5.0), and a passcode keystore (EncryptionKeyStore). These need extension, not replacement.

**Primary recommendation:** Install nostr-tools as the single Nostr dependency. Use its nip06, nip19, nip44, and nip59 submodule exports. Replace hand-rolled BIP-39 and key derivation with nostr-tools primitives. Extend existing EncryptionKeyStore for AES-GCM encrypted nsec storage.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Onboarding flow**: Welcome screen with two paths: "Create New Identity" and "Import Seed Phrase". Create path auto-generates seed in background, shows npub with Copy + "Get Started". Import path: 12 individual numbered input fields (grid layout), one word per field, auto-advance focus. Optional display name step. No seed phrase shown during onboarding.
- **OwnID migration**: Silent migration on app update. Detect existing OwnID in IndexedDB, load seed, derive secp256k1 keypair (NIP-06), encode as npub/nsec (bech32), re-map virtual peers, re-encrypt offline queue messages. Old OwnID removed after successful migration.
- **Key protection**: Three user-selectable options: PIN (4-6 digits), passphrase (text), or no protection (browser-scoped CryptoKey). Default is browser-scoped (no user input). PIN/passphrase stretched via PBKDF2 for AES-GCM key. Protection NOT asked during onboarding. Lock screen when PIN/passphrase active. Recovery via seed re-import.
- **NIP-05 alias**: Self-hosted .well-known/nostr.json only. Setup in Settings > Identity > NIP-05. Verified badge (green check) in profile and chat list. Auto-verify contacts every 24h. Published as kind 0 metadata.
- **Contact exchange**: FAB in chat list + sidebar menu. FAB shows "Scan QR Code" and "Paste npub". Dedicated "My QR" screen with npub + display name + NIP-05 alias + Copy + Share as image. QR scanner supports camera AND gallery upload. After adding contact, open chat directly.

### Claude's Discretion
- QR code styling (colors, logo, corner style)
- Exact lock screen UI design
- PBKDF2 iteration count for PIN/passphrase stretching
- BIP-39 checksum validation strictness on import
- NIP-44 encryption implementation details (ChaCha20-Poly1305 internals)
- NIP-17 gift-wrap primitive structure (kind 14 -> kind 13 -> kind 1059)
- How to handle contacts with no kind 0 metadata (display as truncated npub)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| IDEN-01 | Generate Nostr keypair from BIP-39 seed phrase (NIP-06) and derive npub/nsec | nostr-tools/nip06 `privateKeyFromSeedWords()` + nip19 `npubEncode()`/`nsecEncode()` |
| IDEN-02 | User sees only npub during onboarding -- seed generated in background, accessible in settings | Onboarding UI redesign; npub display via nip19; seed stored encrypted in IndexedDB |
| IDEN-03 | User can set NIP-05 alias (user@domain) for human-readable identity | nostr-tools/nip05 `queryProfile()` for verification; kind 0 metadata event via `finalizeEvent()` |
| IDEN-04 | User can share identity via QR code containing npub | Existing qr-code-styling v1.5.0; encode npub string as QR data |
| IDEN-05 | User can add contacts by scanning QR code or pasting npub | Camera API + `nip19.decode()` for npub validation; VirtualPeersDB for storage |
| IDEN-06 | User's keys encrypted at rest in IndexedDB (not plaintext) | AES-GCM via Web Crypto API; PBKDF2 key stretching; extend EncryptionKeyStore |
| MSG-03 | Messages encrypted with NIP-44 (ChaCha20-Poly1305) | nostr-tools/nip44 `v2.encrypt()`/`v2.decrypt()`; replaces existing NIP-04 code |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| nostr-tools | 2.23.3 | NIP-06, NIP-19, NIP-44, NIP-17/59, NIP-05, event signing | Official Nostr JS toolkit; bundles all @noble/@scure crypto deps; tree-shakeable submodule exports |
| qr-code-styling | 1.5.0 | QR code generation with custom styling | Already in deps; used for Telegram login QR; supports logo overlay and rounded corners |

### Supporting (bundled by nostr-tools)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @noble/ciphers | 2.1.1 | ChaCha20-Poly1305 for NIP-44 | Used internally by nostr-tools/nip44; do not import directly |
| @noble/curves | 2.0.1 | secp256k1 ECDH, schnorr signatures | Used internally by nostr-tools; replaces existing @noble/secp256k1 |
| @noble/hashes | 2.0.1 | SHA-256, HMAC, HKDF | bytesToHex/hexToBytes utilities also useful directly |
| @scure/bip39 | 2.0.1 | BIP-39 mnemonic generation/validation | Used internally by nostr-tools/nip06 |
| @scure/bip32 | 2.0.1 | BIP-32 HD key derivation (m/44'/1237'/0'/0/0) | Used internally by nostr-tools/nip06 |
| @scure/base | 2.0.0 | Bech32 encoding for npub/nsec | Used internally by nostr-tools/nip19 |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| nostr-tools | Hand-roll with @noble/* + @scure/* directly | More control but duplicates NIP implementations; nostr-tools is thin wrappers anyway |
| nostr-tools | NDK (Nostr Dev Kit) | Much heavier; includes relay management, caching -- overkill when we only need crypto primitives now |
| qr-code-styling | qrcode.js | Less styling options; qr-code-styling already in deps |

**Installation:**
```bash
pnpm add nostr-tools@2.23.3
```

Note: This will also install @noble/ciphers, @noble/curves, @noble/hashes, @scure/base, @scure/bip32, @scure/bip39 as transitive dependencies. The existing @noble/secp256k1 v3.0.0 can be removed once all imports are migrated to nostr-tools.

## Architecture Patterns

### Recommended Project Structure
```
src/lib/nostra/
  identity.ts         # REFACTOR: Replace OwnID with Nostr keypair (NIP-06)
  nostr-crypto.ts     # NEW: NIP-44 encrypt/decrypt + NIP-17 gift-wrap primitives
  nostr-identity.ts   # NEW: npub/nsec encoding, NIP-05 verification
  key-storage.ts      # NEW: AES-GCM encrypted key storage (extends EncryptionKeyStore pattern)
  migration.ts        # NEW: OwnID -> npub silent migration
  wordlist.ts         # REMOVE: Replaced by @scure/bip39 bundled wordlist
  nostr-relay.ts      # UPDATE: Replace NIP-04 with NIP-44 encryption

src/pages/nostra/
  onboarding.ts       # REFACTOR: New two-path flow (Create/Import)
  onboarding.css      # UPDATE: Grid layout for 12-word import

src/components/nostra/
  QRIdentity.tsx       # NEW: "My QR" screen (Solid.js component)
  QRScanner.tsx        # NEW: Camera + gallery QR scanner
  AddContact.tsx       # NEW: QR scan + npub paste dialog
  LockScreen.tsx       # NEW: PIN/passphrase lock screen
  SeedPhraseGrid.tsx   # NEW: 12-field import grid component

src/components/sidebarLeft/tabs/
  nostraSecurity.ts  # NEW: Settings > Security (PIN/passphrase, seed view)
  nostraIdentity.ts  # NEW: Settings > Identity (NIP-05 setup, npub display)

src/stores/
  nostraIdentity.ts  # NEW: Reactive identity store (npub, displayName, nip05)
```

### Pattern 1: NIP-06 Key Derivation
**What:** Derive Nostr keypair from BIP-39 mnemonic using standard derivation path
**When to use:** New identity creation and seed import
**Example:**
```typescript
// Source: nostr-tools/nip06 + nostr-tools/nip19
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {privateKeyFromSeedWords} from 'nostr-tools/nip06';
import * as nip19 from 'nostr-tools/nip19';
import {generateMnemonic, validateMnemonic} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';

// Generate new identity
const mnemonic = generateMnemonic(wordlist, 128); // 12 words
const privateKeyHex = privateKeyFromSeedWords(mnemonic);
// privateKeyHex is a hex string of the 32-byte private key

// Derive public key
const sk = hexToBytes(privateKeyHex);
const pk = getPublicKey(sk); // hex string

// Encode as npub/nsec
const npub = nip19.npubEncode(pk);
const nsec = nip19.nsecEncode(sk);
```

### Pattern 2: AES-GCM Key Encryption
**What:** Encrypt nsec/seed at rest using Web Crypto API
**When to use:** Storing keys in IndexedDB
**Example:**
```typescript
// Source: Web Crypto API standard
// Default: browser-scoped non-exportable CryptoKey (no user input)
async function generateBrowserScopedKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    false, // non-exportable
    ['encrypt', 'decrypt']
  );
}

// PIN/passphrase: PBKDF2 -> AES-GCM key
async function deriveKeyFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256'},
    keyMaterial,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt nsec
async function encryptKeys(
  data: Uint8Array, key: CryptoKey
): Promise<{iv: Uint8Array; ciphertext: ArrayBuffer}> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    data
  );
  return {iv, ciphertext};
}
```

### Pattern 3: NIP-44 Encrypt/Decrypt (for MSG-03)
**What:** Versioned encryption replacing NIP-04
**When to use:** All message encryption going forward
**Example:**
```typescript
// Source: nostr-tools/nip44, NIP-44 spec
import * as nip44 from 'nostr-tools/nip44';
import {bytesToHex} from '@noble/hashes/utils';

// Derive conversation key (long-term, per-peer)
const conversationKey = nip44.v2.utils.getConversationKey(
  bytesToHex(senderPrivateKey),
  recipientPublicKeyHex
);

// Encrypt
const ciphertext = nip44.v2.encrypt(
  plaintext,
  conversationKey
);

// Decrypt
const decrypted = nip44.v2.decrypt(
  ciphertext,
  conversationKey
);
```

### Pattern 4: NIP-17 Gift Wrap Primitives (for downstream phases)
**What:** Three-layer wrapping: rumor (kind 14) -> seal (kind 13) -> gift-wrap (kind 1059)
**When to use:** Phase 4 messaging, but primitives built here
**Example:**
```typescript
// Source: NIP-59 spec, nostr-tools
import {finalizeEvent, getPublicKey, getEventHash} from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import {generateSecretKey} from 'nostr-tools/pure';

// 1. Create rumor (unsigned kind 14)
function createRumor(content: string, senderSk: Uint8Array) {
  const rumor = {
    kind: 14,
    created_at: Math.round(Date.now() / 1000),
    content,
    tags: [],
    pubkey: getPublicKey(senderSk)
  };
  (rumor as any).id = getEventHash(rumor as any);
  return rumor;
}

// 2. Seal rumor into kind 13
function createSeal(rumor: any, senderSk: Uint8Array, recipientPk: string) {
  const convKey = nip44.v2.utils.getConversationKey(
    bytesToHex(senderSk), recipientPk
  );
  return finalizeEvent({
    kind: 13,
    content: nip44.v2.encrypt(JSON.stringify(rumor), convKey),
    created_at: randomTimestamp(),
    tags: []
  }, senderSk);
}

// 3. Gift-wrap seal into kind 1059
function createWrap(seal: any, recipientPk: string) {
  const ephemeralSk = generateSecretKey();
  const convKey = nip44.v2.utils.getConversationKey(
    bytesToHex(ephemeralSk), recipientPk
  );
  return finalizeEvent({
    kind: 1059,
    content: nip44.v2.encrypt(JSON.stringify(seal), convKey),
    created_at: randomTimestamp(),
    tags: [['p', recipientPk]]
  }, ephemeralSk);
}
```

### Pattern 5: Identity Store (Solid.js)
**What:** Reactive identity state following existing store pattern
**When to use:** Any component needing current user identity
**Example:**
```typescript
// Source: existing src/stores/ pattern
import {createRoot, createSignal} from 'solid-js';
import rootScope from '@lib/rootScope';

const [npub, setNpub] = createRoot(() => createSignal<string | null>(null));
const [displayName, setDisplayName] = createRoot(() => createSignal<string | null>(null));
const [nip05, setNip05] = createRoot(() => createSignal<string | null>(null));
const [isLocked, setIsLocked] = createRoot(() => createSignal(false));

rootScope.addEventListener('nostra_identity_loaded', (e) => {
  setNpub(e.npub);
  setDisplayName(e.displayName);
  setNip05(e.nip05);
});

export default function useNostraIdentity() {
  return {npub, displayName, nip05, isLocked};
}
```

### Anti-Patterns to Avoid
- **Hand-rolling BIP-39 checksum calculation:** The existing identity.ts uses a broken XOR-based checksum (`checksumIdx = indices.reduce((a, b) => a ^ b, 0) % 2048`). Use @scure/bip39 validateMnemonic() instead.
- **Storing plaintext nsec in IndexedDB:** Current code stores base64 privateKey unencrypted. Must encrypt with AES-GCM before storage.
- **Using NIP-04 for new messages:** The existing nostr-relay.ts uses AES-256-CBC (NIP-04). All new encryption must use NIP-44 (ChaCha20-Poly1305).
- **Importing from @noble/secp256k1 directly:** Migrate to nostr-tools/pure which uses @noble/curves internally.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BIP-39 mnemonic generation | Custom wordlist + entropy + checksum (current identity.ts) | @scure/bip39 via nostr-tools | Broken checksum in current code; audited library handles entropy correctly |
| BIP-32 HD key derivation | Custom PBKDF2-based key derivation (current deriveKeys()) | nostr-tools/nip06 `privateKeyFromSeedWords()` | NIP-06 specifies exact path m/44'/1237'/0'/0/0; hand-rolling risks incompatibility |
| Bech32 npub/nsec encoding | Custom bech32 encoder | nostr-tools/nip19 | Bech32 has subtle checksum requirements; nip19 handles all Nostr entity types |
| NIP-44 encryption | Custom ChaCha20 implementation | nostr-tools/nip44 | Versioned padding, HKDF conversation key, HMAC-SHA256 MAC -- too many crypto details |
| NIP-05 verification | Custom fetch + JSON parse | nostr-tools/nip05 `queryProfile()` | Handles CORS, .well-known path, pubkey matching |
| QR code rendering | Canvas-based QR generator | qr-code-styling (already in deps) | Supports logos, rounded corners, image export |
| Event signing + ID hashing | Manual SHA-256 + schnorr (current nostr-relay.ts) | nostr-tools `finalizeEvent()` | Handles serialization order, hash computation, schnorr signing in one call |

**Key insight:** The existing codebase has a non-standard crypto implementation that produces keys incompatible with the Nostr ecosystem. Every crypto primitive must be replaced with nostr-tools equivalents to ensure interoperability with other Nostr clients.

## Common Pitfalls

### Pitfall 1: BIP-39 Wordlist Mismatch
**What goes wrong:** The existing `src/lib/nostra/wordlist.ts` is a hand-maintained copy of the BIP-39 English wordlist. If it differs from the canonical list, seed phrase import from other wallets/clients will fail silently (wrong keys derived).
**Why it happens:** Copy-paste errors, encoding issues, or incomplete wordlist.
**How to avoid:** Remove wordlist.ts entirely. Use `@scure/bip39/wordlists/english` which nostr-tools bundles.
**Warning signs:** Test vector private keys don't match NIP-06 test vectors.

### Pitfall 2: Non-Exportable CryptoKey Cannot Be Persisted
**What goes wrong:** A non-exportable CryptoKey generated via `crypto.subtle.generateKey({extractable: false})` cannot be stored in IndexedDB across sessions. The key is tied to the browser's crypto context.
**Why it happens:** Non-exportable means the raw key bytes cannot be extracted. IndexedDB can store CryptoKey objects via structured clone, but only in the same origin+context.
**How to avoid:** For the default "no protection" mode, generate a non-exportable CryptoKey and store it directly in IndexedDB (structured clone preserves it). Test that it survives page reloads and service worker lifecycle.
**Warning signs:** Encrypted keys become undecryptable after browser restart.

### Pitfall 3: OwnID Migration Data Loss
**What goes wrong:** The existing identity stores seed phrase as plaintext in IndexedDB. During migration, if the seed is re-derived through NIP-06 path, it produces a DIFFERENT private key than the current PBKDF2-derived key.
**Why it happens:** Current deriveKeys() uses PBKDF2 with custom salt ("Nostra.chat-Signing-v1"), not BIP-32 derivation. NIP-06 uses BIP-32 path m/44'/1237'/0'/0/0.
**How to avoid:** Migration must: (1) read existing seed, (2) derive NEW keypair via NIP-06, (3) re-map all virtual peer IDs using the NEW pubkey, (4) re-encrypt offline queue with NIP-44 using NEW keys. The old keys and new keys will be DIFFERENT from the same seed.
**Warning signs:** Virtual peer mappings break after migration; old messages become undecryptable.

### Pitfall 4: PBKDF2 Iteration Count Too Low for PIN
**What goes wrong:** 4-6 digit PINs have very low entropy (10,000-1,000,000 possibilities). Low PBKDF2 iterations allow brute-force.
**Why it happens:** Defaulting to iteration counts suitable for passphrases.
**How to avoid:** Use 600,000 iterations minimum (OWASP 2023 recommendation for SHA-256). For PINs specifically, consider even higher (1,000,000+) since the key space is tiny.
**Warning signs:** PIN brute-force takes < 1 second on modern hardware.

### Pitfall 5: NIP-44 Conversation Key Caching
**What goes wrong:** Recomputing the ECDH shared secret + HKDF for every message is expensive in the browser.
**Why it happens:** The conversation key is deterministic per sender-recipient pair but the derivation involves point multiplication.
**How to avoid:** Cache conversation keys per-peer in memory (Map<recipientPubkey, conversationKey>). Clear on logout/lock.
**Warning signs:** Message encryption becomes noticeably slow in active chats.

### Pitfall 6: QR Scanner Permission Denied
**What goes wrong:** Camera API requires HTTPS and user permission. Users deny permission, or the browser blocks it.
**Why it happens:** No graceful fallback; camera-only scanning.
**How to avoid:** Always offer gallery image upload as alternative (decision already specifies this). Use `navigator.mediaDevices.getUserMedia()` with proper error handling.
**Warning signs:** QR scanner blank screen on HTTP or after permission denial.

### Pitfall 7: NIP-05 CORS Blocking
**What goes wrong:** Browser fetch to `https://domain.com/.well-known/nostr.json` is blocked by CORS.
**Why it happens:** Most domains don't set `Access-Control-Allow-Origin` on .well-known responses.
**How to avoid:** nostr-tools/nip05 `queryProfile()` handles this. For self-hosted verification, document that the .well-known response needs CORS headers. For verifying contacts, may need a CORS proxy or relay-based metadata lookup.
**Warning signs:** NIP-05 verification always fails in browser despite correct server config.

## Code Examples

### NIP-06 Test Vector Validation
```typescript
// Source: NIP-06 specification test vectors
import {privateKeyFromSeedWords} from 'nostr-tools/nip06';
import {getPublicKey} from 'nostr-tools/pure';

// Test vector 1
const mnemonic1 = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const sk1 = privateKeyFromSeedWords(mnemonic1);
// Expected: '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a'
const pk1 = getPublicKey(hexToBytes(sk1));
// Expected: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917'
```

### IndexedDB Encrypted Storage Layout
```typescript
// Source: Web Crypto API + project convention
interface EncryptedIdentityStore {
  id: 'current';
  npub: string;              // Public, unencrypted (for display)
  displayName?: string;      // Public, unencrypted
  nip05?: string;            // Public, unencrypted
  protectionType: 'none' | 'pin' | 'passphrase';
  salt?: Uint8Array;         // 16 bytes, for PBKDF2 (null if protectionType='none')
  iv: Uint8Array;            // 12 bytes, for AES-GCM
  encryptedKeys: ArrayBuffer; // AES-GCM({seed, nsec})
  wrappingKeyId?: string;    // Reference to stored CryptoKey (for 'none' protection)
  createdAt: number;
  migratedFrom?: 'ownid';   // Flag for migration tracking
}
```

### OwnID Migration Flow
```typescript
// Source: project-specific migration logic
async function migrateOwnIdToNpub(): Promise<boolean> {
  // 1. Check for existing OwnID identity
  const oldIdentity = await loadOldIdentity(); // from Nostra.chat/identity store
  if(!oldIdentity?.seed) return false;

  // 2. Derive new Nostr keypair via NIP-06
  const privateKeyHex = privateKeyFromSeedWords(oldIdentity.seed);
  const sk = hexToBytes(privateKeyHex);
  const pk = getPublicKey(sk);
  const npub = nip19.npubEncode(pk);

  // 3. Generate default encryption key (browser-scoped)
  const wrappingKey = await generateBrowserScopedKey();

  // 4. Encrypt seed + nsec
  const {iv, ciphertext} = await encryptKeys(
    new TextEncoder().encode(JSON.stringify({seed: oldIdentity.seed, nsec: nip19.nsecEncode(sk)})),
    wrappingKey
  );

  // 5. Re-map virtual peers (old pubkey -> new pubkey)
  const bridge = NostraBridge.getInstance();
  const allMappings = await getAllMappings();
  // Note: peer mappings stay the same (they map OTHER users' pubkeys to peerIds)
  // Only OUR identity changes

  // 6. Save new encrypted identity
  await saveEncryptedIdentity({npub, iv, encryptedKeys: ciphertext, ...});

  // 7. Delete old OwnID store
  await deleteOldIdentity();

  return true;
}
```

### NIP-05 Kind 0 Metadata Event
```typescript
// Source: Nostr NIP-05, NIP-01
import {finalizeEvent} from 'nostr-tools/pure';

function createMetadataEvent(sk: Uint8Array, metadata: {
  name?: string;
  nip05?: string;
  display_name?: string;
  about?: string;
}) {
  return finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(metadata)
  }, sk);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| NIP-04 (AES-256-CBC) | NIP-44 (ChaCha20-Poly1305 + HKDF) | NIP-44 finalized 2023 | Must replace all NIP-04 encryption; NIP-04 deprecated |
| Custom keypair derivation | NIP-06 (BIP-39 + BIP-32 m/44'/1237'/0'/0/0) | Standard since 2022 | Interoperable with all Nostr clients |
| Hex/base64 key display | Bech32 npub/nsec (NIP-19) | Standard since 2022 | Human-readable, error-detecting encoding |
| Kind 4 encrypted DMs | Kind 14/13/1059 gift-wrap (NIP-17) | NIP-17 finalized 2024 | Hides metadata (sender, recipient, timestamp) from relays |
| @noble/secp256k1 v3 standalone | @noble/curves v2 (via nostr-tools) | 2024 | Unified API; secp256k1 + schnorr in same package |

**Deprecated/outdated:**
- **NIP-04 encryption:** Deprecated in favor of NIP-44. The existing nostr-relay.ts NIP-04 code must be replaced.
- **Custom OwnID format (xxxxx.xxxxx.xxxxx):** Non-standard, not interoperable. Replace with npub.
- **PBKDF2 key derivation for signing keys:** Not how Nostr does it. NIP-06 uses BIP-32 HD derivation.

## Open Questions

1. **CryptoKey persistence in IndexedDB across browser updates**
   - What we know: Structured clone of CryptoKey works in IndexedDB for same-origin.
   - What's unclear: Whether browser updates, cache clears, or incognito mode affect stored CryptoKeys.
   - Recommendation: Test thoroughly in Chromium and Firefox. Document recovery path (seed re-import) prominently.

2. **Camera API for QR scanning in PWA**
   - What we know: `navigator.mediaDevices.getUserMedia()` works in PWAs on HTTPS.
   - What's unclear: Whether a JS-only QR decoder library is needed or if browser BarcodeDetector API has sufficient support.
   - Recommendation: Use jsQR or @aspect/barcode-scanner as decoder. BarcodeDetector is not available in all browsers (missing in Firefox).

3. **NIP-05 CORS for contact verification**
   - What we know: Self-hosted domains can set CORS headers. Third-party domains may not.
   - What's unclear: How nostr-tools/nip05 handles CORS failures in browser context.
   - Recommendation: Verify contact NIP-05 via relay kind 0 metadata as fallback. Only do direct .well-known fetch for self-verification.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via pnpm test) |
| Config file | vitest.config.ts (jsdom environment, globals: true) |
| Quick run command | `pnpm test src/tests/nostra/` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IDEN-01 | NIP-06 keypair derivation from mnemonic | unit | `pnpm test src/tests/nostra/nostr-identity.test.ts -t "NIP-06"` | No -- Wave 0 |
| IDEN-02 | Onboarding shows npub, not seed | integration | `pnpm test src/tests/nostra/onboarding-npub.test.ts` | No -- Wave 0 |
| IDEN-03 | NIP-05 alias set and verified | unit | `pnpm test src/tests/nostra/nip05.test.ts` | No -- Wave 0 |
| IDEN-04 | QR code contains valid npub | unit | `pnpm test src/tests/nostra/qr-identity.test.ts` | No -- Wave 0 |
| IDEN-05 | Contact added from scanned/pasted npub | integration | `pnpm test src/tests/nostra/add-contact.test.ts` | No -- Wave 0 |
| IDEN-06 | Keys encrypted in IndexedDB (no plaintext nsec) | unit | `pnpm test src/tests/nostra/key-storage.test.ts` | No -- Wave 0 |
| MSG-03 | NIP-44 encrypt/decrypt roundtrip | unit | `pnpm test src/tests/nostra/nip44-crypto.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test src/tests/nostra/`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tests/nostra/nostr-identity.test.ts` -- NIP-06 derivation with test vectors, npub/nsec encoding
- [ ] `src/tests/nostra/key-storage.test.ts` -- AES-GCM encrypt/decrypt roundtrip, PBKDF2 key derivation
- [ ] `src/tests/nostra/nip44-crypto.test.ts` -- NIP-44 encrypt/decrypt, conversation key derivation
- [ ] `src/tests/nostra/onboarding-npub.test.ts` -- Onboarding UI shows npub not seed
- [ ] `src/tests/nostra/nip05.test.ts` -- NIP-05 kind 0 event creation, verification
- [ ] `src/tests/nostra/qr-identity.test.ts` -- QR contains valid npub string
- [ ] `src/tests/nostra/add-contact.test.ts` -- npub parse, virtual peer creation
- [ ] `src/tests/nostra/migration.test.ts` -- OwnID to npub migration preserves data

## Sources

### Primary (HIGH confidence)
- nostr-tools v2.23.3 npm registry -- verified version, dependencies, exports via `npm view`
- [NIP-06 specification](https://github.com/nostr-protocol/nips/blob/master/06.md) -- derivation path m/44'/1237'/0'/0/0, test vectors
- [NIP-44 specification](https://github.com/nostr-protocol/nips/blob/master/44.md) via Context7 /nostr-protocol/nips -- ChaCha20-Poly1305, HKDF conversation key, pseudocode
- [NIP-59/NIP-17 specification](https://github.com/nostr-protocol/nips/blob/master/59.md) via Context7 -- gift-wrap JS example with full seal/wrap flow
- nostr-tools/nip19 README via Context7 /nbd-wtf/nostr-tools -- npub/nsec encode/decode examples
- nostr-tools/nip06 README via Context7 -- privateKeyFromSeedWords API
- @scure/bip39 via Context7 /bitcoinjs/bip39 -- generateMnemonic, validateMnemonic API

### Secondary (MEDIUM confidence)
- [nostr-tools npm page](https://www.npmjs.com/package/nostr-tools) -- exports list, dependencies
- [nip06 npm standalone](https://www.npmjs.com/package/nip06) -- accountFromSeedWords API confirmation
- Web Crypto API -- AES-GCM, PBKDF2 patterns (well-documented standard)

### Tertiary (LOW confidence)
- Camera/QR scanning in PWA -- needs runtime validation on target browsers
- CryptoKey IndexedDB persistence across browser updates -- needs empirical testing

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- nostr-tools is the canonical Nostr JS library; npm verified
- Architecture: HIGH -- existing codebase patterns well understood; clear migration path
- Pitfalls: HIGH -- identified from inspecting actual code (broken checksum, plaintext keys, NIP-04 usage)
- NIP-44/NIP-17 primitives: HIGH -- verified via Context7 with official spec and code examples
- QR scanning: MEDIUM -- camera API well-known but barcode decoder choice needs validation
- CryptoKey persistence: MEDIUM -- standard behavior but edge cases untested

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable -- Nostr NIPs rarely change after finalization)
