---
phase: 03-multi-relay-pool
plan: 03
subsystem: ui, infra
tags: [relay-settings, tor-shield, topbar, privacy-transport, nip-65, onboarding-integration]

# Dependency graph
requires:
  - phase: 03-multi-relay-pool
    provides: NostrRelayPool CRUD API, PrivacyTransport, Tor UX components (shield, banners, popups)
provides:
  - Full CRUD relay settings with status dots, latency, read/write toggles
  - Topbar with TorShield icon and TorBanner integration
  - PrivacyTransport wired into app startup via nostra-bridge
  - NIP-65 published at identity initialization
  - Onboarding + relay store migrated from old identity to encrypted nostr-identity store
affects: [04-messaging-ui]

# Tech tracking
tech-stack:
  added: []
  patterns: [solid-render-in-vanilla-ts, identity-store-decryption-pattern]

key-files:
  created: []
  modified:
    - src/components/sidebarLeft/tabs/nostraRelaySettings.ts
    - src/components/chat/topbar.ts
    - src/lib/nostra/nostra-bridge.ts
    - src/tests/nostra/nostr-relay-pool.test.ts
    - src/pages/nostra-onboarding-integration.ts
    - src/lib/nostra/nostr-relay.ts
    - src/index.ts
    - src/pages/nostra/onboarding.ts

key-decisions:
  - "Onboarding always mounts regardless of identity presence -- handles both new and existing users internally"
  - "Private key hex-to-bytes conversion via parseInt(hex, 16) instead of atob base64 decoding"
  - "Unified handleIdentity() function guards race condition between callback and DOM event"
  - "NostrRelay.initialize() uses encrypted identity store (loadEncryptedIdentity + decryptKeys + importFromMnemonic)"

patterns-established:
  - "Identity decryption pattern: loadEncryptedIdentity() -> loadBrowserKey() -> decryptKeys() -> importFromMnemonic() for any component needing identity access"
  - "Solid.js render() in vanilla TS: mount Solid components into DOM nodes created by vanilla TypeScript classes"

requirements-completed: [INF-03, INF-04, INF-06, PRIV-01, PRIV-02, PRIV-03]

# Metrics
duration: 45min
completed: 2026-04-01
---

# Phase 3 Plan 03: Relay Settings CRUD + Topbar Integration + App Init Summary

**End-to-end wiring of relay settings UI, topbar shield/banner, PrivacyTransport app init, and NIP-65 identity publishing with encrypted store migration**

## Performance

- **Duration:** 45 min (spread across checkpoint verification session)
- **Started:** 2026-04-01T20:05:00Z
- **Completed:** 2026-04-01T21:05:00Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments
- Relay settings UI shows per-relay status dot (green/red/yellow), latency, read/write toggles, enable/disable, and "usa solo i miei relay" toggle
- TorShield icon mounted in topbar with reactive color states; TorBanner renders below topbar
- PrivacyTransport initialized at app startup via nostra-bridge with fire-and-forget bootstrap
- NIP-65 kind 10002 published at identity initialization from onboarding integration
- All identity consumers (onboarding, relay, index.ts) migrated from old `identity` store to encrypted `nostr-identity` store
- Pool tests extended with 6 new tests covering default relays, enable/disable, Tor mode, NIP-65

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend relay settings UI + wire topbar + app init** - `ca7b892` (feat)
2. **Task 2: Extend pool test + integration smoke test** - `fe7b501` (test)
3. **Task 3: Visual verification + identity store bugfixes** - `70db5cd` (fix)

## Files Created/Modified
- `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` - Full CRUD relay settings with status dots, latency, R/W toggles
- `src/components/chat/topbar.ts` - TorShield icon and TorBanner mounted via solid-js/web render()
- `src/lib/nostra/nostra-bridge.ts` - PrivacyTransport init wired into app startup, NIP-65 publishing
- `src/tests/nostra/nostr-relay-pool.test.ts` - 6 new tests for Phase 3 pool features
- `src/pages/nostra-onboarding-integration.ts` - Migrated to encrypted identity store, fixed race condition and hex key encoding
- `src/lib/nostra/nostr-relay.ts` - Migrated to encrypted identity store, removed old identity dependency
- `src/index.ts` - Always mount onboarding (handles both new/existing users)
- `src/pages/nostra/onboarding.ts` - Code style fixes (catch spacing)
- `src/components/sidebarLeft/tabs/nostraIdentity.ts` - Code style fixes
- `src/components/sidebarLeft/tabs/nostraSecurity.ts` - Code style fixes (ternary, catch)
- `src/lib/nostra/migration.ts` - Code style fixes (catch spacing)
- `src/langPackLocalVersion.ts` - Lang pack version bump

