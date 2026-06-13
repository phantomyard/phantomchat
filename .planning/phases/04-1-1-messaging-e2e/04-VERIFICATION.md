---
phase: 04-1-1-messaging-e2e
verified: 2026-04-02T13:05:00Z
status: human_needed
score: 16/16 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 13/16
  gaps_closed:
    - "On ChatAPI init or relay reconnect, backfill from relay with since:getLatestTimestamp for each known conversation (MSG-02)"
    - "Message requests section shows messages from unknown senders with accept/reject"
    - "Onboarding flow completes successfully and app boots with full bridge chain initialized"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Send a text message and verify it renders as a bubble"
    expected: "Message appears as a chat bubble with correct sender name and timestamp"
    why_human: "Visual rendering requires a running browser"
  - test: "Send a photo from one user to another"
    expected: "Photo renders inline in the chat bubble (not as a download link)"
    why_human: "Inline image rendering requires running browser + actual Blossom upload"
  - test: "Delivery status icons: clock -> 1 check -> 2 checks -> 2 blue checks"
    expected: "Each state transition is visually reflected with the correct icon in the chat bubble"
    why_human: "Icon state transitions require running browser with two connected clients"
  - test: "Message requests section appears at top of chat list"
    expected: "A 'Richieste' row with badge count is visible when messages from unknown senders arrive"
    why_human: "MutationObserver-based DOM mounting of MessageRequestsRow requires running browser with chat list rendered"
  - test: "Read receipt toggle in Privacy settings"
    expected: "Toggle appears in Settings > Privacy & Security and disabling it stops blue checks"
    why_human: "Settings UI rendering requires running browser"
  - test: "Conversation deletion removes messages and notifies peer"
    expected: "Delete removes from IndexedDB, peer's client hides referenced messages, relay receives NIP-09 kind 5"
    why_human: "Multi-level deletion requires running browser with two clients and relay inspection"
---

# Phase 4: 1:1 Messaging E2E Verification Report

**Phase Goal:** Two users can have a complete 1:1 conversation via Nostr relays with metadata-private encrypted messages and media
**Verified:** 2026-04-02T13:05:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 04-05 and 04-06)

## Re-verification Summary

Previous verification (2026-04-02T09:00:00Z) found 3 gaps:
1. (Blocker) MessageRequests component orphaned — not mounted in any UI
2. (Partial) MSG-02 backfill via getMessages() returned empty array immediately
3. (Blocker) Onboarding CONTINUE button could block indefinitely on relay publish

