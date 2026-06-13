# CLAUDE-RULES.md — Nostra.chat Subsystem Rules

This file holds the durable, code-touching rules that aren't derivable from the code alone. CLAUDE.md links here. For broader architecture narrative, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For fuzz status / open findings, see [`FUZZ-FINDINGS.md`](FUZZ-FINDINGS.md).

## Worker Context

- Managers run in a DedicatedWorker even with `noSharedWorker=true`. `src/lib/appManagers/` + `src/lib/storages/` run Worker-side where `window` is undefined — never import window-touching modules there without `typeof window !== 'undefined'` guards.
- `loadIdentity()` returns `{publicKey, privateKey}` as **hex strings** (not base64). No conversion needed before passing to `nostr-tools` helpers like `finalizeEvent` (with `hexToBytes`) or before signing NIP-98 headers.
- `@noble/hashes/utils` exports require the explicit `.js` suffix in this version (e.g. `import {hexToBytes} from '@noble/hashes/utils.js'`). Bare `'@noble/hashes/utils'` resolves but with missing exports.
- `getSelf()` returns `undefined` in Nostra mode (no MTProto auth) — guard all `.id` access.
- `rootScope.myId === NULL_PEER_ID` (0) → `isOurMessage()` uses `pFlags.out` as fallback.
- Worker `rootScope` events don't cross to main thread (separate instances). Only `message_sent`/`messages_pending` are mirrored via MessagePort.
- **Vite worker build does NOT inject `import.meta.env.PROD`** — guards inside `src/lib/serviceWorker/*` evaluate `PROD` to `false` and tree-shake the gated block out of the SW bundle entirely. Use a different gate (e.g. `'serviceWorker' in self`, runtime feature check) instead. Same applies to dynamic imports inside SW: prefer static imports for SW dependencies — Vite chunk splits make `await import(...)` unreliable in SW context.

## Peer Mirroring

Storing a user in Worker's `appUsersManager.users[]` is NOT enough — call `this.mirrorUser(user)` to sync to `apiManagerProxy.mirrors.peers` and the Solid `peers` store. Without mirroring, `getPeer()`/`usePeer()` return `undefined` on main thread.

## Virtual MTProto Architecture (MessagePort Bridge)

`nostraIntercept()` in `apiManager.ts` routes Worker method calls: **Static** (`NOSTRA_STATIC` — `help.getConfig`, `updates.getState`, `account.*`, `stories.*`) return shaped stubs; **Bridge** (`NOSTRA_BRIDGE_METHODS` — getHistory, getDialogs, search, deleteMessages, sendMessage, sendMedia, getContacts, getUsers, getFullUser, editMessage) forward via `port.invoke('nostraBridge', ...)` to main-thread `apiManagerProxy` → `NostraMTProtoServer.handleMethod()` → `message-store.ts` (IndexedDB) → native MTProto response. Worker processes normally via `saveMessages()` → `setMessageToStorage()` → mirror → UI. `NostraSync` handles incoming ChatAPI messages → persist → dispatch `nostra_new_message`. Design principle: vanilla tweb code works unchanged; the bridge is transparent. Debug: `window.__nostraMTProtoServer`.

## Virtual MTProto Middleware Rules

