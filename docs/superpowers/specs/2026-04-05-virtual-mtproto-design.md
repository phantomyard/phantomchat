# Virtual MTProto Layer — Design Spec

## Summary

Replace Nostra.chat's push-based P2P injection layer with a pull-based "Virtual MTProto Server" that writes directly into tweb's own IndexedDB. This eliminates 15+ workarounds, ~2400 lines of hack code, and structurally fixes reload/duplicate/timestamp bugs.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Full stack (1:1, groups, media, presence, search) | Clean break, no hybrid code |
| Migration strategy | Big bang on dedicated branch | Too many tentacles for incremental migration |
| Persistence | Write into tweb's own IDB | Single database, zero duplication, native compatibility |
| Existing bugs | Cherry-pick CSS/UI fixes, structural bugs resolved by refactoring | 6 UI fixes already written, 4 structural bugs disappear with new architecture |
| Existing data | Fresh start, no migration | Pre-alpha (v0.0.1), messages on relays, backfill re-downloads |
| Upstream tweb | Work on our fork, no pull from upstream | UI customizations to keep, hacks are additive and will be removed |

## Problem Statement

tweb is designed as a **pull** architecture: the UI asks for data via MTProto calls (`getHistory`, `getDialogs`, `getMessage`), and the server responds. Nostra.chat currently fights this by **pushing** data into the UI through injection:

- `injectP2PMessage` pushes messages into a separate cache
- `dispatchHistoryAppend` pushes events to trigger rendering
- `dialogs_multiupdate` pushes dialog updates
- `reDispatchDialogsWhenReady()` retries at 2s/5s/10s for race conditions

This causes: messages disappearing on reload, duplicate messages, timestamp 1970, context menu failures on sent messages, and 15+ workarounds in core tweb files.

## Architecture

### Before (current)

```
Nostr Relays
    |
ChatAPI
    |
message-store.ts (IndexedDB #2)
    |
nostra-display-bridge.ts (1475 lines of push/inject/dispatch)
    |
p2pMessageCache + mirrors.messages (dual cache)
    |
bubbles.ts (~100 lines of P2P guards)
    |
UI
```

### After (Virtual MTProto)

```
Nostr Relays
    |
ChatAPI (unchanged)
    |
NostraMTProtoServer (single integration point)
    |
tweb IndexedDB (single database)
    |
tweb core (unchanged — Worker, mirrors, bubbles, dialogs)
    |
UI
```

## New Components

### 1. NostraMTProtoServer

**File:** `src/lib/nostra/virtual-mtproto-server.ts`
**Size estimate:** ~500 lines
**Purpose:** Intercepts MTProto calls from `apiManager.ts` and returns proper responses by reading/writing tweb's IndexedDB.

**Methods to implement:**

| MTProto Method | Behavior |
|---------------|----------|
| `messages.getDialogs` | Read dialogs from tweb IDB, return sorted by date |
| `messages.getHistory` | Read messages for peerId from tweb IDB, return paginated |
| `messages.sendMessage` | Write to tweb IDB + call ChatAPI.sendText() + dispatch events |
| `messages.sendMedia` | Write to tweb IDB + upload to Blossom + call ChatAPI.sendFileMessage() |
| `messages.readHistory` | Mark messages as read in IDB + send NIP read receipt |
| `messages.deleteMessages` | Remove from IDB + send NIP-09 kind 5 |
| `messages.search` | Full-text search in tweb IDB messages |
| `users.getFullUser` | Return User object from IDB (populated by kind 0 profile) |
| `contacts.getContacts` | Return all P2P contacts from IDB |
| `updates.getState` | Return current state (seq, date, pts) |
| `updates.getDifference` | Return new messages since last sync |

**Interface:**

```typescript
class NostraMTProtoServer {
  constructor(chatAPI: ChatAPI, peerMapper: NostraPeerMapper);

  // Called by apiManager.nostraIntercept()
  async handleMethod(method: string, params: any): Promise<any>;

  // Called by NostraSync when new data arrives
  async onIncomingMessage(msg: ChatMessage, senderPubkey: string): Promise<void>;
  async onProfileUpdate(pubkey: string, profile: Kind0Profile): Promise<void>;
  async onPresenceUpdate(pubkey: string, status: PresenceStatus): Promise<void>;
}
```

### 2. NostraSync

