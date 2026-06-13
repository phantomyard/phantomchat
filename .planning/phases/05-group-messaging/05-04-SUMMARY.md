---
phase: 05-group-messaging
plan: "04"
subsystem: ui
tags: [solid-js, group-messaging, sidebar, nostr]

requires:
  - phase: 05-group-messaging/03
    provides: GroupAPI, GroupStore, NostraDisplayBridge.injectGroupChat
provides:
  - AppNostraNewGroupTab SliderSuperTab for group creation
  - GroupAPI initialization at login with relay pool publishFn
  - sidebarLeft onNewGroupClick wired to Nostra.chat group creation flow
affects: [05-group-messaging]

tech-stack:
  added: []
  patterns: [dynamic-import-tab-loading, peerId-to-pubkey-reverse-lookup]

key-files:
  created:
    - src/components/sidebarLeft/tabs/nostraNewGroup.ts
  modified:
    - src/pages/nostra-onboarding-integration.ts
    - src/components/sidebarLeft/index.ts

key-decisions:
  - "Dynamic import for AppNostraNewGroupTab to avoid circular dependency risk and reduce bundle impact"
  - "publishFn uses bridge.getRelayPool().publishRawEvent for group control message publishing"

patterns-established:
  - "Dynamic tab import: await import() inside closeTabsBefore callback for Nostra.chat-specific tabs"
  - "peerId-to-pubkey mapping via virtual-peers-db.getPubkey() for group member resolution"

requirements-completed: [GRP-01]

duration: 3min
completed: 2026-04-03
---

# Phase 05 Plan 04: Wire New Group Button to GroupAPI Summary

**New Group button in sidebarLeft creates Nostra.chat groups via GroupAPI with relay pool publishing and virtual peer mapping**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-03T17:31:32Z
- **Completed:** 2026-04-03T17:34:26Z
- **Tasks:** 2/2
- **Files modified:** 3

## Accomplishments

### Task 1: Create AppNostraNewGroupTab and initialize GroupAPI
- Created `src/components/sidebarLeft/tabs/nostraNewGroup.ts` — SliderSuperTab that maps selected peerIds to Nostr pubkeys via virtual-peers-db, calls `getGroupAPI().createGroup()`, injects the new group dialog via `NostraDisplayBridge.injectGroupChat`, and navigates to the new group chat
- Modified `src/pages/nostra-onboarding-integration.ts` to call `initGroupAPI()` with the user's hex pubkey, derived private key bytes, and a publishFn that routes through `bridge.getRelayPool().publishRawEvent()`
- **Commit:** 6c66747

### Task 2: Wire onNewGroupClick to AppNostraNewGroupTab
- Modified `src/components/sidebarLeft/index.ts` to replace `AppAddMembersTab.createNewGroupTab(this)` with a custom flow: opens `AppAddMembersTab` with a `takeOut` callback that dynamically imports and creates `AppNostraNewGroupTab`
- Preserved existing `AppNewGroupTab` and `AppAddMembersTab` imports (used elsewhere)
- Removed the only call to `createNewGroupTab` static method from this file
- **Commit:** d901058

## Verification Results

| Check | Result |
|-------|--------|
| `initGroupAPI` in onboarding | PASS (lines 133, 142) |
| `createGroup` in nostraNewGroup | PASS (line 76) |
| `AppNostraNewGroupTab` in sidebarLeft | PASS (lines 1001, 1009) |
| `createNewGroupTab` removed from sidebarLeft | PASS (0 matches) |
| Original imports preserved | PASS (AppNewGroupTab line 14, AppAddMembersTab line 22) |

## Deviations from Plan

### Minor Adjustments

**1. [Rule 3 - Blocking] Used dynamic import instead of static import for AppNostraNewGroupTab**
- **Found during:** Task 2
- **Issue:** Plan suggested static import at file top, but dynamic import avoids circular dependency risk and reduces initial bundle size
- **Fix:** Used `await import('@components/sidebarLeft/tabs/nostraNewGroup')` inside the async callback
- **Files modified:** src/components/sidebarLeft/index.ts

**2. [Rule 2 - Critical] Added null guard for relay pool in publishFn**
- **Found during:** Task 1
- **Issue:** `bridge.getRelayPool()` can return null if pool not yet connected
- **Fix:** Added `if(!pool) return;` guard in publishFn before iterating events
- **Files modified:** src/pages/nostra-onboarding-integration.ts

## Known Stubs

None - all data paths are wired to real implementations.
