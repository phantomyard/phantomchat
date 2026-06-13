# Feature Research

**Domain:** Decentralized P2P privacy messaging (Telegram-compatible UX)
**Researched:** 2026-03-31
**Confidence:** MEDIUM (competitor features via WebSearch verified against multiple sources; internal architecture constraints from PROJECT.md are HIGH confidence)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features Telegram refugees assume exist. Missing any of these causes immediate abandonment.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| 1:1 text messaging | Core of every messenger | LOW | Already partially built (R001, R004); needs polished E2E flow |
| Message delivery receipts (sent/delivered) | Users need to know messages arrived | LOW | Binary: sent to relay vs. delivered to peer; no "read" needed for v1 |
| Offline message delivery | Telegram works when recipient is offline | MEDIUM | Nostr relay storage (R004) covers this; needs reliability hardening |
| Contact/peer directory (local) | Users need to remember who they talk to | LOW | Local storage of npub + display name + alias |
| No phone number required | Core promise of the product | LOW | Identity system (R002) covers this; must be frictionless in onboarding |
| Text formatting (bold, italic, code) | Telegram users use this constantly | LOW | tweb already supports Telegram markdown; wire through to P2P path |
| Emoji in messages | Universal expectation | LOW | tweb emoji picker exists; needs P2P forwarding |
| Image/photo sharing | Every modern messenger has this | MEDIUM | R005 partially complete; WebRTC data channel needed for actual transfer |
| File sharing (documents) | Telegram heavy usage pattern | HIGH | WebRTC data channel transfer; size limits must be enforced |
| Copy / forward messages | Telegram muscle memory | LOW | UI action; needs P2P send plumbing |
| Message deletion (for me / for both) | Privacy baseline | LOW | For-me: local only; for-both requires NIP event to peer |
| Human-readable identity | npub alone is unusable | MEDIUM | NIP-05 alias (user@domain) or display name; NIP-05 has DNS dependency — display name is fallback |
| QR code / link-based contact add | Only viable no-phone-number contact discovery | LOW | Share npub as link/QR; no central directory needed |
| Installable PWA | Desktop + mobile baseline | LOW | PWA manifest + service worker already delivered (R007) |
| Offline app load (cached shell) | Users expect it to work after install | MEDIUM | Service worker cache; IndexedDB for messages; note iOS 50MB cache limit |

### Differentiators (Competitive Advantage)

Features that set Nostra.chat apart from Session, SimpleX, Element, and Signal. Aligned with the core value: messaging UX + real privacy.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Tor transport (webtor-rs) built-in | IP address never exposed to relays or peers — Session uses onion routing, Signal/SimpleX do not hide IP by default | HIGH | Already implemented; must be reliable at launch — flaky Tor = no differentiator |
| Nostr ecosystem interop | Users can contact any Nostr user; identity works in Damus, Primal, etc. | MEDIUM | Nostr npub/nsec standard; NIP-17 for private DMs if interop with Nostr clients desired |
| Familiar messaging UX | Session/SimpleX/Briar have poor UX; this is built on tweb | LOW | Core inheritance from tweb fork; maintain feature parity of tweb UI patterns |
| Censorship-resistant distribution (multi-mirror + IPFS) | App itself cannot be blocked — unique vs. all competitors | MEDIUM | PWA served from multiple domains/IPFS; no single URL to block |
| Seed phrase backup (power user) | Full self-custody of identity — no account recovery service to trust | LOW | Accessible in settings; hidden from default onboarding |
| NIP-17 sealed DMs (metadata privacy) | NIP-04 (current) leaks sender pubkey to relays; NIP-17 gift-wrapping hides sender | HIGH | Upgrade from NIP-04 to NIP-17 significantly improves metadata privacy; NIP-04 deprecated upstream |
| Multi-relay failover | Single relay = single point of censorship; redundancy is a feature | MEDIUM | Connect to 3-5 public Nostr relays; message to all, deduplicate on receive |
| WebRTC direct (no relay latency when online) | When both peers online, zero-latency direct path — better than all relay-only competitors | MEDIUM | Already implemented (R001); must be stable with TURN fallback for symmetric NAT |

### Anti-Features (Commonly Requested, Often Problematic)

