# Project Research Summary

**Project:** Nostra.chat
**Domain:** Decentralized P2P privacy messaging (Telegram-compatible UX on Nostr + WebRTC)
**Researched:** 2026-03-31
**Confidence:** MEDIUM-HIGH

## Executive Summary

Nostra.chat is a Telegram-refugee-targeting privacy messenger built by layering a Nostr identity and relay network on top of the existing tweb (Nostra.chat) fork. The foundation — Solid.js, Vite, MTProto workers, IndexedDB — is already in place. What remains is replacing the prototype identity format (OwnID) with Nostr npub/nsec keys, migrating message encryption from the deprecated NIP-04 to NIP-44/NIP-17, hardening the single-relay signaling into a multi-relay pool, and standing up the only required infrastructure: a self-hosted coturn TURN server. These four items are the critical path; everything else (groups, channels, PWA distribution) branches off once they are complete.

The recommended build order is driven by hard technical dependencies, not feature desirability. NIP-44 cryptographic utilities must exist before identity can be rewritten. Identity must be complete before virtual peer mappings can be re-keyed. The relay pool must be multi-relay before group or channel APIs can rely on it. TURN must be deployed before any public-facing WebRTC test is credible. Skipping this order (for example, building group chat before fixing the single-relay dependency) produces features that work in development and fail for target users in censored or restricted network environments.

The top risk is deploying with any of the eight documented critical pitfalls still open: STUN-only ICE (~30% silent connection failure), NIP-04 encryption (authenticated-encryption breach), single-relay signaling (total censorship failure), plaintext key storage in IndexedDB (infostealer exposure), and unresolved vendor stubs (silent feature breakage across emoji, audio, and animation). Each of these is a launch blocker in a privacy-first product targeting adversarial environments. The research is unambiguous: none can be deferred.

## Key Findings

### Recommended Stack

The core UI stack (Solid.js, TypeScript 5.7, Vite 5) requires no changes. The Nostr layer should be added via `nostr-tools` v2.23.3 — the ecosystem standard, tree-shakeable, and shipping all needed NIPs as subpath imports. Seed phrase generation uses `@scure/bip39` and `@scure/bip32` (audited, minimal, maintained by the noble-cryptography team). The existing `@noble/secp256k1 3.0.0` can remain as long as Nostra.chat code does not mix key formats with nostr-tools internals.

For infrastructure, coturn (self-hosted on a $5-10/mo VPS) is the only required server component. Time-limited HMAC credentials must be used — never static credentials in a distributed PWA. Public STUN (stun.l.google.com) handles most NAT scenarios; coturn TURN is required for the ~30% of users on symmetric NAT. The four recommended public Nostr relays (damus.io, nos.lol, relay.primal.net, relay.nostr.band) provide multi-relay redundancy until a self-hosted relay becomes warranted at scale.

**Core technologies:**
- `nostr-tools` 2.23.3: Nostr identity, relay pool, NIP-17/44/19/06 — ecosystem standard, no NDK bloat
- `@scure/bip39` + `@scure/bip32`: BIP-39 seed phrases for NIP-06 key derivation — audited, 5KB, actively maintained
- `nostr-tools/nip17` + `nostr-tools/nip44`: Gift-wrap DMs and versioned encryption — NIP-04 replacement, Cure53-audited
- `nostr-tools/pool` (SimplePool): Multi-relay publish/subscribe with fan-out — replaces hardcoded single relay
- coturn 4.6.x (self-hosted): STUN+TURN server for WebRTC NAT traversal — required for symmetric NAT (~30% of users)
- Cloudflare Pages + GitHub Pages + own VPS: Multi-mirror PWA distribution — censorship-resistant fallback chain
- webtor-rs (existing WASM): Tor transport for IP privacy — must be made progressive (non-blocking bootstrap)

### Expected Features