**File:** `src/lib/nostra/nostra-sync.ts`
**Size estimate:** ~400 lines
**Purpose:** Background sync process that listens to ChatAPI events and writes into tweb's IDB. Handles backfill on first connection.

**Responsibilities:**

- Listen to `ChatAPI.onMessage` for incoming messages
- Convert `ChatMessage` to tweb `Message.message` format
- Write Message, Dialog, User objects into tweb IDB
- Dispatch standard tweb rootScope events (`new_message`, `dialog_update`, etc.)
- On first connect: backfill message history from relays
- Subscribe to kind 0 (profiles) and kind 30315 (presence)
- Update User objects when profiles change

**Key difference from display bridge:** NostraSync writes to the database and dispatches standard tweb events. It does NOT inject into caches, does NOT retry, does NOT guard against race conditions — because tweb handles all of that natively when data is in its own database.

### 3. NostraPeerMapper

**File:** `src/lib/nostra/nostra-peer-mapper.ts`
**Size estimate:** ~200 lines
**Purpose:** Evolution of `nostra-bridge.ts`. Maps Nostr identities to tweb objects.

**Responsibilities:**

- `pubkeyToPeerId(pubkey)` — deterministic SHA-256 mapping (reuse existing algorithm)
- `eventIdToMid(eventId)` — deterministic message ID mapping (reuse existing)
- `createTwebUser(pubkey, peerId, profile?)` — creates a `User.user` object in tweb format
- `createTwebChat(groupId, peerId, members)` — creates a `Chat.chat` object for groups
- `createTwebDialog(peerId, topMessage?)` — creates a `Dialog.dialog` object
- `createTwebMessage(msg, peerId, mid, isOutgoing)` — converts `ChatMessage` to `Message.message`
- `reverseLookup(peerId)` — peerId back to pubkey (via `virtual-peers-db.ts`, reused)

## Components Reused Without Changes

| Component | File | Why unchanged |
|-----------|------|---------------|
| ChatAPI | `chat-api.ts` (952 lines) | Relay communication, NIP-17 gift-wrap — solid |
| NostrRelayPool | `nostr-relay-pool.ts` | WebSocket management — solid |
| NostrRelay | `nostr-relay.ts` | Per-relay connection — solid |
| OfflineQueue | `offline-queue.ts` | Message queuing — solid |
| PrivacyTransport | `privacy-transport.ts` | Tor routing — solid |
| virtual-peers-db | `virtual-peers-db.ts` | Reverse lookup peerId → pubkey — solid |
| NostraPresence | `nostra-presence.ts` | Kind 30315 heartbeats — solid |
| Group store | `group-store.ts` | Group metadata IndexedDB — solid |

## Components Eliminated

| Component | File | Lines | Why |
|-----------|------|-------|-----|
| Display bridge | `nostra-display-bridge.ts` | 1475 | Entire push/inject/dispatch layer replaced by NostraSync |
| Send bridge | `nostra-send-bridge.ts` | 454 | Routing replaced by NostraMTProtoServer.sendMessage() |
| Message store | `message-store.ts` | 286 | Duplicate database eliminated — tweb IDB is the single store |
| P2P cache | `apiManagerProxy.ts` changes | ~40 | p2pMessageCache, injectP2PMessage removed |
| Bubbles hacks | `bubbles.ts` changes | ~100 | P2P guards, Worker bypass, direct cache access removed |
| Dialog guards | `dialogsStorage.ts` changes | ~20 | dropDialog guard for >= 1e15 removed |
| Context menu hacks | `contextMenu.ts` changes | ~50 | P2P delete logic removed (standard delete works) |
| Search intercept | `appSearch.ts` changes | ~30 | P2P search removed (standard search works on IDB) |

**Total: ~2455 lines removed, ~1100 lines added. Net reduction: ~1355 lines.**

## tweb Core Files — Changes

### Files restored to vanilla (hacks removed)

- `src/components/chat/bubbles.ts` — remove ~100 lines of P2P guards
- `src/lib/storages/dialogs.ts` — remove `dropDialog` guard, `registerP2PDialog`, `dropP2PDialog`
- `src/lib/apiManagerProxy.ts` — remove `p2pMessageCache`, `injectP2PMessage`
- `src/components/chat/contextMenu.ts` — remove P2P delete special-casing
- `src/components/appSearch.ts` — remove P2P search intercept

