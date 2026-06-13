# Nostra.chat

## What This Is

A decentralized messaging app for Telegram refugees — combining Telegram's polished UX with P2P privacy and censorship resistance. Fork of Nostra.chat (tweb) rebuilt as a PWA with Nostr-based identity, WebRTC direct connections, Nostr relay storage, and Tor privacy via webtor-rs. No phone number, no central server, no single point of failure.

## Core Value

Private, censorship-resistant messaging that feels as good as Telegram — users own their identity and data, and the app can be served from any mirror.

## Requirements

### Validated

- ✓ Seed phrase identity generation (12 words → keypair) — M001
- ✓ Key derivation (signing + encryption keys from seed) — M001
- ✓ WebRTC peer-to-peer transport with perfect negotiation — M001
- ✓ Nostr relay signaling for WebRTC (offer/answer/ICE) — M001
- ✓ Nostr relay offline message storage (NIP-04 encrypted) — M001
- ✓ Offline message queue with IndexedDB persistence — M001
- ✓ Tor privacy layer via webtor-rs (HTTP relay polling) — M002
- ✓ Display bridge integration into tweb UI — M003
- ✓ Virtual peer ID mapping (Nostr pubkey ↔ tweb peerId) — M003
- ✓ Tor stack cleanup (tor-wasm + I2P removed, webtor-rs only) — M004/M005
- ✓ Unit tests passing (chat-api, transport, offline-queue) — M005

### Active

- [ ] Nostr npub identity (replace OwnID with secp256k1 npub/nsec standard)
- [ ] NIP-05 alias system (user@domain human-readable identity)
- [ ] Simplified onboarding (seed generated in background, show npub only)
- [ ] Chat 1:1 with text (end-to-end working flow for public launch)
- [ ] Media messaging (photos, videos, GIFs in chat)
- [ ] Group messaging (P2P mesh for small groups, relay-based for large)
- [ ] Broadcast channels (one-to-many, Telegram-style)
- [ ] Tor privacy at launch (webtor-rs must work reliably for all users)
- [ ] TURN server deployment (WebRTC NAT traversal for symmetric NATs)
- [ ] Multi-relay signaling (failover across multiple Nostr relays)
- [ ] Distributed hosting (PWA servable from any mirror/IPFS for censorship resistance)
- [ ] PWA installability (works offline, installable on mobile and desktop)
- [ ] Production build pipeline (vendor stubs replaced, full build working)

### Out of Scope

- Voice/video calls — future milestone, not v1
- End-to-end encrypted backups to cloud — complexity, defer post-launch
- Custom emoji/sticker packs — nice-to-have, not launch-critical
- Monetization/premium features — open source puro, community-driven
- Mobile native app — PWA-first, native later if needed
- I2P transport — removed in M004, Tor is sufficient
- Custom Nostr relay deployment — use public relays only for v1

## Context

**Prior work (GSD v2, M001-M005):** 5 milestones completed building the P2P foundation. Core transport, identity, privacy layer, and tweb integration exist but were built with an underperforming LLM (Minimax M2.7), leaving several areas incomplete or fragile.

**Key technical decisions from prior work:**
- D031: webtor-rs only (tor-wasm removed — less mature, AGPL)
- D032: I2P removed (not production-ready in WASM)
- D033: Signaling via direct WebSocket (IP visible to relay, accepted trade-off)
- D034: Fallback chain: webtor-rs → WebSocket direct
- D040: Vendor stubs in src/vendor/ need replacement with real modules

**Identity system rewrite needed:** Current OwnID (XXXXX.XXXXX.XXXXX) replaced with Nostr npub standard + NIP-05 aliases. This enables interoperability with the Nostr ecosystem.

**Infrastructure gaps (documented in .gsd/KNOWLEDGE.md):**
- TURN server needed for symmetric NAT traversal
- Single relay (wss://relay.damus.io) → need multi-relay failover
- Snowflake bridge for webtor-rs not externally configurable

**Target users:** Telegram refugees — frustrated by censorship/privacy issues, want familiar UX but decentralized. Not crypto-native, so onboarding must be simple.

## Constraints

- **Tech stack**: Must work within tweb's Solid.js + Vite + TypeScript architecture — no framework changes
- **Privacy**: Tor (webtor-rs) is a must-have at launch, not optional
- **Identity**: Nostr npub/nsec (secp256k1) — interoperable with Nostr ecosystem
- **Infrastructure**: Zero server dependencies for message storage (public Nostr relays only); TURN server is the only required infrastructure
- **Distribution**: PWA must be servable from any origin/mirror for censorship resistance
- **License**: GPL v3 (inherited from tweb)
- **Compatibility**: Must not break existing tweb Telegram functionality (feature-gated via window.__nostraEnabled)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Nostr npub + NIP-05 alias for identity | Interop with Nostr ecosystem, standard crypto identity, human-readable aliases | — Pending |
| Simplified onboarding (seed in background) | Target users are not crypto-native; seed accessible in settings for power users | — Pending |
| Public Nostr relays only (no self-hosted) | Zero infra for storage, resilient, decentralized by default | — Pending |
| Distributed PWA hosting (multi-mirror + IPFS) | Censorship resistance — no single domain to block | — Pending |
| Tor must-have at launch | Privacy is the core differentiator for Telegram refugees | — Pending |
| Open source puro | Community-driven, no monetization, trust through transparency | — Pending |
| OwnID format replaced by npub | OwnID was proprietary, short (collision risk), no ecosystem interop | — Pending |
| v1 relay-only (no WebRTC) | All messages via Nostr relay with Tor — eliminates TURN, ICE IP leaks, NAT issues. 100% users reachable. WebRTC deferred to v2 for voice/video. | — Pending |

---
*Last updated: 2026-03-31 after initialization*
