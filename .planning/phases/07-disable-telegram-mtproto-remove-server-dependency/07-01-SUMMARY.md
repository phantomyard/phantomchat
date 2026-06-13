---
phase: 07-disable-telegram-mtproto-remove-server-dependency
plan: 01
subsystem: api
tags: [mtproto, stub, transport, security, defense-in-depth]

# Dependency graph
requires:
  - phase: 04-1-1-messaging-e2e
    provides: api-manager-stub with P2P method routing
provides:
  - No-op NetworkerFactory that never creates MTPNetworker instances
  - Full invokeApi rejection for all non-intercepted methods (MTPROTO_DISABLED, code 503)
  - Defense-in-depth guards on authorizer.ts and transport controller
  - Test suite validating all stub behaviors
affects: [07-02, 07-03, production-build]

# Tech tracking
tech-stack:
  added: []
  patterns: [defense-in-depth guards, MTPROTO_DISABLED error pattern]

key-files:
  created:
    - src/tests/nostra/mtproto-stub.test.ts
  modified:
    - src/lib/appManagers/networkerFactory.ts
    - src/lib/nostra/api-manager-stub.ts
    - src/lib/mtproto/authorizer.ts
    - src/lib/mtproto/transports/controller.ts

key-decisions:
  - "All invokeApi fall-throughs to stub._original removed; zero code paths reach real MTProto"
  - "Defense-in-depth guards use synchronous throw (not async reject) for immediate prevention"
  - "Unused imports commented out rather than deleted per D-03 (no file deletion)"

patterns-established:
  - "MTPROTO_DISABLED error: {type: 'MTPROTO_DISABLED', code: 503, description: string}"
  - "Defense-in-depth: guard at top of function body, rest of code preserved but unreachable"

requirements-completed: [STUB-01, STUB-03]

# Metrics
duration: 7min
completed: 2026-04-02
---

# Phase 07 Plan 01: MTProto Transport Stub Summary

**NetworkerFactory stubbed as no-op, all invokeApi fall-throughs replaced with MTPROTO_DISABLED rejection, defense-in-depth guards on authorizer and transport controller**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-02T16:19:30Z
- **Completed:** 2026-04-02T16:26:16Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- NetworkerFactory.getNetworker() throws immediately, startAll/stopAll/forceReconnect/forceReconnectTimeout are no-ops
- api-manager-stub.ts has zero fall-throughs to real MTProto -- every code path either routes through Nostra.chat bridge or rejects with MTPROTO_DISABLED
- authorizer.ts throws synchronously at the top of auth() before any DH handshake can start
- Transport controller throws synchronously at the top of pingTransports() before any WebSocket/HTTP probes
- 12 tests validate all behaviors

## Task Commits

Each task was committed atomically:

1. **Task 1: Create test scaffold for MTProto stub behaviors** - `6dcda29` (test) - TDD RED phase, 12 tests written, 7 failing
2. **Task 2: Stub NetworkerFactory, extend api-manager-stub, add defense-in-depth guards** - `90d5b51` (feat) - TDD GREEN phase, all 12 tests passing

## Files Created/Modified
- `src/tests/nostra/mtproto-stub.test.ts` - 12 tests covering api-manager-stub rejection, NetworkerFactory stub, and defense-in-depth guards
- `src/lib/appManagers/networkerFactory.ts` - All methods stubbed as no-ops, getNetworker throws
- `src/lib/nostra/api-manager-stub.ts` - All fall-throughs replaced with MTPROTO_DISABLED rejection
- `src/lib/mtproto/authorizer.ts` - Defense-in-depth guard at top of auth()
- `src/lib/mtproto/transports/controller.ts` - Defense-in-depth guard at top of pingTransports()

## Decisions Made
- All invokeApi fall-throughs to stub._original removed; zero code paths reach real MTProto
- Defense-in-depth guards use synchronous throw for immediate prevention (not async)
- Unused imports in networkerFactory.ts commented out rather than deleted (D-03)
- ChatAPI mock required in tests for P2P routing validation (window.__nostraChatAPI)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test needed ChatAPI mock for P2P routing**
- **Found during:** Task 2 (GREEN phase)
- **Issue:** messages.getHistory test failed because getChatAPI() returned undefined (no window.__nostraChatAPI)
- **Fix:** Added ChatAPI mock to test beforeEach setup
- **Files modified:** src/tests/nostra/mtproto-stub.test.ts
- **Verification:** All tests pass
- **Committed in:** 90d5b51

**2. [Rule 1 - Bug] Authorizer.auth() throws synchronously, not async**
- **Found during:** Task 2 (GREEN phase)
- **Issue:** Test used rejects.toThrow but auth() throws synchronously (guard is before any async code)
- **Fix:** Changed test to use synchronous toThrow matcher
- **Files modified:** src/tests/nostra/mtproto-stub.test.ts
- **Verification:** Test passes correctly
- **Committed in:** 90d5b51

---

**Total deviations:** 2 auto-fixed (2 bugs in test setup)
**Impact on plan:** Minor test adjustments. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- MTProto transport layer fully stubbed -- ready for Plan 02 (server URL/constant cleanup)
- api-manager-stub provides clean MTPROTO_DISABLED errors for any remaining callers to handle gracefully

---
*Phase: 07-disable-telegram-mtproto-remove-server-dependency*
*Completed: 2026-04-02*
