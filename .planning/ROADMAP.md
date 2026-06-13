# Roadmap: Nostra.chat

## Overview

Nostra.chat ships in seven phases. All v1 messaging goes through Nostr relays (with Tor privacy) — no WebRTC in v1. This eliminates TURN server dependency, ICE IP leaks, and NAT traversal issues entirely. WebRTC direct connections + TURN are deferred to v2 for voice/video calls. The order follows hard technical dependencies: trustworthy build → crypto + identity → multi-relay pool → 1:1 messaging → disable Telegram MTProto → groups → channels.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Build Pipeline & Distribution** - Production build working, PWA deployable from any mirror (completed 2026-04-01)
- [ ] **Phase 2: Crypto Foundation & Identity** - NIP-44 encryption, Nostr npub identity, encrypted key storage
- [x] **Phase 3: Multi-Relay Pool** - Multi-relay messaging replacing single-relay dependency (completed 2026-04-01)
- [ ] **Phase 4: 1:1 Messaging E2E** - Complete relay-based 1:1 messaging with NIP-17 DMs and media
- [ ] **Phase 7: Disable Telegram MTProto & Remove Server Dependency** - Stub MTProto layer, zero Telegram connections, remap connection status to Nostr relays
- [ ] **Phase 5: Group Messaging** - NIP-17 gift-wrap groups up to 12 members
- [ ] **Phase 6: Broadcast Channels** - NIP-28 one-to-many broadcast channels

## Phase Details

### Phase 1: Build Pipeline & Distribution
**Goal**: The production build is trustworthy and the PWA is deployable from any origin for censorship resistance
**Depends on**: Nothing (first phase)
**Requirements**: DIST-01, DIST-02, DIST-03, DIST-04, DIST-05
**Success Criteria** (what must be TRUE):
  1. `pnpm build` completes without errors, TypeScript checker passes, and all 9 vendor stub modules are replaced with real implementations
  2. The built PWA installs on mobile and desktop, loads an offline shell without a network connection, and shows a valid PWA manifest
  3. The same build artifact loads correctly from at least two distinct mirror domains (Cloudflare Pages and GitHub Pages)
  4. The PWA loads from an IPFS gateway via a pinned CID without path errors
  5. Relative asset paths (`./`) are used throughout — no absolute origin-specific URLs in the build output
**Plans**: 5 plans

Plans:
- [ ] 01-01-PLAN.md — Test scaffolds + ESLint fixes (clean build, Wave 0 tests)
- [ ] 01-02-PLAN.md — solid-transition-group implementation + TypeScript checker re-enable
- [ ] 01-03-PLAN.md — PWA headers (COOP/COEP) + GitHub Pages 404 fallback
- [ ] 01-04-PLAN.md — GitHub Actions CI/CD: Cloudflare Pages + GitHub Pages deploy
- [ ] 01-05-PLAN.md — GitHub Actions IPFS deploy + three-mirror checkpoint

### Phase 2: Crypto Foundation & Identity
**Goal**: Users have Nostr npub identity with encrypted key storage and all NIP-44/NIP-17 cryptographic primitives are available for downstream phases
**Depends on**: Phase 1
**Requirements**: MSG-03, IDEN-01, IDEN-02, IDEN-03, IDEN-04, IDEN-05, IDEN-06
**Success Criteria** (what must be TRUE):
  1. New user sees only their npub during onboarding — no seed phrase shown on screen; seed is accessible only in settings
  2. Existing OwnID users have their peer mappings and offline queue migrated to npub without data loss
  3. User's keys are stored AES-GCM encrypted in IndexedDB — plaintext nsec or seed phrase does not appear in raw IndexedDB data
  4. User can set a NIP-05 alias (user@domain) visible in their profile
  5. User can share their npub as a QR code and add a contact by scanning a QR code or pasting an npub
**Plans**: 4 plans

Plans:
- [ ] 02-01-PLAN.md — Crypto core: nostr-tools install, NIP-06 identity, NIP-44 encryption, AES-GCM key storage, identity store
- [ ] 02-02-PLAN.md — OwnID migration + onboarding redesign (Create/Import paths)
- [ ] 02-03-PLAN.md — QR identity sharing + QR scanner + contact addition
- [ ] 02-04-PLAN.md — NIP-05 alias settings + security settings (PIN/passphrase/lock screen)

