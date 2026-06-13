# Stack Research

**Domain:** Production-ready decentralized P2P messaging with Nostr identity
**Researched:** 2026-03-31
**Confidence:** MEDIUM-HIGH (primary libs verified via Context7 + official sources; infra pricing verified via WebSearch with official pages)

---

## Recommended Stack

### Core Technologies (already in place)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Solid.js | 1.9.11 (custom fork) | Reactive UI | Already integrated; no change |
| TypeScript | 5.7 | Type safety | Already configured; no change |
| Vite | 5.2.10 | Build + dev server | Already working; no change |
| @noble/secp256k1 | 3.0.0 | secp256k1 keypair ops | Already present. NOTE: v3.x is the minimal rewrite — confirm it exports `generateSecretKey` or upgrade to `@noble/curves` (see below) |

### Nostr Identity Layer

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| nostr-tools | 2.23.3 | Full NIP toolkit | The ecosystem standard for browser-based Nostr clients. Ships tree-shakeable ESM subpath imports (`nostr-tools/pure`, `/nip19`, `/nip44`, `/nip04`, `/pool`). v2.x has breaking changes from v1.x (nsecEncode takes Uint8Array). Latest stable as of 2026-03. MEDIUM confidence — verified release series via npm/JSR, version number from search results dated Dec 2025. |
| nostr-tools/nip19 | (bundled) | npub/nsec bech32 encoding | `nip19.npubEncode()`, `nip19.nsecEncode()`, `nip19.decode()` — standard bech32 identifiers. Required for NIP-19 compliance so Nostra.chat identities display as `npub1...` not raw hex. HIGH confidence — Context7 verified. |
| nostr-tools/nip44 | (bundled) | NIP-44 versioned encryption | Replaces NIP-04. Uses XChaCha20-Poly1305 with HMAC-SHA256 key derivation. NIP-04 is officially deprecated and has known CBC-mode vulnerabilities. All new DM storage on Nostr relays MUST use NIP-44. HIGH confidence — official NIP spec + Context7 verified. |
| nostr-tools/pool | (bundled) | SimplePool multi-relay | `SimplePool` handles fan-out publish and merge-subscribe across multiple relays. Required for multi-relay failover. HIGH confidence — Context7 verified with code examples. |

### Seed Phrase to Nostr Keypair (NIP-06)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| nostr-tools/nip06 | (bundled) | BIP-39 mnemonic → secp256k1 keypair | NIP-06 specifies derivation path `m/44'/1237'/0'/0/0` using BIP-32. nostr-tools ships this natively — no extra library needed. Keeps Nostra.chat's existing 12-word seed phrases compatible with the Nostr ecosystem (Amethyst, Damus import). HIGH confidence — NIP-06 official spec confirmed. |
| @scure/bip39 | ^1.4.0 | BIP-39 mnemonic wordlist + validation | Paul Miller's audited library for generating and validating 12-word seed phrases. Used internally by nostr-tools/nip06 but may need direct import for the onboarding UX (generating seed words, checking validity before key derivation). HIGH confidence — widely used, audited. |
| @scure/bip32 | ^1.5.0 | BIP-32 HD key derivation | Dependency of nostr-tools/nip06 path. Required if doing manual derivation for multiple account support. HIGH confidence. |

### Alternative: @noble/curves instead of @noble/secp256k1

Current stack uses `@noble/secp256k1 3.0.0`. The v3.x rewrite has a reduced API surface vs v1.x. nostr-tools 2.x internally uses `@noble/curves` (the full-featured sibling). There is no direct conflict, but consider:

- **Keep `@noble/secp256k1 3.0.0`** if only doing ECDH shared secret + signature verify (matches its API).
- **Switch to `@noble/curves`** if you need DER encoding, hash-to-curve, or want one lib to cover both secp256k1 and ed25519. MEDIUM confidence — API differences verified via npm search, not Context7.

