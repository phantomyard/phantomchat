---
phase: 05-group-messaging
plan: 01
subsystem: messaging
tags: [nostr, nip-17, gift-wrap, indexeddb, group-messaging, nip-44]

# Dependency graph
requires:
  - phase: 04-1-1-messaging-e2e
    provides: NIP-17 gift-wrap primitives (createRumor, createSeal, createGiftWrap, unwrapGiftWrap)
provides:
  - GroupRecord and GroupControlPayload type definitions
  - IndexedDB GroupStore with CRUD and peerId index
  - groupIdToPeerId deterministic negative peer ID mapping
  - wrapGroupMessage for N+1 multi-recipient gift-wrap
  - Group control message wrapping/unwrapping with control and group tags
  - isControlEvent helper for receipt loop prevention
affects: [05-02-PLAN, 05-03-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: [multi-recipient gift-wrap loop, control message tagging via rumor tags, negative peer IDs for group chats]

key-files:
  created:
    - src/lib/nostra/group-types.ts
    - src/lib/nostra/group-store.ts
    - src/lib/nostra/group-control-messages.ts
    - src/tests/nostra/group-store.test.ts
    - src/tests/nostra/group-crypto.test.ts
  modified:
    - src/lib/nostra/nostr-crypto.ts

key-decisions:
  - "GROUP_PEER_BASE = 2*10^15 (separate range from user peers at 10^15)"
  - "Group peer IDs are negative (peerChat convention) via groupIdToPeerId"
  - "NTNostrEvent type exported from nostr-crypto.ts for cross-module use"
  - "GroupStore.destroy() closes DB connection for test isolation with fake-indexeddb"

patterns-established:
  - "Multi-recipient gift-wrap: single rumor, N+1 seal/wrap pairs (one per member + self)"
  - "Control message tagging: ['control', 'true'] + ['group', groupId] in rumor tags"
  - "IndexedDB test isolation: deleteDatabase in beforeEach after closing connection"

requirements-completed: [GRP-01, GRP-02]

# Metrics
duration: 7min
completed: 2026-04-03
---

# Phase 05 Plan 01: Group Data Layer Summary

**IndexedDB group store with CRUD, NIP-17 multi-recipient gift-wrap (N+1 events), and control message wrapping with group/control tags**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-03T13:51:02Z
- **Completed:** 2026-04-03T13:57:49Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- GroupRecord, GroupControlPayload, GroupDeliveryInfo types with GROUP_PEER_BASE constant and groupIdToPeerId deterministic mapping
- GroupStore class providing IndexedDB CRUD (save, get, getAll, getByPeerId, delete, updateMembers, updateInfo) with unique peerId index
- wrapGroupMessage producing N+1 gift-wraps for group members plus self-send
- Control message wrapping/unwrapping with isControlEvent for receipt loop prevention
- 22 tests covering all store operations, peer ID mapping, wrapping round-trips, and control messages

## Task Commits

Each task was committed atomically:

1. **Task 1: Define group types and implement IndexedDB group store** - `71d423c` (feat)
2. **Task 2: Implement multi-recipient gift-wrap and control message wrapping** - `4b0b210` (feat)

## Files Created/Modified
- `src/lib/nostra/group-types.ts` - GroupRecord, GroupControlPayload, GroupDeliveryInfo types, GROUP_PEER_BASE constant, groupIdToPeerId mapping
- `src/lib/nostra/group-store.ts` - GroupStore class with IndexedDB CRUD and peerId index
- `src/lib/nostra/group-control-messages.ts` - wrapGroupControl, unwrapGroupControl, broadcastGroupControl, isControlEvent, getGroupIdFromRumor
- `src/lib/nostra/nostr-crypto.ts` - Added wrapGroupMessage, exported NTNostrEvent type
- `src/tests/nostra/group-store.test.ts` - 10 tests for GroupStore CRUD and groupIdToPeerId
- `src/tests/nostra/group-crypto.test.ts` - 12 tests for wrapping and control messages

## Decisions Made
- GROUP_PEER_BASE set to 2*10^15 to avoid collision with user virtual peer range (10^15)
- Group peer IDs are negative per peerChat convention (tweb uses negative IDs for chats)
- NTNostrEvent type exported from nostr-crypto.ts so group-control-messages.ts can use it
- GroupStore.destroy() closes the DB connection explicitly to enable test isolation with fake-indexeddb

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] GroupStore.destroy() must close DB connection**
- **Found during:** Task 1
- **Issue:** Simply setting _dbPromise to null left the DB connection open, causing fake-indexeddb to hang on deleteDatabase in test teardown
- **Fix:** Added async destroy() that calls db.close() before nullifying the promise
- **Files modified:** src/lib/nostra/group-store.ts
- **Verification:** All 10 group-store tests pass with proper isolation
- **Committed in:** 71d423c (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor fix for test infrastructure correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all data paths are fully wired.

## Next Phase Readiness
- Group types and store ready for Plan 02 (group API manager and message routing)
- wrapGroupMessage and control message functions ready for integration with NostrRelayPool
- isControlEvent available for receipt loop prevention in message routing

---
*Phase: 05-group-messaging*
*Completed: 2026-04-03*
