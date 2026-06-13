---
status: diagnosed
phase: 04-1-1-messaging-e2e
source: [04-VERIFICATION.md]
started: 2026-04-02T13:10:00Z
updated: 2026-04-02T13:22:00Z
---

## Current Test

E2E browser testing complete via Chrome DevTools MCP (User A) + Playwright MCP (User B)

## Tests

### 1. Send a text message and verify it renders as a bubble
expected: Message appears as a chat bubble with correct sender name and timestamp
result: PARTIAL — NIP-17 gift-wrap message sent from Alice, received and decrypted by Bob via relay. Content "Ciao Bob! Test messaggio E2E da Alice" confirmed in unwrapped kind 14 event. Display bridge processes onIncomingMessage correctly. Chat bubble rendering requires Telegram UI `setPeer()` which doesn't fully support synthetic peerIds for navigation — message is delivered and processed but bubble rendering depends on Telegram chat view integration.

### 2. Send a photo from one user to another
expected: Photo renders inline in the chat bubble (not as a download link)
result: SKIPPED — Requires Blossom server endpoint for upload; media-crypto and blossom-client modules are unit-tested and verified in code review

### 3. Send a video from one user to another
expected: Video renders inline in the chat bubble
result: SKIPPED — Same as #2, Blossom upload dependency

### 4. Delivery status icons: clock -> 1 check -> 2 checks -> 2 blue checks
expected: Each state transition is visually reflected with the correct icon in the chat bubble
result: PARTIAL — DeliveryTracker module verified via unit tests. Forward-only state machine confirmed in code. Visual icon rendering requires chat bubble view which depends on Telegram setPeer integration.

### 5. Message requests section appears at top of chat list
expected: A 'Richieste' row with badge count is visible when messages from unknown senders arrive
result: PASS — Confirmed via screenshot: "Richieste" row with badge "1" visible at top of chat list on Bob's side after Alice sent a message. Clicking opens "Richieste di messaggi" overlay showing sender npub, message preview "Ciao Bob! Test messaggio E2...", and Accetta/Rifiuta buttons. Accepting removes the request ("Nessuna richiesta di messaggi"), creates synthetic dialog (peerId in injectedPeers + peerDialogs), and dispatches nostra_contact_accepted event.

### 6. Read receipt toggle in Privacy settings
expected: Toggle appears in Settings > Privacy & Security and disabling it stops blue checks
result: SKIPPED — Settings UI is wired (verified in code review of privacyAndSecurity.ts), requires Telegram settings panel navigation which has MTProto dependency

### 7. Conversation deletion removes messages and notifies peer
expected: Delete removes from IndexedDB, peer's client hides referenced messages, relay receives NIP-09 kind 5
result: SKIPPED — deleteConversation method verified in code review with 3-level cleanup logic; UI trigger requires chat context menu integration

### 8. Onboarding completion under IndexedDB pressure
expected: CONTINUE button completes within 5 seconds even if IndexedDB operations are slow
result: PASS — Both users completed onboarding successfully. CONTINUE button disabled immediately on click (prevents double-submit). withTimeout(5000) wraps IndexedDB saves. Identity (12-word seed + nsec) correctly encrypted with AES-GCM and stored in nostr-identity store. Browser key saved in nostr-keys store.

## Critical Bug Found and Fixed During Testing

**Pool identity loading bug:** `nostr-relay-pool.ts::initialize()` called `loadIdentity()` from the legacy `identity` store, but onboarding saves to the `nostr-identity` store via `saveEncryptedIdentity()`. This caused `pool.publicKey` and `pool.privateKeyBytes` to remain empty, breaking NIP-17 gift-wrap encryption/decryption and relay subscriptions.

**Fix committed:** `cded533` — Changed pool to use `loadEncryptedIdentity()` + `loadBrowserKey()` + `decryptKeys()` + `importFromMnemonic()` chain. All 23 pool unit tests now pass (were all failing before).

## Summary

total: 8
passed: 2
issues: 1 (fixed: pool identity loading)
pending: 0
skipped: 4 (Blossom server, settings panel, chat context menu)
blocked: 0
partial: 2 (message delivery works E2E, bubble rendering blocked by Telegram setPeer)

## Gaps

### Gap 1: Telegram setPeer synthetic dialog navigation
status: known-limitation
description: appImManager.setPeer() with synthetic peerIds doesn't fully render the chat view because Telegram's AppUsersManager expects pFlags and other MTProto-specific fields. The display bridge correctly injects messages via dispatchHistoryAppend, but navigating INTO the chat from the sidebar requires deeper Telegram UI integration.
severity: medium
phase: future (Phase 7 MTProto removal will eliminate this dependency)
