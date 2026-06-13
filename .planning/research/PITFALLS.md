# Pitfalls Research

**Domain:** Decentralized P2P messaging (WebRTC + Nostr + Tor / WASM)
**Researched:** 2026-03-31
**Confidence:** HIGH (core pitfalls confirmed by project history and official sources)

---

## Critical Pitfalls

### Pitfall 1: STUN-Only ICE Fails ~30% of Users Silently

**What goes wrong:**
The current `NostraIceConfig` in `src/lib/nostra/peer.ts` uses only Google's free STUN servers. WebRTC ICE negotiation appears to succeed in development (where peers are on simple home NATs or the same network), but silently fails for users behind symmetric NAT — common in enterprise networks, carrier-grade NAT (CGNAT), and many mobile carriers. Symmetric NAT peers cannot be reached by STUN; they require relay via TURN. Industry data: up to 30% of WebRTC sessions require TURN to connect.

**Why it happens:**
STUN works in developer environments and passes all unit tests. The failure mode only appears when users are behind restrictive NATs. Developers ship STUN-only because it works for them and TURN requires operational infrastructure.

**How to avoid:**
Deploy a TURN server (coturn on a VPS, or a managed service like Metered.ca or Xirsys) and add TURN credentials to `iceServers` in `NostraIceConfig`. For a privacy-focused app, self-hosted coturn on a hardened VPS is preferred over commercial services that log connections. The TURN server is the only required infrastructure for Nostra.chat.

**Warning signs:**
- "Works on my machine" but users report connection failures
- Connections succeed on home WiFi but fail on corporate/mobile networks
- ICE state stays at "checking" then fails with no data channel open event
- All failing users share corporate NAT or carrier networks

**Phase to address:**
Infrastructure setup phase — TURN must be deployed and credentials injected into `NostraIceConfig` before any public-facing testing. Cannot be deferred to post-launch.

---

### Pitfall 2: NIP-04 Is Cryptographically Broken — Actively Deprecated

**What goes wrong:**
Nostra.chat's offline message storage uses NIP-04 encrypted direct messages (kind 4 events) for relay storage. NIP-04 uses AES-256-CBC with no message authentication code (MAC). This means messages can be silently altered in transit by any relay that handles them — receivers cannot detect tampering. Additionally, AES-CBC with improper PKCS7 padding validation can leak information. NIP-04 is formally deprecated in the Nostr protocol; the community replacement is NIP-44 (ChaCha20-Poly1305, Curve25519 XDH, Cure53-audited December 2023).

**Why it happens:**
NIP-04 was the only available standard when Nostra.chat's relay storage was built (M001). NIP-44 was merged and stabilised after development began. Projects that shipped NIP-04 and are not tracking Nostr NIPs remain unaware the standard changed.

**How to avoid:**
Migrate `src/lib/nostra/nostr-relay.ts` from NIP-04 (kind 4 events) to NIP-44 encryption. NIP-44 uses versioned encryption payloads, so future algorithm changes are non-breaking. The migration requires: (1) encrypting with `nip44.encrypt()` instead of `nip04.encrypt()`, (2) choosing an appropriate event kind (NIP-17 private direct messages via kind 14 sealed with gift-wrapping is the current recommendation for DMs), (3) verifying that relay storage and retrieval remain functional with the new format.

**Warning signs:**
- Any usage of `aes-256-cbc` in custom NIP-04 implementation
- Kind 4 events in relay queries (`["REQ", ..., {"kinds":[4]}]`)
- No MAC/HMAC verification on decrypted payloads
- Nostr library version older than 2024

**Phase to address:**
Identity system rewrite phase (npub migration). The identity and encryption layers are coupled; rewriting both together avoids a second migration pass.

---

### Pitfall 3: Single Relay Dependency Causes Total Signaling Failure

**What goes wrong:**
`NostrSignaler` in `src/lib/nostra/signaling.ts` defaults to `wss://relay.damus.io`. If this relay is down, rate-limited, banning IPs from certain countries, or simply congested, WebRTC signaling is completely unavailable — no offer/answer/ICE exchange can occur and no P2P connections can be established. This is a single point of failure for the entire transport layer.

