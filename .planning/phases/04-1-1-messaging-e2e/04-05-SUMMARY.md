---
phase: 04-1-1-messaging-e2e
plan: 05
subsystem: messaging
tags: [nostr, relay, eose, nip-17, onboarding, timeout, indexeddb]

requires:
  - phase: 04-1-1-messaging-e2e
    provides: NIP-17 gift-wrap relay storage and pool infrastructure
provides:
  - EOSE-based getMessages returning real events from relays
  - Timeout-protected onboarding completion
  - Deduplicated pool-level message retrieval
affects: [messaging, onboarding, backfill]

tech-stack:
  added: []
  patterns: [Promise.race timeout pattern, query resolver map for async WebSocket responses]

key-files:
  created: []
  modified:
    - src/lib/nostra/nostr-relay.ts
    - src/lib/nostra/nostr-relay-pool.ts
    - src/pages/nostra/onboarding.ts
    - src/tests/nostra/nostr-relay.test.ts

key-decisions:
  - "Query resolver map pattern for EOSE-awaiting getMessages — avoids modifying subscription handler"
  - "10s timeout on relay queries returns partial results instead of hanging"
  - "Onboarding always calls notifyIdentityCreated even on failure — app boot must never block"

patterns-established:
  - "queryResolvers map for temporary subscription-based queries on Nostr relay"
  - "withTimeout Promise.race helper for IndexedDB resilience"

requirements-completed: [MSG-02]

duration: 6min
completed: 2026-04-02
---

# Phase 04 Plan 05: Gap Closure — EOSE getMessages and Onboarding Timeout Summary

**EOSE-based relay getMessages with query resolver map and timeout-protected onboarding completion**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-02T10:24:01Z
- **Completed:** 2026-04-02T10:29:49Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- nostr-relay.ts getMessages() now awaits EOSE and returns collected events instead of empty array
- nostr-relay-pool.ts getMessages() properly deduplicates and returns results from all read relays
- Onboarding completeOnboarding() protected with 5s timeout on IndexedDB ops and catch-all fallback

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement EOSE-based getMessages in nostr-relay.ts and nostr-relay-pool.ts** - `cb004e5` (fix)
2. **Task 2: Add timeout protection to onboarding completeOnboarding** - `aba9d84` (fix)

## Files Created/Modified
- `src/lib/nostra/nostr-relay.ts` - Added queryResolvers map, EOSE-awaiting getMessages, collectQueryEvent helper
- `src/lib/nostra/nostr-relay-pool.ts` - Fixed getMessages to push deduplicated DecryptedMessage-to-NostrEvent conversions
- `src/pages/nostra/onboarding.ts` - Added withTimeout helper, button disable on click, catch-all notifyIdentityCreated
- `src/tests/nostra/nostr-relay.test.ts` - Updated getMessages tests to simulate EOSE responses

## Decisions Made
- Used a queryResolvers Map keyed by subscription ID to route EVENT/EOSE to pending queries without modifying the live subscription handler
- 10-second timeout on relay queries returns partial results (better than empty or hanging)
- Onboarding catch block always calls notifyIdentityCreated — app boot chain must never block permanently

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated tests for EOSE-based getMessages**
- **Found during:** Task 1
- **Issue:** Existing getMessages tests timed out because mock WebSocket did not send EOSE responses
- **Fix:** Added send interceptor in tests to auto-respond with EOSE for query subscriptions
- **Files modified:** src/tests/nostra/nostr-relay.test.ts
- **Verification:** All 55 relay tests pass
- **Committed in:** cb004e5 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Test update necessary for correctness after behavior change. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- backfillConversations in chat-api.ts will now receive real messages from relays on init/reconnect
- Onboarding flow resilient to IndexedDB hangs — new user boot chain always completes

---
*Phase: 04-1-1-messaging-e2e*
*Completed: 2026-04-02*
