---
phase: 02-crypto-foundation-identity
plan: 02
subsystem: auth
tags: [nostr, nip-06, nip-44, migration, onboarding, bip-39, indexeddb, solid-js]

requires:
  - phase: 02-crypto-foundation-identity/01
    provides: nostr-identity, nostr-crypto, key-storage modules
provides:
  - OwnID-to-npub silent migration with offline queue NIP-44 re-encryption
  - Two-path onboarding flow (Create New Identity / Import Seed Phrase)
  - SeedPhraseGrid Solid.js component with 12-field grid
affects: [02-crypto-foundation-identity/03, 02-crypto-foundation-identity/04]

tech-stack:
  added: []
  patterns: [direct-indexeddb-access-for-migration, version-agnostic-db-open]

key-files:
  created:
    - src/lib/nostra/migration.ts
    - src/components/nostra/SeedPhraseGrid.tsx
    - src/tests/nostra/migration.test.ts
    - src/tests/nostra/onboarding-npub.test.ts
  modified:
    - src/lib/nostra/offline-queue.ts
    - src/pages/nostra/onboarding.ts
    - src/pages/nostra/onboarding.css

key-decisions:
  - "Migration opens Nostra.chat DB without version to avoid v1/v2 conflicts with key-storage"
  - "rootScope.dispatchEvent wrapped in try/catch in migration — non-fatal in test/worker contexts"
  - "Offline queue exports loadAllQueuedMessages/saveQueuedMessage as thin wrappers over internal functions"

patterns-established:
  - "Version-agnostic DB open: indexedDB.open(name) without version for read-only migration access"
  - "Direct IndexedDB access with explicit close() for migration to avoid connection blocking"

requirements-completed: [IDEN-02]

duration: 13min
completed: 2026-04-01
---

# Phase 02 Plan 02: OwnID-to-npub Migration and Onboarding Redesign Summary

**Silent OwnID migration with NIP-44 offline queue re-encryption and two-path onboarding (Create/Import npub)**

## Performance

- **Duration:** 13 min
- **Started:** 2026-04-01T15:32:12Z
- **Completed:** 2026-04-01T15:45:18Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- OwnID-to-npub migration module that silently upgrades existing users with NIP-06 key derivation
- Offline queue pending messages re-encrypted with NIP-44 using new keypair during migration
- Onboarding redesigned with Create New Identity (shows npub, not seed) and Import Seed Phrase paths
- SeedPhraseGrid Solid.js component with 12 numbered fields, auto-advance focus, and paste detection
- 17 tests covering migration flow, error recovery, NIP-44 decode verification, and onboarding UI

## Task Commits

Each task was committed atomically:

1. **Task 1: OwnID-to-npub migration (TDD RED)** - `24cd79b` (test)
2. **Task 1: OwnID-to-npub migration (TDD GREEN)** - `5305032` (feat)
3. **Task 2: Onboarding redesign with SeedPhraseGrid** - `1757d9b` (feat)

## Files Created/Modified
- `src/lib/nostra/migration.ts` - needsMigration() and migrateOwnIdToNpub() with offline queue re-encryption
- `src/lib/nostra/offline-queue.ts` - Exported loadAllQueuedMessages/saveQueuedMessage for migration access
- `src/components/nostra/SeedPhraseGrid.tsx` - 12-field seed phrase import grid (Solid.js)
- `src/pages/nostra/onboarding.ts` - Redesigned two-path onboarding (Create/Import)
- `src/pages/nostra/onboarding.css` - Updated styles for npub display, seed grid, display name
- `src/tests/nostra/migration.test.ts` - 9 tests for migration including NIP-44 decode verification
- `src/tests/nostra/onboarding-npub.test.ts` - 8 tests for onboarding UI and migration integration

## Decisions Made
- Migration opens Nostra.chat DB without specifying version to avoid conflicts with key-storage's v2 schema upgrade. This ensures the migration read works whether the DB is at v1 (pre-migration) or v2 (post key-storage init).
- rootScope.dispatchEvent wrapped in try/catch in migration code since MTProtoMessagePort may not be initialized in all contexts.
- Offline queue module exports thin wrapper functions rather than making internal functions public directly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Direct IndexedDB access instead of identity.ts loadIdentity/clearIdentity**
- **Found during:** Task 1 (migration implementation)
- **Issue:** Using loadIdentity() from identity.ts opened Nostra.chat DB at v1 without closing it, causing key-storage's v2 open to deadlock
- **Fix:** Implemented readOldIdentity() and deleteOldIdentity() directly in migration.ts with explicit db.close() and version-agnostic open
- **Files modified:** src/lib/nostra/migration.ts
- **Verification:** All 9 migration tests pass without timeout
- **Committed in:** 5305032

**2. [Rule 1 - Bug] Fixed require() call in onboarding.ts import path**
- **Found during:** Task 2 (onboarding implementation)
- **Issue:** Used require('@lib/nostra/nostr-identity') inside showImport() which fails in ESM context
- **Fix:** Moved validateMnemonic to top-level import statement
- **Files modified:** src/pages/nostra/onboarding.ts
- **Verification:** All 8 onboarding tests pass
- **Committed in:** 1757d9b

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for correct operation. No scope creep.

## Issues Encountered
- fake-indexeddb version conflicts between test helper (v1) and key-storage (v2) required test helpers to open Nostra.chat at v2 with all stores pre-created
- MTProtoMessagePort unhandled rejection in test context required vi.mock setup in test files

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Migration module ready for Plan 03/04 to integrate into app startup
- SeedPhraseGrid available for reuse in backup/recovery flows
- Onboarding now fully npub-based, compatible with Nostr relay messaging

---
*Phase: 02-crypto-foundation-identity*
*Completed: 2026-04-01*
