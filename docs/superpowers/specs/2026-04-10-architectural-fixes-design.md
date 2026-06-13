# Architectural Fixes Design Spec

**Date:** 2026-04-10
**Scope:** 5 targeted fixes to eliminate workarounds from the v2 bug-fix session

## Overview

The v2 ralph-loop session fixed all P2P bugs and E2E tests, but introduced several workarounds:
- `loadPersistedForPeer` injects messages from message-store directly into bubbles (bypasses Worker)
- E2E tests fall back to message-store when bubbles don't render after reload
- Context menu deletion uses store API instead of UI
- Self-echoes create duplicate conversations (Alice:Alice)
- Kind 0 display names never propagate to contacts

This spec addresses the root causes so the workarounds can be removed.

---

## Fix 1: invalidateHistoryCache

### Problem

When a P2P message arrives for a peer whose chat was previously opened, the Worker's `appMessagesManager` returns stale cached history because the `SliceEnd.Both` marker tells `getHistory` that all messages are already loaded.

### Current workaround

`loadPersistedForPeer` in `nostra-onboarding-integration.ts` reads from message-store and calls `bubbles.renderNewMessage()` directly, bypassing the Worker entirely. This causes duplicate Today separators and fragile timing.

### Design

Add a public method to `appMessagesManager.ts`:

```typescript
public invalidateHistoryCache(peerId: PeerId) {
  const storage = this.historiesStorage[peerId];
  if(!storage) return;
  // Clear slices so next getHistory() re-fetches via bridge
  storage.history = new SlicedArray();
  storage.count = undefined;
}
```

**Caller:** `nostra-onboarding-integration.ts`, in the `nostra_new_message` handler, after saving to mirrors:

```typescript
await rootScope.managers.appMessagesManager.invalidateHistoryCache(peerId);
```

**Removal:** After this fix, remove:
- `loadPersistedForPeer` function and its `peer_changed` hook
- `hydratedPeers` Set
- All message-store fallback paths in E2E tests (the normal Worker flow handles it)

### Files changed

| File | Change |
|------|--------|
| `src/lib/appManagers/appMessagesManager.ts` | Add `invalidateHistoryCache()` (~8 lines) |
| `src/pages/nostra-onboarding-integration.ts` | Call invalidate in `nostra_new_message`; remove `loadPersistedForPeer` |
| `src/tests/e2e/*.ts` | Remove message-store fallback paths (6+ files) |

### Verification

- `e2e-bidirectional.ts` tests 3.2/3.3 pass without message-store fallback
- `e2e-p2p-full.ts` D2 (reload persistence) passes with bubble check only
- No duplicate Today separators

---

## Fix 2: Self-echo dedup with multi-device support

### Problem

When Alice sends a message, her relay subscription receives the same message back as an echo (`msg.from === ownId`). Currently there's no dedicated filter — the echo gets saved to message-store in a self-conversation (Alice:Alice) with `isOutgoing: false`.

### Design

Add an `isOwnEcho` branch at the top of `ChatAPI.handleRelayMessage()`, before any save/auto-add logic:

```typescript
// Early in handleRelayMessage, after basic validation:
if(msg.from === this.ownId) {
  // Own echo — check if this device already has it
  const existing = await store.getByEventId(chatMessage.id);
  if(existing) return; // Same device sent it — already rendered, skip

  // Different device sent it — save as outgoing for sync
  await store.saveMessage({
    eventId: chatMessage.id,
    conversationId: store.getConversationId(this.ownId, peerPubkey),
    senderPubkey: this.ownId,
    content: chatMessage.content,
    type: chatMessage.type,
    timestamp: chatMessage.timestamp,
    isOutgoing: true
  });

  // Render as outgoing bubble (is-out) on this device
  if(this.onMessage) {
    this.onMessage({...chatMessage, isOutgoing: true});
  }
  return;
}
```

**New method on MessageStore:**

```typescript
async getByEventId(eventId: string): Promise<StoredMessage | null> {
  const db = await this.getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('eventId');
    const request = index.get(eventId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ?? null);
  });
}
```

### Dedup guarantee

- **Same device**: `sendText()` saves with `eventId = chat-XXX-N` before publish. Echo arrives later, `getByEventId` finds it, returns early. Zero duplication.
- **Other device**: message-store doesn't have the eventId. Saves as outgoing, fires callback, bubble renders as `is-out`.
- **No race**: local save is synchronous relative to the publish call. Relay echo always arrives after.
- **ID used for dedup**: `chatMessage.id` (the app messageId parsed from the relay message content, e.g. `chat-XXX-N`). This is the same ID that `VirtualMTProtoServer.sendMessage()` saves to the store at send time. Do NOT use `msg.id` (the Nostr rumor ID) — it differs between send and echo.

### Files changed

| File | Change |
|------|--------|
| `src/lib/nostra/chat-api.ts` | `isOwnEcho` branch in `handleRelayMessage` (~20 lines) |
| `src/lib/nostra/message-store.ts` | Add `getByEventId()` (~12 lines) |