**Why it happens:**
Single relay is the simplest implementation. Public relays like damus.io are reliable enough for local testing. The failure only manifests when the relay has operational issues or blocks specific users/regions (which censored users — Nostra.chat's target market — are most likely to encounter).

**How to avoid:**
Implement multi-relay signaling with automatic failover. The `NostrSignaler` should maintain a prioritised list of relay URLs and try the next relay when the current one fails to connect within a timeout (5-10 seconds). Minimum viable: three heterogeneous public relays (damus.io, relay.nostr.band, nos.lol). Better: include a self-hosted relay as the primary for guaranteed availability. Write signaling events to all available relays simultaneously and deduplicate received events.

**Warning signs:**
- Hardcoded single relay URL in `signaling.ts`
- No relay connection timeout or retry logic
- WebRTC signaling tests that mock the relay and never test actual relay connectivity
- Users in censored regions unable to connect while users elsewhere connect fine

**Phase to address:**
Multi-relay signaling phase — must be complete before public launch. This is a prerequisite for censorship resistance, not a nice-to-have.

---

### Pitfall 4: WebRTC ICE Candidates Leak Real IP Addresses

**What goes wrong:**
WebRTC ICE candidate exchange exposes the user's real IP address (both local network IP and public IP via STUN reflexive candidates) in the signaling messages visible to the Nostr relay. For a privacy-focused app targeting users in censored regions, this undermines the Tor layer: webtor-rs hides the user's IP for HTTP traffic, but the signaling exchange over native WebSocket and the ICE candidates in signaling messages directly expose the IP.

This is partially documented in D033 (accepted trade-off for signaling), but the ICE candidate exposure is a separate and more concrete risk: ICE candidates are present in plain-text Nostr event tags even though message content is NIP-04 encrypted.

**Why it happens:**
ICE candidate generation is automatic and produces host candidates (local IPs) and srflx candidates (STUN-reflected public IPs). Developers focus on functionality and do not audit the content of signaling messages for IP leakage. The relay operator (and anyone who can monitor relay traffic) sees these candidates.

**How to avoid:**
Two complementary mitigations: (1) Once TURN is deployed, set `iceTransportPolicy: 'relay'` in `NostraIceConfig` — this forces all ICE candidates to be relay candidates through TURN, suppressing host and srflx candidates that reveal the user's IP. (2) For users with Tor active, verify that webtor-rs is routing the Nostr relay WebSocket connection (currently it cannot — D033 — but this should be revisited if WebSocket-over-Tor becomes available). Note: `iceTransportPolicy: 'relay'` requires TURN to be deployed first; setting it without TURN causes all connections to fail.

**Warning signs:**
- ICE candidate events in the signaling log contain `typ host` or `typ srflx` entries
- No `iceTransportPolicy` set in `NostraIceConfig`
- Privacy-conscious users able to enumerate relay operator's ability to correlate identities

**Phase to address:**
TURN deployment phase (prerequisite) then ICE transport policy hardening. Sequence matters: deploy TURN first, then switch to `relay` policy.

---

### Pitfall 5: Vendor Stubs in Production Build Cause Silent Feature Breakage

**What goes wrong:**
`src/vendor/` is gitignored (D040). 9 stub files were created to unblock the build: `emoji.ts`, `emoji/regex.ts`, `bezierEasing.ts`, `fastBlur.ts`, `opus.ts`, `libwebp-0.2.0.ts`, `convertPunycode.ts`, `prism.ts`, `solid-transition-group.ts`. These stubs return safe no-ops or empty values. If these stubs reach a production build, emoji rendering will be broken, audio transcoding (opus) silently fails, image compression (libwebp) produces no output, smooth animations (bezierEasing, fastBlur) are missing, and syntax highlighting (prism) shows plain text.

**Why it happens:**
Stubs were created as a development workaround. In a monorepo with gitignored vendor assets, CI pipelines often do not reproduce the full vendor setup, and the "build passes" signal gives false confidence that the app is production-ready.

**How to avoid:**
Before any public-facing deployment: (1) restore all 9 real vendor modules from the original tweb source, (2) add a build-time assertion that stubs are not present in production bundles (check for a known stub sentinel, e.g., a comment or export), (3) re-enable TypeScript checking in `vite-plugin-checker` (it was disabled in D040 due to missing modules). Treat stub presence in a production build as a P0 blocker.

**Warning signs:**
- `typescript: false` in `vite-plugin-checker` config
- Any file in `src/vendor/` that exports an empty function or returns `null`/`undefined` for a value that should be real data
- Emoji display showing boxes instead of emoji characters
- No smooth easing on animations that should have it

**Phase to address:**
Production build pipeline phase — this must be resolved in the first production-targeted milestone before any user-facing deployment.

---

### Pitfall 6: Seed Phrase / nsec Exposure in Browser Storage

**What goes wrong:**
The identity system stores the seed phrase and private keys (nsec) in IndexedDB without encryption at rest (confirmed concern in CONCERNS.md). IndexedDB data is stored in plain text on disk. An infostealer, malicious browser extension, or physical access to the device can extract the private key trivially. For a privacy-first app targeting users in adversarial environments (censored regions), this is a severe threat: loss of private key means permanent identity loss and retroactive decryption of all stored messages if an attacker obtained relay history.

**Why it happens:**
IndexedDB is the natural persistence layer in browser apps. Encrypting keys at rest requires a user-provided PIN or passphrase, which adds UX friction developers tend to defer. The result is an unencrypted key in storage from prototype through launch.

**How to avoid:**
Use the Web Crypto API's `CryptoKey` with `extractable: false` for runtime key operations — keys never leave the browser's key storage in extractable form. For persistence, use the CryptoKey export mechanism only with AES-GCM wrapping tied to a user PIN. Alternative: derive a storage-encryption key from the user's seed phrase itself (re-derive on login), never storing the raw seed — only the encrypted blob. At minimum, mark the `nsec`/`seed` fields in IndexedDB as needing encryption before launch and treat plaintext storage as a security blocker.

**Warning signs:**
- `seed` or `privateKey` fields stored as plain strings in IndexedDB
- No PIN/passphrase prompt on app load or identity access
- `encryptedStorageLayer.ts` not applied to offline queue or identity store
- DevTools Application → IndexedDB shows readable key material

**Phase to address:**
Identity rewrite phase (OwnID → npub). Security posture for key storage must be decided here; retrofitting encryption after user data exists is a migration nightmare.

---

### Pitfall 7: OwnID → npub Migration Breaks Existing Peers

**What goes wrong:**
The current identity system uses the OwnID format (`XXXXX.XXXXX.XXXXX`). The planned migration to Nostr npub/nsec (secp256k1) will change the identifier format for all users. Any existing peer-to-peer connections, virtual peer mappings in IndexedDB (via `virtual-peers-db.ts`), and offline queue entries keyed by OwnID will become invalid after migration. Users who had added contacts by OwnID cannot reach those contacts until both sides migrate. The virtual peer ID derivation formula (`VIRTUAL_PEER_BASE + hashBigInt % VIRTUAL_PEER_RANGE`) is keyed to OwnID, so the entire peer mapping layer needs to be re-keyed to npub.

**Why it happens:**
Identity format changes mid-project are common when a prototype format (OwnID) is replaced with a standard (npub). The data migration is easy to overlook because it only manifests when users have existing data — not in fresh installs tested during development.

**How to avoid:**
Write a migration function that: (1) reads existing identity from IndexedDB (OwnID format), (2) derives the corresponding npub from the same seed using secp256k1, (3) re-keys all virtual peer mappings and offline queue entries, (4) writes the new npub-format identity. Run the migration function on first load after the identity update ships. Test with pre-populated IndexedDB data, not just fresh installs.

**Warning signs:**
- No IndexedDB migration version bump when identity format changes
- Virtual peer IDs still derived from OwnID hash after npub migration
- Offline queue entries still use `to: ownId` format instead of `to: npub`
- E2E tests only test fresh installs, never existing-user upgrade paths

**Phase to address:**
Identity rewrite phase — migration logic must ship alongside the new format, not as a follow-up.

---

### Pitfall 8: webtor-rs Bootstrap Time Blocks All Signaling

**What goes wrong:**
webtor-rs (Tor WASM) takes 30-90 seconds to bootstrap a Tor circuit. During this window, the privacy transport is in `bootstrapping` state. Currently the fallback chain goes: webtor-rs → direct WebSocket (D034). If the app waits for webtor-rs bootstrap to complete before attempting Nostr signaling, WebRTC signaling is delayed by 30-90 seconds. In practice, many users will think the app is broken and abandon. If the fallback fires prematurely, users get direct WebSocket connections with no Tor privacy — which defeats the core differentiator.

**Why it happens:**
The bootstrap timeout (60 seconds in `privacy-transport.ts`) was chosen to give Tor a fair chance. But in adversarial network conditions (which is exactly when users need Tor most), bootstrap can take longer or fail partially. The UX shows a spinner but provides no feedback about what is happening.

**How to avoid:**
Implement progressive connection: begin Nostr signaling via direct WebSocket immediately (for speed), while simultaneously bootstrapping webtor-rs in the background. Once Tor circuit is ready, migrate future signaling and all storage requests to go through Tor. Show a clear "Privacy: Connecting via Tor... / Active / Direct" status indicator. Never silently downgrade to direct without a user-visible notice. This approach means signaling IP is exposed for the first connection session but subsequent sessions use Tor — an acceptable trade-off for UX versus a broken first experience.

**Warning signs:**
- No progress indicator during Tor bootstrap beyond a generic spinner
- Users must wait for Tor before the app becomes interactive
- Bootstrap timeout set to a fixed value without network condition awareness
- No user-visible privacy status indicator in the UI

**Phase to address:**
Tor reliability phase — before public launch. The UX around Tor bootstrap is currently underdeveloped and will cause first-impression failures.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Vendor stubs (D040) | Build unblocked without real vendor modules | All vendor-dependent features silently broken in production | Never — must replace before first real deployment |
| Single Nostr relay | Simple implementation, easy to test | Total signaling failure if relay is down; unacceptable for launch | Never in production — multi-relay is a launch requirement |
| NIP-04 encryption | Available when built, widely supported | Deprecated, malleable ciphertexts, replaced by NIP-44 | Only for reading legacy messages during migration window |
| STUN-only ICE | Zero infrastructure cost | ~30% of users cannot connect, fails silently | Only for internal developer testing |
| No key-at-rest encryption | No UX friction for PIN/passphrase | Keys extractable by infostealers, browser extensions, device access | Never for a privacy-first app |
| TypeScript checker disabled | Build succeeds with missing modules | Type errors accumulate undetected, regressions become invisible | Only as temporary unblock, never past MVP |
| Direct WebSocket fallback (D034) | Functional if Tor fails | Silent privacy downgrade without user awareness | Only with explicit user-visible status indicator |
| LRU cache capped at 100 peers | Bounded memory use | Power users with 100+ chats hit constant cache misses | Acceptable for v1 if cache miss triggers DB lookup (not failure) |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Nostr relay signaling | Assuming relay connection is instant; no timeout before ICE gathering | Add 5-10 second relay connection timeout; start ICE gathering only after relay ACKs subscription |
| WebRTC perfect negotiation | Not handling `onnegotiationneeded` firing before signaling channel is open | Queue pending negotiations; flush when relay WebSocket opens |
| webtor-rs HTTP polling | Polling every 3s regardless of connection state | Back off to 30s when transport is `direct` (no Tor); resume 3s when Tor is active |
| Nostr relay event filtering | Using `since` filter with local clock time | Use relay server time or add a 60-second buffer to `since` to account for clock skew |
| IndexedDB migrations | Bumping version without writing migration code | Always write `onupgradeneeded` handlers for each version bump; test upgrade paths |
| Virtual peer ID mapping | Deriving peer ID only at creation time | Re-derive and verify on every lookup; log warnings if DB entry is inconsistent |
| ICE candidate leak through relay | Assuming NIP-04 content encryption hides ICE candidates | ICE candidates are in Nostr event tags, not content — they are visible to relay operators even with encrypted content |
| webtor-rs WebSocket limitation | Attempting to proxy native WebSocket through webtor-rs HTTP fetch API | webtor-rs supports HTTP fetch only; WebSocket must use native API (IP exposed to relay — D033) |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded offline queue | Memory grows until tab crashes; IndexedDB quota exhausted | Cap queue at 500 messages; purge delivered messages aggressively; warn user when queue is large | ~1000 queued messages |
| No relay connection pooling | New WebSocket opened for every relay query; browser connection limit reached | Reuse relay connections; pool connections by relay URL | >6 simultaneous relay connections |
| HTTP polling Nostr relay at 3s intervals | Battery drain on mobile; relay rate-limits the client | Implement long-polling or WebSocket where Tor permits; back off to 30s on mobile or when app is backgrounded | Continuous background usage |
| Large base64 media in IndexedDB | Slow message load times; IndexedDB quota exceeded quickly | Enforce 5 MB photo / 10 MB video limits (already in MediaPicker); consider CacheStorage for media blobs | First multi-media chat session |
| Virtual peers LRU cache (100 entries) | Cache miss on every message send for power users; noticeable latency | Increase to 500 or implement persistent local cache with IndexedDB fallback on miss | >100 active P2P chats |
| tweb message history loading all at once | Mobile browsers with large Nostr history become unresponsive | Implement pagination; load last 50 messages, fetch older on scroll | ~500 messages per chat |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| NIP-04 AES-CBC without MAC | Relay can silently alter message content; recipient cannot detect tampering | Migrate to NIP-44 (ChaCha20-Poly1305 with Poly1305 MAC — authenticated encryption) |
| nsec/seed stored plaintext in IndexedDB | Infostealer, malicious extension, or device access extracts private key | Encrypt key material at rest with AES-GCM; use `extractable: false` CryptoKey for runtime operations |
| ICE candidates expose real IP to relay | Relay operator can correlate npub with IP address; defeats Tor privacy | Set `iceTransportPolicy: 'relay'` once TURN is deployed to suppress host/srflx candidates |
| Nostr signaling over direct WebSocket | Relay operator sees user IP during signaling (D033) | Accepted trade-off; mitigate with `iceTransportPolicy: 'relay'`; revisit when WebSocket-over-Tor is available |
| No replay attack protection on Nostr messages | Old Nostr events replayed by relay to re-deliver messages | Track highest seen `created_at` per peer; reject events older than tolerance window (e.g., 5 minutes) |
| Silent fallback from Tor to direct | User believes Tor is active; app silently sends via direct WebSocket | Always surface privacy status; never silently downgrade; require explicit user acknowledgement for downgrade |
| XSS via rich text in P2P messages | Attacker sends malicious Nostr message content rendered as HTML | All Nostr message content must pass through the same `wrapRichText` entity-sanitizing pipeline used for MTProto messages |
| Nostr pubkey in relay query tags | Relay operator knows which npubs are querying for messages from which other npubs — social graph leak | Use NIP-17 sealed gift-wrap events (recipient pubkey in encrypted content, not in cleartext tag) for DMs |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing "seed phrase" terminology | Non-crypto users confused; conflate with password; store insecurely | Use "recovery phrase" or "backup phrase"; explain once in plain language with a real-consequences warning |
| Blocking UI until Tor bootstraps (30-90s) | Users think app is broken; abandon on first launch | Allow app to be interactive immediately; show Tor status as a status badge that updates in background |
| No indicator of connection state | Users send messages not knowing peer is offline; expect instant delivery | Show "queued — peer offline" state in chat; show "sending via Tor / direct" per-message indicator |
| Onboarding generates seed but never forces backup | User loses phone → loses identity permanently | Require seed phrase acknowledgement step during onboarding; cannot proceed to chat without confirming backup |
| npub format shown as primary identity | Non-crypto users cannot understand or share a 63-character bech32 string | Show NIP-05 alias as primary (user@domain format); show npub only in settings for power users |
| Identity reuse across multiple devices not explained | User creates new identity on second device; loses contact with existing peers | Explain seed portability during onboarding; provide clear "import identity" flow |
| TURN server credentials in client bundle | Credentials are public in distributed PWA; TURN abused by third parties | Use time-limited TURN credentials (TURN REST API with TTL); rotate credentials regularly |

---

## "Looks Done But Isn't" Checklist

- [ ] **TURN server:** ICE candidates resolve and data channel opens — verify on a symmetric NAT (use a mobile hotspot or test with a tool like `checkmynat.com`); STUN-only will pass all LAN tests.
- [ ] **NIP-04 migration:** Encryption uses `nip44.encrypt()` — verify event kind is not 4 and payload is not `iv:ciphertext` base64 format.
- [ ] **Vendor stubs replaced:** All 9 `src/vendor/` modules are real implementations — verify emoji renders, smooth animations play, Opus encoding produces valid audio frames.
- [ ] **TypeScript checker re-enabled:** `vite-plugin-checker` has `typescript: true` — build fails on type errors, not silently.
- [ ] **Multi-relay failover:** `NostrSignaler` connects to relay 2 when relay 1 is down — verify by blocking `wss://relay.damus.io` in hosts file and confirming signaling still works.
- [ ] **ICE transport policy:** `iceTransportPolicy: 'relay'` is set and TURN credentials are present — verify no `typ host` or `typ srflx` candidates appear in signaling events.
- [ ] **Key storage encryption:** `nsec`/`seed` fields in IndexedDB are not readable plain text — verify in DevTools Application → IndexedDB.
- [ ] **Tor fallback visible:** When webtor-rs falls back to direct WebSocket, a user-visible indicator changes — verify by blocking Snowflake bridge and confirming status badge updates.
- [ ] **OwnID → npub migration:** Existing IndexedDB identity is migrated, not abandoned — test by seeding old-format identity and upgrading the app.
- [ ] **PWA manifest in dist:** `dist/site.webmanifest` exists after `pnpm build` — `copyPublicDir: true` must be set (D038).
- [ ] **Nostr event replay protection:** Duplicate Nostr events (same `id`) delivered by relay do not create duplicate messages — verify by replaying a stored event.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Vendor stubs shipped to production | HIGH | Hotfix build with real vendor modules; force service worker cache invalidation; user re-installs PWA |
| NIP-04 in production (messages tampered) | HIGH | Migrate to NIP-44; existing NIP-04 messages unrecoverable if tampered; communicate breach to users |
| Single relay down at launch | MEDIUM | Add relay URLs to config without code change (if config is externalisable); DNS update to self-hosted relay |
| STUN-only at launch (~30% failure) | MEDIUM | Provision TURN server (coturn, 2-4 hours); push config update; affected users can retry |
| Plaintext keys discovered by attacker | CRITICAL/UNRECOVERABLE | Rotate all user keys (impossible — users must generate new identity); no recovery for past messages if attacker had relay access |
| webtor-rs bootstrap blocking UX | LOW | Progressive connection patch; deploy in hotfix; no data loss |
| OwnID migration missed, users lose contacts | MEDIUM | Provide manual "re-add contact by npub" flow; automated migration not possible without both peers online |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| STUN-only ICE (no TURN) | Infrastructure setup | Test on symmetric NAT; confirm TURN candidates appear in ICE logs |
| NIP-04 deprecated encryption | Identity rewrite (OwnID → npub) | Audit event kinds in relay queries; confirm NIP-44 payloads |
| Single relay dependency | Multi-relay signaling phase | Block primary relay; confirm signaling succeeds via secondary |
| ICE candidate IP leak | TURN + ICE policy hardening phase | Capture signaling events; verify no host/srflx candidates present |
| Vendor stubs in production | Production build pipeline phase | `pnpm build` produces fully functional dist with all vendor assets |
| Plaintext key storage | Identity rewrite phase | DevTools IndexedDB shows encrypted blobs, not raw key strings |
| OwnID → npub migration | Identity rewrite phase | Load pre-migration IndexedDB; verify contacts and queue entries survive |
| webtor-rs bootstrap UX | Tor reliability phase | First-launch experience test; app interactive within 3 seconds of load |
| Silent Tor fallback | Tor reliability phase | Block Snowflake; verify status badge updates and user sees warning |
| Replay attack on Nostr messages | Identity rewrite phase | Replay stored Nostr event; verify no duplicate message in UI |

---

## Sources

- Project `KNOWLEDGE.md` — infrastructure gaps documented (TURN, single relay, Snowflake bridge), D033 IP trade-off
- Project `DECISIONS.md` — D031 (webtor-rs only), D033 (signaling IP trade-off), D034 (fallback chain), D040 (vendor stubs)
- Project `CONCERNS.md` — IndexedDB plaintext key storage, relay pool no retry limit, LRU cache limit, ICE candidate exposure
- [Why WebRTC Remains Deceptively Complex in 2025 — WebRTC.ventures](https://webrtc.ventures/2025/08/why-webrtc-remains-deceptively-complex-in-2025/)
- [WebRTC NAT Traversal Methods: A Case for Embedded TURN — LiveSwitch](https://www.liveswitch.io/blog/webrtc-nat-traversal-methods-a-case-for-embedded-turn)
- [NIP-04 considered harmful — nostr-protocol/nips #107](https://github.com/nostr-protocol/nips/issues/107)
- [NIP-44: Encrypted Payloads (Versioned) — nips.nostr.com](https://nips.nostr.com/44)
- [Understanding and Preventing WebRTC IP Leaks in 2025 — VideoSDK](https://www.videosdk.live/developer-hub/webrtc/webrtc-ip-leaks)
- [Of Secrets and Seedphrases: CHI 2025](https://dl.acm.org/doi/10.1145/3706598.3713209)
- [IPFS and decentralized app distribution pitfalls — IPFS Blog](https://blog.ipfs.tech/dapps-ipfs/)
- [Nostr relay single point of failure — nostr.how](https://nostr.how/en/relays)
- [IndexedDB security and encryption — OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/11-Client-side_Testing/12-Testing_Browser_Storage)

---
*Pitfalls research for: Decentralized P2P messaging (WebRTC + Nostr + Tor WASM)*
*Researched: 2026-03-31*
