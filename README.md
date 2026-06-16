# PhantomChat

[![Build](https://github.com/phantomyard/phantomchat/actions/workflows/deploy.yml/badge.svg)](https://github.com/phantomyard/phantomchat/actions/workflows/deploy.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8.svg)](https://chat.phantomyard.ai)

Privacy-first decentralized messaging with end-to-end encryption and
relay-based delivery. 100% client-side, no accounts, no servers — just
cryptographic keys and a browser.

## ⚠️ Project status — early alpha, expect breakage

PhantomChat is **early alpha and moving fast**. It has **not** been
independently audited. Recent releases have removed a large amount of
inherited Telegram-fork functionality and reworked the messaging core, so
some surfaces are half-built or temporarily broken (see
[Current limitations](#current-limitations)). Expect bugs, rough edges, and
breaking changes between releases. **This is unfinished software that needs a
lot more polish.**

**Do not use PhantomChat for communications where a compromise would put your
physical safety, freedom, or life at risk.** For those threat models, prefer
mature, audited tools such as [Signal](https://signal.org/) or
[Session](https://getsession.org/). We will revisit this warning once an
independent audit is complete and the software has stabilized.

For the threat model — what the project defends against and what it does not —
see [SECURITY.md](SECURITY.md).

## Try it now

| Mirror | URL | Notes |
|---|---|---|
| 🌐 **Primary** | **<https://chat.phantomyard.ai>** | GitHub Pages, custom domain (HTTPS enforced) |

Install as a PWA: open the link above in Chrome, Edge, or Firefox → the
browser will offer an "Install app" option in the address bar or menu.

## About

**PhantomChat** is a client-side Progressive Web App for decentralized
messaging, forked from [Telegram Web K](https://github.com/morethanwords/tweb).
It strips out the Telegram (MTProto) backend and replaces it with peer-to-peer
encrypted chat over [Nostr](https://nostr.com/) relays.

No servers we operate. No accounts. No phone number. Your identity is a
cryptographic key you hold; messages travel as encrypted gift-wrap envelopes
through a redundant set of public Nostr relays.

### How it works

Every message is end-to-end encrypted with
[NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) v2 and
wrapped in [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) /
[NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift-wrap
envelopes — a three-layer scheme (Rumor → Seal → Gift-Wrap) so relay operators
see only opaque blobs: not the sender, not the recipient, not the content.

Messages are delivered through a configurable set of Nostr relays published via
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md). Delivery is
**poll-based with multi-relay redundancy**: the client periodically re-queries
relays for recent gift-wraps and de-duplicates them, so a message survives any
single relay dropping a live push. If one relay goes down, the others keep
working. There is no central server to shut down, censor, or compel.

### Identity

Your identity is a
[BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) /
[NIP-06](https://github.com/nostr-protocol/nips/blob/master/06.md) seed phrase
that derives a Nostr keypair. Generate one on the spot, or import an existing
key — PhantomChat accepts a seed phrase **or** a raw `nsec` / hex private key,
so you can link the same identity used in other Nostr clients such as 0xchat.

There is no phone number, no email, no username registry. Keys are stored
locally in IndexedDB with AES-GCM encryption, protected by an optional PIN or
passphrase (PBKDF2, 600,000 iterations). You can set a
[NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md)
human-readable alias and share your identity via QR code. You can export your
key (seed words or `nsec`, behind the PIN/reveal gate) at any time.

### Transport & privacy

Relay connections are made over **direct TLS WebSockets (`wss://`)**.

> **Note:** earlier builds shipped an in-browser Tor transport (Arti/webtor
> WASM). That integration has been **removed** — it was heavy, unreliable in
> the browser, and is not currently part of the app. Your IP is therefore
> visible to the relay operators you connect to. If you need IP-level privacy
> today, run the PWA behind your own VPN or system-level Tor. Re-introducing an
> optional onion transport is on the long-term wishlist, not a near-term
> commitment.

## Features

### Working today

**Messaging**
- 1:1 encrypted text messaging over Nostr relays, with Markdown rendering and
  proper NIP-17 text alignment
- Small group chats using NIP-17 multi-recipient gift-wrap — relay operators
  cannot determine group membership
- Group management: create, rename, edit description, add/remove members,
  leave, and admin **delete-for-everyone** (with sender verification and a
  tombstone gate so deleted groups don't resurrect from relay backlog)
- Photo and video sharing via [Blossom](https://github.com/hzrd149/blossom)
  encrypted blob storage (AES-256-GCM)
- Message deletion, local and remote, via
  [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) kind 5
- Message requests for unknown senders — strangers can't land directly in your
  chat list

**Delivery & status**
- Multi-state delivery indicators (sending → sent to relay → delivered → read)
- Gift-wrapped delivery and read receipts (togglable per user)
- **Poll-based delivery** with an offline queue and relay backfill on
  reconnect — messages self-heal even when a relay misses the live push
- Multi-relay redundancy

**Identity & contacts**
- Deterministic [DiceBear](https://www.dicebear.com/) fun-emoji avatars derived
  from each pubkey
- Kind 0 profile fetch (display name, avatar)
- Presence / last-seen indicators via kind 30315 heartbeats
- Contact management by npub or QR code
- Seed-phrase **and** `nsec`/hex key import for cross-client account linking

**Infrastructure**
- Multi-relay pool with a configurable relay list and NIP-65 publication
- Real-time relay status page (connected / disconnected / latency / R/W)
- Canonical relay list served at `/relays.json` (single source of truth)
- PWA installable on mobile and desktop; works offline for cached
  conversations
- Deployable from any static origin (GitHub Pages today; portable to any host
  or IPFS)

### Not working / not yet implemented

See [Current limitations](#current-limitations) for the full list — the short
version is **voice, background push, and some emoji/search surfaces are not
functional yet.**

## Current limitations

PhantomChat began life as a full Telegram Web K client, so a lot of UI exists
that the Nostr backend does not (yet) implement. Recent releases have been
**aggressively removing** the parts that can't work, but some gaps remain:

- **Voice does not work.** Voice/video calling is not implemented, and
  voice-note record/playback is unreliable. Treat voice as absent for now.
- **Background push notifications are not implemented.** The push code path
  (NIP-98-authenticated Nostr → Web Push relay) is **intentionally kept in the
  tree but disabled** (`App.pushEnabled = false`) — there is no live push
  relay deployed, so there are currently no notifications when the tab is
  closed. The wiring is ready to flip on once a relay is hosted; see
  [docs/PUSH-NOTIFICATIONS.md](docs/PUSH-NOTIFICATIONS.md).
- **Some search emoji functionality is missing.** Parts of the emoji/sticker
  picker and emoji-related search were removed during the Telegram-cruft
  cleanup and have not been rebuilt on the PhantomChat side.
- **No Tor / IP privacy.** The in-browser Tor transport was removed — relay
  connections go out over direct `wss://` (see
  [Transport & privacy](#transport--privacy)).
- **No signed / consent-gated auto-update.** An earlier
  cryptographically-signed update system was reverted to a vanilla Service
  Worker; updates now follow standard PWA cache-refresh behavior.

### Removed in recent releases

To keep the app honest about what it actually does, these inherited
Telegram-fork features were **deleted** (not hidden):

- Telegram-cloud global search tabs (Posts / Channels / Apps) and the Premium
  paywalls behind them
- "New Channel" flow, folder invite-links and the folder icon picker
- Active Sessions, Data & Storage (with storage-quota UI), Language settings,
  and the stickers & emoji settings tab
- The experimental P2P mesh settings panel
- The trust-minimized / consent-gated signed-update system (reverted to a
  vanilla Service Worker)
- Dead premium-transcription paywalls

## Architecture

The app runs Telegram Web K's full UI stack (Solid.js, TypeScript, Vite) but
replaces the MTProto backend with a **Virtual MTProto Server** — an in-browser
layer that intercepts MTProto API calls and serves responses from local
IndexedDB storage populated by Nostr relays. The Worker-based architecture
(SharedWorker + ServiceWorker) is preserved. No connections are made to
Telegram servers.

```
Nostr Relays (direct wss://)
       |
   ChatAPI  <-  gift-wrap decrypt + poll-based delivery
       |
  message-store (IndexedDB)
       |
  Virtual MTProto Server  <-  intercepts getHistory, getDialogs, etc.
       |
  tweb Worker (appManagers)
       |
  Solid.js UI
```

## Getting Started

### Browser support

PhantomChat requires a modern browser with Service Workers, IndexedDB, the Web
Crypto API, and ES2020+ (SharedWorker preferred, falls back to a dedicated
worker).

| Browser | Status | Notes |
|---|---|---|
| Chrome / Chromium 100+ | ✅ Primary target | Best tested |
| Edge 100+ | ✅ | Chromium-based |
| Firefox 115+ | ✅ | SharedWorker works |
| Brave | ✅ | Chromium-based |
| Safari 16+ | ⚠️ Partial | SharedWorker disabled by default; pass `?noSharedWorker=1` |
| Mobile Chrome / Edge | ✅ | Installable as PWA |
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

Open <http://localhost:8080/> in your browser.

### Production build

```bash
pnpm build
```

The output is in `dist/`. Copy its contents to any static web server.

### Tests

```bash
pnpm test                      # all tests (Vitest)
pnpm test:phantomchat:quick    # critical P2P tests (fast)
pnpm test:phantomchat          # full P2P test suite
pnpm lint                      # ESLint
```

### Debug query parameters

| Parameter | Effect |
|-----------|--------|
| `?debug=1` | Verbose logging |
| `?noSharedWorker=1` | Disable SharedWorker (debugging) |

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI Framework | Solid.js (custom fork) |
| Language | TypeScript 5.7 |
| Build | Vite 5 |
| CSS | SCSS |
| Testing | Vitest + Playwright (E2E) |
| Package Manager | pnpm 9 |
| Protocol | Nostr (NIP-06, NIP-09, NIP-17, NIP-44, NIP-59, NIP-65) |
| Encryption | NIP-44 v2 + AES-256-GCM (media) |
| Transport | Direct TLS WebSocket (`wss://`) |
| Storage | IndexedDB + CacheStorage + localStorage |
| Workers | SharedWorker + ServiceWorker |
| Media | Blossom encrypted blob storage |
| Avatars | DiceBear fun-emoji |

## Roadmap

- [x] Build pipeline & PWA distribution (GitHub Pages, portable to IPFS)
- [x] Crypto foundation — NIP-06 identity, NIP-44 encryption, AES-GCM key storage
- [x] Multi-relay pool transport
- [x] 1:1 messaging — NIP-17 gift-wrap DMs, media, delivery tracking, message requests
- [x] Telegram MTProto fully disabled — zero server connections
- [x] Group messaging — NIP-17 multi-recipient groups with admin controls
- [x] Poll-based delivery — push-independent, self-healing message arrival
- [x] `nsec` / hex key import for cross-client account linking
- [ ] Fix voice (notes + eventually calling)
- [ ] Deploy a push relay and enable background notifications (code already in tree)
- [ ] Rebuild the missing emoji / search surfaces
- [ ] Optional onion / IP-privacy transport (replacement for the removed Tor build)
- [ ] Independent security audit before leaving alpha

## Security

PhantomChat is **alpha, unaudited software**. Read
[SECURITY.md](SECURITY.md) for the full threat model and how to privately
report vulnerabilities.

**Quick summary of the threat model:**

| Threat | Defended? |
|---|---|
| Relay operators reading message content | ✅ Gift-wrap (NIP-17 / NIP-59) |
| Relay operators learning sender, recipient, or group membership | ✅ Gift-wrap, ephemeral keys |
| Censorship of a single relay | ✅ Multi-relay redundancy |
| Network eavesdropper linking your IP to your pubkey | ❌ Tor transport removed — IP is visible to relays |
| DNS / CDN hijack serving modified app code | ⚠️ Standard PWA / Service-Worker model only (signed-update system removed) |
| Endpoint compromise (malware, keylogger, screen capture) | ❌ No client-side messenger defends against this |
| Traffic-analysis by a global passive adversary | ❌ |

To privately report a vulnerability, DM the project Nostr account:

```
npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz
```

## Contributing

Contributions are welcome — bug reports, code, documentation, and release
testing. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and style
rules.

**Before opening a PR:**

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Run `pnpm lint` and `pnpm test`.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) — the
   changelog is generated from them.
4. Target `main`; we squash-and-merge.

## Community

- **Nostr:** [`npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz`](https://njump.me/npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz)
- **Issues & feature requests:** [GitHub Issues](https://github.com/phantomyard/phantomchat/issues)
- **Security reports:** see [SECURITY.md](SECURITY.md) (not public channels)

## Nostr NIPs implemented

| NIP | Purpose |
|-----|---------|
| [NIP-06](https://github.com/nostr-protocol/nips/blob/master/06.md) | Key derivation from BIP-39 seed phrase |
| [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event deletion (kind 5) |
| [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) | Private direct messages (gift-wrap) |
| [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Versioned encryption (v2) |
| [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) | Gift-wrap envelope (Rumor → Seal → Gift-Wrap) |
| [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata |

## License

The source code is licensed under GPL v3. License available [here](/LICENSE).
This project is a fork of [Telegram Web K](https://github.com/morethanwords/tweb),
also GPL v3.