Features to deliberately avoid, with rationale.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Phone number registration | Familiar pattern | Defeats privacy entirely; requires legal entity to hold user data | Seed phrase + optional NIP-05 alias |
| Email-based account recovery | "I lost my seed phrase" user support requests | Creates a centralised account recovery server to attack, subpoena, or fail | Show seed phrase prominently at setup; educate user once |
| Cloud backup of messages | Convenience, "Telegram cloud" feel | Leaks message content to cloud provider; breaks E2E guarantee | Offline-first + IndexedDB; future: optional encrypted export |
| Contact syncing from address book | "Find your friends" | Uploads contacts to a server; massive privacy violation even with hashing | QR code and shareable invite links only |
| Read receipts sent to sender by default | Telegram has these | Leaks activity timing and presence metadata to sender | Optional, off by default; user controls when to share |
| Global user search / discovery | "Find users by name" | Requires central directory; enables enumeration attacks | NIP-05 lookup by domain only; share npub out-of-band |
| Large group voice/video calls | Telegram does this | WebRTC mesh collapses above ~6 peers; requires SFU media server — major infrastructure | Defer to v2; text groups are sufficient for launch |
| Self-hosted relay deployment UX | Power users will want it | Scope explosion; adds server management complexity for no user-facing gain at launch | Use public Nostr relays; document self-hosting separately post-launch |
| Message reactions (emoji reactions) | Telegram has these | Moderate complexity; no urgent user need at launch | Defer to v1.x |
| Sticker packs and custom emoji | Telegram culture | Significant media infrastructure and storage complexity | Defer post-launch; tweb has infra but not wired to P2P path |
| Status / Stories | Telegram Stories feature | Not relevant for private messaging focus; dilutes product identity | Not applicable to the privacy-first positioning |
| Bot API / mini-apps | Telegram superapp direction | Completely orthogonal to privacy mission; security surface area | Out of scope permanently |

---

## Feature Dependencies

```
[Nostr npub Identity]
    └──required by──> [1:1 Text Messaging]
    └──required by──> [Contact Directory]
    └──required by──> [QR / Link Contact Add]
    └──enables──> [NIP-05 Alias]
    └──enables──> [Nostr Ecosystem Interop]

[1:1 Text Messaging]
    └──required by──> [Image / File Sharing]  (data channel on same peer connection)
    └──required by──> [Message Deletion]
    └──required by──> [Group Messaging]

[WebRTC P2P Transport]
    └──required by──> [Direct (low-latency) Messaging]
    └──required by──> [Image / File Sharing]
    └──required by──> [Group Messaging (mesh)]
    └──depends on──> [TURN Server] (symmetric NAT fallback)
    └──depends on──> [Nostr Relay Signaling] (offer/answer/ICE exchange)

[Nostr Relay Storage]
    └──required by──> [Offline Message Delivery]
    └──enhanced by──> [Multi-Relay Failover]
    └──upgraded by──> [NIP-17 Sealed DMs]  (NIP-04 → NIP-17 migration)

[Tor Transport (webtor-rs)]
    └──depends on──> [WebRTC P2P Transport]  (wraps signaling + relay polling)
    └──required for──> [IP Privacy Differentiator]

[PWA Installability]
    └──required by──> [Offline App Load]
    └──required by──> [Push-like Notifications]  (Web Push API)

[Group Messaging]
    └──depends on──> [1:1 Text Messaging]
    └──depends on──> [WebRTC P2P Transport]
    └──depends on──> [Nostr Relay Storage]
    └──requires design choice──> [Mesh (≤6 peers) vs Relay-broadcast (large groups)]

[NIP-17 Sealed DMs]
    └──conflicts with──> [NIP-04 Relay Storage]  (migration required, not additive)
    └──breaks──> [Existing M001-M005 encrypted message format]
```

### Dependency Notes

- **NIP-17 conflicts with NIP-04:** Nostra.chat currently uses NIP-04 (implemented in M001/S04). Upgrading to NIP-17 is a breaking change to the message format and relay storage schema. Must be a planned migration, not an incremental addition.
- **Group Messaging requires architecture decision:** P2P mesh works for ≤6 peers (each peer connects to each other — O(n²) connections). For larger groups, relay-broadcast (each member publishes to a relay, others subscribe) must be used. These are fundamentally different code paths.
- **TURN server is a hard prerequisite for P2P reliability:** Without TURN, ~15% of users on symmetric NAT cannot establish WebRTC connections at all. This makes TURN a launch-blocking dependency for the P2P differentiator.
- **File sharing depends on WebRTC data channel stability:** The current base64 data URL approach (R005 partial) is not production-viable for files >1MB. Proper chunked data channel transfer must be implemented before media sharing is considered complete.