### Files modified (minimal changes)

- `src/lib/appManagers/apiManager.ts` — `nostraIntercept()` becomes a thin router to `NostraMTProtoServer.handleMethod()`

### Files kept with UI customizations (no change in refactoring)

- `src/components/sidebarLeft/index.ts` — hamburger menu (Status, Identity, branding)
- `src/components/sidebarLeft/tabs/settings.ts` — Nostr Relays row
- `src/components/sidebarLeft/tabs/nostraStatus.ts` — Status page
- `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` — Relay settings
- `src/components/avatarNew.tsx` — Dicebear SVG avatars
- `src/pages/pagesManager.ts` — Nostra onboarding redirect
- `src/pages/nostra-onboarding-integration.ts` — Onboarding flow
- `src/components/nostra/SearchBarStatusIcons.tsx` — Tor/Nostr icons
- `src/scss/style.scss`, `src/scss/partials/pages/_chats.scss` — Full width layout

## Data Flows

### Receiving a message

```
1. Relay delivers NIP-17 gift-wrap event
2. ChatAPI decrypts → ChatMessage
3. ChatAPI.onMessage callback → NostraSync.onIncomingMessage()
4. NostraSync:
   a. peerMapper.createTwebMessage(msg) → Message.message
   b. peerMapper.createTwebUser(senderPubkey) → User.user (if new)
   c. Write Message to tweb IDB messages table
   d. Write/update Dialog in tweb IDB dialogs table
   e. Write/update User in tweb IDB users table
   f. rootScope.dispatchEvent('new_message', {message})
5. tweb reacts natively:
   - Chat list updates (dialog has new top_message)
   - If chat is open, bubble renders
   - Notification fires
```

### Sending a message

```
1. User types text → tweb calls invokeApi('messages.sendMessage', params)
2. apiManager.nostraIntercept() → server.handleMethod('messages.sendMessage', params)
3. NostraMTProtoServer.sendMessage():
   a. Create Message.message with pFlags.is_outgoing = true
   b. Write to tweb IDB
   c. Dispatch 'new_message' → bubble appears with clock icon
   d. await ChatAPI.sendText(content)
   e. On success: update Message (remove is_outgoing), dispatch 'message_sent'
   f. tweb transitions bubble: clock → checkmark
4. On failure: set message.error, dispatch 'message_edit' → bubble shows error
```

### Page reload

```
1. tweb boots, calls invokeApi('messages.getDialogs')
2. NostraMTProtoServer.getDialogs():
   a. Read all P2P dialogs from tweb IDB
   b. Return {dialogs, messages, users, chats} in MTProto format
3. tweb renders chat list natively
4. User opens a chat → tweb calls invokeApi('messages.getHistory', {peer, limit})
5. NostraMTProtoServer.getHistory():
   a. Read messages for peerId from tweb IDB, paginated
   b. Return {messages, users, chats} in MTProto format
6. tweb renders bubbles natively — correct timestamps, no duplicates, correct order
```

### Adding a contact

```
1. User enters npub in Add Contact dialog
2. NostraMTProtoServer:
   a. Decode npub → hex pubkey
   b. peerMapper.pubkeyToPeerId(pubkey) → peerId
   c. Fetch kind 0 profile from relays
   d. peerMapper.createTwebUser(pubkey, peerId, profile) → User.user
   e. Write User to tweb IDB
   f. Create empty Dialog, write to tweb IDB
   g. Return success → UI shows new contact in chat list
```

## Critical Finding: tweb Storage Architecture

Reverse engineering revealed that tweb does NOT persist messages to IDB. The actual architecture:

- **Messages**: In-memory `MessagesStorage` Maps only. Mirrored from Worker to main thread via `MTProtoMessagePort`. Lost on page reload — re-fetched from server via `messages.getHistory`.
- **Dialogs**: Persisted to IDB via `AppStorage.set()`. Keyed by `PeerId`.
- **Users**: Persisted to IDB via `AppStorage.set()`. Keyed by `UserId`.
- **Chats**: Persisted to IDB via `AppStorage.set()`. Keyed by `ChatId`.

This means the Virtual MTProto Server does NOT write messages to tweb's IDB. Instead:
1. It returns properly formatted MTProto responses from `nostraIntercept()`
2. tweb's own `saveApiResult()` → `saveMessages()` handles in-memory storage + mirroring
3. On reload, tweb calls `messages.getHistory` again → our server reads from `message-store.ts` (our own IDB) and returns the response