**Must have (v1 launch):**
- Nostr npub identity with frictionless onboarding (seed in background, npub displayed)
- 1:1 text messaging: complete online + offline path (WebRTC direct + relay fallback)
- Multi-relay failover (3-5 relays) — single relay is a launch-blocking censor point
- TURN server operational — blocks ~30% of users without it
- Tor via webtor-rs reliable with progressive UX (app interactive within 3s, Tor upgrades in background)
- QR code / npub link for contact sharing — only viable no-phone-number discovery path
- Image sharing (photos) — Telegram refugees test this immediately
- Message delivery indicator (sent to relay)
- Offline PWA shell via service worker
- Censorship-resistant distribution (at least 2 active mirrors)

**Should have (v1.x, post-validation):**
- NIP-17 sealed DMs — privacy upgrade from NIP-04; planned breaking migration, not additive
- Group messaging (NIP-17 multi-recipient gift-wrap for ≤10 members)
- File sharing (documents) — chunked WebRTC data channel; after image sharing is stable
- Message deletion (for both sides) — NIP delete event
- Display name + NIP-05 alias — human-readable identity
- Typing indicators, optional read receipts

**Defer (v2+):**
- Broadcast channels (NIP-28, one-to-many)
- Voice/video calls (1:1 WebRTC)
- Large groups (NIP-29 relay-managed, requires relay selection UX)
- Emoji reactions, disappearing messages

**Explicit anti-features (never):**
- Phone number registration, email account recovery, address-book sync, global user search, large group video mesh, Bot API

### Architecture Approach

The architecture is a layered stack where each layer communicates only with the layer below it, and all P2P logic is isolated in `src/lib/nostra/`. The tweb UI and AppManagers layers remain untouched; Nostra.chat intercepts only at `isVirtualPeer()` boundaries and communicates back via `rootScope` events. This isolation is the kill switch: `window.__nostraEnabled = false` disables all P2P paths without touching Telegram functionality.

**Major components:**
1. `identity.ts` (upgrade) — npub/nsec keypair, NIP-05 alias, NIP-65 relay list publishing
2. `nostr-relay-pool.ts` (upgrade) — multi-relay health tracking, publish-to-all, subscribe-with-dedup, exponential backoff reconnect
3. `nip44.ts` + `nip17.ts` (new) — pure crypto/encoding utilities; no network I/O; fully unit-testable
4. `virtual-peers-db.ts` (upgrade) — extended peer types: `user | group-nip17 | group-nip29 | channel-nip28`
5. `group-api.ts` (new) — NIP-17 gift-wrap for small groups (≤12); NIP-29 relay-groups for large (deferred)
6. `channel-api.ts` (new) — NIP-28 publish/subscribe for one-to-many broadcast
7. `relay-health.ts` (new) — cross-cutting relay health tracker (latency, failure count, backoff state)
8. coturn TURN server — ops-only; no code changes; HMAC credentials injected into `NostraIceConfig`

### Critical Pitfalls

1. **STUN-only ICE fails ~30% of users silently** — deploy coturn before any public-facing test; add TURN credentials to `NostraIceConfig`; test specifically on symmetric NAT (mobile hotspot or corporate network)
2. **NIP-04 is cryptographically broken (no MAC)** — migrate `nostr-relay.ts` to NIP-44 + NIP-17 gift-wrap during the identity rewrite phase; NIP-04 may remain for reading legacy messages only
3. **Single relay is a total signaling failure point** — extend `NostrRelayPool` to connect to 3-4 relays simultaneously; publish to all; subscribe from all with client-side dedup; this is a launch requirement, not a nice-to-have
4. **Plaintext nsec/seed in IndexedDB** — use `extractable: false` CryptoKey for runtime ops; wrap stored material with AES-GCM keyed to user PIN or re-derived from seed; treat plaintext key storage as a security blocker before any public deployment
5. **Vendor stubs in production silently break emoji, audio, and animation** — restore all 9 real vendor modules from tweb source before first deployment; add build-time assertion; re-enable TypeScript checker in `vite-plugin-checker`
6. **webtor-rs 30-90s bootstrap blocks UX** — implement progressive connection: start Nostr signaling over direct WebSocket immediately; migrate to Tor once circuit is ready; show explicit privacy status badge at all times
7. **OwnID → npub migration breaks existing peer mappings** — migration function must ship alongside new format; re-key virtual peer IDs and offline queue; test with pre-populated IndexedDB, not just fresh installs
8. **ICE candidates leak real IP to relay operator** — after TURN is deployed, set `iceTransportPolicy: 'relay'` in `NostraIceConfig`; sequence matters — TURN first, then relay policy

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Production Build Pipeline & Vendor Restoration
**Rationale:** Every subsequent phase requires a trustworthy build. Vendor stubs silently break features in production; TypeScript checker disabled means regressions are invisible. This must be the first phase — not deferred — because it is a prerequisite for verifying any other work.
**Delivers:** A production-viable `pnpm build` with all vendor modules real, TypeScript checks passing, and a "Looks Done But Isn't" checklist item verified.
**Addresses:** Vendor stubs pitfall, TypeScript checker disabled technical debt
**Avoids:** Shipping to users with broken emoji, audio transcoding, and animations

