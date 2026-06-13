---
phase: 01-build-pipeline-distribution
plan: 01
subsystem: testing
tags: [vitest, eslint, vite, vendor-stubs, build-pipeline]

# Dependency graph
requires: []
provides:
  - "pnpm build exits 0 with zero ESLint errors"
  - "Wave 0 test scaffolds: vendor-stubs.test.ts (6 tests), build-output.test.ts (3 tests)"
  - "ESLint await-thenable false positives suppressed at call sites"
affects: [02-nostr-identity, 03-tor-transport, 04-media-transfer, 05-ux-polish, 06-distribution]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ESLint await-thenable false positive: suppress with eslint-disable-next-line at call site, never remove await"
    - "Build output test: use describe.skipIf(!existsSync(dist/)) pattern for pre-build contexts"
    - "Vendor stub tests: dynamic import via @vendor/* alias to assert API shape"

key-files:
  created:
    - src/tests/vendor-stubs.test.ts
    - src/tests/build-output.test.ts
  modified:
    - src/helpers/compareVersion.ts
    - src/pages/nostra-onboarding-integration.ts
    - src/components/chat/bubbles.ts
    - src/components/sidebarLeft/index.ts
    - src/helpers/themeController.ts
    - src/lib/appImManager.ts
    - src/lib/passcode/actions.ts

key-decisions:
  - "await-thenable ESLint rule suppressed per-line only (eslint-disable-next-line), not file-level — setAppSettings/setAppState genuinely return Promises but TypeScript infers void from SetStoreFunction"
  - "build-output.test.ts checks asset script/link src/href for absolute URLs only, not meta/canonical tags (which legitimately use https://nostra.chat)"

patterns-established:
  - "Vendor stub test pattern: dynamic import + typeof assertion for shape verification without full DOM/runtime"
  - "Build output test pattern: skipIf(!distExists) guard allows test to be committed before first build"

requirements-completed: [DIST-01, DIST-05]

# Metrics
duration: 15min
completed: 2026-04-01
---

# Phase 1 Plan 01: Fix Build Pipeline and Wave 0 Test Scaffolds Summary

**ESLint-clean pnpm build (0 errors) restored via 10 targeted fixes, with Vitest scaffolds for vendor stub API shapes and dist/ asset URL correctness**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-01T07:00:00Z
- **Completed:** 2026-04-01T07:11:24Z
- **Tasks:** 2 of 2
- **Files modified:** 9

## Accomplishments

- Created `vendor-stubs.test.ts` with 6 tests covering all critical vendor stubs (bezierEasing, convertPunycode, fastBlur, prism, emoji, solid-transition-group) — all pass green
- Created `build-output.test.ts` with dist/ asset path checks (relative vs absolute) and `skipIf(!distExists)` guard — passes pre- and post-build
- Fixed all 10 ESLint errors: 2 keyword-spacing in compareVersion.ts, 1 trailing-space in onboarding integration, 7 await-thenable false positives suppressed with single-line comments
- `pnpm build` now exits 0 — unblocking all downstream plans

## Task Commits

1. **Task 1: Create Wave 0 test scaffolds** - `1ae415c` (test)
2. **Task 2: Fix all 10 ESLint errors** - `6257588` (fix)

## Files Created/Modified

- `src/tests/vendor-stubs.test.ts` - 6 vendor stub shape assertion tests using dynamic @vendor/* imports
- `src/tests/build-output.test.ts` - 3 dist/ asset URL tests with skipIf guard for pre-build context
- `src/helpers/compareVersion.ts` - keyword-spacing fix (if without space)
- `src/pages/nostra-onboarding-integration.ts` - trailing whitespace removal
- `src/components/chat/bubbles.ts` - await-thenable suppression on setAppState call
- `src/components/sidebarLeft/index.ts` - await-thenable suppression on setAppSettings call
- `src/helpers/themeController.ts` - await-thenable suppression on two setAppSettings calls
- `src/lib/appImManager.ts` - await-thenable suppression on setAppState call
- `src/lib/passcode/actions.ts` - await-thenable suppression on two setAppSettings calls

## Decisions Made

- Suppressed `@typescript-eslint/await-thenable` per-line only (not file-level) because `setAppSettings`/`setAppState` genuinely return Promises at runtime; TypeScript incorrectly infers `void` from the `SetStoreFunction` type. Removing `await` would be incorrect behavior, not a valid fix.
- `build-output.test.ts` checks only `<script src>` and `<link href>` asset attributes for absolute URLs — meta/canonical tags legitimately reference `https://nostra.chat` by design (OG/SEO metadata).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] build-output.test.ts test scope narrowed to asset attributes only**
- **Found during:** Task 1 (test scaffold creation)
- **Issue:** Plan specified "test: dist/index.html does not contain 'https://nostra.chat' string" — but dist/ already existed with legitimate nostra.chat URLs in `<meta property="og:url">`, `<meta property="twitter:url">`, and `<link rel="canonical">` meta tags. These are intentionally absolute per OG/Twitter spec. Testing the raw string would always fail.
- **Fix:** Scoped the test to check only `<script src>` and `<link rel="stylesheet">`/`<link rel="modulepreload">` href attributes. Added separate test for web.telegram.org absence in those same attributes.
- **Files modified:** src/tests/build-output.test.ts
- **Verification:** All 3 build-output tests pass against fresh dist/ build
- **Committed in:** 1ae415c (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in test specification)
**Impact on plan:** Test now correctly validates the meaningful constraint (asset paths are relative) without false-failing on legitimate absolute meta tag URLs.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `pnpm build` exits 0 — Phase 1 remaining plans (TypeScript, dist/ validation, deployment) can proceed
- `pnpm test` passes for both new test files — CI baseline established
- No blockers for subsequent plans

---
*Phase: 01-build-pipeline-distribution*
*Completed: 2026-04-01*
