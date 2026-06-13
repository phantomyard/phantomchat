# ARCHITECTURE.md — Nostra.chat deep notes

Companion to `CLAUDE.md` in the repo root. Read `CLAUDE.md` first for core rules, commands, and the middleware rules table. This file contains deeper architecture notes that are only relevant when you're actively working on the corresponding subsystem.

## Table of Contents

- [Tor WASM runtime (webtor-rs)](#tor-wasm-runtime-webtor-rs)
- [Testing P2P Code (Vitest)](#testing-p2p-code-vitest)
- [E2E Testing (Playwright)](#e2e-testing-playwright)
- [Own Profile Sync (cache-first SWR)](#own-profile-sync-cache-first-swr)
- [Profile Tab Structure (`editProfile/`)](#profile-tab-structure-editprofile)
- [Blossom Avatar Upload](#blossom-avatar-upload)
- [Phase A Controlled Updates (`src/lib/update/`)](#phase-a-controlled-updates-srclibupdate)

---

## Tor WASM runtime (webtor-rs)

- `ChatAPI` owns its OWN `NostrRelayPool` separate from `NostraBridge._relayPool`. Privacy/startup gates must touch BOTH — `chatAPI.initGlobalSubscription()` bypasses the bridge pool.
- `PrivacyTransport.waitUntilSettled()` is the authoritative gate (resolves on `active`/`direct`/`failed`). Defer ALL network-touching init behind it when Tor is enabled — no WebSocket must leak the user's IP during the 30-40s bootstrap window.
- Tor consensus files: `public/webtor/consensus.br.bin` + `microdescriptors.br.bin`. Refresh with `pnpm run update-tor-consensus` (runs automatically only via `pnpm build:release`, which CI invokes — plain `pnpm build` uses the committed snapshot so dev builds are reproducible and don't mutate `public/webtor/`). **Do NOT rename to `.br`** — Vite auto-sets `Content-Encoding: br` for `.br` files, the browser pre-decompresses before the WASM fetch shim sees the bytes, and consensus load fails with `Invalid Data`.
- `webtor-fallback.ts` rewrites stale `privacy-ethereum.github.io/webtor-rs/*` URLs to local `/webtor/*.br.bin` and caches them in `CacheStorage` (2h TTL via `tor-consensus-cache.ts`). Staleness symptom: `Failed to extend to middle: Circuit-extension handshake authentication failed`.
- **Never timeout `WebtorClient.fetch()` with `Promise.race`** — arti serializes concurrent callers inside WASM and abandoned promises don't free the stream, wedging the client. Bootstrap retries only via fresh `WebtorClient` (not `abort()`); `PrivacyTransport.bootstrap()` already retries 4× with new clients.
- Tor HTTP polling (`NostrRelay.startHttpPolling`) chains via `setTimeout` in a `finally` block, never `setInterval` — a 3s interval with 45s per-fetch timeouts saturates the WASM tunnel.
- Debug handles: `window.__nostraTransport`, `__nostraPool`, `__nostraPrivacyTransport`. Access private `webtorClient` via `(t as any).webtorClient`.

---

## Testing P2P Code (Vitest)

**Commands:**
- TS check: `npx tsc --noEmit 2>&1 | grep "error TS"` (Vite checker may show stale cached errors). Expect ~30 pre-existing errors from `@vendor/emoji`, `@vendor/bezierEasing`.
- Unit tests: `npx vitest run src/tests/nostra/` — peer mapper, VMT server, sync, relay pool, crypto.
- `pnpm test:nostra:quick` lists files explicitly — add new tests there or they won't run in the fast path.
- `pnpm test:nostra` runs 78 files / 1044 tests. Must exit with 0 failures and 0 unhandled errors.

**Vitest quirks** (`isolate: false` + `threads: false` — shared module registry across files):
- `vi.mock()` factories persist across files. Use `mockImplementation()` in `beforeEach`, not shared state.
- Always pair `vi.mock('@lib/rootScope')` with `afterAll(() => { vi.unmock('@lib/rootScope'); vi.restoreAllMocks(); })` — else later tests get the mock instead of real rootScope and cascade-fail.
- **`vi.mock()` cannot override already-cached modules** under `isolate: false`. If a module was loaded by a previous test file, `vi.mock` at file top has no effect. The reliable pattern: `vi.resetModules()` + `vi.doMock()` + dynamic `await import()` inside `beforeAll`. See `tor-bootstrap.test.ts` or `migration.test.ts` for examples.
- **Global object mutations leak across files.** `globalThis.RTCPeerConnection`, `(global as any).indexedDB`, etc. must be saved before and restored in `afterAll`. See `mesh-manager.test.ts` and `virtual-peers-db.test.ts`.
- **`rootScope.dispatchEvent` crashes in vitest** — it forwards events via `MTProtoMessagePort.getInstance().invokeVoid()` which is undefined. Mocking `@lib/mainWorker/mainMessagePort` doesn't help under `isolate: false` (rootScope already cached with real import). Mock rootScope itself via `vi.doMock('@lib/rootScope', ...)`.
- `fake-indexeddb/auto`: use unique IDs per test (e.g. `uniqueConvId()`) — IndexedDB state persists across files.
- Don't mock `MOUNT_CLASS_TO` via `vi.mock('@config/debug')` — it's a mutable singleton. Set `MOUNT_CLASS_TO.apiManagerProxy = {...}` directly in `beforeEach`.

**Worktrees:**
- Need `pnpm install` + both `.env.local` AND `.env.local.example` copied from main repo (Vite fails with ENOENT otherwise).
- Parallel dev servers: `pnpm exec vite --force --port <8090-8099> --strictPort`.

**Runtime access:**
- Use `rs.managers.appMessagesManager.*` (imported from `@lib/rootScope`). `apiManagerProxy.managers` is the IPC proxy class, NOT the namespace. `rs.managers` is undefined during early boot — wait for `window.__nostraChatAPI` first.
- Injecting synthetic P2P peers needs `storeMapping(pubkey, peerId, displayName)` from `virtual-peers-db.ts`. Without persistence, VMT's `getPubkey(peerId)` returns null and bridge calls silently return `emptyUpdates`.
- Playwright console filter must exclude `MTPROTO`, `relay_state`, `nostra_relay_state` noise. Include only: `[ChatAPI]`, `[NostrRelay]`, `[NostraSync]`, `[NostraOnboarding`, `[VirtualMTProto`.
- **Tests can pass for the wrong reason.** Seeding `nostra-profile-cache` via `localStorage.setItem` and reloading bypasses the entire signal/dispatch chain via `loadCachedProfile()`. A green test here does NOT prove the fresh-onboarding path works — verify in a real browser (chrome-devtools MCP with `new_page`/`isolatedContext`) before claiming a signal-dependent bug is fixed.

---

## E2E Testing (Playwright)

**Running tests:**
- `pnpm test:e2e:all` (bail on first failure) / `:all:no-bail` / `pnpm test:e2e <file>` / `pnpm test:e2e:debug <file>`.
- Launch via `launchOptions` from `helpers/launch-options.ts`. Env: `E2E_HEADED=1`, `E2E_SLOWMO=N`, `E2E_DEVTOOLS=1`. Never hardcode `headless: true`.
- New tests must be added to `TESTS` array in `src/tests/e2e/run-all.sh` or they're skipped silently.
- `// @ts-nocheck` at top of E2E files (playwright types not in tsconfig).
- `APP_URL`/`E2E_APP_URL` env var for worktree runs on alternate ports (`e2e-p2p-edit.ts` / `e2e-bug-regression.ts` reference pattern).

**Page boot:**
- **Vite HMR fails on first headless load** (`ERR_NETWORK_CHANGED`). Pattern: `goto({waitUntil: 'load'})` → `waitForTimeout(5000)` → `reload({waitUntil: 'load'})` → `waitForTimeout(15000)`.
- Wait on selectors, not fixed timeouts: onboarding `button:has-text("Create New Identity")` (30s); post-onboarding `.sidebar-header .btn-menu-toggle`. Fresh worktrees compile slower.
- "Get Started" onboarding button may hang on relay publish — click `SKIP` link as fallback.
- Dismiss overlays via shared helper: `import {dismissOverlays} from './helpers/dismiss-overlays'`. `BLOCKING_SELECTORS` is the single source of truth — add new blocking overlays there. Tests that need an overlay present (e.g. `e2e-tor-privacy-flow.ts` querying `.tor-startup-banner`) must NOT call it.

**Clicking in Solid.js (critical):**
Solid uses event delegation, so **synthetic clicks do not fire delegated handlers**. This covers `element.dispatchEvent(new MouseEvent('click'))`, `HTMLElement.click()` inside `page.evaluate()`, and raw `page.mouse.down/up` at computed coordinates. Always either (a) use Playwright's `locator.click()`, or (b) compute `getBoundingClientRect()` in `page.evaluate()` and then `await page.mouse.click(x, y)` from the test side. Also: never wrap popup containers with `onClick={e => e.stopPropagation()}` — it breaks delegation for all descendants; handle dismiss-on-outside-click elsewhere.
**Exception — sidebar hamburger (`ButtonMenuToggle`)**: uses plain `addEventListener`, NOT Solid delegation. Playwright's `.click()` often fails here because the search input overlays intercept pointer events. Instead, dispatch synthetic `mousedown` + `click` on the same button element via `page.evaluate()` — both events MUST share the target or `hasMouseMovedSinceDown` rejects the handler.

**Input handling:**
- `msgArea.pressSequentially(text)` does NOT clear input. Between sends: `Control+A` → `Backspace` → `type(text)`. **Never use `Delete`** after `Control+A` — it eats the first char of the next `type()` call.
- **Markdown italic trap:** underscores in test strings (e.g. `Bug3_reply_`) get parsed as `<i>`. Use dashes: `Bug1-first-msg-${Date.now()}`.

**Assertions & selectors:**
- NEVER `document.body.textContent.includes()` — matches chat list preview. Use `.bubble .message, .bubble .inner, .bubble-content`.
- **Bubble text extraction:** `.message` contains `.time`, `.time-inner`, `.reactions`, `.bubble-pin`. Clone + `querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach(e => e.remove())` before reading text.
- Count unique bubbles via `.bubble[data-mid]` + `Set<mid>`. Filter `.message` selectors with `.closest('.reply, .quote') == null` to skip quoted text.
- Open chats via `appImManager.setPeer({peerId})` — headless click on `.chatlist-chat a` is unreliable.
- `peer_changing`/`peer_changed` dispatch on `appImManager`, not `rootScope` (`MOUNT_CLASS_TO.appImManager.addEventListener`).
- To trigger edit mode: call `appImManager.chat.input.initMessageEditing(mid)` directly, then fill input and click `button.btn-send`.

**Local relay & network:**
- `LocalRelay` (`src/tests/e2e/helpers/local-relay.ts`) manages a strfry Docker container on `ws://localhost:7777`. `relay.injectInto(ctx)` overrides `DEFAULT_RELAYS` via `window.__nostraTestRelays` (set before page load via `addInitScript`). Uses `--user $(id -u):$(id -g)` + `--tmpfs /app/strfry-db` (RAM-backed, no stale data, no root cleanup).
- Public relay propagation needs **30s** timeout. damus.io + nos.lol reliable; snort.social + nostr.band frequently down.
- Bidirectional tests need two separate `browser.newContext()` for isolated storage.
- When filtering WebSocket traffic (`page.on('websocket')`), exclude `ws://localhost:*` — Vite HMR pollutes assertions.
- `MutationObserver` for transient DOM (toasts, overlays) must be registered BEFORE the triggering action.
- ALWAYS run `e2e-bidirectional.ts` after pipeline changes — sender-only tests don't verify receive.
- Canonical regression suite: `e2e-bug-regression.ts` (4 P2P bugs).

**Manual alternative:** When Playwright LocalRelay harness is flaky, use chrome-devtools MCP with `new_page({url, isolatedContext: "userA"})` + `new_page({url, isolatedContext: "userB"})` — isolated contexts give fully separate storage, faster and more deterministic for one-off verification.

---

## Own Profile Sync (cache-first SWR)

- Source of truth: relay. Cache: `localStorage.nostra-profile-cache` (`{profile, created_at}`).
- `src/lib/nostra/own-profile-sync.ts` exposes `hydrateOwnProfileFromCache()` (sync read + dispatch `nostra_identity_updated`), `refreshOwnProfileFromRelays(pubkey)` (background fetch, newest `created_at` wins), `saveOwnProfileLocal(profile, created_at)` (optimistic update before publish).
- Boot: `nostra-onboarding-integration.ts` hydrates then refreshes in background. Save: `editProfile` calls `saveOwnProfileLocal` before `publishKind0Metadata`.
- `useNostraIdentity()` exposes `about`, `website`, `lud16`, `banner` alongside `npub`, `displayName`, `nip05`, `picture` — driven by `nostra_identity_loaded`/`_updated` in `src/stores/nostraIdentity.ts`.
- Conflict resolution: `fetchOwnKind0(pubkey)` queries all relays in parallel, returns highest `created_at`; cache updates only when relay is newer.
- **Do NOT add plain localStorage stopgaps** for new profile fields — they must flow through `saveOwnProfileLocal` → kind 0 publish to survive multi-device.
- Legacy `nostra-profile-extras` key auto-migrates and deletes on first read.
- **Kind 0 republish on boot must merge cached fields.** `nostra-onboarding-integration.ts` publishes kind 0 ~3s after mount. Sending only `display_name`+`name` clobbers `picture`/`about`/`nip05`/`website`/`lud16`/`banner` on the relay — then `refreshOwnProfileFromRelays` overwrites the local cache with the stripped version on the next boot. Always merge `loadCachedProfile()` fields into the republish, and skip entirely when `fetchOwnKind0` shows the relay is already current.

---

## Profile Tab Structure (`editProfile/`)

- `src/components/sidebarLeft/tabs/editProfile/` is a directory; consumers still `import from '@components/sidebarLeft/tabs/editProfile'` (resolves to `index.ts`).
- Tests using `fs.readFileSync` must use `editProfile/index.ts`, not `editProfile.ts` — the latter no longer exists.
- Files: `index.ts` (orchestrator — boot, save, focus, pubkey row) / `basic-info-section.ts` (Name/Bio/Website/Lightning via `createBasicInfoSection`) / `nip05-section.ts` (alias + setup + verify).
- Add a new input: extend `BasicInfoSection` (or new section file), wire via `setInitialValues`/`getValues`, extend `publishKind0Metadata` in `index.ts` `save()`.

---

## Blossom Avatar Upload

- `src/lib/nostra/blossom-upload.ts` → `uploadToBlossom(blob, privkeyHex)`. Signs NIP-24242 (kind 24242), PUTs to fallback chain: `blossom.primal.net` → `cdn.satellite.earth` → `blossom.band`.
- Avatar `Blob` exposed via `EditPeer.lastAvatarBlob` (widened `AvatarEdit.onChange`). `EditPeer.uploadAvatar()` is MTProto-only, NOT used here.
- SHA-256 via Web Crypto (`crypto.subtle.digest`), no `@noble/hashes` / `blossom-client-sdk` deps.

---

## Phase A Controlled Updates (`src/lib/update/`)

User-controlled PWA updates with 3-source integrity verification (Cloudflare / GitHub Release / IPFS). Spec: `docs/superpowers/specs/2026-04-16-phase-a-controlled-updates-design.md`. Entry: `updateBootstrap()` called first in `src/index.ts` DOMContentLoaded — runs Step 0 (first-install baseline) → Step 1a (local SW URL consistency) → Step 1b (`registration.update()` byte-compare; bypasses SW fetch handler per spec, so compromised SWs can't lie) → Step 2 (cross-source manifest verification, 5 verdicts). SW lifecycle: no `skipWaiting()` in install (new SW stays in `waiting`), activation only via main-thread `postMessage({type: 'SKIP_WAITING'})`, navigation intercepted in `onFetch` to serve cached `index.html`. Update flow: `startUpdate(manifest)` in `update-flow.ts` — download each bundle file, SHA-256 verify against `manifest.bundleHashes`, `register()` new SW URL, SKIP_WAITING + reload. State persisted in `localStorage['nostra.update.*']` — cleared by `nostra-cleanup.ts`. Manifest emitted by `src/scripts/build/emit-update-manifest.ts` post-build; published to 3 origins via `.github/workflows/deploy.yml`.

**Build quirk:** Vite emits multiple `sw-*.js` files — the registered production SW is only the one referenced from `dist/index.html`'s main chunk. `emit-update-manifest.ts` resolves this by parsing `index.html` → finding main chunk → grepping for the `sw-*.js` reference. A naive regex scan of `dist/` for `sw-*.js` picks up worker-internal chunks and produces the wrong `swUrl`.

**Dev-mode gates (`pnpm start`):**
- `updateBootstrap()` is guarded by `if(import.meta.env.PROD && 'serviceWorker' in navigator)` in `src/index.ts`. Manifest URLs point to production origins and Vite HMR regenerates the SW hash every session, so running it in dev false-positives Step 1a and throws the "possibile compromissione rilevata" compromise alert on reload. Do not drop this guard to "test the update flow locally" — build + serve from `dist/` instead.
- `resetLocalData.ts` must `await import('@components/confirmationPopup')` lazily. A static import pulls in `popups/index` → `popups/peer`, creating a circular-init race in Vite dev's ESM graph that throws `ReferenceError: Cannot access 'PopupPeer' before initialization` at `popups/mute.ts`'s `extends PopupPeer` line. `clearAllExceptSeed` from `nostra-cleanup.ts` is also lazy-imported for the same reason.
- Regression coverage: `src/tests/e2e/e2e-dev-boot-smoke.ts` asserts the dev server boots without the TDZ error and without the compromise banner firing.