### NIP-05 Alias System

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Static `.well-known/nostr.json` | N/A | NIP-05 identity verification | Serve `GET /.well-known/nostr.json?name=alice` → `{"names":{"alice":"<hex-pubkey>"},"relays":{"<hex-pubkey>":["wss://..."]}}` with `Access-Control-Allow-Origin: *`. No server logic required — a static JSON file served from any web host is sufficient for v1. HIGH confidence — official NIP-05 spec. |
| Cloudflare Workers (optional) | N/A | Dynamic NIP-05 at scale | If users register their own alias (like `user@nostra.chat`), a Worker can serve the JSON dynamically from a KV store. Free tier covers millions of requests/day. MEDIUM confidence — WebSearch verified via Cloudflare docs. |

### WebRTC / NAT Traversal

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| coturn | 4.6.x (latest) | Self-hosted STUN+TURN server | The only production-grade open-source TURN implementation. Ships as Docker image (`coturn/coturn`). Configure with `use-auth-secret` + `static-auth-secret` for time-limited HMAC credentials (no long-term passwords in client code). Single VPS ($5-10/mo DigitalOcean) handles thousands of concurrent relayed connections. REQUIRED for symmetric NAT traversal — ~15-20% of users will fail P2P without it. HIGH confidence — well-established, official coturn Docker image verified. |
| Cloudflare Realtime TURN | N/A | Managed TURN (fallback option) | Free tier: 1,000 GB/month before charges ($0.05/GB outbound after). No infrastructure to manage. Trade-off: ties Nostra.chat to Cloudflare, weakening censorship resistance. Use as backup or during coturn outage only. MEDIUM confidence — Cloudflare Realtime docs verified. |
| STUN: stun.l.google.com:19302 | N/A | ICE candidate gathering | Google's public STUN server for most NAT scenarios. Free, no auth. Always include alongside TURN. No maintenance needed. HIGH confidence — universal WebRTC standard. |

**Coturn credentials pattern (time-limited HMAC):**
```typescript
// Generate on each session load — never expose static password to client
function getTurnCredentials(userId: string, sharedSecret: string) {
  const timestamp = Math.floor(Date.now() / 1000) + 3600; // 1h TTL
  const username = `${timestamp}:${userId}`;
  const hmac = crypto.subtle.sign('HMAC', key, encoder.encode(username));
  return {username, credential: btoa(hmac)};
}
```

**Avoid Metered.ca and Xirsys for Nostra.chat:** Both are commercial services with usage-based pricing that can be blocked as infrastructure for a censorship-resistant app. coturn self-hosted aligns with the project's zero-dependency philosophy. MEDIUM confidence — pricing from WebSearch.

### Multi-Relay Signaling

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| nostr-tools SimplePool | (bundled) | Multi-relay publish + subscribe | `SimplePool.publish(relays, event)` fan-outs to all relays simultaneously. `pool.subscribe(relays, filter, handlers)` merges streams with automatic dedup. This is the correct primitive for multi-relay failover — no extra library needed. HIGH confidence — Context7 verified. |

**Recommended relay set (hardcoded defaults):**
```typescript
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',      // Largest, most reliable public relay
  'wss://nos.lol',             // High uptime, good spam filtering
  'wss://relay.primal.net',    // Backed by Primal, stable
  'wss://relay.nostr.band',    // Global reach, good availability
];
```

All four have been consistently cited as high-availability public relays in 2025. MEDIUM confidence — WebSearch only, no official SLA.

