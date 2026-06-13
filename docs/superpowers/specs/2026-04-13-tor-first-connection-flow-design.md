# Tor-First Connection Flow

**Date:** 2026-04-13
**Status:** Approved for implementation
**Problem:** When Tor is enabled, the app opens direct WebSocket connections to relays *before* the Tor circuit is ready, exposing the user's real IP for the 30–40 seconds of bootstrap. Bootstrap itself is slower than necessary because consensus + microdescriptors are fetched from scratch every launch and WASM initialization is not preloaded.

## Goals

1. **Privacy-first:** with Tor enabled, no network traffic leaves the browser toward Nostr relays until either the Tor circuit is active or the user has explicitly chosen to fall back to direct.
2. **Faster subsequent launches:** second and later launches (within the consensus TTL) reach `active` in ≲10s, down from 30–40s, via a persistent consensus cache.
3. **Non-blocking UX:** the rest of the app is usable during bootstrap — cached chats read from IndexedDB, drafted messages queue in `OfflineQueue`.
4. **Honest UI:** a persistent top banner tells the user why the app is not yet talking to the network, with a clear skip path protected by a confirmation popup that explains the trade-off.
5. **Session-scoped skip:** skipping Tor only affects the current session. The next launch retries Tor. Permanent disable is only possible from Settings → Privacy & Security.

## Non-goals

- Service Worker warm-up of the WASM module — ~1–2s of additional gain, postponed.
- Persisting the Tor guard node between sessions — requires arti-side changes we cannot ship from JS.
- Redesigning the existing Tor dashboard, shield icon, or Settings tab.

## Architecture

### Startup sequence (Tor enabled)

```
1. App boots, user authenticates
2. nostra-bridge.initTransport() is called
3. PrivacyTransport is constructed
4. transport.bootstrap() is started — non-blocking
5. pool.initialize() is DEFERRED until transport reaches 'active' or 'direct'
6. Global startup banner mounts on document.body, listens on nostra_tor_state
7. User can read cached conversations from IndexedDB
8. User can draft messages — sends go to OfflineQueue (already exists)
9. On state → 'active': pool.initialize() with setTorMode already applied
10. On state → 'direct' (skip or failed+confirm): pool.initialize() in WebSocket mode
11. Banner dismisses on 'active' (3s fade) or immediately on 'direct'
```

### Startup sequence (Tor disabled)

```
1. App boots, user authenticates
2. nostra-bridge.initTransport() called
3. No banner, no bootstrap
4. pool.initialize() immediately in WebSocket mode (current behavior)
```

### Consensus cache layer

A new `tor-consensus-cache.ts` module owns two Cache Storage entries under the cache name `nostra-tor-consensus-v1`:

- `GET /__tor-cache/consensus` → the cached brotli consensus
- `GET /__tor-cache/microdescriptors` → the cached brotli microdescriptors

The fetch shim installed by `webtor-fallback.ts` checks the cache before issuing a real request:

1. Cache hit AND not expired → return cached `Response`, skip network
2. Cache miss or expired → forward to `/webtor/consensus.br.bin` (or `.microdescriptors.br.bin`), clone the response, write to cache with the extracted `valid-until` as the expiry

TTL is parsed from the consensus body: each consensus document starts with a header containing `valid-until YYYY-MM-DD HH:MM:SS`. We store the epoch ms in a side metadata file (`/__tor-cache/consensus-meta`) containing `{validUntil, savedAt}`.

Cache miss triggers still work the existing way — via the local `/webtor/` path served by Vite — which is why the consensus update script (`scripts/update-tor-consensus.mjs`) remains the source of truth.

### Preload

`index.html` gets two hints in `<head>`:

```html
<link rel="modulepreload" href="/webtor/webtor_wasm.js">
<link rel="preload" href="/webtor/webtor_wasm_bg.wasm" as="fetch" type="application/wasm" crossorigin>
```

The browser starts fetching both in parallel with the main bundle, so by the time `WebtorClient.init()` runs the bytes are already in memory cache.

## Components

### `tor-consensus-cache.ts`

```ts
export async function getCachedConsensus(): Promise<Response | null>
export async function saveCachedConsensus(resp: Response): Promise<void>
export async function getCachedMicrodescs(): Promise<Response | null>
export async function saveCachedMicrodescs(resp: Response): Promise<void>
export async function clearConsensusCache(): Promise<void>
```

Internally the module opens `caches.open('nostra-tor-consensus-v1')` and reads `consensus-meta` to check TTL. On decompression failure or corrupted metadata the cache entry is discarded.

### `PrivacyTransport` — new `waitUntilSettled()` API

```ts
/** Resolves when state reaches 'active', 'direct', or 'failed'. */
async waitUntilSettled(): Promise<PrivacyTransportState>
```

Used by `nostra-bridge.ts` to gate `pool.initialize()`. Internally it wires a one-shot listener on rootScope `nostra_tor_state` and resolves on the first settled state.

### `nostra-bridge.ts` — reordered init

