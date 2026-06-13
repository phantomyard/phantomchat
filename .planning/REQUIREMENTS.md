# Requirements: Nostra.chat

**Defined:** 2026-03-31
**Core Value:** Private, censorship-resistant messaging that feels as good as Telegram

## v1 Requirements

Requirements for public launch. Each maps to roadmap phases.

### Identity

- [x] **IDEN-01**: User can generate Nostr keypair from BIP-39 seed phrase (NIP-06) and derive npub/nsec
- [x] **IDEN-02**: User sees only their npub during onboarding — seed phrase generated in background, accessible in settings
- [x] **IDEN-03**: User can set a NIP-05 alias (user@domain) for human-readable identity
- [x] **IDEN-04**: User can share their identity via QR code containing npub
- [x] **IDEN-05**: User can add contacts by scanning QR code or pasting npub
- [x] **IDEN-06**: User's keys are encrypted at rest in IndexedDB (not plaintext)

### Messaging

- [x] **MSG-01**: User can send and receive 1:1 text messages via Nostr relay pool
- [x] **MSG-02**: User can send and receive 1:1 text messages when peer is offline (relay stores until peer connects)
- [x] **MSG-03**: Messages are encrypted with NIP-44 (ChaCha20-Poly1305, replacing deprecated NIP-04)
- [x] **MSG-04**: 1:1 DMs use NIP-17 gift-wrap (kind 14 → kind 13 → kind 1059) to hide metadata from relays
- [x] **MSG-05**: User can send and receive photos in chat
- [x] **MSG-06**: User can send and receive videos in chat
- [x] **MSG-07**: User sees message delivery status (sent to relay / delivered to peer)
- [x] **MSG-08**: Offline messages are queued in IndexedDB and sent when peer connects or flushed to relay

### Groups

- [x] **GRP-01**: User can create a group with up to 12 members
- [x] **GRP-02**: Group messages use NIP-17 multi-recipient gift-wrap (privacy preserved)
- [x] **GRP-03**: User can add/remove members from groups they created
- [x] **GRP-04**: User can leave a group

### Channels

- [ ] **CHN-01**: User can create a broadcast channel (NIP-28, kind 40)
- [ ] **CHN-02**: Channel owner can post messages to channel (kind 42)
- [ ] **CHN-03**: Users can subscribe to and read channels
- [ ] **CHN-04**: Channel metadata is updatable by owner (kind 41)

### Infrastructure

- [x] **INF-03**: Multi-relay messaging with SimplePool across 4+ public Nostr relays
- [x] **INF-04**: Relay failover — if primary relay is down, messaging continues via alternates
- [x] **INF-06**: User's relay list published via NIP-65 (kind 10002)

### MTProto Removal (Phase 7)

- [x] **STUB-01**: App starts without attempting any connection to Telegram MTProto data centers
- [x] **STUB-02**: ConnectionStatusComponent shows Nostr relay pool status instead of Telegram DC status
- [x] **STUB-03**: invokeApi() rejects with explicit error for non-intercepted MTProto methods; Nostra.chat-bridged methods continue working
- [x] **STUB-04**: apiManagerProxy.loadAllStates()/sendAllStates() work against local IndexedDB without MTProto
- [x] **STUB-05**: All existing tests continue to pass after MTProto stubbing

### Privacy

- [x] **PRIV-01**: Tor privacy via webtor-rs for relay storage HTTP polling (IP hidden from relays)
- [x] **PRIV-02**: Tor bootstrap is progressive — app interactive within 3s, Tor upgrades in background
- [x] **PRIV-03**: Fallback to direct WebSocket if Tor fails (with user notification)

### Distribution

- [x] **DIST-01**: Production build pipeline working (vendor stubs replaced, TypeScript checker re-enabled)
- [x] **DIST-02**: PWA installable on desktop and mobile with offline shell via service worker
- [x] **DIST-03**: PWA servable from multiple mirror domains (censorship resistance)
- [x] **DIST-04**: PWA hosted on IPFS with gateway access
- [x] **DIST-05**: Vite base path set to './' for portable builds across any origin

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Communication