All three gaps have been closed by commits `de9d32e` (plan 04-06) and `cb004e5`/`aba9d84` (plan 04-05). No regressions found. Score advances from 13/16 to 16/16.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | Text messages sent via ChatAPI are wrapped as NIP-17 gift-wrap (kind 14 -> kind 13 -> kind 1059) before publishing | VERIFIED | `chat-api.ts:24` imports `wrapNip17Message`; `nostr-crypto.ts` wraps via `wrapManyEvents` from nostr-tools/nip17 |
| 2 | Incoming kind 1059 events are unwrapped to extract rumor content and sender pubkey | VERIFIED | `nostr-relay.ts` checks `event.kind !== NOSTR_KIND_GIFTWRAP` and calls `unwrapNip17Message` in handleEvent |
| 3 | Self-send wrapping is included so messages appear on other devices | VERIFIED | nostr-tools `wrapManyEvents` includes `senderPublicKey` in recipients automatically |
| 4 | Relay subscription uses kind 1059 filter instead of kind 4 | VERIFIED | `nostr-relay.ts:327,368` both use `NOSTR_KIND_GIFTWRAP` (1059); no kind 4 references remain |
| 5 | Decrypted messages are cached in IndexedDB message-store for instant chat load | VERIFIED | `message-store.ts` exports `MessageStore` with all CRUD methods; wired in `chat-api.ts` |
| 6 | Offline queue flushes via gift-wrap pipeline, not raw kind 4 | VERIFIED | `offline-queue.ts` calls `relayPool.publish()` which uses gift-wrap; exponential backoff at 2s base, 2x multiplier, 5min cap |
| 7 | Relay backfill calls getLatestTimestamp per conversation on init and reconnect | VERIFIED | `nostr-relay.ts:315-359` now awaits EOSE via `queryResolvers` map with 10s timeout; pool deduplicates via `seenIds`; `chat-api.ts` calls `backfillConversations()` on init (line 244) and reconnect (line 685) |
| 8 | Photos encrypted with AES-256-GCM client-side before Blossom upload | VERIFIED | `media-crypto.ts:22` exports `encryptMedia` using `crypto.subtle`; `blossom-client.ts:145` calls `encryptMedia` in `uploadEncryptedMedia` |
| 9 | Encrypted blobs uploaded to Blossom with server fallback | VERIFIED | `blossom-client.ts:36-134` BlossomClient tries 3 DEFAULT_BLOSSOM_SERVERS; transport-agnostic via `fetchFn` injection |
| 10 | Downloaded blobs decrypted with key from NIP-17 message | VERIFIED | `blossom-client.ts:165-172` `downloadDecryptedMedia` calls `decryptMedia`; `nostra-display-bridge.ts:522` calls `downloadDecryptedMedia` |
| 11 | Each message has visible delivery state: sending -> sent -> delivered -> read | VERIFIED | `delivery-tracker.ts:18` exports `DeliveryState`; forward-only state machine; rootScope `nostra_delivery_update` dispatched |
| 12 | Delivery receipts are gift-wrapped kind 1059 (indistinguishable from messages) | VERIFIED | `delivery-tracker.ts:160` calls `wrapNip17Receipt`; `nostr-crypto.ts:129` creates kind 14 rumor wrapped in kind 1059 via nip59 |
| 13 | Read receipts only sent if user has receipts enabled (reciprocal) | VERIFIED | `delivery-tracker.ts` `sendReadReceipt()` checks `isReadReceiptsEnabled()` (localStorage); ignores read receipts when disabled |
| 14 | Receipt events do not trigger receipt events (no loops) | VERIFIED | `delivery-tracker.ts:134` calls `isReceiptEvent()` guard before processing |
| 15 | Messages from unknown pubkeys go to separate Richieste section with UI | VERIFIED | `message-requests.ts` MessageRequestStore routes unknown senders; `nostra-display-bridge.ts:134` `mountMessageRequests()` waits for `#chatlist-container` via MutationObserver and renders `MessageRequestsRow` via `solid-js/web render()`; `nostra_contact_accepted` event wired to `injectSyntheticPeer()` on accept |
| 16 | Onboarding flow completes within 5 seconds even if relay or IndexedDB operations hang | VERIFIED | `onboarding.ts:321` has `withTimeout(promise, 5000)` wrapping `saveEncryptedIdentity` and `saveBrowserKey`; catch-all fallback always calls `notifyIdentityCreated()` |