### Phase 3: Multi-Relay Pool
**Goal**: Messaging is resilient — no single Nostr relay can silence the app. All message transport goes through the relay pool with Tor privacy.
**Depends on**: Phase 2
**Requirements**: INF-03, INF-04, INF-06, PRIV-01, PRIV-02, PRIV-03
**Success Criteria** (what must be TRUE):
  1. With the primary relay (wss://relay.damus.io) manually blocked, messages still deliver via alternate relays within 10 seconds
  2. The app maintains messaging connectivity when any one of the four configured relays is down
  3. User's relay list is published to Nostr via NIP-65 (kind 10002) on identity initialization
  4. Relay connections go through Tor (webtor-rs) — user IP is hidden from relay operators
  5. App is fully interactive within 3 seconds; Tor bootstrap completes in background with status indicator
  6. If Tor fails, app falls back to direct WebSocket with visible notification — no silent degradation
**Plans**: 3 plans

Plans:
- [ ] 03-01-PLAN.md — Pool + transport core: 4+ relays, dual-mode NostrRelay, NIP-65, PrivacyTransport pool wrapper
- [ ] 03-02-PLAN.md — Tor UX: shield icon, banners, fallback confirmation popup, status popup
- [ ] 03-03-PLAN.md — Wiring: relay settings CRUD, topbar integration, app init, visual verification

### Phase 4: 1:1 Messaging E2E
**Goal**: Two users can have a complete 1:1 conversation via Nostr relays with metadata-private encrypted messages and media
**Depends on**: Phase 3
**Requirements**: MSG-01, MSG-02, MSG-04, MSG-05, MSG-06, MSG-07, MSG-08
**Success Criteria** (what must be TRUE):
  1. Two users exchange text messages via Nostr relay pool; messages are NIP-17 gift-wrapped (kind 1059) so relay operators cannot read sender or recipient metadata
  2. Messages to offline peers are stored on relay; received when peer comes online — delivery indicator updates
  3. User can send a photo in chat; the recipient sees the image inline
  4. User can send a video in chat; the recipient can play it inline
  5. Message delivery status is visible per message: sending, sent to relay, delivered to peer
**Plans**: 6 plans

Plans:
- [x] 04-01-PLAN.md — NIP-17 gift-wrap migration + message store + relay kind 1059 subscription
- [x] 04-02-PLAN.md — Media pipeline: AES-256-GCM encryption + Blossom blob storage client
- [x] 04-03-PLAN.md — Delivery tracking: 4-state indicators + gift-wrapped receipts + message requests
- [x] 04-04-PLAN.md — UI wiring: display bridge media/delivery + send bridge media + visual verification
- [ ] 04-05-PLAN.md — Gap fix: EOSE-based getMessages backfill + onboarding timeout protection
- [x] 04-06-PLAN.md — Gap fix: Wire MessageRequests component into chat list UI

### Phase 7: Disable Telegram MTProto & Remove Server Dependency
**Goal**: The app makes zero connections to Telegram servers — MTProto layer stubbed, connection status remapped to Nostr relay pool, apiManagerProxy works against local IndexedDB only
**Depends on**: Phase 4
**Requirements**: STUB-01, STUB-02, STUB-03, STUB-04, STUB-05
**Success Criteria** (what must be TRUE):
  1. App starts without attempting any connection to Telegram MTProto data centers
  2. `ConnectionStatusComponent` shows Nostr relay pool status (connected/disconnected/reconnecting) instead of Telegram DC status
  3. `invokeApi()` rejects with explicit error for non-intercepted MTProto methods; Nostra.chat-bridged methods continue working
  4. `apiManagerProxy.loadAllStates()`/`sendAllStates()` work against local IndexedDB without MTProto
  5. All existing tests continue to pass
**Plans**: 3 plans

Plans:
- [x] 07-01-PLAN.md — Stub NetworkerFactory + extend api-manager-stub to reject all non-intercepted methods
- [x] 07-02-PLAN.md — Remap ConnectionStatusComponent to Nostr relay pool events
- [x] 07-03-PLAN.md — Boot path guard + apiManagerProxy verification + full regression test

### Phase 5: Group Messaging
**Goal**: Users can create private groups and exchange messages with up to 12 members using the same privacy guarantees as 1:1 DMs
**Depends on**: Phase 7
**Requirements**: GRP-01, GRP-02, GRP-03, GRP-04
**Success Criteria** (what must be TRUE):
  1. User can create a group with up to 12 members — the group appears in the chat list and all members receive the invitation
  2. Group messages are delivered to all members via NIP-17 multi-recipient gift-wrap — relay operators cannot determine group membership
  3. Group creator can add or remove members; removed members no longer receive new group messages
  4. Any member can leave a group; the group continues working for remaining members
**Plans**: 5 plans

Plans:
- [x] 05-01-PLAN.md — Group data layer: GroupStore IndexedDB, nostr-crypto multi-recipient wrapping, control messages
- [x] 05-02-PLAN.md — GroupAPI lifecycle + delivery tracker + display/send bridge group support
- [x] 05-03-PLAN.md — (Superseded by gap closure plans 04+05) UI components — orphaned
- [x] 05-04-PLAN.md — Gap fix: initGroupAPI + AppNostraNewGroupTab + wire onNewGroupClick
- [ ] 05-05-PLAN.md — Gap fix: AppNostraGroupInfoTab + topbar hook + delete orphaned components + visual checkpoint

### Phase 6: Broadcast Channels
**Goal**: Users can create and subscribe to one-to-many broadcast channels in the Telegram-channel style
**Depends on**: Phase 5
**Requirements**: CHN-01, CHN-02, CHN-03, CHN-04
**Success Criteria** (what must be TRUE):
  1. User can create a channel; it appears in their chat list and generates a shareable channel ID
  2. Channel owner can post messages and they appear for all subscribers in real time
  3. Any user can subscribe to a channel by ID and read all channel messages
  4. Channel owner can update the channel name and description; subscribers see the updated metadata
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in order: 1 → 2 → 3 → 4 → 7 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Build Pipeline & Distribution | 5/5 | Complete   | 2026-04-01 |
| 2. Crypto Foundation & Identity | 3/4 | In Progress|  |
| 3. Multi-Relay Pool | 3/3 | Complete   | 2026-04-01 |
| 4. 1:1 Messaging E2E | 4/6 | In Progress|  |
| 7. Disable Telegram MTProto | 0/3 | Not started | - |
| 5. Group Messaging | 2/5 | In Progress|  |
| 6. Broadcast Channels | 0/? | Not started | - |