## Decisions Made
- Onboarding always mounts regardless of identity presence -- it handles both new user (shows onboarding) and existing user (loads identity, mounts chat) paths internally
- Private key hex-to-bytes conversion uses `parseInt(hex, 16)` mapping over hex pairs instead of `atob()` base64 decoding (which was wrong for hex strings)
- Unified `handleIdentity()` function called by both callback and DOM event, guarded by `identityHandled` flag to prevent double execution
- NostrRelay.initialize() decrypts identity via the Phase 2 encrypted store chain rather than the deprecated `loadIdentity()` function

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Old identity store used in onboarding-integration, nostr-relay, and index.ts**
- **Found during:** Task 3 (visual verification via Playwright)
- **Issue:** All three files imported from the old `identity` store which returns `{ownId, privateKey(base64), publicKey}` format. The Phase 2 encrypted store returns different data requiring decryption.
- **Fix:** Replaced `loadIdentity()` with `loadEncryptedIdentity()` + `loadBrowserKey()` + `decryptKeys()` + `importFromMnemonic()` chain in all three files
- **Files modified:** src/pages/nostra-onboarding-integration.ts, src/lib/nostra/nostr-relay.ts, src/index.ts
- **Verification:** App loads and initializes identity correctly in browser
- **Committed in:** 70db5cd

**2. [Rule 1 - Bug] Race condition in identity callback vs DOM event**
- **Found during:** Task 3 (visual verification)
- **Issue:** DOM event handler set `identityHandled = true` before the async callback could execute its logic, causing identity processing to be skipped
- **Fix:** Unified both paths into a single `handleIdentity()` async function; both callback and DOM event call it, first one wins
- **Files modified:** src/pages/nostra-onboarding-integration.ts
- **Committed in:** 70db5cd

**3. [Rule 1 - Bug] Private key base64 decode on hex string**
- **Found during:** Task 3 (visual verification)
- **Issue:** `Uint8Array.from(atob(identity.privateKey), c => c.charCodeAt(0))` used base64 decoding on a hex-encoded private key, producing wrong bytes
- **Fix:** Changed to `new Uint8Array(identity.privateKey.match(/.{2}/g)!.map(b => parseInt(b, 16)))` for proper hex-to-bytes conversion
- **Files modified:** src/pages/nostra-onboarding-integration.ts
- **Committed in:** 70db5cd

**4. [Rule 1 - Bug] Entry point only mounted onboarding when identity absent**
- **Found during:** Task 3 (visual verification)
- **Issue:** `index.ts` checked `loadIdentity()` and only mounted onboarding when null. With the new store, existing users need onboarding mounted too (it handles the "existing identity" path internally).
- **Fix:** Removed conditional check; always mount onboarding which handles both paths
- **Files modified:** src/index.ts
- **Committed in:** 70db5cd

---

**Total deviations:** 4 auto-fixed (all Rule 1 - bugs)
**Impact on plan:** All bugs discovered during visual verification checkpoint. Store migration was necessary because Phase 2 changed the identity storage format. No scope creep.

## Issues Encountered
None beyond the auto-fixed bugs above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 complete: multi-relay pool with Tor privacy fully wired end-to-end
- PrivacyTransport bootstraps at app startup, NIP-65 publishes at identity init
- Relay settings CRUD, topbar shield, and banners all functional
- Ready for Phase 4: 1:1 messaging with NIP-17 gift-wrapped DMs over the relay pool

## Self-Check: PASSED

All 7 key files verified on disk. All 3 task commits (ca7b892, fe7b501, 70db5cd) found in git history.

---
*Phase: 03-multi-relay-pool*
*Completed: 2026-04-01*