- **COMM-01**: Voice calls P2P via WebRTC (requires TURN server)
- **COMM-02**: Video calls P2P via WebRTC (requires TURN server)
- **COMM-03**: Large groups via NIP-29 relay-managed groups (>12 members)

### Infrastructure (v2)

- **INF-01**: TURN server (coturn) deployed for WebRTC NAT traversal (needed for voice/video)
- **INF-02**: TURN credentials are time-limited HMAC (not static passwords in bundle)
- **INF-05**: ICE transport policy set to 'relay' to prevent IP leaks (needed when WebRTC active)

### Transport (v2)

- **TRANS-01**: WebRTC direct P2P connections for low-latency messaging
- **TRANS-02**: WebRTC data channel for real-time media streaming

### Features

- **FEAT-01**: Message reactions (emoji)
- **FEAT-02**: Disappearing messages (auto-delete timer)
- **FEAT-03**: Message editing and deletion
- **FEAT-04**: File/document sharing (chunked WebRTC data channel)
- **FEAT-05**: Custom sticker/emoji packs
- **FEAT-06**: Message search

### Platform

- **PLAT-01**: Push notifications via service worker
- **PLAT-02**: Self-hosted Nostr relay option
- **PLAT-03**: Native mobile app (Capacitor/Tauri)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Phone number registration | Core differentiator — Nostr npub identity replaces phone |
| Cloud backup of messages | Contradicts P2P/privacy model; relay storage is the backup |
| OAuth/social login | Not applicable — identity is seed phrase + Nostr keypair |
| Monetization/premium features | Open source puro, community-driven |
| I2P transport | Removed in M004, Tor via webtor-rs is sufficient |
| Custom Nostr relay hosting | Use public relays only for v1; self-hosted is v2 |
| Telegram MTProto interop | Feature-gated separate path; not a v1 concern |
| NIP-29 relay groups | Insufficient public relay support; defer to v2 for large groups |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| IDEN-01 | Phase 2 | Complete |
| IDEN-02 | Phase 2 | Complete |
| IDEN-03 | Phase 2 | Complete |
| IDEN-04 | Phase 2 | Complete |
| IDEN-05 | Phase 2 | Complete |
| IDEN-06 | Phase 2 | Complete |
| MSG-01 | Phase 4 | Complete |
| MSG-02 | Phase 4 | Complete |
| MSG-03 | Phase 2 | Complete |
| MSG-04 | Phase 4 | Complete |
| MSG-05 | Phase 4 | Complete |
| MSG-06 | Phase 4 | Complete |
| MSG-07 | Phase 4 | Complete |
| MSG-08 | Phase 4 | Complete |
| GRP-01 | Phase 5 | Complete |
| GRP-02 | Phase 5 | Complete |
| GRP-03 | Phase 5 | Complete |
| GRP-04 | Phase 5 | Complete |
| CHN-01 | Phase 6 | Pending |
| CHN-02 | Phase 6 | Pending |
| CHN-03 | Phase 6 | Pending |
| CHN-04 | Phase 6 | Pending |
| INF-03 | Phase 3 | Complete |
| INF-04 | Phase 3 | Complete |
| INF-06 | Phase 3 | Complete |
| STUB-01 | Phase 7 | Complete |
| STUB-02 | Phase 7 | Complete |
| STUB-03 | Phase 7 | Complete |
| STUB-04 | Phase 7 | Complete |
| STUB-05 | Phase 7 | Complete |
| PRIV-01 | Phase 3 | Complete |
| PRIV-02 | Phase 3 | Complete |
| PRIV-03 | Phase 3 | Complete |
| DIST-01 | Phase 1 | Complete |
| DIST-02 | Phase 1 | Complete |
| DIST-03 | Phase 1 | Complete |
| DIST-04 | Phase 1 | Complete |
| DIST-05 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 38 total
- Mapped to phases: 38
- Unmapped: 0
- Deferred to v2: 3 (INF-01, INF-02, INF-05 — TURN/ICE, needed for voice/video)

---
*Requirements defined: 2026-03-31*
*Last updated: 2026-04-02 — added STUB-01 through STUB-05 for Phase 7 MTProto removal*
