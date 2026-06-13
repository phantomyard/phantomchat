# Phase 2: Crypto Foundation & Identity - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Users have Nostr npub identity with encrypted key storage and all NIP-44/NIP-17 cryptographic primitives are available for downstream phases. Includes: keypair generation (NIP-06), npub/nsec encoding, encrypted key storage (AES-GCM), NIP-05 alias, QR code identity sharing, contact addition, and OwnID migration. Does NOT include: actual messaging (Phase 4), relay pool setup (Phase 3), or group features (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Onboarding flow
- Welcome screen with two paths: "Create New Identity" and "Import Seed Phrase"
- Create path: auto-generates seed in background, shows npub with Copy button + "Get Started"
- Import path: 12 individual numbered input fields (grid layout), one word per field, auto-advance focus
- Display name step: optional, skippable — falls back to truncated npub if skipped
- No seed phrase shown during onboarding — accessible only in Settings > Security

### OwnID migration
- Silent migration — no user prompt
- On app update: detect existing OwnID in IndexedDB → load seed → derive secp256k1 keypair (NIP-06) → encode as npub/nsec (bech32) → re-map virtual peers → re-encrypt offline queue messages
- Old OwnID removed from storage after successful migration

### Key protection
- Three user-selectable options: PIN (4-6 digits), passphrase (text), or no protection (browser-scoped CryptoKey)
- Default: browser-scoped (no user input required) — non-exportable CryptoKey via Web Crypto API
- PIN/passphrase stretched via PBKDF2 to derive AES-GCM encryption key for nsec/seed
- Protection NOT asked during onboarding — configurable in Settings > Security
- Lock screen on app open when PIN or passphrase is active
- Recovery path: "Forgot PIN?" → re-import 12-word seed → set new PIN/passphrase
- Storage layout: salt (16 bytes), iv (12 bytes), encrypted_keys (AES-GCM blob), npub (public, unencrypted)

### NIP-05 alias
- Self-hosted .well-known/nostr.json only (no centralized provider)
- Setup in Settings > Identity > NIP-05: user enters alias → Nostra.chat shows instructions for .well-known setup → verifies via GET request
- Verified badge (green check) shown in profile AND chat list next to display name
- Auto-verification of contacts' NIP-05 aliases — re-verify every 24 hours
- Alias published as Nostr kind 0 metadata event to relays (interoperable with Nostr ecosystem)

### Contact exchange
- Access from two points: FAB (floating action button) in chat list + sidebar menu item
- FAB tap shows: "Scan QR Code" and "Paste npub"
- Dedicated "My QR" screen: accessible from profile/sidebar, shows QR code with npub + display name + NIP-05 alias if set + Copy npub button + Share QR as image
- QR scanner supports both live camera AND gallery image upload (for received screenshots)
- After adding contact (QR scan or npub paste): open chat directly, no confirmation step
- Contact display name and NIP-05 alias loaded async via kind 0 metadata from relays

### Claude's Discretion
- QR code styling (colors, logo, corner style) — qr-code-styling library already available
- Exact lock screen UI design
- PBKDF2 iteration count for PIN/passphrase stretching
- BIP-39 checksum validation strictness on import
- NIP-44 encryption implementation details (ChaCha20-Poly1305 internals)
- NIP-17 gift-wrap primitive structure (kind 14 → kind 13 → kind 1059)
- How to handle contacts with no kind 0 metadata (display as truncated npub)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **identity.ts** (`src/lib/nostra/identity.ts`): Has generateSeed(), validateSeed(), deriveKeys() with PBKDF2 — needs refactoring from OwnID to npub but core crypto logic is reusable
- **wordlist.ts** (`src/lib/nostra/wordlist.ts`): BIP-39 2048-word English wordlist already present
- **@noble/secp256k1** (v3.0.0): Already in deps — provides getPublicKey, sign, getSharedSecret for Nostr keypair operations
- **qr-code-styling** (v1.5.0): Already in deps — used in pageSignQR.ts for Telegram login QR, can be reused for npub QR
- **nostr-relay.ts**: Has nip04Encrypt/nip04Decrypt — needs NIP-44 upgrade but the relay communication patterns are reusable
- **keyStore.ts** (`src/lib/passcode/keyStore.ts`): Existing EncryptionKeyStore class with CryptoKey management — can be extended for PIN/passphrase key storage
- **virtual-peers-db.ts**: IndexedDB-backed pubkey ↔ peerId mapping — already functional, needs migration from OwnID keys to npub keys
- **nostra-bridge.ts**: mapPubkeyToPeerId(), createSyntheticUser() — deterministic peer ID generation from pubkeys

### Established Patterns
- **IndexedDB stores**: Three Nostra.chat-specific DBs already exist (Nostra.chat/identity, nostra-virtual-peers, nostra-offline-queue) — follow same pattern for new stores
- **Vendor aliases**: All imports via @vendor/*, @lib/*, @helpers/* — new crypto modules follow same convention
- **rootScope events**: State changes propagate via rootScope.dispatchEvent() — identity events should follow same pattern
- **Solid.js stores**: Reactive state via createSignal + rootScope listener in src/stores/ — identity state should have a store

### Integration Points
- **Onboarding page** (`src/pages/nostra/onboarding.ts`): Existing OwnID onboarding — needs redesign for npub flow (Create/Import choice)
- **pageSignQR.ts** (`src/pages/pageSignQR.ts`): QR code rendering logic reusable for npub QR screen
- **Sidebar** (`src/components/sidebarLeft/`): "Add Contact" menu item + "My QR" link to add
- **Chat list FAB**: Existing new-chat button needs "Add P2P Contact" option
- **Settings tabs** (`src/components/sidebarLeft/tabs/`): nostraRelaySettings.ts exists — add Security and Identity tabs in same pattern

</code_context>

<specifics>
## Specific Ideas

- Onboarding should feel familiar to Telegram refugees — two clear paths (new vs import), minimal crypto jargon
- Lock screen when PIN/passphrase is set — like Telegram's passcode lock
- QR screen should be easily shareable (save as image for WhatsApp/Telegram groups where refugees organize)
- Contact addition → immediate chat open, zero friction — like Telegram's t.me/username links
- NIP-05 badge should look like Twitter/Nostr verification badge (green check)
- User communicates in Italian — UI strings should be i18n-ready

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-crypto-foundation-identity*
*Context gathered: 2026-04-01*