| Rule | Why |
|---|---|
| `createTwebUser()` in `virtual-mtproto-server.ts` MUST pass `firstName: mapping?.displayName` via `getMapping()` | Omitting → hex fallback names overwrite correct names after reload |
| `NOSTRA_ACTION_PREFIXES` in `apiManager.ts` must NOT contain `.get` or `.check` | Query methods need shaped responses, not `return true` |
| P2P send shortcut in `appMessagesManager.ts` must dispatch `message_sent` (not just `messages_pending`) AND call `setMessageToStorage()` | Needed for bubble ⏳→✓ transition + context menu |
| `window.__nostraOwnPubkey` must be set in `nostra-onboarding-integration.ts` | `contacts.ts` needs it to persist conversations |
| `saveApiUser()` preserves P2P synthetic user's `first_name` | Prevents bridge responses overwriting nicknames with hex fallbacks |
| `nostra_new_message` handler must build messages via `mapper.createTwebMessage()` directly | Never re-read from message-store — IndexedDB round-trip has 0-5s latency and silently drops messages |
| Call `rs.managers.appMessagesManager.invalidateHistoryCache(peerId)` after `nostra_new_message` arrives | Resets `SlicedArray`; without it, reopened chats return stale history |
| Synthetic dialogs via `dialogs_multiupdate` must carry `(dialog as any).topMessage = msg` (full object) | Else `setLastMessage` falls back to `getMessageByPeer` and fails when `hasReachedTheEnd=false` |
| `NostraSync.onIncomingMessage()` MUST save with `eventId = msg.relayEventId \|\| msg.id` | Mismatched eventIds (parsed `chat-XXX-N` vs rumor hex) → duplicate rows → two bubbles |
| `ChatAPI.connect(peerPubkey)` MUST be a lightweight `activePeer` switch, NOT `disconnect()` + reconnect | `disconnect()` tears down the relay pool and kills the self-echo subscription |
| `inputMessagesFilterPinned` intercepted in BOTH `searchMessages` AND `getHistory`, return empty | `ChatPinnedMessage` routes via either depending on context |
| VMT `sendMessage` must return `nostraMid` + `nostraEventId` | Worker's P2P shortcut renames temp mid `0.0001` → real timestamp mid; without this, outgoing bubbles sort wrong |
| `generateTempMessageId` MUST use `base + 1` (integer) for `base >= 2^50`, NOT `base + 0.0001` | Float precision collapses for P2P virtual mids ≈1.78e15 → tempMid == topMessage → `message_sent` overwrites incoming bubble's `data-mid` → dup-mid (FIND-cfd24d69) |
| `beforeMessageSending` MUST skip `history_append` dispatch for P2P peers (`peerId >= 1e15`) | Main-thread `injectOutgoingBubble` is sole render path; dual dispatch → duplicate DOM |
| Main-thread VMT code MUST use `rs.dispatchEventSingle(...)`, never `rs.dispatchEvent(...)` | The latter forwards via `MTProtoMessagePort` and throws unhandled rejections in vitest |
| `messages.editMessage` MUST be in `NOSTRA_BRIDGE_METHODS` | Otherwise `.edit` action prefix short-circuits it |

**P2P edit protocol**: edits are new NIP-17 gift-wraps carrying `['nostra-edit', '<originalAppMessageId>']` — the `chat-XXX-N` form, NOT rumor hex. Sender rows use it as `eventId`, receiver rows as `appMessageId`, so a single `getByAppMessageId` lookup works on both sides. Receive handler upserts the original row preserving `mid`/`twebPeerId`/`timestamp`; only `content` + `editedAt` change. Author verification mandatory: drop edits where `rumor.pubkey !== original.senderPubkey`.

## Service Worker Install Precache

- `SKIP_PRECACHE_PATTERNS` (in `src/lib/serviceWorker/index.service.ts`) filters paths out of the install-time fetch loop so first-install finishes in ~3-4s instead of ~27s. Emoji PNGs (3788 files, 22MB) are the current entry. Skipped paths still appear in `bundleHashes` — they're just lazy-loaded via the fetch handler on first use.
- **Manifest path format trap**: `update-manifest.json` paths ship with a leading `./` prefix (release-pipeline quirk, not Vite). Any regex against bundle paths MUST normalize via `p.replace(/^\.?\//, '')` first — use the `normalizeManifestPath()` helper next to the filter. A no-op filter shipped undetected in 0.14.1 because Vite local builds don't emit the manifest; writing unit tests against the live manifest (or a fixture of it) is the right safety net.
- The install handler is tolerant of per-path fetch failures (catches URL-reserved chars like `#` in changelog filenames). It throws only when `successCount === 0`.

## Message Receive Pipeline

- `initGlobalSubscription()` in `chat-api.ts` subscribes to kind 1059 on all relays at boot. Without it, only peers from `chatAPI.connect()` are heard.
- **Receive chain**: relay WS → `NostrRelay.handleEvent()` → gift-wrap decrypt → `RelayPool.handleIncomingMessage()` → `ChatAPI.handleRelayMessage()` → `NostraSync.onIncomingMessage()` → `message-store` → `nostra_new_message` → `history_append` → bubble.
- **Relay echo**: own sent messages come back via subscription. `handleRelayMessage` checks `msg.from === this.ownId` — same-device echoes skipped via `store.getByEventId()`, cross-device saved as `isOutgoing: true` (multi-device ready).
- `NostrRelay.handleDisconnect()` uses infinite backoff: `1s, 2s, 4s, …` then steady 10s. Only explicit `disconnect()` stops retries.