---

## MVP Definition

### Launch With (v1)

Minimum to validate the concept with Telegram refugees and be usable daily.

- [ ] Nostr npub identity with frictionless onboarding (seed in background, show npub only) — users cannot start without identity
- [ ] 1:1 text messaging E2E working (online + offline path) — the core loop
- [ ] Multi-relay failover (3-5 relays) — single relay is too fragile for public launch
- [ ] TURN server operational — ~15% of users blocked without it
- [ ] Tor via webtor-rs reliable — the primary privacy differentiator
- [ ] QR code / npub link contact sharing — only viable contact discovery path
- [ ] Image sharing (photos) — minimum media expectation; Telegram refugees will test this immediately
- [ ] Message delivery indicator (sent to relay) — users need feedback that message left the device
- [ ] Offline app load via service worker — PWA must work after install
- [ ] Censorship-resistant distribution (at least 2 mirrors) — core promise

### Add After Validation (v1.x)

Add when core loop is validated and user feedback gathered.

- [ ] NIP-17 sealed DMs — privacy upgrade from NIP-04; implement after stable foundation; schedule as migration
- [ ] Group messaging (≤10 people mesh) — most-requested after 1:1 works; mesh architecture only
- [ ] File sharing (documents, video) — chunked data channel; after image sharing proves stable
- [ ] Message deletion (for both sides) — quality-of-life; needs NIP delete event
- [ ] Display name + NIP-05 alias — human-readable identity; NIP-05 requires user to own a domain (power user) or use a service
- [ ] Typing indicators — nice UX signal; low complexity once data channel is open
- [ ] Optional read receipts (user opt-in) — privacy-respecting implementation

### Future Consideration (v2+)

Defer until product-market fit is established.

- [ ] Broadcast channels (one-to-many, Telegram-style) — R011 already deferred; large audience delivery architecture
- [ ] Voice/video calls (1:1) — R010 deferred to M007; WebRTC already in stack, but call UX is complex
- [ ] Large groups (relay-broadcast architecture) — different code path from mesh; design separately
- [ ] Emoji reactions — nice-to-have; low user value vs. cost at this stage
- [ ] Disappearing messages (configurable timer) — privacy feature; medium complexity

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Nostr npub identity + onboarding | HIGH | LOW | P1 |
| 1:1 text messaging (complete E2E) | HIGH | MEDIUM | P1 |
| Multi-relay failover | HIGH | MEDIUM | P1 |
| TURN server | HIGH | LOW (ops) | P1 |
| Tor transport reliability | HIGH | MEDIUM | P1 |
| QR / link contact sharing | HIGH | LOW | P1 |
| Image sharing | HIGH | MEDIUM | P1 |
| Delivery receipts | MEDIUM | LOW | P1 |
| Offline PWA shell | MEDIUM | LOW | P1 |
| Mirror / censorship-resistant hosting | MEDIUM | MEDIUM | P1 |
| NIP-17 sealed DMs | HIGH | HIGH | P2 |
| Group messaging (mesh, small) | HIGH | HIGH | P2 |
| File sharing (documents) | MEDIUM | HIGH | P2 |
| Display name / NIP-05 alias | MEDIUM | MEDIUM | P2 |
| Message deletion | MEDIUM | LOW | P2 |
| Typing indicators | LOW | LOW | P2 |
| Read receipts (opt-in) | LOW | LOW | P2 |
| Broadcast channels | MEDIUM | HIGH | P3 |
| Voice/video calls | HIGH | HIGH | P3 |
| Emoji reactions | LOW | MEDIUM | P3 |
| Disappearing messages | MEDIUM | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have; add in first post-launch iteration
- P3: Nice to have; future milestones

---

## Competitor Feature Analysis

