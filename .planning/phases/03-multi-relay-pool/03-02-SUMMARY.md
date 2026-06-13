---
phase: 03-multi-relay-pool
plan: 02
subsystem: ui
tags: [solid-js, tor, privacy-ux, scss, italian-i18n]

# Dependency graph
requires:
  - phase: 02-crypto-identity
    provides: rootScope event system, Solid.js component patterns
provides:
  - TorShield icon component with 4 color states
  - TorBanner component with bootstrap/direct/reconnect banners
  - TorFallbackConfirm modal popup blocking auto-fallback
  - TorStatus popup with per-relay latency display
  - Tor UI SCSS styles (shield, banners, popups)
  - rootScope tor/relay event type definitions
affects: [03-multi-relay-pool, 04-messaging]

# Tech tracking
tech-stack:
  added: []
  patterns: [tor-state-reactive-ui, privacy-banner-pattern, modal-confirmation-gate]

key-files:
  created:
    - src/components/nostra/torShield.tsx
    - src/components/nostra/torBanner.tsx
    - src/components/popups/torFallbackConfirm.tsx
    - src/components/popups/torStatus.tsx
    - src/scss/nostra/_tor-ui.scss
    - src/tests/nostra/tor-fallback-confirm.test.ts
  modified:
    - src/lib/rootScope.ts

key-decisions:
  - "rootScope events (nostra_tor_state, nostra_relay_state, nostra_relay_list_changed) added inline since Plan 01 runs in parallel"
  - "Fallback confirmation popup is strictly modal — overlay click does not dismiss, user must choose Riprova or Continua"
  - "Direct banner dismiss stored in sessionStorage (not localStorage) so it reappears on next session"

patterns-established:
  - "Tor state UI pattern: components subscribe to nostra_tor_state via rootScope.addEventListener in onMount with onCleanup"
  - "Privacy banner pattern: persistent orange warning for IP-exposed state, green fade-out for reconnection"
  - "Modal confirmation gate: privacy-critical actions require explicit user confirmation before proceeding"

requirements-completed: [PRIV-02, PRIV-03]

# Metrics
duration: 6min
completed: 2026-04-01
---

# Phase 3 Plan 02: Tor UX Components Summary

**Tor privacy UI with shield icon (4 color states), Italian banners, modal fallback confirmation, and per-relay status popup**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-01T19:45:29Z
- **Completed:** 2026-04-01T19:51:29Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- TorShield component renders shield SVG with reactive color (grey/green/orange/red) based on Tor state
- TorBanner shows Italian text for each state: "Avvio di Tor...", "Connessione diretta - IP visibile ai relay", "Connesso via Tor" with 3s fade-out
- TorFallbackConfirm modal blocks auto-fallback -- user must explicitly choose Riprova or Continua
- TorStatus popup displays Tor state label and per-relay info (URL, status dot, latency, R/W badges)
- Added nostra_tor_state, nostra_relay_state, nostra_relay_list_changed event types to rootScope

## Task Commits

Each task was committed atomically:

1. **Task 1: Tor shield icon + banners + SCSS** - `3757809` (feat)
2. **Task 2: Tor fallback confirmation popup + status popup + test** - `2b9f105` (feat)

**Plan metadata:** [pending] (docs: complete plan)

## Files Created/Modified
- `src/components/nostra/torShield.tsx` - Shield icon with 4 color states reacting to nostra_tor_state
- `src/components/nostra/torBanner.tsx` - Bootstrap/direct/reconnect banners with Italian text
- `src/components/popups/torFallbackConfirm.tsx` - Modal confirmation popup for direct fallback
- `src/components/popups/torStatus.tsx` - Detailed Tor status popup with per-relay latency
- `src/scss/nostra/_tor-ui.scss` - Styles for shield, banners, popups, and relay status
- `src/lib/rootScope.ts` - Added 3 nostra tor/relay event type definitions
- `src/tests/nostra/tor-fallback-confirm.test.ts` - 5 tests for popup callbacks and modal behavior

## Decisions Made
- Added rootScope event types (nostra_tor_state, nostra_relay_state, nostra_relay_list_changed) inline since Plan 01 runs in same wave and may not have committed yet
- Fallback confirmation popup strictly modal -- overlay click does not dismiss, ensuring user always makes explicit privacy decision
- Direct banner dismiss stored in sessionStorage (not localStorage) so warning reappears each session

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added rootScope event type definitions**
- **Found during:** Task 1 (TorShield component)
- **Issue:** nostra_tor_state, nostra_relay_state, nostra_relay_list_changed events not yet defined in rootScope (Plan 01 parallel)
- **Fix:** Added type definitions to BroadcastEvents in rootScope.ts
- **Files modified:** src/lib/rootScope.ts
- **Verification:** TypeScript compiles without errors for all new files
- **Committed in:** 3757809 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential for type safety. Plan 01 defines the same events -- whichever commits first establishes them.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Tor UX components ready to be wired to the PrivacyTransport layer from Plan 01
- Shield icon can be placed in topbar once integration plan runs
- Fallback confirmation popup ready to be triggered by Tor failure events

## Self-Check: PASSED

All 6 created files verified on disk. Both task commits (3757809, 2b9f105) found in git history.

---
*Phase: 03-multi-relay-pool*
*Completed: 2026-04-01*
