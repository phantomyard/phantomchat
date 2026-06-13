# External Integrations

**Analysis Date:** 2026-03-31

## APIs & External Services

**Telegram MTProto:**
- Telegram client protocol (binary, not HTTP REST)
- Connection via `src/lib/mtproto/networker.ts` to Telegram data centers
- Auth: OAuth via phone number or QR code, stored in app state as `AuthState` type in `src/types.d.ts`
- SDK/Client: Custom MTProto implementation (`src/lib/mtproto/`) - no third-party SDK
- Fallback DC configuration via `dcConfigurator.ts` - handles DC discovery and failover

**Nostr Relays (NIP-04 Protocol):**
- Encrypted message relay protocol for privacy-first messaging
- Implementation: `src/lib/nostra/nostr-relay.ts`, `src/lib/nostra/nostr-relay-pool.ts`
- SDK/Client: Custom Nostr client (no external SDK)
- Auth: Cryptographic signing via secp256k1 private key (derived from seed phrase)
- Events: Kind 4 (encrypted direct messages), Kind 0 (metadata)
- Connection: WebSocket to relay URLs (configurable)

**Privacy Transport (Tor/Webtor Fallback):**
- Tor network integration for privacy-preserving requests
- Implementation: `src/lib/nostra/privacy-transport.ts`
- SDK/Client:
  - Tor: Custom WASM client in `public/tor-wasm/` (TorWasm)
  - WebTor fallback: webtor-rs (MIT licensed) wrapped in `src/lib/nostra/webtor-fallback.ts`
- Auth: None (anonymous network)
- Trigger: Configurable, used for identity-preserving relay communication
- Bridge: Snowflake WebRTC bridge for Tor (handled by webtor-rs)

**Nostra.chat Login (t.me callback):**
- Cross-tab account synchronization from t.me links
- Implementation: `src/index.ts` - `checkLastActiveAccountFromTMe()` checks referrer
- Auth: Session ID from `sessionStorage.get('xt_instance')`
- No external API calls; local account switching logic

## Data Storage

**Databases:**
- IndexedDB (primary)
  - Client: Custom storage abstraction in `src/lib/storage.ts` wrapping IndexedDB
  - ORM: `src/lib/files/idb.ts` - Direct IDB manipulation with encryption layer
  - Schema: Dynamic based on app state in `src/config/state.ts`
  - Encryption: Optional via `src/lib/encryptedStorageLayer.ts` (AES-256 with passcode)

**Browser Storage:**
- localStorage - For app settings, sidebar width, theme, language
- sessionStorage - Wrapped in `src/lib/sessionStorage.ts` with Worker messaging
- CacheStorage - Service Worker caching of HTTP resources (Telegram DCs, static assets)

**File Storage:**
- Browser native: IndexedDB for encrypted attachment storage
- CacheStorage: HTTP caching for media files and resources
- WebTor fallback: IPFS-like retrieval via webtor-rs WASM

**Caching:**
- IndexedDB document cache (chats, messages, users)
- CacheStorage HTTP cache (favicons, media preview)
- In-memory Solid.js stores in `src/stores/` - reactive state caching

## Authentication & Identity

**Telegram Auth Provider:**
- Primary: Phone number + SMS/Call code or QR code login
- Implementation: `src/pages/pageSignIn.ts`, `src/pages/pageSignQR.ts`, `src/pages/pageAuthCode.ts`
- Auth state stored in IndexedDB under `authState` (type: `AuthState` in `src/types.d.ts`)
- Multi-account support: `src/lib/accounts/` - up to 3 free or 5+ premium accounts
- Session management: `src/lib/mainWorker/` handles DC connection pooling

**Nostra.chat Identity (Nostr-based):**
- Custom identity layer in `src/lib/nostra/identity.ts`
- Seed phrase: 12-word mnemonic in BIP39-like format (via `src/lib/nostra/wordlist.ts`)
- OwnID derivation: ECDSA public key → base32 format (xxxxx.xxxxx.xxxxx)
- Storage: IndexedDB encrypted with passcode
- Cryptographic: secp256k1 signing via @noble/secp256k1
- Entry point: `src/pages/nostra-onboarding-integration.ts` - checks for identity before Telegram auth

**Passcode Lock:**
- Local encryption of sensitive data
- Implementation: `src/components/passcodeLock/passcodeLockScreenController.ts`
- Crypto: PBKDF2 + AES-256 via `src/lib/crypto/`
- Storage: Encrypted key in `src/lib/passcode/keyStore.ts`