**Score:** 16/16 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/nostra/nostr-crypto.ts` | NIP-17 gift-wrap using nostr-tools/nip17 | VERIFIED | Exports `wrapNip17Message`, `unwrapNip17Message`, `wrapNip17Receipt` |
| `src/lib/nostra/nostr-relay.ts` | EOSE-based getMessages + kind 1059 subscription | VERIFIED | `queryResolvers` Map at line 655; EOSE handler at line 685-694; 10s timeout |
| `src/lib/nostra/nostr-relay-pool.ts` | Pool getMessages deduplicating from all read relays | VERIFIED | Lines 280-306: `seenIds` Set, `Promise.all`, converts `DecryptedMessage` to `NostrEvent` |
| `src/lib/nostra/chat-api.ts` | Gift-wrap send pipeline with self-send + backfill | VERIFIED | Imports `wrapNip17Message`, calls `backfillConversations` on init/reconnect |
| `src/lib/nostra/message-store.ts` | IndexedDB message cache per conversation | VERIFIED | `saveMessage`, `getMessages`, `getLatestTimestamp`, `deleteMessages` all present |
| `src/lib/nostra/media-crypto.ts` | AES-256-GCM encrypt/decrypt | VERIFIED | Exports `encryptMedia`, `decryptMedia`, `sha256Hex` |
| `src/lib/nostra/blossom-client.ts` | Blossom upload/download with fallback | VERIFIED | 3 DEFAULT_BLOSSOM_SERVERS, `uploadEncryptedMedia`, `downloadDecryptedMedia` |
| `src/lib/nostra/delivery-tracker.ts` | 4-state delivery tracking + receipt creation | VERIFIED | `DeliveryState`, `DeliveryTracker`, `isReceiptEvent`, `parseReceipt` |
| `src/lib/nostra/message-requests.ts` | Unknown-sender message request management | VERIFIED | `MessageRequestStore`, `acceptRequest`, `rejectRequest`, `blockSender` |
| `src/lib/nostra/nostra-display-bridge.ts` | Media rendering + delivery indicators + MessageRequests mount | VERIFIED | `buildMediaForType`, `nostra_delivery_update` listener, `mountMessageRequests()` at line 134, `showMessageRequestsList()` at line 205 |
| `src/lib/nostra/nostra-send-bridge.ts` | Media send routing via Blossom + gift-wrap | VERIFIED | Imports `uploadEncryptedMedia`; `sendMediaViaChatAPI` at line 259 |
| `src/components/nostra/MessageRequests.tsx` | Message request list UI with accept/reject | VERIFIED | 227 lines; `MessageRequestsRow`, `MessageRequestsList`, `useMessageRequestCount`; dispatches `nostra_contact_accepted` on accept |
| `src/components/nostra/ReadReceiptToggle.tsx` | Privacy setting toggle | VERIFIED | 84 lines; `setReadReceiptsEnabled` wired; mounted in `privacyAndSecurity.ts` |
| `src/scss/partials/_messageRequests.scss` | Message request UI styles | VERIFIED | File exists; imported in `src/scss/style.scss` at line 414 |
| `src/lib/rootScope.ts` | `nostra_contact_accepted` event type | VERIFIED | Line 271: `'nostra_contact_accepted': {pubkey: string; peerId: number}` |
| `src/pages/nostra/onboarding.ts` | Timeout-protected completeOnboarding | VERIFIED | `withTimeout` helper at line 321; both IndexedDB saves wrapped; catch-all at line 386-388 |
| `src/tests/nostra/nostr-relay.test.ts` | EOSE-aware getMessages tests | VERIFIED | 32 tests pass; mock WS sends EOSE for query subscriptions |
| `src/tests/nostra/nip17-messaging.test.ts` | Gift-wrap roundtrip tests | VERIFIED | 5 tests pass |
| `src/tests/nostra/blossom-media.test.ts` | Media crypto + Blossom client tests | VERIFIED | 22 tests pass |
| `src/tests/nostra/delivery-tracker.test.ts` | Delivery state machine tests | VERIFIED | 14 tests pass |
| `src/tests/nostra/message-requests.test.ts` | Message requests smoke tests | VERIFIED | 8 tests pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `chat-api.ts` | `nostr-crypto.ts` | `wrapNip17Message` in sendMessage | WIRED | `chat-api.ts:24` imports; line 221 uses in send path |
| `nostr-relay.ts` | `nostr-crypto.ts` | `unwrapNip17Message` in handleEvent | WIRED | `nostr-relay.ts:693` calls unwrap on incoming kind 1059 |
| `nostr-relay.ts` | filter kinds | subscription filter `kinds:[1059]` | WIRED | Lines 327, 368 use `NOSTR_KIND_GIFTWRAP` |
| `chat-api.ts` | `nostr-relay-pool.ts` | relay backfill via getMessages | WIRED | Called at line 451; pool now returns real deduplicated events after EOSE |
| `nostr-relay.ts` | queryResolvers | EOSE handler resolves pending queries | WIRED | Lines 685-694: `queryResolvers.get(subId)` → `resolve(events)` |
| `blossom-client.ts` | `media-crypto.ts` | `encryptMedia`/`decryptMedia` | WIRED | `blossom-client.ts:11` imports; lines 145 and 172 call both |
| `delivery-tracker.ts` | `nostr-crypto.ts` | `wrapNip17Receipt` | WIRED | `delivery-tracker.ts:13` imports; lines 160, 170 call it |
| `delivery-tracker.ts` | `rootScope` | `nostra_delivery_update` | WIRED | Lines 123, 144, 151 dispatch event |
| `nostr-relay.ts` | `delivery-tracker.ts` | receipt routing via `onReceiptHandler` | WIRED | `nostr-relay.ts:117,400,715` implement `onReceiptHandler` |
| `nostra-display-bridge.ts` | `blossom-client.ts` | `downloadDecryptedMedia` | WIRED | `nostra-display-bridge.ts:20` imports; line 522 calls it |
| `nostra-display-bridge.ts` | `rootScope nostra_delivery_update` | listener for delivery state changes | WIRED | Line 90 registers `addEventListener('nostra_delivery_update')` |
| `nostra-send-bridge.ts` | `blossom-client.ts` | `uploadEncryptedMedia` | WIRED | `nostra-send-bridge.ts:23` imports; line 304 calls it |
| `nostra-display-bridge.ts` | `MessageRequests.tsx` | dynamic import + `solid-js/web render()` | WIRED | `mountMessageRequests()` line 146: `import('@components/nostra/MessageRequests')` with MutationObserver DOM readiness |
| `MessageRequests.tsx` | `nostra-display-bridge.ts` | `nostra_contact_accepted` event | WIRED | `MessageRequests.tsx:153` dispatches; `nostra-display-bridge.ts:99` listens and calls `injectSyntheticPeer()` |
| `ReadReceiptToggle.tsx` | `privacyAndSecurity.ts` | imported and mounted | WIRED | `privacyAndSecurity.ts:581-591` dynamically imports and renders |
| `onboarding.ts` | `withTimeout` | IndexedDB operations timeout-protected | WIRED | Lines 360, 366 wrap `saveEncryptedIdentity` and `saveBrowserKey` in `withTimeout(, 5000)` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| MSG-01 | 04-01, 04-04 | User can send/receive 1:1 text messages via Nostr relay pool | SATISFIED | NIP-17 gift-wrap pipeline complete; wrapNip17Message -> publishRawEvent chain verified; 5 NIP-17 round-trip tests pass |
| MSG-02 | 04-01, 04-05 | Offline messages delivered when peer connects (relay stores until peer connects) | SATISFIED | `backfillConversations` called on init/reconnect; `nostr-relay.ts::getMessages()` now awaits EOSE with 10s timeout; pool deduplicates and returns real events; 32 relay tests pass |
| MSG-04 | 04-01 | NIP-17 gift-wrap kind 14 -> kind 13 -> kind 1059 | SATISFIED | nostr-tools/nip17 `wrapManyEvents` used; kind structure verified in nip17-giftwrap.test.ts |
| MSG-05 | 04-02, 04-04 | User can send/receive photos in chat | SATISFIED (automated) | `encryptMedia` + Blossom upload + kind 15 gift-wrap send; `downloadDecryptedMedia` + `messageMediaPhoto` render; 22 blossom tests pass; needs human visual verification |
| MSG-06 | 04-02, 04-04 | User can send/receive videos in chat | SATISFIED (automated) | `messageMediaDocument` with `mime_type:video/mp4` in buildMediaForType; needs human visual verification |
| MSG-07 | 04-03, 04-04 | Message delivery status is visible per message | SATISFIED (automated) | Backend tracker complete (14 delivery tests pass); UI display of check icons depends on `_deliveryState` in synthetic message objects; needs human visual verification |
| MSG-08 | 04-01 | Offline messages queued in IndexedDB with exponential backoff | SATISFIED | `offline-queue.ts` BACKOFF_BASE_MS=2000, 2x multiplier, 5min cap, 20 max attempts |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/lib/nostra/nostra-display-bridge.ts` | 159 | `rootScope.addEventListener('nostra_message_request' as any, ...)` — `as any` cast | Info | Event type not statically typed in rootScope; functional but bypasses type checking |