### Phase 2: NIP-44 Crypto Utilities + NIP-17 Gift-Wrap Foundation
**Rationale:** These are pure cryptographic/encoding utilities with no network I/O and no dependencies. They can be built and unit-tested in complete isolation. All subsequent phases (identity, group API, channel API) depend on them.
**Delivers:** `nip44.ts` and `nip17.ts` as standalone, fully tested modules; paves the way for identity rewrite
**Uses:** `nostr-tools/nip44`, `nostr-tools/nip17`
**Implements:** Cryptographic foundation
**Research flag:** Standard — NIP specs are official and well-documented; no research phase needed

### Phase 3: Identity Rewrite (OwnID → npub) + Key Storage Encryption
**Rationale:** Identity is the dependency root for all P2P features. The OwnID format must be retired and all IndexedDB peer mappings re-keyed to npub before group or channel work can begin. Plaintext key storage is a security blocker that cannot survive first public deployment.
**Delivers:** Nostr npub/nsec keypair identity; NIP-06 BIP-39 seed → npub derivation; AES-GCM encrypted key storage; OwnID migration function; NIP-65 relay list publishing on identity init
**Uses:** `nostr-tools/nip06`, `@scure/bip39`, `@scure/bip32`, `nostr-tools/nip19`, Web Crypto API
**Implements:** `identity.ts` upgrade, IndexedDB migration version bump
**Avoids:** Plaintext key storage pitfall, OwnID migration pitfall
**Research flag:** Skip — NIP-06, BIP-39, and Web Crypto patterns are well-documented

### Phase 4: Multi-Relay Pool + Signaling Failover
**Rationale:** The single-relay dependency is a launch blocker for censorship resistance. This phase upgrades `nostr-relay-pool.ts` to manage a configurable pool with health tracking, publish-to-all, and deduplicated subscribe-from-all. It is a prerequisite for group and channel APIs.
**Delivers:** `relay-health.ts`; upgraded `nostr-relay-pool.ts` with 4-relay default set; exponential backoff reconnect; publish-to-all + dedup subscribe; NIP-65 outbox model support
**Implements:** Architecture component: `NostrRelayPool`
**Avoids:** Single relay dependency pitfall
**Research flag:** Skip — NIP-65 outbox model and SimplePool patterns are well-documented

### Phase 5: TURN Server Deployment + ICE Hardening
**Rationale:** Ops-only phase that unblocks ~30% of users. Must occur before any public-facing test. After TURN is live, `iceTransportPolicy: 'relay'` can be set to suppress ICE candidate IP leakage.
**Delivers:** coturn running on VPS; HMAC time-limited credentials; `NostraIceConfig` updated; `iceTransportPolicy: 'relay'` set; symmetric NAT test verified
**Uses:** coturn 4.6.x Docker; time-limited HMAC credential pattern
**Avoids:** STUN-only ICE pitfall, ICE candidate IP leak pitfall
**Research flag:** Skip — coturn deployment is well-documented; credential pattern is established