### Group Messaging Protocol

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| NIP-17 (Private DMs / small groups) | Draft → stable | 1:1 and small group encrypted chat | NIP-17 uses NIP-59 gift wrap (kind:1059) + NIP-44 encryption. Hides sender identity, timestamps, and participant list from relays. The correct protocol for Nostra.chat's primary 1:1 DM use case. Also supports small groups (fan-out gift wraps to each member). MEDIUM confidence — NIP spec verified at nips.nostr.com, nostr-tools support needs integration test. |
| NIP-28 (Public Channels) | Final | Group channels / broadcast | Event kinds 40-44. Channel creation (kind:40), messages (kind:42). Suitable for Telegram-style public groups and channels. Has broad client support (Amethyst, nostrudel). No access control — moderation is client-side. MEDIUM confidence — NIP spec confirmed, WebSearch verified implementations. |
| NIP-29 (Relay-managed groups) | Draft | Private managed groups | Relay-enforced membership and moderation. Requires a relay that implements NIP-29 (not all do). Adds relay dependency — avoid for v1. LOW confidence on production readiness — limited relay support. |

**Recommendation for Nostra.chat v1:**
- 1:1 DM → NIP-17 (gift wrap, full sender privacy)
- Small group chat (<50) → NIP-17 fan-out (each member gets a gift-wrapped copy)
- Public channels → NIP-28 (publicly readable, Telegram-channel feel)
- Defer NIP-29 (relay-managed private groups) post-launch

### Privacy Transport (Tor)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| webtor-rs | Current (in-tree WASM) | Browser-native Tor transport | Already integrated (D031 decision). Uses Snowflake bridge for censorship-heavy regions. The only WASM Tor implementation that survived the M004/M005 cleanup. Production concern: Snowflake bridge URL is currently hardcoded — must be configurable via config or env for deployments in different censorship contexts. MEDIUM confidence — internal knowledge from PROJECT.md; Tor Snowflake operational status confirmed via Tor Project blog (Nov/Dec 2025 updates show active maintenance). |

**Production concern:** The Tor Project confirmed two active Snowflake bridges as of 2025 and active work on stability. webtor-rs must pick the bridge URL from runtime config, not a compile-time constant, to allow the community to update bridges without a code deploy.

### PWA Distribution / Censorship-Resistant Hosting

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Vite build → static dist/ | (existing) | PWA asset bundle | Already works. The output is purely static HTML+JS+CSS+WASM — can be served from any origin, including IPFS. |
| IPFS via Fleek | Current | Decentralized hosting | Fleek provides CI/CD → IPFS publish with IPNS for mutable pointers. CID pinning via Fleek + Pinata redundancy means content survives individual node/gateway failures. PWA served over IPFS via HTTPS gateway at inbrowser.link or via `ipfs.io/ipfs/<CID>`. MEDIUM confidence — Fleek + IPFS official docs verified via WebSearch. |
| IPNS + ENS domain | Current | Human-readable IPFS address | ENS name (`nostra.eth`) → IPNS record updated on each release. Censorship-resistant: no registrar can yank the domain (unlike .com). Resolves in MetaMask/Brave. Expensive for casual users (requires ETH). MEDIUM confidence — documented pattern, WebSearch verified. |
| Multiple web mirrors | N/A | HTTP fallback for non-IPFS users | Deploy same dist/ to GitHub Pages + Cloudflare Pages + a self-hosted VPS. Users fall back to any available mirror. Simple, no crypto required. More practical than IPFS-only for non-technical Telegram refugees. HIGH confidence — standard practice. |
| Service Worker (existing) | N/A | Offline PWA functionality | Already in tweb architecture. Ensure `site.webmanifest` has `start_url` and `display: standalone` for installability. Cache strategy: Cache-First for assets, Network-First for relay queries. HIGH confidence — existing PWA infrastructure. |