No blocker anti-patterns found. The single `as any` cast is a minor typing omission with no runtime impact.

### Human Verification Required

### 1. Text Message Bubble Rendering

**Test:** Start dev server, create two identities in separate browser tabs, send a text message from Tab A to Tab B.
**Expected:** Message appears in Tab B as a properly styled chat bubble with sender info and timestamp.
**Why human:** Visual rendering and WebSocket relay communication require a running browser.

### 2. Photo Send/Receive

**Test:** Send a photo from Tab A to Tab B using the file picker.
**Expected:** Photo renders inline in the chat bubble (not as a link). Image is visible without any error state.
**Why human:** Requires live Blossom server connection + browser rendering.

### 3. Video Send/Receive

**Test:** Send a video file from Tab B to Tab A.
**Expected:** Video renders with a play button control in the chat bubble.
**Why human:** Requires live Blossom server + browser media element rendering.

### 4. Delivery Indicator Icons (4 States)

**Test:** Send a message from Tab A to Tab B with Tab B open.
**Expected:** Tab A shows: clock (sending) -> single check (sent to relay) -> double check gray (delivered) -> double check blue (read after Tab B opens chat).
**Why human:** Icon visual transitions require running browser with two connected clients + relay.

### 5. Message Requests Row Visibility

**Test:** From Tab C (unknown identity), send a message to Tab A. Observe Tab A's chat list sidebar.
**Expected:** A "Richieste" row with badge count appears at the top of the chat list. Clicking shows the message with Accept/Reject buttons. Accepting creates a new conversation in the main chat list.
**Why human:** The MutationObserver-based DOM mounting waits for `#chatlist-container` to appear; the full flow requires a running browser with chat list initialized.

