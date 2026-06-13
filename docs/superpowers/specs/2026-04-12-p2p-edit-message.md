# P2P Edit Message — NIP-17 with edit tag

**Date:** 2026-04-12
**Branch:** `feat/p2p-edit-message`
**Goal:** Implement message edit for P2P chats. Users can edit their own sent text messages; receivers see the bubble update with an "edited" marker.

## Protocol

Edit = a new NIP-17 gift-wrapped rumor (kind 14) carrying a marker tag pointing at the original event:

```json
{
  "kind": 14,
  "pubkey": "<sender_pubkey>",
  "created_at": <unix_seconds>,
  "content": "<new message text>",
  "tags": [
    ["p", "<recipient_pubkey>"],
    ["e", "<original_event_id>", "", "edit"]
  ]
}
```

The marker is `["e", <id>, "", "edit"]` — relay-recommendation slot is empty, marker slot is the literal string `"edit"`. This is custom (non-NIP-standard) but interoperable with future Nostr-DM clients that adopt the same convention.

The wrapped seal/giftwrap envelope is identical to a normal message.

**Why a new rumor instead of mutating in place:** Nostr events are immutable. The only way to express "this is an edit" is to publish a new event whose tag references the original.

## Behavior

- **Send:** sender publishes the edit rumor to peer + self (multi-device echo).
- **Receive:** receiver detects the edit tag, locates the original message by `eventId` in `message-store`, updates its `content` (and an `editedAt` field) **without** changing `mid` or original `timestamp`. Bubble re-renders with new text + "edited" marker.
- **Self-echo:** sender's other devices treat the edit identically to a foreign edit — find original by eventId, update. Same-device echo is a no-op (content already matches).
- **Edit of edit:** allowed. Each edit references the *original* eventId, not the previous edit. Last edit wins (highest `created_at` of all edits seen for that original).
- **Delete after edit:** delete operates on original eventId; edit history is gone.
- **Edit by non-author:** ignored. Receiver must verify the edit rumor's `pubkey` equals the original message's `senderPubkey`.

## Out of scope (this slice)

- Editing media captions (only text body for now — same as the existing P2P send focuses on text first)
- Edit history UI (Telegram shows previous versions; we won't)
- Edit time limit (Telegram's 48h window)
- Group chat edits (P2P 1:1 only)

## Files touched

| File | Change |
|---|---|
| `src/lib/rootScope.ts` | Add `nostra_message_edit` event signature |
| `src/lib/nostra/chat-api.ts` | Add `ChatAPI.editMessage(peerPubkey, originalEventId, newText)` |
| `src/lib/nostra/chat-api-receive.ts` | Add `isEditMessage()` pure fn + edit-handling branch in `handleRelayMessage` |
| `src/lib/nostra/message-store.ts` | Add `editedAt?: number` field; rely on existing upsert in `saveMessage` |
| `src/lib/nostra/nostra-sync.ts` | Add `onIncomingEdit()` |
| `src/lib/nostra/nostra-message-handler.ts` | Add `handleIncomingEdit()` that updates mirrors and dispatches tweb `message_edit` |
| `src/lib/nostra/nostra-onboarding-integration.ts` | Wire `nostra_message_edit` listener |
| `src/lib/nostra/virtual-mtproto-server.ts` | Add `messages.editMessage` handler returning `{nostraMid, nostraEventId}` |
| `src/lib/appManagers/apiManager.ts` | Add `messages.editMessage` to `NOSTRA_BRIDGE_METHODS` |
| `src/lib/appManagers/appMessagesManager.ts` | P2P shortcut in `editMessage` (mirror of send shortcut at ~line 1412) |
| `src/tests/nostra/edit-message.test.ts` | Unit tests: isEditMessage detection, store upsert preserves mid, sync updates content |
| `src/tests/e2e/e2e-p2p-edit.ts` | Bidirectional E2E: A sends → B sees → A edits → B sees edit + "edited" marker |

## Slices

1. **Slice 1 — Protocol primitives + send side**
   - `nostra_message_edit` event in `rootScope.ts`
   - `isEditMessage()` pure fn in `chat-api-receive.ts` (with author verification)
   - `ChatAPI.editMessage()` in `chat-api.ts` (build rumor, publish)
   - `editedAt?: number` field in `message-store.ts` schema
   - Unit test: `isEditMessage()` parsing (positive + negative cases)
   - **Commit:** `feat(p2p): edit-message protocol + ChatAPI.editMessage`

2. **Slice 2 — Receive side**
   - In `chat-api-receive.ts` `handleRelayMessage`, after delete check: detect edit, look up original by eventId, validate author matches, update store via `saveMessage` upsert, fire callback with edit-flag
   - `NostraSync.onIncomingEdit()` dispatching `nostra_message_edit`
   - `nostra-message-handler.handleIncomingEdit()` updating mirrors + dispatching tweb `message_edit`
   - Unit test: end-to-end receive of edit updates store + dispatches event
   - **Commit:** `feat(p2p): receive-side edit handling`

3. **Slice 3 — Wire send through tweb stack**
   - `messages.editMessage` in `NOSTRA_BRIDGE_METHODS`
   - VMT server `editMessage` handler returning `{nostraMid, nostraEventId}` and updating local store + mirrors + dispatching local `message_edit`
   - `appMessagesManager.editMessage` P2P shortcut
   - Verify bubble re-renders on `message_edit`
   - **Commit:** `feat(p2p): wire editMessage through Virtual MTProto`

4. **Slice 4 — E2E test + docs**
   - `e2e-p2p-edit.ts` bidirectional test
   - Update `docs/FEATURES.md` (already says ✅, add note that P2P now supported)
   - Update `CLAUDE.md` Nostra section with edit-pipeline gotchas
   - **Commit:** `test(e2e): bidirectional p2p edit-message regression`

## Author verification

`isEditMessage()` returns `{originalEventId, newContent}` only. The receive handler must:
1. Look up original in `message-store` by `originalEventId`
2. If `original.senderPubkey !== rumor.pubkey` → log + drop (edit by non-author)
3. If original not found → drop (we never saw the original; nothing to update)
4. Else → upsert with new content + `editedAt = rumor.created_at`

## "Edited" marker UI

tweb's `bubbles.ts` already renders an "edited" marker when `message.edit_date` is set. We must populate `edit_date` on the tweb `Message` object during the receive update path. The mapper's `createTwebMessage()` reads `editedAt` from the stored message and sets `edit_date` accordingly.

## Risks (from research)

| # | Risk | Mitigation |
|---|---|---|
| 1 | Store race: receive saves before sync, sync's upsert wins but loses fields | Edit path skips receive-layer save; only sync writes |
| 2 | Tag tuple shape fragility | `isEditMessage()` validates tag length, marker string, eventId hex |
| 3 | Bubble dedup by `fullMid` | Edit reuses original mid, only updates content |
| 4 | `message_edit` event wrong storageKey | Dispatch from both VMT server (sender) and message-handler (receiver) — same dispatch path as `nostra_new_message` uses |
| 5 | Cross-device echo loops | Edit upsert is content-stable: `if(stored.content === newContent && stored.editedAt === rumor.created_at) return` |
| 6 | Timestamp re-sort | Original `timestamp`/`mid` preserved; only `content` and `editedAt` change |
| 7 | Edit by non-author | Pubkey check in receive handler |