| Feature | Session | SimpleX | Signal | Element/Matrix | Briar | Our Approach |
|---------|---------|---------|--------|----------------|-------|--------------|
| No phone number | Yes (66-digit ID) | Yes (no IDs at all) | No (phone required) | Partial (username on some servers) | Yes | Yes (npub) |
| Human-readable identity | No | No | Yes (phone) | Yes (matrix ID) | No | NIP-05 alias optional |
| Contact discovery | ID exchange | Link/QR only | Phone contacts | Directory search | Link/QR/BT | Link/QR (npub) |
| E2E encryption | Yes (Signal protocol) | Yes (quantum-resistant) | Yes (Signal protocol) | Yes (Olm/Megolm) | Yes | Yes (NIP-04 now, NIP-17 planned) |
| IP hiding | Onion routing (3-hop) | Optional Tor/proxy | No | No | Tor (online) | Tor (webtor-rs, built-in) |
| Offline messages | Swarm nodes (buffered) | Server-stored encrypted | Sealed sender + server | Homeserver | No (Tor only) | Nostr relay (NIP-04/17) |
| Groups | Yes (up to 100) | Yes (small, E2E) | Yes (up to 1000) | Yes (federated rooms) | Yes (small) | Planned v1.x (mesh ≤10) |
| Channels/broadcast | No | No | No | Yes (Spaces) | No | Planned v2+ |
| Media sharing | Yes | Yes | Yes | Yes | Limited | Photos v1; docs v1.x |
| Desktop support | Yes | Yes | Yes | Yes | No | Yes (PWA) |
| Mobile install | Native app | Native app | Native app | Native app | Native (Android only) | PWA (installable) |
| Open source | Yes | Yes | Yes | Yes | Yes | Yes (GPL v3) |
| Censorship-resistant distribution | Partial | No | No | Partial (self-host) | No | Yes (multi-mirror + IPFS) |
| Telegram-like UX | No | No | No | No | No | Yes (tweb fork) |
| Nostr ecosystem interop | No | No | No | No | No | Yes (npub/nsec) |

---

## Sources

- [Session Messenger Review 2026](https://cyberinsider.com/secure-encrypted-messaging-apps/session/) — MEDIUM confidence (review site, detailed feature coverage)
- [Session Wikipedia](https://en.wikipedia.org/wiki/Session_(software)) — MEDIUM confidence
- [SimpleX Chat homepage](https://simplex.chat/) — HIGH confidence (official source)
- [SimpleX Chat GitHub](https://github.com/simplex-chat/simplex-chat) — HIGH confidence (official)
- [NIP-17 Private Direct Messages](https://nostrcompass.org/en/topics/nip-17/) — MEDIUM confidence
- [NIP-17 spec on GitHub](https://github.com/nostr-protocol/nips/blob/master/17.md) — HIGH confidence (official protocol spec)
- [NIP-04 spec on GitHub](https://github.com/nostr-protocol/nips/blob/master/04.md) — HIGH confidence (official, deprecated)
- [Briar Project](https://briarproject.org/) — HIGH confidence (official)
- [Briar Wikipedia](https://en.wikipedia.org/wiki/Briar_(software)) — MEDIUM confidence
- [WebRTC P2P architecture — GetStream](https://getstream.io/resources/projects/webrtc/architectures/p2p/) — MEDIUM confidence
- [WebRTC complexity 2025 — WebRTC.ventures](https://webrtc.ventures/2025/08/why-webrtc-remains-deceptively-complex-in-2025/) — MEDIUM confidence
- [PWA capabilities 2025 — CodeBrand](https://www.codebrand.us/blog/progressive-web-apps-pwa-guide-2025/) — MEDIUM confidence
- [iOS PWA limitations — IPH Technologies](https://iphtechnologies9.wordpress.com/2025/07/01/solving-ios-pwa-limitations-push-notifications-offline-access/) — MEDIUM confidence
- [Nostr best clients 2026 — Webvator](https://webvator.com/best-nostr-apps-of-2026-which-decentralized-social-app-is-best-for-you/) — LOW confidence (blog)
- [NIP-05 verification — nostr.how](https://nostr.how/en/guides/get-verified) — HIGH confidence (official Nostr documentation)
- [Contact discovery privacy research](https://contact-discovery.github.io/) — HIGH confidence (academic)
- [Top 5 secure private messengers 2026 — ProPrivacy](https://proprivacy.com/privacy-service/comparison/5-secure-private-messengers) — MEDIUM confidence

---
*Feature research for: Nostra.chat — decentralized P2P messaging for Telegram refugees*
*Researched: 2026-03-31*