### Phase 6: Tor Transport Reliability (Progressive Bootstrap)
**Rationale:** The Tor differentiator is currently blocked for the first 30-90 seconds of every session. Progressive connection (direct WebSocket immediately, Tor upgrade in background) makes the app usable from first load while preserving the privacy goal. A visible privacy status badge ensures the silent-fallback pitfall is never triggered.
**Delivers:** Progressive Tor bootstrap (non-blocking); explicit privacy status UI badge; runtime-configurable Snowflake bridge URL; verified silent-fallback warning
**Implements:** `privacy-transport.ts` update; status indicator component
**Avoids:** webtor-rs bootstrap UX pitfall, silent Tor fallback pitfall
**Research flag:** May need research — webtor-rs WASM progressive loading patterns are not extensively documented externally; internal project knowledge is the primary source

### Phase 7: 1:1 Messaging E2E Polish + NIP-17 DM Migration
**Rationale:** The 1:1 messaging loop is the core product loop and the most important thing to prove at launch. This phase completes it: migrates from NIP-04 to NIP-17 (gift-wrap, sender metadata privacy), adds delivery indicators, offline queuing hardening, and image sharing via WebRTC data channel.
**Delivers:** NIP-17 sealed DMs replacing NIP-04; delivery status (sent to relay / delivered to peer); image sharing with 5MB limit enforced; offline queue reliability; Nostr replay attack protection
**Uses:** `nip17.ts` from Phase 2; multi-relay pool from Phase 4
**Avoids:** NIP-04 deprecated encryption pitfall; unbounded offline queue performance trap
**Research flag:** Skip for NIP-17 (spec is official); may need research for WebRTC data channel chunking patterns for image transfer

### Phase 8: PWA Distribution + Censorship-Resistant Hosting
**Rationale:** The app's distribution strategy is itself a feature. This phase ensures the Vite build is portable (relative paths, hash routing for IPFS compatibility), deploys to multiple mirrors, pins to IPFS, and verifies service worker offline caching. Independent of P2P features; can partially overlap with Phase 6-7.
**Delivers:** `vite.config.ts` with `base: './'`; CI/CD deploying to Cloudflare Pages + GitHub Pages + VPS simultaneously; IPFS pin via Pinata/Fleek; `copyPublicDir: true` fix; PWA manifest verified in `dist/`
**Avoids:** Absolute base URL anti-pattern; IPFS incompatibility
**Research flag:** Skip — patterns are well-documented in official Fleek and IPFS docs

### Phase 9: Group Messaging (NIP-17 Small Groups)
**Rationale:** First post-validation feature. Reuses 1:1 infrastructure (same gift-wrap, same relay pool). No new relay behaviors required. Practical limit: ~12 members before gift-wrap fan-out cost becomes noticeable.
**Delivers:** `group-api.ts`; NIP-17 multi-recipient gift-wrap for ≤12 members; `virtual-peers-db.ts` upgraded with `group-nip17` peer type; group membership UI
**Implements:** GroupAPI (NIP-17 path)
**Research flag:** Skip — NIP-17 group send pattern is documented; architecture is a direct extension of 1:1

### Phase 10: Broadcast Channels (NIP-28)
**Rationale:** Simpler than groups (no membership management; purely additive publish/subscribe). Can be built after group foundation exists. Unlocks Telegram-style one-to-many channel experience.
**Delivers:** `channel-api.ts`; NIP-28 kind 40/41/42 publish and subscribe; `virtual-peers-db.ts` upgraded with `channel-nip28` peer type; read-only subscriber view
**Implements:** ChannelAPI
**Research flag:** Skip — NIP-28 spec is final and well-documented

### Phase Ordering Rationale

- Phases 1-2 are strictly prerequisite: no trust in the build, no confidence in any feature
- Phase 3 (identity) gates everything: npub is the key into group membership, virtual peer routing, and relay outbox model
- Phase 4 (relay pool) is a prerequisite for group and channel APIs; building groups on a single relay wastes the work
- Phase 5 (TURN) must precede public user testing; all WebRTC integration tests before TURN are misleading
- Phase 6 (Tor reliability) must precede launch; the primary differentiator cannot be broken on first impression
- Phase 7 (1:1 DM + NIP-17) completes the core loop; launch validation starts here
- Phase 8 (distribution) can start in parallel with Phases 6-7 once the build pipeline (Phase 1) is proven
- Phases 9-10 (groups, channels) are post-validation; correct order is what the core user base asks for first

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 6:** webtor-rs progressive WASM loading — limited external documentation; internal project decisions (D031-D034) are the primary source; implementation patterns may need experimentation
- **Phase 7 (image transfer):** WebRTC data channel chunked file transfer — multiple competing patterns; needs concrete sizing and error recovery design before implementation

