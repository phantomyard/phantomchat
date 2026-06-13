---
phase: 03-multi-relay-pool
plan: 01
subsystem: infra
tags: [nostr, nip-65, relay-pool, tor, webtor, privacy-transport, http-polling]

# Dependency graph
requires:
  - phase: 02-crypto-identity
    provides: NIP-44 encryption, identity storage, nostr-tools finalizeEvent
provides:
  - NIP-65 kind 10002 event building and parsing
  - 4-relay pool with enable/disable, Tor mode switching
  - Dual-mode NostrRelay (WebSocket direct / HTTP polling via Tor)
  - Pool-wrapping PrivacyTransport with shared WebtorClient
  - Relay discovery module scaffolding
  - rootScope events for Tor state, relay state, relay list changes, message queuing
affects: [03-02-tor-ux, 03-03-relay-settings, 04-messaging-ui]

# Tech tracking
tech-stack:
  added: []
  patterns: [dual-mode-relay-transport, pool-level-tor-wrapping, nip65-replaceable-events]

key-files:
  created:
    - src/lib/nostra/nip65.ts
    - src/lib/nostra/relay-discovery.ts
    - src/tests/nostra/nip65.test.ts
    - src/tests/nostra/relay-failover.test.ts
    - src/tests/nostra/privacy-transport.test.ts
    - src/tests/nostra/tor-bootstrap.test.ts
  modified:
    - src/lib/nostra/nostr-relay.ts
    - src/lib/nostra/nostr-relay-pool.ts
    - src/lib/nostra/privacy-transport.ts
    - src/lib/rootScope.ts
    - src/tests/nostra/nostr-relay-pool.test.ts

key-decisions:
  - "PrivacyTransport accepts optional WebtorClient via constructor for DI/testing"
  - "Tor failure sets state to 'failed' (never auto-fallback to direct) per PRIV-03"
  - "Pool recovery skips reconnection when in Tor mode without active fetchFn (Pitfall 6)"
  - "NIP-65 ensures created_at > previousTimestamp to prevent event replacement (Pitfall 3)"

patterns-established:
  - "Dual-mode relay: each NostrRelay supports websocket and http-polling modes, switchable at runtime"
  - "Pool-level Tor: single WebtorClient shared across all relays via PrivacyTransport wrapper"
  - "rootScope events for transport state: nostra_tor_state, nostra_relay_state, nostra_relay_list_changed, nostra_message_queued"

requirements-completed: [INF-03, INF-04, INF-06, PRIV-01]

# Metrics
duration: 16min
completed: 2026-04-01
---

# Phase 3 Plan 1: Relay Pool + Dual-Mode Transport + NIP-65 Summary

**4-relay pool with dual-mode transport (WebSocket/HTTP-polling), NIP-65 relay list publishing, and pool-wrapping PrivacyTransport with shared WebtorClient**

## Performance

- **Duration:** 16 min
- **Started:** 2026-04-01T19:45:28Z
- **Completed:** 2026-04-01T20:01:56Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- NIP-65 module builds/parses kind 10002 events for relay list advertising
- NostrRelay supports dual-mode (websocket/http-polling) with setTorMode/setDirectMode
- NostrRelayPool has 4 default relays, per-relay enable/disable, Tor mode switching, NIP-65 publishing, relay state events
- PrivacyTransport rewritten to wrap entire pool with shared WebtorClient (removed PeerTransport/WebRTC dependency)
- Messages queued during Tor bootstrap, explicit user confirmation required before direct fallback
- 40 new tests across 4 test files, all passing

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1: NIP-65 module + pool extensions + dual-mode NostrRelay + tests**
   - `da2d896` (test): RED — failing tests for NIP-65 and relay failover
   - `e683250` (feat): GREEN — NIP-65 module, dual-mode relay, pool extensions with 4 relays

2. **Task 2: Refactor PrivacyTransport to wrap pool + test**
   - `e5a43e2` (test): RED — failing tests for PrivacyTransport pool wrapper
   - `db3d5c8` (feat): GREEN — rewrite PrivacyTransport to wrap pool with shared WebtorClient

3. **Fix: Update existing pool test mock** (Deviation Rule 1)
   - `a968c20` (fix): update pool test mock with Phase 3 methods

## Files Created/Modified
- `src/lib/nostra/nip65.ts` — NIP-65 kind 10002 event building and parsing
- `src/lib/nostra/relay-discovery.ts` — Relay discovery from contacts' NIP-65 events (scaffolding)
- `src/lib/nostra/nostr-relay.ts` — Added dual-mode transport (websocket/http-polling), latency measurement
- `src/lib/nostra/nostr-relay-pool.ts` — 4th default relay, enable/disable, Tor mode, NIP-65 publishing, rootScope events
- `src/lib/nostra/privacy-transport.ts` — Rewritten: wraps NostrRelayPool with shared WebtorClient
- `src/lib/rootScope.ts` — Added nostra_tor_state, nostra_relay_state, nostra_relay_list_changed, nostra_message_queued events
- `src/tests/nostra/nip65.test.ts` — 13 tests for NIP-65 build/parse
- `src/tests/nostra/relay-failover.test.ts` — 12 tests for pool failover, Tor mode, enable/disable
- `src/tests/nostra/privacy-transport.test.ts` — 11 tests for PrivacyTransport bootstrap, send, fallback
- `src/tests/nostra/tor-bootstrap.test.ts` — 4 tests for fire-and-forget bootstrap behavior
- `src/tests/nostra/nostr-relay-pool.test.ts` — Updated mock with Phase 3 methods

## Decisions Made
- PrivacyTransport accepts optional WebtorClient via constructor for dependency injection (cleaner testing, avoids cross-file vi.mock isolation issues)
- Tor failure always sets state to 'failed', never auto-fallback to 'direct' (per PRIV-03 and user's explicit requirement)
- Pool recovery skips reconnection when in Tor mode but fetchFn is not available (prevents WebSocket leaks during Tor bootstrap, Pitfall 6)
- NIP-65 buildNip65Event ensures created_at is strictly greater than previousTimestamp to prevent replaceable event conflicts (Pitfall 3)
- relay-discovery.ts created as scaffolding — actual kind 10002 subscription queries will be wired when pool supports kind-specific queries

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated existing pool test mock with Phase 3 methods**
- **Found during:** Task 1 verification (running full test suite)
- **Issue:** Existing nostr-relay-pool.test.ts mock lacked getLatency(), sendRawEvent(), setTorMode(), setDirectMode() methods added to NostrRelay in Phase 3
- **Fix:** Added missing methods to mock class, added rootScope and nip65 mocks
- **Files modified:** src/tests/nostra/nostr-relay-pool.test.ts
- **Verification:** All 14 existing pool tests pass in isolation
- **Committed in:** a968c20

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug fix)
**Impact on plan:** Necessary fix to keep existing tests working with the new NostrRelay interface. No scope creep.

## Issues Encountered
- Vitest mock isolation with `threads: false`: When multiple test files mock the same module (`@lib/rootScope`, `@lib/nostra/nostr-relay`), mock state leaks across files. Mitigated by using constructor injection for WebtorClient and accessing mock.calls directly instead of shared event arrays. Pre-existing project issue, not introduced by these changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Pool infrastructure ready for Phase 3 Plan 2 (Tor UX components: shield icon, banners, status popup)
- rootScope events (`nostra_tor_state`, `nostra_relay_state`) ready for UI consumption
- PrivacyTransport API ready for Phase 4 messaging integration
- NIP-65 publishing ready to be triggered from identity initialization

---
*Phase: 03-multi-relay-pool*
*Completed: 2026-04-01*