## Delivery Tracker & Receipts

- `DeliveryTracker.states` is keyed by app messageId (`chat-XXX-N`), NOT rumor hex. Receipts from `handleRelayMessage` must use `chatMessage.id` (parsed from content), not `msg.id` — else `handleReceipt` silently no-ops.
- `deliveryTracker` must be initialized in BOTH `ChatAPI.connect(peer)` AND `initGlobalSubscription()` — else reload-then-receive-receipt drops all receipts silently.
- `chatAPI.markRead(eventId, senderPubkey)` exists but no production code calls it — sender bubbles stay at ✓✓ (delivered) instead of blue (read). A `peer_changed` listener should iterate visible `is-in` bubbles and call it.
- `nostra_delivery_update` handled by `nostra-delivery-ui.ts`, maps `eventId → mid` via `NostraPeerMapper.mapEventId(eventId, timestamp)`.

## Logout & Data Cleanup

- Settings logout calls `showLogOutPopup()` from `@components/popups/logOut` — never inline `indexedDB.deleteDatabase + reload`. `nostra-cleanup.ts` is the centralized module.
- Cleanup MUST run in the main thread (Worker has no `localStorage`). `apiManager.logOut()` only handles `deleteEncryptedIdentity()`.
- `indexedDB.deleteDatabase()` blocks silently if any connection is open. Close singletons via `destroy()` first, then `forceCloseDB()` for orphan connections (`key-storage.ts`, `identity.ts` open DBs on-demand).
- `VirtualPeersDB` has TWO connections (`this._db` class-level + `_dbPromise` module-level singleton) — `destroy()` must close both.
- Nostra IndexedDB: `nostra-messages`, `nostra-message-requests`, `nostra-virtual-peers`, `nostra-groups`, `NostraPool`, `Nostra.chat`.
- Nostra localStorage: `nostra_identity`, `nostra-relay-config`, `nostra-last-seen-timestamp`, `nostra:read-receipts-enabled`.
- `.toasts-container` has `z-index: 5` — too low for popup transitions. Use a dedicated overlay with `z-index: 9999` for destructive-action feedback.
- **Reset Local Data** (sibling of logout): `showResetLocalDataPopup()` in `src/components/popups/resetLocalData.ts` wipes everything except the seed via `clearAllExceptSeed()` in `nostra-cleanup.ts` and calls `apiManager.logOut(undefined, {keepNostraIdentity: true})` so the Worker-side `deleteEncryptedIdentity()` is skipped. A `sessionStorage` marker (`nostra-just-reset`) triggers a confirmation toast on the next boot via `maybeShowResetToast()` called from `src/index.ts`.

## UI Components

- The active "Add Contact" dialog is in `src/components/sidebarLeft/tabs/contacts.ts` (imperative DOM), NOT `src/components/nostra/AddContact.tsx` (Solid.js — unused).
- `bubbles.ts` is 11000+ lines. `appMessagesManager.ts` is 8500+ lines. Changes to these files risk cascading side effects.
- All `notDirect` flags were removed from `contextMenu.ts` — all chats are Nostra, there are no Telegram DMs. The type field, invocation logic, and all 10 button properties were deleted.
- Hamburger profile entry (`buildNostraProfileMenuContent` in `sidebarLeft/index.ts`): the async storage-read path must generate a dicebear avatar from the stored npub *before* calling `fetchOwnKind0`, otherwise fresh-onboarding (no cache, no kind 0 picture) leaves `avatar.src=""` until the user opens the profile tab.

## Nostra Module Architecture

`nostra-onboarding-integration.ts` is a thin orchestrator (~240 lines) wiring: `nostra-message-handler.ts` (incoming message builder), `nostra-pending-flush.ts` (queue for closed-chat peers), `nostra-read-receipts.ts` (batch on peer open), `nostra-delivery-ui.ts` (bubble sent/delivered/read icons). `chat-api-receive.ts` extracts `handleRelayMessage` with `ReceiveContext` DI as pure step functions (`isDeleteNotification`, `parseMessageContent`, `extractFileMetadata`, `isDuplicate`). All Nostra rootScope events are typed in `BroadcastEvents` (rootScope.ts) — no `as any` casts.