Phases with standard patterns (skip research-phase):
- **Phases 2, 3, 4, 5, 8, 9, 10:** NIP specs are official; crypto libraries are audited; coturn and PWA deployment are well-documented; patterns are established

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | nostr-tools version verified via npm/JSR; NIP specs are official; coturn and @scure/* are HIGH confidence; nostr-tools NIP-17 browser integration needs an integration test |
| Features | MEDIUM | Table stakes and differentiators derived from multi-source competitor analysis; internal architecture constraints are HIGH confidence; some feature complexity estimates are approximate |
| Architecture | HIGH | NIP specs (17, 28, 29, 44, 59, 65) are official; component boundaries follow established patterns from the existing codebase; WebRTC mesh limits are well-documented in multiple industry sources |
| Pitfalls | HIGH | Core pitfalls confirmed by project KNOWLEDGE.md, DECISIONS.md, and CONCERNS.md; external sources corroborate (OWASP, WebRTC.ventures, NIP deprecation notices) |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **NIP-17 browser integration test:** nostr-tools ships NIP-17 utilities but browser-side gift-wrap encode/decode with the existing WebSocket relay pool needs an integration test before committing to the architecture; validate in Phase 2
- **nostr-tools/nip17 availability:** confirm `nostr-tools/nip17` is a valid subpath export in v2.23.3 before writing import statements; if not present, nip17 encoding must be assembled from lower-level primitives (`nip59`, `nip44`)
- **webtor-rs progressive loading:** no public documentation on migrating from blocking to progressive Tor bootstrap; implementation will require reading the in-tree WASM module's event API; flag for Phase 6 planning
- **NIP-29 relay availability:** NIP-29 relay-managed groups require relay-side implementation; production relay support is limited as of early 2026; defer NIP-29 until adoption is verified; do not commit road to this in v1 planning
- **coturn bandwidth cost at scale:** TURN bandwidth is the only infrastructure cost that scales with users; model expected usage before committing to VPS tier; first bottleneck at 1k-10k users

## Sources

### Primary (HIGH confidence)
- `/nbd-wtf/nostr-tools` (Context7) — key generation, NIP-19 encoding, SimplePool, pool patterns
- NIP-17 official spec (nips.nostr.com/17) — private DMs, gift-wrap, sender metadata privacy
- NIP-28 official spec (nips.nostr.com/28) — public channels, kind 40-44
- NIP-29 official spec (nips.nostr.com/29) — relay-based groups
- NIP-44 official spec (nips.nostr.com/44) — versioned encryption, Cure53-audited December 2023
- NIP-59 official spec (nips.nostr.com/59) — gift-wrap protocol
- NIP-65 official spec (nips.nostr.com/65) — relay list metadata / outbox model
- NIP-06 official spec (nips.nostr.com/6) — key derivation from mnemonic
- Project KNOWLEDGE.md, DECISIONS.md, CONCERNS.md — infrastructure gaps, D031-D040 decisions
- IPFS official blog (blog.ipfs.tech/dapps-ipfs/) — PWA hosting patterns
- OWASP Web Security Testing Guide — IndexedDB encryption requirements

### Secondary (MEDIUM confidence)
- WebRTC.ventures (2025) — TURN requirement, NAT traversal, WebRTC complexity
- coturn self-hosted guide (webrtc.ventures, 2025) — deployment, HMAC credentials
- Fleek blog — IPFS + ENS censorship-resistant hosting patterns
- nostrbook.dev/groups — NIP-17/28/29 group implementation comparison
- Cloudflare Realtime TURN docs — managed TURN free tier (1,000 GB/month)
- bloggeek.me — WebRTC P2P mesh scalability limits

### Tertiary (LOW confidence)
- Webvator (2026 blog) — Nostr client ecosystem overview; used for context only, not design decisions

---
*Research completed: 2026-03-31*
*Ready for roadmap: yes*