### 6. Read Receipt Toggle Reciprocal Behavior

**Test:** In Tab B Settings > Privacy, disable "Conferme di lettura". Send a message from Tab A to Tab B.
**Expected:** Tab A stays at double-check gray — never shows blue checks.
**Why human:** Requires running browser with two clients.

### 7. Conversation Deletion (3 Levels)

**Test:** Delete the conversation with Tab B from Tab A.
**Expected:** Level 1: Messages removed from Tab A's IndexedDB. Level 2: Tab B receives notification and hides those messages. Level 3: NIP-09 kind 5 published to relay.
**Why human:** Multi-browser coordination and relay inspection needed.

### 8. Onboarding Completion Under Load

**Test:** Open onboarding, enter a display name, click CONTINUE while DevTools shows IndexedDB blocked (simulate by filling storage quota).
**Expected:** The button completes within 5 seconds and the app boots to the chat screen.
**Why human:** Simulating IndexedDB pressure requires manual DevTools manipulation in a browser.

### Gap Closure Validation

All three previously-identified gaps are now closed:

**Gap 1 (Closed) — MessageRequests component now mounted.**
`nostra-display-bridge.ts` adds `mountMessageRequests()` called at line 108 during bridge init. It uses a `MutationObserver` to wait for `#chatlist-container`, then dynamically imports `MessageRequestsRow` and renders it via `solid-js/web render()`. The `nostra_contact_accepted` event is typed in `rootScope.ts:271` and wired to `injectSyntheticPeer()`. Commit `de9d32e`.

**Gap 2 (Closed) — MSG-02 backfill path now functional.**
`nostr-relay.ts::getMessages()` uses a `queryResolvers` Map (line 655) where each query subscription ID maps to a resolver function and collected events array. The `handleMessage` case for `'EOSE'` (line 685) resolves the pending promise with collected events and sends `CLOSE`. A 10-second timeout resolves with partial results if EOSE never arrives. Pool-level `getMessages()` in `nostr-relay-pool.ts` now properly pushes and deduplicates results via `seenIds` Set. 32 relay tests pass including EOSE-response tests. Commits `cb004e5`.

**Gap 3 (Closed) — Onboarding no longer blocks indefinitely.**
`onboarding.ts::completeOnboarding()` wraps `saveEncryptedIdentity` and `saveBrowserKey` in `withTimeout(promise, 5000)`, which uses `Promise.race`. Both operations proceed to the next step if they time out. A catch-all at line 386-388 always calls `notifyIdentityCreated()` even if the entire function throws. Commit `aba9d84`.

---

_Verified: 2026-04-02T13:05:00Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification: Yes — after plans 04-05 and 04-06 gap closure_
