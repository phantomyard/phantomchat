---
phase: 07-disable-telegram-mtproto-remove-server-dependency
plan: 02
subsystem: ui
tags: [connection-status, nostr-relay, solid-js, nostra]

requires:
  - phase: 03
    provides: nostra_relay_state event type in rootScope
provides:
  - Relay-pool-aware connection status UI component
  - Tests for relay-based connection status transitions
affects: [07-disable-telegram-mtproto-remove-server-dependency]

tech-stack:
  added: []
  patterns: [relay-state-map-pattern, any-connected-heuristic]

key-files:
  created:
    - src/tests/nostra/connection-status-relay.test.ts
  modified:
    - src/components/connectionStatus.ts

key-decisions:
  - "Relay connectivity uses Map<url, boolean> with any-connected = online heuristic"
  - "Removed all MTProto DC status dependencies (getBaseDcId, ConnectionStatus enum, forceGetDifference)"

patterns-established:
  - "Relay status pattern: track per-relay state in Map, aggregate with .some() for online status"

requirements-completed: [STUB-02]

duration: 3min
completed: 2026-04-02
---

# Phase 07 Plan 02: Connection Status Relay Remap Summary

**ConnectionStatusComponent remapped from MTProto DC status to Nostr relay pool state with any-connected heuristic**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-02T16:19:53Z
- **Completed:** 2026-04-02T16:23:15Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- ConnectionStatusComponent now listens to nostra_relay_state events instead of connection_status_change
- Shows "Reconnecting" only when ALL relays are disconnected (per D-05)
- Removed all MTProto DC dependencies: getBaseDcId, ConnectionStatus enum, forceGetDifference
- 7 comprehensive tests covering all connection state transitions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create test scaffold for relay-based ConnectionStatus** - `37007de` (test) - TDD RED phase
2. **Task 2: Remap ConnectionStatusComponent to relay pool events** - `d170be8` (feat) - TDD GREEN phase

## Files Created/Modified
- `src/tests/nostra/connection-status-relay.test.ts` - 7 tests for relay-based connection status behavior
- `src/components/connectionStatus.ts` - Replaced MTProto DC status with Nostr relay pool state tracking

## Decisions Made
- Used Map<string, boolean> to track per-relay connectivity, aggregated with Array.some() for online determination
- Removed forceGetDifference entirely (no MTProto updates to fetch in Nostra.chat mode)
- Kept state_synchronizing/state_synchronized listeners as-is (generic state events still useful)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Connection status UI now fully decoupled from MTProto DC status
- Ready for remaining phase 07 plans to continue MTProto removal

---
*Phase: 07-disable-telegram-mtproto-remove-server-dependency*
*Completed: 2026-04-02*
