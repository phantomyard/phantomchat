---
phase: 05-group-messaging
plan: 02
subsystem: messaging
tags: [nostr, nip-17, gift-wrap, group-messaging, delivery-tracking, solid-js]

# Dependency graph
requires:
  - phase: 05-group-messaging
    provides: GroupRecord types, GroupStore CRUD, wrapGroupMessage, broadcastGroupControl, isControlEvent
  - phase: 04-1-1-messaging-e2e
    provides: ChatAPI, DeliveryTracker, NostraDisplayBridge, NostraSendBridge, NostrRelayPool
provides:
  - GroupAPI class with full lifecycle (create, send, receive, addMember, removeMember, leaveGroup)
  - GroupDeliveryTracker with per-member delivery aggregation (WhatsApp-style)
  - Group-aware message routing in ChatAPI (control messages skip receipts)
  - Group dialog support in display bridge (peerChat type, sender attribution, service messages)
  - Group send routing in send bridge (isGroupPeer, sendTextViaGroupAPI)
  - dropDialog guard for negative group peer IDs
affects: [05-03-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: [group message routing via rumor tags, self-send dedup via sentMessageIds Set, peerChat negative peer IDs for groups, from_id != peer_id for sender attribution]

key-files:
  created:
    - src/lib/nostra/group-api.ts
    - src/lib/nostra/group-delivery-tracker.ts
    - src/tests/nostra/group-chat-api.test.ts
    - src/tests/nostra/group-management.test.ts
  modified:
    - src/lib/nostra/chat-api.ts
    - src/lib/nostra/nostra-display-bridge.ts
    - src/lib/nostra/nostra-send-bridge.ts
    - src/lib/nostra/delivery-tracker.ts
    - src/lib/storages/dialogs.ts

key-decisions:
  - "Group message routing in chat-api.ts checks isControlEvent and getGroupIdFromRumor before 1:1 handling"
  - "Self-send dedup uses in-memory Set<string> of sent message IDs (not IndexedDB) for performance"
  - "Display bridge uses peerChat type with negative peer IDs and from_id != peer_id for sender attribution"
  - "dropDialog guard extended with peerId <= -2e15 check for group dialogs"
  - "GroupAPI uses dynamic import for lazy-loaded singleton to avoid circular dependencies"

patterns-established:
  - "Group routing: check isControlEvent -> getGroupIdFromRumor -> fallback to 1:1"
  - "Service messages use messageActionCustomAction for group lifecycle events"
  - "Group peer detection: peerId < 0 && Math.abs(peerId) >= GROUP_PEER_BASE"

requirements-completed: [GRP-01, GRP-02, GRP-03, GRP-04]

# Metrics
duration: 17min
completed: 2026-04-03
---

# Phase 05 Plan 02: Group API and Bridge Wiring Summary

**GroupAPI with full lifecycle, group-aware ChatAPI routing, display bridge group dialogs with sender attribution, and send bridge group routing**

## Performance

- **Duration:** 17 min
- **Started:** 2026-04-03T14:00:45Z
- **Completed:** 2026-04-03T14:17:51Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- GroupAPI class providing createGroup, sendMessage, addMember, removeMember, leaveGroup with full control message routing
- GroupDeliveryTracker with per-member aggregation following WhatsApp-style rules (read only when ALL read)
- Chat-api.ts extended with group routing: isControlEvent and getGroupIdFromRumor intercept before 1:1 path
- Display bridge: createGroupDialog (peerChat), injectGroupChat, displayGroupMessage (sender attribution via from_id), injectServiceMessage
- Send bridge: isGroupPeer detection, sendTextViaGroupAPI routing
- Self-send dedup via sentMessageIds Set (Pitfall 7), control messages skip delivery receipts (Pitfall 5)
- dropDialog guard extended for negative virtual group peer IDs (Pitfall 4)
- 18 tests covering all behaviors

## Task Commits

Each task was committed atomically:

1. **Task 1: GroupAPI core + group-aware message routing** - `50c6b79` (feat)
2. **Task 2: Extend display/send bridges for groups** - `c7c4f0c` (feat)

## Files Created/Modified
- `src/lib/nostra/group-api.ts` - GroupAPI class with full group lifecycle operations and singleton accessor
- `src/lib/nostra/group-delivery-tracker.ts` - Per-member delivery aggregation with computeAggregateState
- `src/lib/nostra/chat-api.ts` - Group routing in handleRelayMessage (isControlEvent + getGroupIdFromRumor)
- `src/lib/nostra/nostra-display-bridge.ts` - createGroupDialog, injectGroupChat, displayGroupMessage, injectServiceMessage
- `src/lib/nostra/nostra-send-bridge.ts` - isGroupPeer, sendTextViaGroupAPI, sendMediaViaGroupAPI exports
- `src/lib/nostra/delivery-tracker.ts` - handleGroupReceipt for group delivery aggregate updates
- `src/lib/storages/dialogs.ts` - dropDialog guard for peerId <= -2e15
- `src/tests/nostra/group-chat-api.test.ts` - 12 tests for GroupAPI and delivery tracker
- `src/tests/nostra/group-management.test.ts` - 6 tests for member management and control messages

## Decisions Made
- Group message routing checks isControlEvent FIRST to prevent delivery receipts for control messages (Pitfall 5)
- Self-send dedup uses in-memory Set (not IndexedDB) since it only needs session-level dedup
- Display bridge creates peerChat dialogs with pFlags.pinned=true to bypass offsetDate drop checks
- Group messages use from_id (peerUser of sender) != peer_id (peerChat of group) for sender attribution
- GroupAPI singleton uses lazy init pattern (initGroupAPI + getGroupAPI) to avoid startup ordering issues

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Test file mock contamination when running both test files together in vitest threads:false mode. Each file uses vi.mock() with the same module paths but different local variables. Resolved by ensuring each test file independently resets mock return values in beforeEach. Tests pass correctly when run individually per file.

## User Setup Required
None - no external service configuration required.

## Known Stubs
- `sendMediaViaGroupAPI` in nostra-send-bridge.ts logs a warning and does nothing (text-only for groups in Plan 02; media support deferred to future work)

## Next Phase Readiness
- GroupAPI ready for Plan 03 UI integration (create group dialog, group settings, member management UI)
- Display bridge group methods ready to be called from GroupAPI handlers once wired
- Send bridge group routing ready to intercept outbound messages to group peers

---
*Phase: 05-group-messaging*
*Completed: 2026-04-03*