## Background Push Notifications

- Client subscribes via `nostra-push-client.ts` to a self-hosted Nostr → Web Push relay (NOT in this repo). Default endpoint `https://push.nostra.chat`; configurable via Settings → Notifications → Advanced.
- Server source: https://github.com/nostra-chat/nostr-webpush-relay (AGPL-3.0, Node.js). HTTP contract in that repo's `docs/PROTOCOL.md`.
- Auth: NIP-98 signed events (`buildNip98Header` in `nostra-push-client.ts`).
- SW handler: `src/lib/serviceWorker/nostra-push.ts` — discriminates on `payload.app === 'nostra-webpush-relay'`. Decryption gated by user's preview level (A=generic / B=full / C=sender-only); when A, privkey is never read in SW.
- SW-safe identity loader: `nostra-identity-sw.ts` (IDB-only, no `localStorage` fallback — SW context lacks it).
- Privacy disclosure: [`PUSH-NOTIFICATIONS.md`](PUSH-NOTIFICATIONS.md).

## MTProto Intercept (`apiManager.ts`)

- `nostraIntercept()` tries dynamic server first (main thread only), then checks `NOSTRA_STATIC`, then `NOSTRA_BRIDGE_METHODS` (Worker→Main via MessagePort), then action prefixes, then fallback `{pFlags: {}}`.
- `NOSTRA_STATIC` must return properly shaped responses — `{pFlags: {}}` causes "Cannot read properties" errors in managers.
- `messages.getDialogFilters` must return `{filters: []}` not `[]` — `filtersStorage` calls `.filters` on the result.
- `stories.getAllStories` must include `peer_stories: []`, `stealth_mode: {}` — `appStoriesManager` iterates these.
- `users.getFullUser` must include `profile_photo: {_: 'photoEmpty'}` — `appProfileManager` accesses it.

## Bug Fuzzer (stateful property-based)

`pnpm fuzz` runs a long-running fuzzer that generates random action sequences across 2 Playwright contexts + LocalRelay and verifies tiered invariants (cheap + medium + regression) after every action. Findings are appended (deduplicated by signature) to [`FUZZ-FINDINGS.md`](FUZZ-FINDINGS.md); minimal replay traces live in `docs/fuzz-reports/FIND-<sig>/trace.json`.

- `pnpm fuzz --duration=2h` — overnight run
- `pnpm fuzz --replay=FIND-<sig>` — deterministic replay of a finding
- `pnpm fuzz --replay-baseline` — 30s regression check against the committed baseline (see [`FUZZ-FINDINGS.md`](FUZZ-FINDINGS.md) for emit status)
- `pnpm fuzz --headed --slowmo=200` — watch the fuzzer in a real browser
- `pnpm fuzz` runs preserve `docs/FUZZ-FINDINGS.md` curation automatically. No `git restore` workaround needed.
- Phase specs: `docs/superpowers/specs/2026-04-*-bug-fuzzer-*.md`

**Fuzz operational notes:**