## Monitoring & Observability

**Error Tracking:**
- No external error tracking service detected (e.g., Sentry, Rollbar)
- Console logging: `src/lib/logger.ts` - Logger class with levels and context

**Logs:**
- Browser console: Via `logger` class and `console.log`/`console.error`
- Service Worker: `src/lib/serviceWorker/` logs to console
- Debug query param: `?debug=1` enables verbose logging
- Performance monitoring: `console.time()` for startup metrics in `src/index.ts`

## CI/CD & Deployment

**Hosting:**
- Static file hosting (Vite build output in `dist/`)
- No backend server required (API: Telegram + Nostr relays)
- Deployed to: Web server or CDN (e.g., Netlify, Vercel, GitHub Pages)
- HTTPS required for Service Worker and Web Crypto API

**CI Pipeline:**
- Not detected in source code (would be in `.github/workflows/` if GitHub Actions)
- Build command: `pnpm build` (runs `generate-changelog && vite build`)
- Test command: `pnpm test` (runs Vitest)
- Lint command: `pnpm lint` (runs ESLint on `src/**/*.ts`)

**Service Worker:**
- Implementation: `src/index.service.ts` (registered in browser)
- Purpose: Offline support, caching, push notifications
- Messaging: `src/lib/serviceWorker/serviceMessagePort.ts` - bi-directional communication
- Cache: CacheStorage for HTTP resources

## Environment Configuration

**Required env vars:**
- None strictly required (app works with defaults)
- Optional config loaded from `.env.local`:
  - Custom Telegram API credentials (if running forked instance)
  - Nostr relay URLs (defaults: Nostr.band or custom)
  - Privacy transport settings (Tor/Webtor toggle)

**Secrets location:**
- IndexedDB (encrypted with passcode) - `src/lib/encryptedStorageLayer.ts`
- No `.env` file for secrets in production
- Private keys derived from seed phrase (never exported)

## Webhooks & Callbacks

**Incoming:**
- Telegram Updates: Real-time message/status updates via MTProto longpolling
  - Handler: `src/lib/appManagers/apiUpdatesManager.ts`
  - Event types: Message, Chat, User, Reaction updates etc.

- Nostr Relay Events: NIP-04 encrypted messages
  - Handler: `src/lib/nostra/nostra-send-bridge.ts` (subscribes to relay)
  - Event types: Kind 4 (DMs)

- Service Worker Messages: Background task completion
  - Handler: `src/lib/serviceWorker/serviceMessagePort.ts`
  - Message types: Push notification, offline sync completion

**Outgoing:**
- Telegram API calls: `src/lib/appManagers/apiManager.ts` sends MTProto requests
  - No webhook callbacks (request-response pattern)

- Nostr Relay publishes: `src/lib/nostra/nostr-relay.ts` - sends Kind 4 events
  - Subscribe-based, no explicit webhooks

- Web Push subscription: `src/lib/webPushApiManager.ts` sends subscription to backend relay
  - API: `pushService.subscribe()` to enable push notifications

## Tor Privacy Integration

**WASM Modules:**
- Location: `public/tor-wasm/` (Tor WASM), `public/webtor/` (WebTor WASM)
- Tor WASM: Custom Tor network client compiled to WASM
- WebTor WASM: webtor-rs (privacy-ethereum/webtor-rs, MIT licensed)
- Loading: Dynamic import in `src/lib/nostra/privacy-transport.ts`
- Fallback chain: Tor WASM → WebTor WASM → Direct connection

## Custom Protocols

**MTProto (Telegram Binary Protocol):**
- Layers: `src/lib/mtproto/` - Full implementation (encryption, serialization, connection)
- Serialization: TL schema in `src/layer.d.ts` (auto-generated, 664KB)
- Crypto: Custom AES-CTR, SHA-1, SHA-256 implementations
- Connection: `src/lib/mtproto/networker.ts` - DC connection pooling

**Nostr Protocol (NIP-04 Encrypted Messages):**
- Encryption: `src/lib/nostra/nostr-relay.ts` - NIP-04 (ECDH + AES-256-CBC)
- Signing: secp256k1 via @noble/secp256k1
- Relay pool: `src/lib/nostra/nostr-relay-pool.ts` - Multi-relay connection management

---

*Integration audit: 2026-03-31*
