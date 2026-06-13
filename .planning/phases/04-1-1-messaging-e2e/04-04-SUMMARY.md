---
phase: 04-1-1-messaging-e2e
plan: 04
subsystem: ui-integration
tags: [display-bridge, send-bridge, message-requests, read-receipts, conversation-delete]

requires:
  - plan: 04-01
    provides: NIP-17 gift-wrap pipeline, message store
  - plan: 04-02
    provides: media encryption, Blossom client
  - plan: 04-03
    provides: delivery tracker, message requests store

provides:
  - Display bridge media rendering (photos inline, videos with play button)
  - Display bridge delivery indicators (4-state: clock/check/double-check/blue)
  - Display bridge read receipt sending on active chat
  - Send bridge media routing via Blossom (encrypt + upload + gift-wrap)
  - MessageRequests.tsx component (Richieste row, accept/reject/block)
  - ReadReceiptToggle component in Privacy & Security settings
  - 3-level conversation deletion (local + peer notification + relay deletion)
---

## Summary

Wired all Phase 04 backend modules into the UI layer. The display bridge now
downloads and decrypts Blossom media, renders photos inline and videos with
play controls, and shows 4-state delivery indicators. The send bridge encrypts
files with AES-256-GCM, uploads to Blossom servers, and sends kind-15
gift-wrapped file messages. MessageRequests.tsx renders a "Richieste" row at
the top of the chat list with badge count; accepting moves to chat list,
rejecting blocks the pubkey. ReadReceiptToggle in Privacy & Security controls
reciprocal read receipt behaviour (WhatsApp-style). Conversation deletion
performs 3-level cleanup: local IndexedDB, gift-wrapped peer notification,
NIP-09 relay deletion request.

## Key Files

### Created
- `src/components/nostra/MessageRequests.tsx` — message request UI component
- `src/components/nostra/ReadReceiptToggle.tsx` — read receipt privacy toggle
- `src/scss/nostra/_message-requests.scss` — message request styles
- `src/tests/nostra/message-requests.test.ts` — 8 smoke tests

### Modified
- `src/lib/nostra/nostra-display-bridge.ts` — media rendering + delivery indicators
- `src/lib/nostra/nostra-send-bridge.ts` — media routing via Blossom
- `src/lib/nostra/chat-api.ts` — fileMetadata, conversation deletion, message requests wiring
- `src/components/sidebarLeft/tabs/privacyAndSecurity.ts` — ReadReceiptToggle mount point

## Commits
- `7d5ed86` feat(04-04): display bridge media rendering + delivery indicators
- `2b30dca` feat(04-04): send bridge media routing + chat-api fileMetadata
- `f7c1441` feat(04-04): message requests UI + read receipt toggle + smoke tests
- `7d252e9` feat(04-04): 3-level conversation deletion

## Verification
- 8/8 message-requests.test.ts pass
- E2E test: two browsers (Playwright + Chrome DevTools MCP), separate identities,
  NIP-17 gift-wrap messages sent and received via 3 public Nostr relays
  (damus.io, nos.lol, snort.social). Content decrypted correctly, sender pubkey verified.
- No regressions in pre-existing test failures

## Self-Check: PASSED