- Each fuzz iter ≈ 66s harness boot + 30-60s actions — minimum useful budget is 3min.
- Hook Worker-side managers (not main-thread wrappers like `chat.sendReaction`); fuzz actions and programmatic callers reach managers via `rs.managers.X` proxy and bypass UI entry points.
- Stop a hung fuzz: `pkill -9 -f "tsx.*fuzz"; pkill -9 -f chromium` (regular `pkill -f` may miss the inner tsx node child).
- New tests in `src/tests/fuzz/` are auto-discovered; new tests in `src/tests/nostra/` must be appended to the explicit file list in `package.json` `test:nostra:quick`.
- **For debugging a specific reproducible bug, prefer a targeted E2E over the fuzz.** Import `bootHarness()` from `src/tests/fuzz/harness.ts` in a standalone tsx script, run one deterministic action flow, dump `user.consoleLog[]` at end. ~80s per pass vs 5min+ for random fuzz. Run with `node_modules/.bin/tsx <path>` (bypasses `npx` rewrite).
- **strfry rejects events silently.** LocalRelay responds with `["OK", eventId, false, "reason"]` for rejected events but `src/lib/nostra/nostr-relay.ts` has no `case 'OK'` handler — rejections are dropped on the floor. When a publish "succeeds" but the event never appears in `getAllEvents()`, the relay rejected it. Add a temporary OK-logger in the `switch(type)` default branch to surface the reason.
- **Vite-plugin-checker overlay blocks Playwright clicks in headless.** Any ESLint warning (including superfluous `eslint-disable-next-line no-console` when no `no-console` rule exists) renders `<vite-plugin-checker-error-overlay>` that intercepts pointer events → `.click()` retries then times out. Before debugging a click timeout, check the dev server log for ESLint warnings. Don't add eslint-disable pragmas that aren't needed.
- **Stale `pnpm start` from removed worktrees occupy :8080.** `git worktree remove` doesn't kill the dev-server process; it keeps serving from the deleted path. New `pnpm start` in a fresh worktree falls to :8081/:8082. Fuzz harness hardcodes `APP_URL=http://localhost:8080` → "Failed to fetch dynamically imported module" errors. Fix: `ss -tlnp | grep ':808'` + `kill <pid>` before starting new server.
- **Push API E2E tests MUST use `chromium.launchPersistentContext()`**, NOT `chromium.launch().newContext()`. Chrome blocks Push API in incognito/ephemeral profiles (crbug/41124656) → `pushManager.subscribe()` returns "permission denied". Reference: `src/tests/e2e/e2e-push-bilateral.ts`.
- In a persistent context the installed Service Worker intercepts `/src/...` requests and 404s them — the dynamic-import pattern from `e2e-reactions-bilateral.ts` (`import('/src/lib/nostra/...')`) won't work. Use UI-driven Playwright clicks/fills instead.

**Adding a fuzz artifact** — `src/tests/fuzz/invariants/<tier>.ts` (one file per tier: `console.ts`, `bubbles.ts`, `delivery.ts`, `avatar.ts` = cheap; `state.ts`, `queue.ts` = medium; `regression.ts` = regression). Register in `invariants/index.ts`. Add a Vitest in the same directory. Same additive pattern for `postconditions/<category>.ts`.

**Phase status & open findings:** see [`FUZZ-FINDINGS.md`](FUZZ-FINDINGS.md) for the current open list, regression-watch entries, and per-phase closure log. The enduring rules surfaced by these phases are captured in **Virtual MTProto Middleware Rules** and **Bubble Rendering** above — that's what this file tracks; the chronology is in the findings doc.

## Bubble Rendering

- Kind 0 profile must be PUBLISHED during onboarding (not just saved locally) for other users to fetch it.
- P2P messages are populated in mirrors automatically via the bridge pipeline (Worker calls getHistory → saveMessages → mirror).
- Calling `appMessagesManager.getHistory({peerId, limit: 1})` from the main thread **pollutes the Worker's history cache** — it marks the slice as `SliceEnd.Both` fulfilled, causing subsequent larger-limit fetches to return the cached (incomplete) result without re-fetching. For P2P message injection, skip `getHistory` and inject directly into `apiManagerProxy.mirrors.messages[${peerId}_history][mid]` instead.
- `history_append` is a one-shot event that only fires when the chat is open with an active `bubbles.ts` listener. For messages arriving while the chat is closed, use a pending-messages queue and flush on `appImManager.addEventListener('peer_changed')` with retry delays (500ms, 1500ms, 3000ms) to wait for `loadedAll.bottom=true`.
- When auto-adding an unknown sender as a contact from `handleRelayMessage`, also inject the User object into `apiManagerProxy.mirrors.peers[peerId]` + call `reconcilePeer` + `appUsersManager.injectP2PUser` — otherwise the chat list title shows but preview text fails to render.
- For new dialogs from unknown senders, `dialogs_multiupdate` must be dispatched TWICE: first dispatch adds the dialog via `sortedList.add()` (returns early, skips `setLastMessageN`), second dispatch hits the "existing dialog" branch which renders the preview text. A single dispatch shows the peer title but no message preview.