**Key implication:** We keep `message-store.ts` as the persistent backing store for messages. We do NOT eliminate it — it's the source of truth for reload. But dialogs and users are written to tweb's own IDB via the standard `saveApiPeers` path.

### Updated Architecture

```
Nostr Relays
    |
ChatAPI (unchanged)
    |
NostraMTProtoServer
    |
    ├── Returns MTProto responses → tweb saveApiResult() handles storage natively
    ├── Persists messages to message-store.ts IDB (for reload)
    └── tweb persists dialogs/users to its own IDB (natively)
```

## Testing Strategy

### Unit tests
- NostraPeerMapper: deterministic mapping (reuse existing tests in `src/tests/nostra/`)
- NostraMTProtoServer: mock IDB, verify correct MTProto response shapes
- NostraSync: mock ChatAPI, verify correct IDB writes

### E2E tests (Playwright)
- All existing E2E tests in `src/tests/e2e-*.ts` should pass unchanged — the UI behavior is the same, only the internal data path changes
- Specific regression tests for bugs 4.4-4.7: send message, reload, verify no duplicates and correct timestamps

### Smoke test
- Create identity → add contact → send message → receive message → reload → verify everything persists

## Bugs Resolved by This Refactoring

| Bug | Current cause | How Virtual MTProto fixes it |
|-----|--------------|------------------------------|
| 4.4 Timestamp 1970 | message-store saves with timestamp 0 on race | Single write to tweb IDB with correct timestamp |
| 4.5 Messages missing after reload (User A) | p2pMessageCache is in-memory, lost on reload | Messages in tweb IDB, loaded by getHistory natively |
| 4.6 Messages missing after reload (User B) | Same as 4.5 | Same as 4.5 |
| 4.7 Duplicate after reload | Dual save (ChatAPI + send bridge) creates two records | Single write path, no dual save |
| 6.16 Context menu on sent messages | message not found via getMessageByPeer after outgoing→sent transition | Standard message_sent event, message always in IDB |

## Phases

### Phase 0: Preparation
- Commit cherry-picked CSS/UI fixes (12.1, 11.1, 1.9, 7.6, 10.12, 10.13)
- Create branch `virtual-mtproto`
- Document tweb IDB schema (`docs/tweb-idb-schema.md`)

### Phase 1: Core — NostraPeerMapper + NostraMTProtoServer (read path)
- Implement NostraPeerMapper (createTwebMessage, createTwebUser, createTwebDialog)
- Implement NostraMTProtoServer: getDialogs, getHistory, getFullUser
- Wire into apiManager.nostraIntercept()
- Remove p2pMessageCache from apiManagerProxy
- Remove P2P guards from bubbles.ts, dialogsStorage.ts

### Phase 2: Write path — sending + receiving
- Implement NostraSync (onIncomingMessage, profile updates, presence)
- Implement NostraMTProtoServer: sendMessage, sendMedia
- Wire ChatAPI.onMessage → NostraSync
- Delete nostra-display-bridge.ts
- Delete nostra-send-bridge.ts

### Phase 3: Groups + Media + Search
- Implement group message handling (Chat objects in IDB)
- Implement Blossom media upload/download through sendMedia
- Implement messages.search reading from tweb IDB
- Delete message-store.ts

### Phase 4: Cleanup + Testing
- Remove all remaining P2P hacks from core files
- Delete dead code and unused imports
- Run full E2E test suite
- Verify all CHECKLIST.md items pass

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| tweb IDB schema is complex | Document schema first (Phase 0), validate with unit tests |
| Worker/main thread boundary | `apiManager` runs in Worker context, but ChatAPI and relay pool run on main thread. NostraMTProtoServer intercepts in Worker (where `nostraIntercept` already runs). NostraSync runs on main thread (where ChatAPI lives) and writes to IDB directly (IDB is accessible from both contexts). The Worker reads IDB natively when `getHistory`/`getDialogs` are called. No MessagePort bridge needed — IDB is the shared state. |
| Race conditions on send | Single write path eliminates dual-save races. Use IDB transactions for atomicity |
| Backfill performance | Limit to last 100 messages per conversation on first sync. Paginate older history on scroll |