```ts
private async initTransport(): Promise<void> {
  const pool = new NostrRelayPool({...})
  const queue = new OfflineQueue(pool)
  const transport = new PrivacyTransport(pool, queue)

  this._relayPool = pool
  this._offlineQueue = queue
  this._privacyTransport = transport

  if (typeof window !== 'undefined') {
    (window as any).__nostraPool = pool
    (window as any).__nostraTransport = transport
    mountTorStartupBanner() // fire-and-forget Solid render onto document.body
  }

  if (!PrivacyTransport.isTorEnabled()) {
    await pool.initialize()
    return
  }

  // Tor is enabled — do not touch the network until bootstrap settles
  transport.bootstrap() // fire-and-forget
  const settled = await transport.waitUntilSettled()
  await pool.initialize() // setTorMode already applied if settled === 'active'
}
```

The key invariant: `pool.initialize()` is never called during `bootstrapping`.

### `torStartupBanner.tsx`

- Solid component mounted once on `document.body` by `nostra-bridge`
- Listens to `nostra_tor_state` and renders:
  - `bootstrapping`: dark bar, spinner, label "Connecting via Tor to hide your IP…", `Skip` button on the right
  - `active` (transition): green fade-out "Connected via Tor" for 3s, then unmount
  - `failed`: red bar, label "Tor failed to connect", `Retry` / `Continue without Tor` buttons
  - `direct`: not shown (invisible state while app is running)
- `Skip` opens `TorStartupSkipConfirm` popup

### `torStartupSkipConfirm.tsx`

- Modal popup (not a transient toast)
- Title: "Continue without Tor?"
- Body paragraphs:
  1. "Your IP address will be visible to the Nostr relays you connect to."
  2. "Messages will stay end-to-end encrypted, but relays can log your network location."
  3. "This choice only applies to this session. Next launch will try Tor again automatically."
  4. "If Tor isn't working on this network, you can disable it permanently in Settings → Privacy & Security → Tor."
- The Settings link uses the existing `AppPrivacyAndSecurityTab` route the dashboard already opens.
- Buttons: `Cancel` (keeps bootstrapping) / `Continue without Tor` (destructive primary — calls `transport.confirmDirectFallback()`)

### SCSS

New partial `src/scss/nostra/_tor-startup.scss`:

- `.tor-startup-banner` — fixed-position, top:0, full width, z-index above toasts (`9999`)
- Variants: `--bootstrap`, `--active`, `--failed`
- Imported from the existing `src/scss/nostra/_index.scss` or equivalent aggregator.

## Data flow — deferred pool initialization

```
User auth done
    ↓
nostra-bridge.initTransport()
    ↓
isTorEnabled() = true
    ↓
transport.bootstrap() → dispatches nostra_tor_state 'bootstrapping'
    ↓                    ↓
    ↓                  Banner renders 'bootstrapping'
    ↓
await transport.waitUntilSettled() ← blocks here
    ↓
Tor circuit ready OR user clicks Skip → confirmDirectFallback
    ↓
state becomes 'active' or 'direct'
    ↓
pool.initialize() runs
    ↓
connectAll() opens relays in the appropriate mode
```

## Testing

### Unit

**`tor-consensus-cache.test.ts`** (new)
- save then get returns the same bytes
- get after TTL expiry returns null and deletes the entry
- get with missing/corrupted meta returns null
- save overwrites previous entry

**`privacy-transport.test.ts`** (extended)
- `waitUntilSettled()` resolves on 'active', 'direct', 'failed'
- resolves immediately if already settled
- rejects after a hard timeout (N minutes) — optional safety

**`tor-ui.test.ts`** (updated mocks)
- keep passing after new exports from webtor-fallback (already fixed)

### E2E

**`e2e-tor-privacy-flow.ts`** (new)
- Launch browser, capture all `request` events
- Navigate, authenticate
- Assert that no `wss://` request is issued while `transport.getState()` is `bootstrapping`
- Assert the startup banner DOM element exists
- Click `Skip` → confirmation popup appears
- Click `Cancel` → popup closes, still bootstrapping, still no wss
- Click `Skip` again → `Continue without Tor`
- Assert `wss://` requests now appear, banner disappears
- Assert `localStorage['nostra-tor-enabled'] === 'true'` (session-scoped skip must not persist)

**`e2e-tor-wasm.ts`** (existing) must still pass unchanged.

## File inventory

**New:**
- `src/lib/nostra/tor-consensus-cache.ts`
- `src/components/nostra/torStartupBanner.tsx`
- `src/components/popups/torStartupSkipConfirm.tsx`
- `src/scss/nostra/_tor-startup.scss`
- `src/tests/nostra/tor-consensus-cache.test.ts`
- `src/tests/e2e/e2e-tor-privacy-flow.ts`

**Modified:**
- `src/lib/nostra/nostra-bridge.ts` — deferred `pool.initialize()`, banner mount
- `src/lib/nostra/webtor-fallback.ts` — cache-aware fetch shim
- `src/lib/nostra/privacy-transport.ts` — `waitUntilSettled()` API
- `src/components/chat/topbar.ts` — remove inline TorBanner mount (kept TorShield)
- `src/tests/nostra/privacy-transport.test.ts` — new cases
- `index.html` — WASM preload hints
- `src/scss/nostra/_index.scss` — import new partial (if that aggregator exists)

## Open questions answered during brainstorming

- **Banner position:** overlay full-width on top of the app chrome, non-blocking — lets users read cached chats and draft messages.
- **TorBanner in topbar:** removed to avoid two banners. TorShield icon stays.
- **Skip persistence:** session-scoped only. `nostra-tor-enabled` localStorage flag stays `true`.
- **Settings link in skip popup:** points to existing Privacy & Security tab.
