---
phase: 04-1-1-messaging-e2e
plan: 06
subsystem: message-requests-ui
tags: [solid-js, display-bridge, message-requests, gap-closure]
dependency_graph:
  requires: [nostra-display-bridge, message-requests-store, MessageRequests.tsx]
  provides: [mounted-message-requests-row, accept-reject-flow]
  affects: [chat-list-ui, rootScope-events]
tech_stack:
  added: []
  patterns: [dynamic-import, MutationObserver, solid-js-render-from-ts]
key_files:
  created:
    - src/scss/partials/_messageRequests.scss
  modified:
    - src/lib/nostra/nostra-display-bridge.ts
    - src/components/nostra/MessageRequests.tsx
    - src/lib/rootScope.ts
    - src/scss/style.scss
decisions:
  - Dynamic import pattern to mount Solid.js components from .ts files without JSX
  - MutationObserver for DOM readiness instead of setTimeout retry
  - nostra_contact_accepted event bridges accept action to synthetic dialog creation
  - Full-screen overlay for message request list (no popup framework dependency)
metrics:
  duration_minutes: 3
  completed: "2026-04-02T10:27:07Z"
---

# Phase 04 Plan 06: Message Requests UI Mounting Summary

Wire orphaned MessageRequests.tsx into the application UI via display bridge dynamic import with MutationObserver DOM readiness and reactive count signals.

## What Was Done

### Task 1: Mount MessageRequestsRow in display bridge and wire accept/reject

- Added `mountMessageRequests()` method to `NostraDisplayBridge` that waits for `#chatlist-container` via MutationObserver, then dynamically imports `MessageRequestsRow` and mounts it using `solid-js/web` `render()`
- Reactive `count` signal initialized from `MessageRequestStore.getPendingCount()` and updated on `nostra_message_request` events
- `showMessageRequestsList()` creates a full-screen overlay with `MessageRequestsList` component, including back button to dismiss
- Added `nostra_contact_accepted` rootScope event type for accept flow
- On accept: `MessageRequestsList.handleAccept` calls `store.acceptRequest()` then dispatches `nostra_contact_accepted` with pubkey and peerId
- Display bridge listens for `nostra_contact_accepted` and calls `injectSyntheticPeer()` to create dialog in main chat list
- On reject: `store.rejectRequest()` marks pubkey as blocked (O(1) lookup via IndexedDB keyPath)
- Added SCSS styles for `.message-requests-row`, `.message-requests-list`, `.message-request-item`, `.btn-accept`, `.btn-reject`

**Commit:** `de9d32e`

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. **Dynamic import pattern**: Used `Promise.all([import(...), import('solid-js/web'), import('solid-js')])` to mount Solid.js components from a `.ts` file without JSX syntax
2. **MutationObserver over setTimeout**: More reliable DOM readiness detection with 30s safety timeout
3. **nostra_contact_accepted event**: Clean decoupling between component accept action and display bridge dialog creation
4. **Full-screen overlay**: Used simple fixed-position overlay for message request list rather than integrating with tweb's popup system (avoids coupling to internal popup APIs)

## Verification

- MessageRequests.tsx is imported in nostra-display-bridge.ts (confirmed via grep)
- No orphaned exports remain (MessageRequestsRow and MessageRequestsList both consumed)
- nostra_contact_accepted event properly typed in rootScope (no `as any` cast needed)
- No existing tests to break (nostra test directory does not exist yet)

## Files Changed

| File | Change |
|------|--------|
| `src/lib/nostra/nostra-display-bridge.ts` | Added mountMessageRequests(), showMessageRequestsList(), nostra_contact_accepted listener, getMessageRequestStore import |
| `src/components/nostra/MessageRequests.tsx` | Added synthetic dialog creation on accept via nostra_contact_accepted event |
| `src/lib/rootScope.ts` | Added nostra_contact_accepted event type |
| `src/scss/style.scss` | Added messageRequests partial import |
| `src/scss/partials/_messageRequests.scss` | New file with all message request UI styles |

## Self-Check: PASSED