**PWA hosting strategy recommendation:** Multi-mirror HTTP first (GitHub Pages + Cloudflare Pages + own VPS), IPFS as an additional distribution channel for advanced users. Don't make IPFS the primary delivery — it's slower and requires gateway trust for non-extension users.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @scure/bip39 | ^1.4.0 | BIP-39 wordlist + entropy | Onboarding: generate 12-word seed + validate user input |
| @scure/bip32 | ^1.5.0 | BIP-32 HD derivation | NIP-06 key derivation path; multi-account support |
| nostr-tools/nip06 | (bundled) | NIP-06 mnemonic→keypair | Convert BIP-39 seed to Nostr nsec/npub |
| nostr-tools/nip19 | (bundled) | bech32 encoding/decoding | Display npub/nsec; QR codes; clipboard copy |
| nostr-tools/nip44 | (bundled) | Versioned E2EE encryption | All new DM content encrypted at rest on relays |
| nostr-tools/nip04 | (bundled) | Legacy NIP-04 (read-only) | Decode old messages from relays during migration period only |
| nostr-tools/nip17 | (bundled, check) | Gift-wrap DM scheme | 1:1 and small group private messages |
| nostr-tools/nip28 | (bundled, check) | Public channels | Group channels, broadcast |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Docker + coturn | Local TURN server for dev/test | `docker run -d coturn/coturn -n --log-file=stdout --min-port=49152 --max-port=65535 --use-auth-secret --static-auth-secret=dev-secret` |
| nostr-relay (local) | Local Nostr relay for testing | `docker run -d -p 7000:7000 scsibug/nostr-rs-relay` — eliminates network dependency in tests |
| Vitest | Unit + integration tests | Already configured |

---

## Installation

```bash
# Nostr identity + relay layer
pnpm add nostr-tools

# BIP-39/BIP-32 (seed phrase generation + NIP-06)
pnpm add @scure/bip39 @scure/bip32

# If replacing @noble/secp256k1 with full curves lib
# pnpm add @noble/curves
# pnpm remove @noble/secp256k1
```

No server-side dependencies. Everything runs in-browser.

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| nostr-tools 2.x | NDK (Nostr Dev Kit) | NDK is higher-level and adds ~80KB overhead. For Nostra.chat's use case (low-level relay control, custom encryption) nostr-tools is more appropriate. NDK makes sense for social-network apps, not P2P messaging. |
| nostr-tools 2.x | nostr-relaypool-ts | Separate library that wraps nostr-tools. Now superseded by nostr-tools SimplePool which ships the same functionality natively in v2.x. |
| coturn (self-hosted) | Metered.ca / Xirsys | Managed services have usage-based pricing, single point of failure, and can be blocked as infrastructure. Violates Nostra.chat's zero-central-dependency philosophy. |
| coturn (self-hosted) | Cloudflare Realtime TURN | Ties app to Cloudflare; Cloudflare can block Nostra.chat if it becomes politically inconvenient. Use only as emergency fallback. |
| NIP-17 (gift wrap) | NIP-04 (legacy DMs) | NIP-04 is deprecated, has CBC-mode vulnerabilities, and leaks sender pubkey in the outer event. Use NIP-44 encryption (via NIP-17) for all new messages. |
| NIP-28 (public channels) | NIP-29 (relay-managed groups) | NIP-29 requires relay-level implementation support — most public relays don't support it yet. High dependency risk for v1. |
| Multi-mirror HTTP | IPFS-only | IPFS gateways add latency, require user education, and are themselves censorable. HTTP mirrors are more immediately accessible to Telegram refugees. |
| @scure/bip39 | bip39 (npm) | `bip39` is a heavyweight unmaintained package. @scure/bip39 is audited, ~5KB, actively maintained by the noble-cryptography team. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| NIP-04 for new messages | Deprecated, CBC vulnerabilities, leaks sender in outer event | NIP-44 (via nostr-tools/nip44 or NIP-17) |
| nostr-rs-relay as app dependency | Requires user to self-host a relay — adds infrastructure burden | Public relay list with SimplePool failover |
| tor-wasm | Removed in M004 (AGPL license, less mature than webtor-rs) | webtor-rs (already in place) |
| I2P / i2p-wasm | Removed in M004 (not production-ready in WASM) | webtor-rs only |
| Long-term TURN credentials (static password) | Password baked into JS bundle — trivially extractable and abused | Time-limited HMAC credentials (coturn `use-auth-secret`) |
| Single Nostr relay | Single point of censorship/failure | SimplePool with 4+ relays |
| NDK (Nostr Dev Kit) | Bloated for Nostra.chat's use case, opinionated relay management conflicts with custom signaling logic | nostr-tools 2.x directly |
| Twilio TURN | Commercial service, phone-number association, politically sensitive | coturn self-hosted |