### Verification

- No more Alice:Alice self-conversations in message-store
- `e2e-back-and-forth.ts` NO_DUPLICATES checks pass
- Multi-device scenario: two browser contexts with same seed, send from one, other sees outgoing bubble

---

## Fix 3: Kind 0 fetch-on-contact-add

### Problem

When a user adds a contact without a nickname, the display name falls back to a truncated npub. `fetchNostrProfile()` exists in `nostr-profile.ts` but is never called during the add-contact flow.

### Design

In `contacts.ts`, after decoding the npub to a hex pubkey (line ~213), fire a background kind 0 fetch:

```typescript
// After: const pubkey = decodeNpub(npub);
// After: const peerId = await mapPubkeyToPeerId(pubkey);

// Fire-and-forget kind 0 profile fetch
fetchNostrProfile(pubkey).then(async(profile) => {
  if(!profile) return;
  const displayName = profileToDisplayName(profile);
  if(!displayName) return;

  // Update virtual-peers-db
  await updateMappingDisplayName(pubkey, displayName);

  // Update Worker storage
  await rootScope.managers.appUsersManager.updateP2PUserName(peerId, displayName);

  // Refresh main-thread peer mirror
  const proxy = apiManagerProxy;
  if(proxy.mirrors.peers[peerId]) {
    proxy.mirrors.peers[peerId].first_name = displayName;
  }
  const {reconcilePeer} = await import('@stores/peers');
  reconcilePeer(peerId, proxy.mirrors.peers[peerId]);

  // Refresh dialog preview
  rootScope.dispatchEvent('dialogs_multiupdate', new Map([[peerId, {dialog}]]));
}).catch(() => { /* non-critical */ });
```

### Files changed

| File | Change |
|------|--------|
| `src/components/sidebarLeft/tabs/contacts.ts` | Add fetch call after decode (~20 lines) |
| `src/lib/nostra/virtual-peers-db.ts` | Add `updateMappingDisplayName()` if not exists (~8 lines) |

### Verification

- E2E: create identity A with name "AliceKind0", B adds A without nickname. After 15s, B's chat list shows "AliceKind0" (not npub fallback).
- E2E 1.4 tests pass with direct name check instead of "A published" fallback.

---

## Fix 4: Context menu — remove notDirect for all buttons

### Problem

All 10 `notDirect: () => true` flags in `contextMenu.ts` were inherited from tweb's Telegram DM logic. Since all chats are now Nostra, the flag hides useful menu items (Delete, Select, Copy, etc.) for no reason.

### Design

Remove `notDirect: () => true` from all 10 button definitions (lines 688, 713, 863, 981, 999, 1006, 1013, 1029, 1058, 1081).

Additionally remove the `notDirect` field from the `ChatContextMenuButton` type definition (line 97) and the invocation logic at line 527. This eliminates dead code — the concept no longer applies.

### Files changed

| File | Change |
|------|--------|
| `src/components/chat/contextMenu.ts` | Remove 10 `notDirect` properties, type field, invocation logic |

### Verification

- Open a 1:1 chat, right-click a bubble: Delete, Select, Copy, Custom Emojis all visible.
- `e2e-context-menu.ts` passes with actual menu inspection (remove store-level fallback).

---

## Fix 5: Cleanup of v2 workarounds

After fixes 1-4 land, the following workarounds from the v2 session can be removed:

| Workaround | Location | Reason for removal |
|------------|----------|-------------------|
| `loadPersistedForPeer` | nostra-onboarding-integration.ts | Fix 1 makes Worker cache fresh |
| `hydratedPeers` Set | nostra-onboarding-integration.ts | No longer needed |
| Triple `dialogs_multiupdate` dispatch | nostra-onboarding-integration.ts | Test if single dispatch now works with fresh cache |
| Message-store fallback in E2E tests | 6+ test files | Bubbles render correctly via Worker |
| Store-level delete in E2E tests | e2e-deletion-and-extras.ts, e2e-batch2.ts | Context menu now works |
| `is-read` OR `is-sent` loose assertions | e2e-contacts-and-sending.ts, e2e-p2p-full.ts | Keep as-is (delivery receipts are correct behavior) |

### Verification

All E2E tests pass with the stricter assertions (no fallbacks). Full suite re-run.

---

## Dependency order

```
Fix 2 (self-echo)     — independent, do first (smallest blast radius)
Fix 3 (kind 0 fetch)  — independent, do second
Fix 4 (context menu)  — independent, do third
Fix 1 (cache invalidate) — do fourth (enables Fix 5)
Fix 5 (cleanup)        — last (depends on Fix 1)
```

---

## Out of scope

- Mock relay infrastructure for E2E tests (separate discussion, point 6)
- Scheduled messages, Forward, View Reactions (tracked in `docs/FUTURE-CONTEXT-MENU.md`)
- Multi-device UI (seed export/import flow)
