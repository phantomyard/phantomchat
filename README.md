# Nostra.chat

[![Build](https://github.com/nostra-chat/nostra-chat/actions/workflows/deploy.yml/badge.svg)](https://github.com/nostra-chat/nostra-chat/actions/workflows/deploy.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8.svg)](https://nostra.chat)

Privacy-first decentralized messaging with end-to-end encryption and anonymous relay-based delivery.

## Try it now

| Mirror | URL | Notes |
|---|---|---|
| 🌐 **Primary** | **<https://nostra.chat>** | Cloudflare Pages, custom domain |
| 🪞 Mirror 1 | <https://nostra-chat.pages.dev> | Cloudflare fallback |
| 🪞 Mirror 2 | <https://nostra-chat.github.io/nostra-chat/> | GitHub Pages |
| 🧅 IPFS (stable URL) | **<https://ipfs.nostra.chat>** | DNSLink gateway, always points to the latest release |
| 🧅 IPFS (raw CID) | see [IPFS distribution](#ipfs-distribution) below | Censorship-resistant, immutable, per-release |

Install as a PWA: open any of the links above in Chrome, Edge, or Firefox →
the browser will offer an "Install app" option in the address bar or menu.

<!-- TODO: add screenshot of a chat with Tor indicator and delivery states -->
<!-- ![Nostra.chat screenshot](docs/assets/screenshot-main.png) -->

## ⚠️ Project status — Alpha software

Nostra.chat is **early alpha**. Expect bugs, expect UI rough edges, expect
occasional breaking changes between releases. The code has **not been
independently audited** by any third party.

**Do not use Nostra.chat for communications where a compromise would put your
physical safety, freedom, or life at risk.** For those threat models, prefer
mature, audited tools such as [Signal](https://signal.org/) or
[Session](https://getsession.org/). We will remove this warning when an
independent audit has been completed and the software has stabilized.

For the threat model, what the project defends against and what it does not,
see [SECURITY.md](SECURITY.md).

## About

**Nostra.chat** is a 100% client-side Progressive Web App for decentralized messaging, forked from [Telegram Web K](https://github.com/morethanwords/tweb). It replaces the Telegram backend with peer-to-peer encrypted chat over [Nostr](https://nostr.com/) relays and integrates [Tor](https://www.torproject.org/) via WASM for network-level privacy.

No servers. No accounts. No install. Just cryptographic keys and a browser.

### How it works

Every message is end-to-end encrypted using [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) v2 and wrapped in [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) / [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift-wrap envelopes — a three-layer scheme (Rumor → Seal → Gift-Wrap) so relay operators see only opaque blobs with no readable metadata: not the sender, not the recipient, not the content.

Messages are delivered through a configurable set of Nostr relays published via [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md). If one relay goes down, the others keep working. There is no central server that can be shut down, censored, or compelled to hand over data.

### Identity

Your identity is a [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) / [NIP-06](https://github.com/nostr-protocol/nips/blob/master/06.md) seed phrase that derives a Nostr keypair. You can generate one on the spot or import an existing one. There is no phone number, no email, no username registry. You own your identity because you hold the private key — not because a company's database says so.

Keys are stored locally in IndexedDB with AES-GCM encryption, protected by an optional PIN or passphrase with PBKDF2 (600,000 iterations). You can set a [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) human-readable alias (user@domain) and share your identity via QR code.

### Privacy

Tor integration runs entirely in the browser via a WASM build of [Arti](https://gitlab.torproject.org/tpo/core/arti) (webtor-rs). When enabled, all relay connections are routed through Tor circuits using Snowflake bridges, hiding your IP address from relay operators and bypassing national firewalls. If Tor fails, the app asks before falling back to a direct connection — there is no silent privacy degradation.

### Consent-gated updates (signed, no silent code injection)

Starting from v0.12.0, Nostra.chat uses a **consent-gated, cryptographically signed** update system. The app-shell is served **only from cache** after the first install — the Service Worker never fetches new code from the network on its own. Every release manifest is signed with an **Ed25519** key whose public fingerprint is baked into the release that installed on your device; any unsigned or wrong-key-signed manifest is silently dropped. Before applying an update, the client cross-verifies the manifest across 3 independent origins (Cloudflare, GitHub Releases, IPFS) and verifies the signature against the pubkey pinned during your first install.

On first install, a one-time popup shows the signing-key fingerprint so you can record it and verify future rotations. When a new release is available, the app shows a second popup with the changelog, the new version's fingerprint, and (if applicable) a key-rotation cross-certificate — no new code runs without your explicit consent. During download, each chunk is SHA-256 verified; on any mismatch the pending cache is discarded atomically and the active version stays untouched.

See [`docs/UPDATE-SYSTEM.md`](docs/UPDATE-SYSTEM.md) for the operator runbook and [`docs/superpowers/specs/2026-04-21-consent-gated-update-design.md`](docs/superpowers/specs/2026-04-21-consent-gated-update-design.md) for the full threat model and design.

### Features

**Messaging**
- 1:1 encrypted text messaging with real-time delivery over Nostr relays
- Group chats up to 12 members using NIP-17 multi-recipient gift-wrap — relay operators cannot determine group membership
- Photo and video sharing via [Blossom](https://github.com/hzrd149/blossom) encrypted blob storage (AES-256-GCM)
- Message deletion (local and remote via [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) kind 5)
- In-chat message search
- Message requests for unknown senders — strangers cannot message you directly

**Delivery & status**
- Four-state delivery indicators: sending → sent to relay → delivered → read
- Gift-wrapped delivery and read receipts (togglable per user)
- Offline message queue with relay backfill on reconnect
- Multi-relay redundancy — messages deliver even when some relays are down
- Background system notifications when the tab is closed, via opt-in self-hosted Web Push relay ([nostr-webpush-relay](https://github.com/nostra-chat/nostr-webpush-relay), AGPL-3.0). NIP-98 authenticated, configurable preview level, default endpoint swappable for a self-hosted instance. See [docs/PUSH-NOTIFICATIONS.md](docs/PUSH-NOTIFICATIONS.md).

**Identity & contacts**
- Deterministic [DiceBear](https://www.dicebear.com/) fun-emoji avatars generated from each pubkey
- Kind 0 profile fetch from relays (display name, avatar)
- Presence indicators via kind 30315 heartbeats
- Contact management by npub or QR code scan

**Privacy & security**
- Tor toggle with circuit status dashboard (guard → middle → exit)
- Tor latency overhead indicators per relay
- Read receipts privacy toggle
- Group invite privacy (Everyone / Contacts / Nobody)
- Passcode lock screen
- Consent-gated, Ed25519-signed PWA updates with cache-only app-shell, per-chunk SHA-256 verification, multi-origin manifest consensus, and key-rotation cross-certificates — see [consent-gated updates](#consent-gated-updates-signed-no-silent-code-injection)

**Infrastructure**
- Multi-relay pool with configurable relay list and NIP-65 publication
- Real-time relay status page (connected / disconnected / latency / R/W)
- Status icons in the search bar for Tor and relay health at a glance
- PWA installable on mobile and desktop, works offline for cached conversations
- Deployable from any origin — Cloudflare Pages, GitHub Pages, IPFS — for censorship resistance

### How Nostra.chat compares

A feature-by-feature comparison with other privacy-focused messengers and the mainstream alternatives. This table reflects publicly known facts as of April 2026 and may become outdated — please [open an issue](https://github.com/nostra-chat/nostra-chat/issues) if you spot an inaccuracy.

| | **Nostra.chat** | Signal | Session | SimpleX | Keet | WhatsApp | Telegram |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Signup without phone number** | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **User-owned cryptographic identity (self-custody keys)** | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **E2E encrypted by default** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ [¹] |
| **Metadata hidden from infrastructure operators** | ✅ | ⚠️ [²] | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Built-in Tor / onion routing** | ✅ | ❌ | ✅ [³] | ✅ | ❌ | ❌ | ❌ |
| **No central server at all** | ✅ | ❌ | ⚠️ [⁴] | ⚠️ [⁵] | ✅ [⁶] | ❌ | ❌ |
| **Self-hostable infrastructure** | ✅ | ❌ | ❌ | ✅ | N/A | ❌ | ❌ |
| **Open-source client** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Open-source protocol / infrastructure** | ✅ | ✅ | ✅ | ✅ | ⚠️ [⁷] | ❌ | ❌ |
| **Independently audited** | ❌ [⁸] | ✅ | ✅ | ✅ | ❌ | ⚠️ [⁹] | ❌ |
| **Group chats** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Media / file sharing** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Voice / video calls** | ❌ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| **Message editing** | ⏳ [¹¹] | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Bot platform** | ⏳ [¹¹] | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Scheduled messages** | ⏳ [¹¹] | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Delete messages for everyone** | ⏳ [¹¹] | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Auto-delete / disappearing messages** | ⏳ [¹¹] | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Secret notifications by default** | ✅ [¹⁵] | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Multiplatform (iOS, Android, Windows, Linux, macOS)** | ✅ [¹²] | ✅ | ✅ | ⚠️ [¹³] | ✅ | ⚠️ [¹⁴] | ✅ |
| **Works without installing a native app** | ✅ [¹⁰] | ❌ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ |
| **Censorship-resistant distribution (multi-mirror, IPFS)** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Notes:**

1. Telegram's "Secret Chats" are E2E encrypted, but regular chats — the default — are client-to-server only and the server sees the plaintext.
2. Signal's Sealed Sender hides the sender from its own servers, but the servers still see that an account exists, when it comes online, and its contact graph approximations.
3. Session uses its own LokiNet / Oxen onion network, not Tor.
4. Session relies on Oxen service nodes, which are permissioned through staking.
5. SimpleX uses SMP relay servers; anyone can self-host, but most users rely on the project-operated defaults.
6. Keet is peer-to-peer over Hyperswarm DHT — peers still discover each other via bootstrap nodes operated by the project.
7. Keet's client and core libraries are open source; the overall ecosystem is developed primarily by a single company (Holepunch).
8. Nostra.chat has **not yet been independently audited** — see [SECURITY.md](SECURITY.md). A formal audit is planned before leaving alpha. Do not rely on Nostra.chat for high-risk threat models today.
9. WhatsApp uses the audited Signal protocol, but the closed-source implementation and the surrounding Meta infrastructure have not been publicly audited.
10. Nostra.chat runs as a PWA — open the URL and start using it. WhatsApp Web and Telegram Web both require a linked mobile device, so "installation-free" is only half true for them.
11. ⏳ = UI layer present (inherited from Telegram Web K), P2P Nostr transport under active development. See the [roadmap](https://github.com/nostra-chat/nostra-chat/issues) for progress.
12. Nostra.chat works as a PWA on all major platforms — iOS (Safari), Android (Chrome), Windows, Linux, and macOS — without a native app install.
13. SimpleX has no account system — each installation is a separate identity. No automatic conversation sync between devices; every contact must be re-linked manually.
14. WhatsApp requires a phone number and the mobile app to link web/desktop clients. Without the phone, multiplatform is non-functional.
15. Notifications default to a generic "New message" payload — sender and content are never written to the lockscreen unless the user explicitly opts into a richer preview level in Settings → Notifications. The push relay is open source ([nostr-webpush-relay](https://github.com/nostra-chat/nostr-webpush-relay)) and operates over NIP-98-authenticated registration; users can swap the endpoint to a self-hosted instance at any time.

**This is not a "Nostra.chat wins everything" chart.** Different tools are good at different things:

- **Signal** has the strongest cryptographic reputation and the longest audit history. If your only concern is message confidentiality with a trusted central operator, Signal is the safest choice today.
- **SimpleX** has arguably the most mature metadata protection model of any messenger, and a Trail of Bits audit.
- **Session** has the most battle-tested decentralized onion routing and a wide install base.
- **Keet** has the smoothest P2P voice and video, backed by Holepunch's Hyperswarm stack.
- **WhatsApp** has universal reach, which is itself a meaningful form of security (the person you want to message is already there).
- **Telegram** has the richest feature set and the best polish.

**Nostra.chat's positioning is different:** fully decentralized over Nostr relays, with user-owned keys, no account to create, censorship-resistant mirror distribution including IPFS, and zero installation — all in the browser. The cost is being newer, less featured, and currently unaudited. **Choose the tool that fits your threat model, not the one with the most green checkmarks.**

### Architecture

The app runs Telegram Web K's full UI stack (Solid.js, TypeScript, Vite) but replaces the MTProto backend with a **Virtual MTProto Server** — an in-browser layer that intercepts all MTProto API calls and serves responses from local IndexedDB storage populated by Nostr relays. The Worker-based architecture (SharedWorker + ServiceWorker) is preserved. Zero connections are made to Telegram servers.

```
Nostr Relays (via Tor)
       |
   ChatAPI  <-  gift-wrap decrypt
       |
  message-store (IndexedDB)
       |
  Virtual MTProto Server  <-  intercepts getHistory, getDialogs, etc.
       |
  tweb Worker (appManagers)
       |
  Solid.js UI (unchanged)
```

## Getting Started

### Browser support

Nostra.chat requires a modern browser with support for Service Workers,
SharedWorkers (optional — falls back to DedicatedWorker), IndexedDB, the Web
Crypto API, and ES2020+.

| Browser | Status | Notes |
|---|---|---|
| Chrome / Chromium 100+ | ✅ Fully tested | Primary development target |
| Edge 100+ | ✅ Fully tested | Chromium-based |
| Firefox 115+ | ✅ Tested | SharedWorker works; Tor WASM slower than Chromium |
| Brave | ✅ Tested | Chromium-based |
| Safari 16+ | ⚠️ Partial | SharedWorker disabled by default; pass `?noSharedWorker=1` |
| Mobile Chrome / Edge | ✅ Works | Installable as PWA |
| Mobile Safari (iOS 16+) | ⚠️ Partial | Service Worker quirks, background delivery limited |

If you hit a browser-specific bug, please open an issue with the browser
version and OS.

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9

### Development

```bash
pnpm install
pnpm start
```

Open http://localhost:8080/ in your browser.

### Production build

```bash
pnpm build
```

The output is in the `dist/` folder. Copy its contents to any static web server.

### Docker

**Development:**
```bash
docker-compose up tweb.dependencies
docker-compose up tweb.develop
```
Open http://localhost:8080/

**Production:**
```bash
docker-compose up tweb.production -d
```
Open http://localhost:80/

You can also build a standalone image:
```bash
docker build -f ./.docker/Dockerfile_production -t nostra-chat:latest .
```

### Tests

```bash
pnpm test                     # all tests (Vitest)
pnpm test:nostra:quick        # critical P2P tests (~160 tests in <2s)
pnpm test:nostra              # full P2P test suite
pnpm lint                     # ESLint
```

### Debug query parameters

| Parameter | Effect |
|-----------|--------|
| `?test=1` | Use test data centers |
| `?debug=1` | Enable verbose logging |
| `?noSharedWorker=1` | Disable SharedWorker (useful for debugging) |

Example: `http://localhost:8080/?debug=1`

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI Framework | Solid.js (custom fork) |
| Language | TypeScript 5.7 |
| Build | Vite 5 |
| CSS | SCSS |
| Testing | Vitest + Playwright (E2E) |
| Package Manager | pnpm 9 |
| Protocol | Nostr (NIP-06, NIP-17, NIP-44, NIP-59, NIP-65) |
| Encryption | NIP-44 v2 + AES-256-GCM (media) |
| Storage | IndexedDB + CacheStorage + localStorage |
| Workers | SharedWorker + ServiceWorker |
| Privacy | Tor via webtor-rs (Arti WASM) |
| Media | Blossom encrypted blob storage |
| Avatars | DiceBear fun-emoji |

## Roadmap

- [x] Build pipeline & multi-mirror PWA distribution (Cloudflare, GitHub Pages, IPFS)
- [x] Crypto foundation — NIP-06 identity, NIP-44 encryption, AES-GCM key storage
- [x] Multi-relay pool with Tor privacy transport
- [x] 1:1 messaging — NIP-17 gift-wrap DMs, media, delivery tracking, message requests
- [x] Telegram MTProto fully disabled — zero server connections
- [x] Group messaging — NIP-17 multi-recipient groups with admin controls
- [x] Background push notifications — self-hosted Nostr → Web Push relay ([nostr-webpush-relay](https://github.com/nostra-chat/nostr-webpush-relay)), NIP-98 authenticated, default preview hides content
- [ ] Broadcast channels — NIP-28 one-to-many channels
- [ ] Tor UI improvements — toggle, circuit dashboard, latency indicators
- [ ] In-browser mini-relay with store-and-forward capability
- [ ] P2P mesh — WebRTC DataChannel between contacts, tunneled through Tor
- [ ] Trust-minimized PWA updates — user-controlled updates with threshold auditor signatures and reproducible builds ([design](docs/TRUST-MINIMIZED-UPDATES.md))

## IPFS distribution

Every release tag is built, bundled, and pinned to [IPFS](https://ipfs.tech/)
as an immutable content-addressed bundle via Filebase. The CID changes with
each release because it is a deterministic function of the build output.

### Stable URL — `https://ipfs.nostra.chat`

A DNSLink record (`_dnslink.ipfs.nostra.chat`) is updated automatically on
every release tag and resolved at request time by a Cloudflare Worker that
proxies traffic to the `dweb.link` subdomain gateway. The URL is stable —
users never need to know the current CID.

### Raw CID gateways

If you prefer to verify the exact content served, pick the CID from
[GitHub Releases](https://github.com/nostra-chat/nostra-chat/releases) or
from the build commit status, and use any public IPFS gateway:

```
https://dweb.link/ipfs/<CID>/
https://ipfs.io/ipfs/<CID>/
https://cf-ipfs.com/ipfs/<CID>/
https://w3s.link/ipfs/<CID>/
```

**Why IPFS matters:** if Cloudflare Pages and GitHub Pages become unavailable
(censorship, takedown, legal action, account suspension), the IPFS mirror
remains reachable from any gateway and from local IPFS nodes. The
content-addressed URL also lets a user verify that the bundle they are
running matches a specific, immutable version of the source.

A planned [trust-minimized update flow](docs/TRUST-MINIMIZED-UPDATES.md) will
build on top of this CID-based distribution to add threshold auditor
signatures before updates are applied.

## Security

Nostra.chat is **alpha, unaudited software**. Read
[SECURITY.md](SECURITY.md) for the threat model, what the project defends
against, what it does not, and how to privately report vulnerabilities.

**Quick summary of the threat model:**

| Threat | Defended? |
|---|---|
| Relay operators reading message content | ✅ Gift-wrap (NIP-17 / NIP-59) |
| Relay operators learning sender, recipient, or group membership | ✅ Gift-wrap, ephemeral keys |
| Network eavesdropper linking your IP to your pubkey | ✅ Tor (when enabled) |
| Censorship of a single relay | ✅ Multi-relay redundancy |
| Censorship of the distribution mirrors | ✅ IPFS fallback, multiple mirrors |
| DNS / CDN hijack serving modified code | ✅ Phase A controlled updates: cross-source manifest verification, per-file hash check, SW integrity via `registration.update()` |
| Coordinated compromise of all 3 distribution origins | 🔜 Planned — Phase C maintainer signatures |
| Compromised maintainer key / malicious release | 🔜 Planned — Phase D threshold auditor signatures |
| Endpoint compromise (malware, keylogger, screen capture) | ❌ No client-side messenger defends against this |
| Traffic-analysis correlation by a global passive adversary | ❌ Partial mitigation via Tor only |

To privately report a vulnerability, DM the project Nostr account:

```
npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz
```

## Contributing

Contributions are welcome — bug reports, code, documentation, translations,
and release testing. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow, style rules, and commit message conventions.

**Before opening a PR:**

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Run `pnpm lint` and `pnpm test`.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for the
   commit messages — the release changelog is generated from them.
4. Target the `main` branch; we merge PRs with squash-and-merge.

## Community

- **Nostr:** [`npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz`](https://njump.me/npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz)
- **Issues & feature requests:** [GitHub Issues](https://github.com/nostra-chat/nostra-chat/issues)
- **General discussion:** [GitHub Discussions](https://github.com/nostra-chat/nostra-chat/discussions)
- **Security reports:** see [SECURITY.md](SECURITY.md) (do not use public
  channels for vulnerability reports)

## Nostr NIPs implemented

| NIP | Purpose |
|-----|---------|
| [NIP-06](https://github.com/nostr-protocol/nips/blob/master/06.md) | Key derivation from BIP-39 seed phrase |
| [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event deletion (kind 5) |
| [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) | Private direct messages (gift-wrap) |
| [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Versioned encryption (v2) |
| [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) | Gift-wrap envelope (Rumor → Seal → Gift-Wrap) |
| [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata |

## Dependencies

* [BigInteger.js](https://github.com/peterolson/BigInteger.js) ([Unlicense](https://github.com/peterolson/BigInteger.js/blob/master/LICENSE))
* [fflate](https://github.com/101arrowz/fflate) ([MIT License](https://github.com/101arrowz/fflate/blob/master/LICENSE))
* [cryptography](https://github.com/spalt08/cryptography) ([Apache License 2.0](https://github.com/spalt08/cryptography/blob/master/LICENSE))
* [emoji-data](https://github.com/iamcal/emoji-data) ([MIT License](https://github.com/iamcal/emoji-data/blob/master/LICENSE))
* [emoji-test-regex-pattern](https://github.com/mathiasbynens/emoji-test-regex-pattern) ([MIT License](https://github.com/mathiasbynens/emoji-test-regex-pattern/blob/main/LICENSE))
* [rlottie](https://github.com/rlottie/rlottie.github.io) ([MIT License](https://github.com/Samsung/rlottie/blob/master/licenses/COPYING.MIT))
* [fast-png](https://github.com/image-js/fast-png) ([MIT License](https://github.com/image-js/fast-png/blob/master/LICENSE))
* [opus-recorder](https://github.com/chris-rudmin/opus-recorder) ([BSD License](https://github.com/chris-rudmin/opus-recorder/blob/master/LICENSE.md))
* [Prism](https://github.com/PrismJS/prism) ([MIT License](https://github.com/PrismJS/prism/blob/master/LICENSE))
* [Solid](https://github.com/solidjs/solid) ([MIT License](https://github.com/solidjs/solid/blob/main/LICENSE))
* [TinyLD](https://github.com/komodojp/tinyld) ([MIT License](https://github.com/komodojp/tinyld/blob/develop/license))
* [libwebp.js](https://libwebpjs.appspot.com/)
* fastBlur
* [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) ([MIT License](https://github.com/Vanilagy/mp4-muxer/blob/main/LICENSE))
* [nostr-tools](https://github.com/nbd-wtf/nostr-tools) ([Unlicense](https://github.com/nbd-wtf/nostr-tools/blob/master/LICENSE))
* [DiceBear](https://github.com/dicebear/dicebear) ([MIT License](https://github.com/dicebear/dicebear/blob/main/LICENSE))

## License

The source code is licensed under GPL v3. License is available [here](/LICENSE).
