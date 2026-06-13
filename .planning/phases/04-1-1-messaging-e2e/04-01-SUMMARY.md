---
phase: 04-1-1-messaging-e2e
plan: 01
subsystem: messaging
tags: [nip17, giftwrap, nostr, indexeddb, nip44, offline-queue, backfill]

requires:
  - phase: 02-nostr-identity-contacts
    provides: nostr identity, NIP-44 encryption, key-storage
  - phase: 03-multi-relay-pool
    provides: relay pool, privacy transport, relay settings

provides:
  - NIP-17 gift-wrap pipeline (wrapNip17Message, unwrapNip17Message, wrapNip17Receipt)
  - Kind 1059 subscription and unwrapping in nostr-relay.ts
  - publishRawEvent and getMessages on relay pool
  - IndexedDB message store per conversation (message-store.ts)
  - Relay backfill on init/reconnect (backfillConversations)
  - sendFileMessage API for Blossom media (Plan 02 consumer)
  - Exponential backoff retry in offline queue

affects: [04-02-blossom-media, 04-03-delivery-indicators, 04-04-display-bridge]

tech-stack:
  added: [nostr-tools/nip17, nostr-tools/nip59]
  patterns: [gift-wrap-envelope, idb-message-cache, relay-backfill-on-reconnect, exponential-backoff-retry]

key-files:
  created:
    - src/lib/nostra/message-store.ts
    - src/tests/nostra/nip17-messaging.test.ts
    - src/tests/nostra/nip17-giftwrap.test.ts
  modified:
    - src/lib/nostra/nostr-crypto.ts
    - src/lib/nostra/nostr-relay.ts
    - src/lib/nostra/nostr-relay-pool.ts
    - src/lib/nostra/chat-api.ts
    - src/lib/nostra/offline-queue.ts
    - src/tests/nostra/nostr-relay.test.ts
    - src/tests/nostra/chat-api.test.ts

key-decisions:
  - "Used nostr-tools/nip17 wrapManyEvents for self-send + recipient wrapping instead of manual rumor/seal/wrap"
  - "Used nostr-tools/nip59 lower-level API for receipt wrapping (custom rumor tags not supported by nip17)"
  - "Pool wraps once and publishes to all relays via publishRawEvent (avoids N wrappings for N relays)"
  - "Deprecated legacy createRumor/createSeal/createGiftWrap/unwrapGiftWrap instead of removing (backward compat)"
  - "Removed sendMedia in favor of sendFileMessage for Blossom upload pipeline"

patterns-established:
  - "Gift-wrap pipeline: content -> wrapNip17Message -> publishRawEvent on all write relays"
  - "Message store: deterministic conversationId from sorted pubkeys joined with ':'"
  - "Backfill pattern: getAllConversationIds -> getLatestTimestamp -> relay query with since filter"
  - "Offline queue backoff: 2s base, 2x multiplier, 5min cap, 20 max attempts, retryMessage for manual"

requirements-completed: [MSG-01, MSG-04, MSG-02, MSG-08]

duration: 13min
completed: 2026-04-02
---

# Phase 4 Plan 01: NIP-17 Gift-Wrap Pipeline + Message Store Summary

**NIP-17 gift-wrap messaging pipeline using nostr-tools/nip17, IndexedDB message cache, and relay backfill on init/reconnect**

## Performance

- **Duration:** 13 min
- **Started:** 2026-04-02T07:35:42Z
- **Completed:** 2026-04-02T07:48:55Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Complete NIP-17 gift-wrap pipeline: kind 14 rumor -> kind 13 seal -> kind 1059 wrap using nostr-tools
- Kind 4 fully removed from nostr-relay.ts, all messaging uses kind 1059
- IndexedDB message store with per-conversation caching, pagination, and backfill support
- Relay backfill on ChatAPI init and reconnect fetches missed messages (MSG-02)
- Exponential backoff retry in offline queue (2s base, 5min cap, 20 max attempts)

## Task Commits

Each task was committed atomically:

1. **Task 1: NIP-17 gift-wrap core + relay migration + tests** - `9a60797` (feat)
2. **Task 2: IndexedDB message store + chat-api gift-wrap integration + relay backfill + offline queue migration** - `438ca65` (feat)

## Files Created/Modified
- `src/lib/nostra/nostr-crypto.ts` - Added wrapNip17Message, unwrapNip17Message, wrapNip17Receipt; deprecated legacy functions
- `src/lib/nostra/nostr-relay.ts` - Migrated from kind 4 to kind 1059, gift-wrap unwrapping with rumor routing
- `src/lib/nostra/nostr-relay-pool.ts` - Added publishRawEvent, getMessages, wrap-once-publish-many pattern
- `src/lib/nostra/chat-api.ts` - Gift-wrap integration, message store, backfillConversations, sendFileMessage
- `src/lib/nostra/offline-queue.ts` - Exponential backoff retry, retryMessage method
- `src/lib/nostra/message-store.ts` - NEW: IndexedDB message cache with conversationId, pagination, backfill support
- `src/tests/nostra/nip17-messaging.test.ts` - NEW: Gift-wrap roundtrip tests
- `src/tests/nostra/nip17-giftwrap.test.ts` - NEW: Gift-wrap structure and receipt tests
- `src/tests/nostra/nostr-relay.test.ts` - Updated for kind 1059 migration
- `src/tests/nostra/chat-api.test.ts` - Updated for sendFileMessage API

## Decisions Made
- Used nostr-tools/nip17 wrapManyEvents for self-send + recipient wrapping instead of manual rumor/seal/wrap
- Used nostr-tools/nip59 lower-level API for receipt wrapping (custom rumor tags not supported by nip17)
- Pool wraps once and publishes to all relays via publishRawEvent (avoids N wrappings for N relays)
- Deprecated legacy createRumor/createSeal/createGiftWrap/unwrapGiftWrap instead of removing (backward compat)
- Removed sendMedia in favor of sendFileMessage for Blossom upload pipeline

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Defensive private key parsing in relay pool initialize**
- **Found during:** Task 1
- **Issue:** Pool test mock returns fake identity with invalid private key hex, causing hexToBytes crash
- **Fix:** Added length check (64 chars) and try/catch around hexToBytes in pool initialize
- **Files modified:** src/lib/nostra/nostr-relay-pool.ts
- **Committed in:** 9a60797

**2. [Rule 1 - Bug] Updated existing tests referencing kind 4 and NOSTR_KIND_ENCRYPTED_DIRECT_MESSAGE**
- **Found during:** Task 1
- **Issue:** Existing nostr-relay tests and chat-api tests referenced removed kind 4 constant and sendMedia method
- **Fix:** Updated test imports, assertions, and test cases for kind 1059 and sendFileMessage API
- **Files modified:** src/tests/nostra/nostr-relay.test.ts, src/tests/nostra/chat-api.test.ts
- **Committed in:** 9a60797, 438ca65

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both necessary for test correctness after migration. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Gift-wrap pipeline ready for Plan 02 (Blossom media upload) via sendFileMessage
- Receipt wrapping ready for Plan 03 (delivery/read indicators)
- Message store ready for display bridge integration in Plan 04
- Backfill infrastructure ready for conversation list rendering

---
*Phase: 04-1-1-messaging-e2e*
*Completed: 2026-04-02*