---

## Stack Patterns by Variant

**For 1:1 DM (launch critical):**
- Use NIP-17 (gift wrap) with NIP-44 encryption
- Store encrypted rumor events on 4 relays via SimplePool
- Deliver over WebRTC when both peers online; fall back to relay fetch when offline

**For group chat (<50 members):**
- Use NIP-17 fan-out: send a separate gift-wrapped copy to each member's pubkey
- Same 4-relay SimplePool for storage
- For large groups (>50), switch to NIP-28 public channels

**For broadcast channels (Telegram-style):**
- Use NIP-28 (kind:40 channel, kind:42 message)
- Channel creator's pubkey is the authority
- Subscribers filter by channel ID

**For Tor-censored regions:**
- webtor-rs with Snowflake bridge (existing)
- Make bridge URL runtime-configurable (not hardcoded)
- Fallback: WebSocket direct (existing D034 decision)

**For PWA distribution:**
- Primary: Cloudflare Pages + GitHub Pages (fast, free, familiar)
- Secondary: IPFS via Fleek (for censorship-resistant mirrors)
- Fallback: any static host can serve dist/

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| nostr-tools 2.x | @noble/secp256k1 3.x | nostr-tools v2 uses @noble/curves internally; no conflict with @noble/secp256k1 as long as Nostra.chat code doesn't mix key formats |
| nostr-tools 2.x | TypeScript 5.7 | Full ESM with type definitions; subpath imports work with moduleResolution: "bundler" (Vite default) |
| @scure/bip39 1.x | nostr-tools nip06 | nostr-tools/nip06 likely bundles @scure/bip39 — check for duplicate before installing separately |
| coturn 4.6.x | browser WebRTC | Requires UDP 3478 + TCP 5349 open; restrict IP ranges per deployment to limit abuse |

---

## Sources

- `/nbd-wtf/nostr-tools` (Context7) — key generation, NIP-19 encoding, SimplePool, NIP-46 bunker examples; HIGH confidence
- https://github.com/nbd-wtf/nostr-tools — README, v2.0.0 breaking changes, latest version (2.23.3); MEDIUM confidence
- https://nips.nostr.com/17 — NIP-17 gift wrap spec; HIGH confidence
- https://nips.nostr.com/28 — NIP-28 public channels spec; HIGH confidence
- https://nips.nostr.com/44 — NIP-44 versioned encryption replacing NIP-04; HIGH confidence
- https://nips.nostr.com/6 — NIP-06 key derivation from mnemonic; HIGH confidence
- https://github.com/coturn/coturn — coturn Docker deployment, time-limited HMAC credentials; HIGH confidence
- https://developers.cloudflare.com/realtime/turn/ — Cloudflare TURN free tier (1,000 GB), pricing; MEDIUM confidence
- https://webrtc.ventures/2025/01/how-to-set-up-self-hosted-stun-turn-servers-for-webrtc-applications/ — coturn self-hosted guide 2025; MEDIUM confidence
- https://resources.fleek.xyz/blog/learn/building-with-ipfs-ens/ — Fleek + IPFS + ENS for censorship-resistant hosting; MEDIUM confidence
- https://nostrbook.dev/groups — comparison of NIP-17/28/29 group implementations; MEDIUM confidence

---
*Stack research for: Nostra.chat production launch — decentralized P2P messaging with Nostr identity*
*Researched: 2026-03-31*
