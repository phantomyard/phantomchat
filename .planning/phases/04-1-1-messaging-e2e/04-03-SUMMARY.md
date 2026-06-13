---
phase: 04-1-1-messaging-e2e
plan: 03
subsystem: messaging
tags: [delivery-tracking, receipts, nip17, giftwrap, message-requests, privacy]

requires:
  - phase: 04-1-1-messaging-e2e
    provides: NIP-17 gift-wrap pipeline, wrapNip17Receipt, relay pool, message store

provides:
  - 4-state delivery tracking (sending -> sent -> delivered -> read)
  - Gift-wrapped delivery/read receipt events via NIP-17
  - Read receipt privacy toggle (reciprocal WhatsApp behavior)
  - Message request store for unknown senders (accept/reject/block)
  - Receipt routing from relay pool to delivery tracker

affects: [04-04-display-bridge, chat-ui, conversation-list]

tech-stack:
  added: []
  patterns: [forward-only-state-machine, receipt-loop-prevention, reciprocal-privacy-toggle]

key-files:
  created:
    - src/lib/nostra/delivery-tracker.ts
    - src/lib/nostra/message-requests.ts
    - src/tests/nostra/delivery-tracker.test.ts
  modified:
    - src/lib/nostra/chat-api.ts
    - src/lib/nostra/nostr-relay-pool.ts
    - src/lib/rootScope.ts

key-decisions:
  - "Forward-only state machine enforces sending->sent->delivered->read ordering via numeric comparison"
  - "Receipt loop prevention: isReceiptEvent() checked before processing any receipt"
  - "Read receipts reciprocal: disabling hides both sent AND received read receipts"
  - "Message requests use IndexedDB with pubkey keyPath for O(1) blocked-sender lookup"
  - "Delivery tracker publishFn wraps via relay pool publishRawEvent for all-relay distribution"

patterns-established:
  - "Forward-only state transition via STATE_ORDER numeric map"
  - "Reciprocal privacy toggle stored in localStorage with defaults"
  - "Unknown sender routing: isBlocked -> isKnownContact -> message request or main chat"

requirements-completed: [MSG-07]

duration: 7min
completed: 2026-04-02
---

# Phase 4 Plan 03: Delivery Indicators + Message Requests Summary

**4-state delivery tracking with gift-wrapped NIP-17 receipts, reciprocal read receipt privacy toggle, and unknown sender message request management**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-02T07:51:49Z
- **Completed:** 2026-04-02T07:58:40Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Forward-only delivery state machine: sending -> sent -> delivered -> read with loop prevention
- Gift-wrapped delivery/read receipts via wrapNip17Receipt (indistinguishable from messages on relay)
- Reciprocal read receipt privacy toggle matching WhatsApp behavior
- IndexedDB message request store for unknown senders with accept/reject/block
- Full wiring: chat-api sends delivery receipts on receive, marks sent on publish, routes unknown senders to requests
- 14 passing tests covering state machine, receipts, privacy toggle, loop prevention

## Task Commits

Each task was committed atomically:

1. **Task 1: Delivery tracker state machine + receipt events + tests** - `f893bf9` (feat, TDD)
2. **Task 2: Message requests store + delivery tracker wiring** - `a7e89ae` (feat)

## Files Created/Modified
- `src/lib/nostra/delivery-tracker.ts` - 4-state delivery tracking, receipt creation/parsing, privacy toggle
- `src/lib/nostra/message-requests.ts` - IndexedDB unknown sender management (accept/reject/block)
- `src/tests/nostra/delivery-tracker.test.ts` - 14 tests: state machine, receipts, privacy, loop prevention
- `src/lib/nostra/chat-api.ts` - Delivery tracker + message request wiring, markRead method
- `src/lib/nostra/nostr-relay-pool.ts` - setOnReceipt/getPrivateKey for delivery tracker integration
- `src/lib/rootScope.ts` - nostra_delivery_update + nostra_message_request events

## Decisions Made
- Forward-only state machine enforces ordering via numeric comparison (no backwards transitions)
- Receipt loop prevention via isReceiptEvent() guard before processing
- Read receipts reciprocal: disabling prevents both sending and displaying others' read receipts
- Message requests use IndexedDB with pubkey keyPath for O(1) blocked-sender lookup
- Delivery tracker publishFn delegates to relay pool publishRawEvent for all-relay distribution

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Mocked nostr-crypto in tests to avoid secp256k1 curve validation**
- **Found during:** Task 1 (TDD GREEN phase)
- **Issue:** sendDeliveryReceipt/sendReadReceipt tests used fake keys (all 0x01 bytes) that fail secp256k1 curve point validation in wrapNip17Receipt
- **Fix:** Added vi.mock for nostr-crypto module returning mock gift-wrap events
- **Files modified:** src/tests/nostra/delivery-tracker.test.ts
- **Committed in:** f893bf9

**2. [Rule 1 - Bug] Fixed virtual-peers-db lookup in isKnownContact**
- **Found during:** Task 2
- **Issue:** virtual-peers-db uses pubkey as keyPath (not an index), so store.index('pubkey').get() would fail
- **Fix:** Changed to store.get(pubkey) which uses the keyPath directly
- **Files modified:** src/lib/nostra/message-requests.ts
- **Committed in:** a7e89ae

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both necessary for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Delivery tracker ready for display bridge to render check icons (nostra_delivery_update event)
- Message request store ready for UI "Richieste" section rendering
- markRead method available for display bridge to call when user views messages
- getDeliveryTracker() exposed on ChatAPI for external state queries

---
*Phase: 04-1-1-messaging-e2e*
*Completed: 2026-04-02*
