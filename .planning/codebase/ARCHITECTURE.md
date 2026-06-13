# Architecture

**Analysis Date:** 2026-03-31

## Pattern Overview

**Overall:** Domain-Driven Manager Architecture with Event-Driven Reactive UI

Nostra.chat extends a mature Nostra.chat client (tweb) with a decentralized P2P messaging layer built on Nostr and DHT. The architecture uses domain managers for API and state management, Solid.js for reactive UI, and a hybrid approach mixing Telegram's centralized API with peer-to-peer routing via the Nostra.chat protocol.

**Key Characteristics:**
- 55+ specialized AppManager subclasses handling distinct domains (chats, messages, users, reactions, etc.)
- Event-driven state propagation via global `rootScope` event bus
- Layered separation: UI (components/pages) → UI Logic (managers) → API/Transport Layer (MTProto + Nostra.chat)
- Solid.js reactive stores for fine-grained reactivity, minimal re-renders
- Multi-account support with account-scoped manager proxies
- Worker-based background processing (MTProto crypto, file downloads, media encoding)
- Hybrid P2P: Nostr relay connections + DHT-based peer discovery + direct WebRTC tunnels

## Layers

**UI Layer (Components & Pages):**
- Purpose: Render Solid.js components, handle user interactions, display messages/chats
- Location: `src/components/` (28 subdirectories), `src/pages/`
- Contains: .tsx components, .module.scss styles, dialog/popup handlers, media viewers
- Depends on: AppManagers (via rootScope), Solid.js stores, helpers
- Used by: Browser DOM

**Application Logic Layer (AppManagers):**
- Purpose: Encapsulate domain-specific business logic (chats, messages, users, reactions, etc.)
- Location: `src/lib/appManagers/` (38+ manager classes)
- Contains: AppManager subclasses, utility functions for domain operations
- Depends on: API layers, Storage layers, rootScope events, MTProto types
- Used by: UI components, other managers (via constructor injection), rootScope listeners

**API & Transport Layer:**
- Purpose: Communicate with Telegram MTProto servers and Nostra.chat P2P network
- Location: `src/lib/appManagers/apiManager.ts`, `src/lib/mtproto/`, `src/lib/nostra/`
- Contains: MTProto RPC calls, Nostr relay client, P2P peer negotiation, WebRTC transport
- Depends on: Crypto workers, network socket, IndexedDB for persistence
- Used by: AppManagers, rootScope

**Storage Layer:**
- Purpose: Persist and query application state via IndexedDB and localStorage
- Location: `src/lib/storages/` (dialogs, filters, peers, messages, etc.)
- Contains: Schema definitions, cached data structures (SlicedArray for message streams)
- Depends on: IndexedDB Web API, roomKey storage for encryption
- Used by: AppManagers for read/write operations

**Reactive State Layer (Stores):**
- Purpose: Provide fine-grained reactive signals for UI reactivity
- Location: `src/stores/` (13 reactive stores)
- Contains: Solid.js createSignal + rootScope listener pairs
- Depends on: rootScope events
- Used by: Components for reactive bindings

**Nostra.chat Integration Layer (New):**
- Purpose: Bridge tweb Telegram functionality with P2P messaging
- Location: `src/lib/nostra/` (15 modules), `src/pages/nostra-*.tsx`
- Contains: Identity management, virtual peer creation, Chat API abstraction, offline queue
- Depends on: AppManagers, Nostr relay client, transport layer
- Used by: AppMessagesManager for P2P message sending/receiving

**Helper/Utility Layer:**
- Purpose: Reusable utilities for DOM, strings, arrays, crypto, math, scheduling
- Location: `src/helpers/` (145+ utility functions organized in 18 subdirectories)
- Contains: Pure functions, DOM manipulators, schedulers (debounce, raf), formatters
- Depends on: Standard library only
- Used by: All layers

## Data Flow

**Message Sending (Centralized - Telegram):**

1. User types message in chat component (`src/components/chat/input.ts`)
2. Component calls `appMessagesManager.sendText(peerId, text)`
3. AppMessagesManager creates temporary message, emits `message_sent` event
4. Message rendered immediately with pending state
5. AppMessagesManager calls `apiManager.invokeApi('messages.sendMessage', {...})`
6. MTProto sends RPC over network socket to Telegram DC
7. Telegram server returns message with server-assigned ID
8. AppMessagesManager emits `message_sent` with real ID
9. Component updates message ID, clears pending state
10. Message persisted in IndexedDB via `appMessagesManager.addToHistory()`

**Message Sending (P2P - Nostra.chat):**

1. User sends to virtual peer (identified by Nostr pubkey)
2. `appMessagesManager.sendText()` detects virtual peer via `isVirtualPeer()` check (line 68 in appMessagesManager.ts)
3. Calls `sendTextViaChatAPI()` from `src/lib/nostra/nostra-send-bridge.ts`
4. ChatAPI creates message with Nostr NIP-04 encryption
5. Publishes via Nostr relay (`nostr-relay-pool.ts`)
6. Message routed to recipient's relay subscriptions
7. Recipient downloads via `nostra-display-bridge.ts` subscription listener
8. Offline queue (`offline-queue.ts`) stores message if recipient unreachable

**Message Reception & Update Propagation:**

1. `apiUpdatesManager.processUpdate()` receives update from server or relay
2. Dispatches to specialized handlers: `processUpdateNewMessage()`, `processUpdateMessageReactions()`, etc.
3. Handlers call AppManagers to update state: `appMessagesManager.addToHistory()`
4. AppManager emits event on `rootScope`: `rootScope.dispatchEvent('history_append', {...})`
5. Stores listen and update signals: `useHistoryStorage()` receives event
6. Components with `useHistoryStorage()` reactively re-render via Solid.js
7. UI shows new message, reads, reactions in real-time

**Offline Queue Processing (Nostra.chat):**

1. Application initializes with `appStateManager.getOfflineQueue()`
2. OfflineQueue loads pending messages from storage
3. For each: verify recipient online → try send → if fail, increment retry counter
4. Background task processes queue periodically (on user activity, periodic timer)
5. Successful sends removed from queue, failures kept for retry

**Account Switching:**

1. User clicks account in sidebar
2. Calls `changeAccount(accountNumber)`
3. AppManagers are re-created via `createProxiedManagersForAccount(accountNumber)`
4. State reloaded from IndexedDB with account partition key
5. rootScope events filtered by account number (multi-account aware)
6. All subscriptions automatically use new account's data

**State Synchronization on Load:**

1. `loadStateForAllAccountsOnce()` called from index.ts
2. For each account: load state partition from IndexedDB
3. AppManagers initialized with state
4. Managers call `after()` lifecycle hook to set up subscriptions
5. `apiUpdatesManager.addMultipleEventsListeners()` subscribes to Telegram updates
6. Nostr relay subscriptions established (Nostra.chat peers)
7. UI renders with cached state, then incremental updates arrive

## Key Abstractions

**AppManager (Base Class):**
- Purpose: Encapsulate a domain with state, persistence, and API methods
- Examples: `AppMessagesManager`, `AppChatsManager`, `AppUsersManager`, `AppReactionsManager`
- Pattern: Inject all dependencies in constructor → extend with domain methods → override `after()` for subscriptions
- Location: `src/lib/appManagers/manager.ts` (base), subclasses in `src/lib/appManagers/app*.ts`

**rootScope (Global Event Bus):**
- Purpose: Central event emitter for all cross-domain state changes
- Examples: `'message_sent'`, `'dialog_unread'`, `'chat_update'`, `'user_auth'`, `'premium_toggle'`
- Pattern: Emit typed event with payload → all listeners notified synchronously
- Location: `src/lib/rootScope.ts` (500+ lines of event type definitions)

**Solid.js Store (Reactive Signal):**
- Purpose: UI-driven reactivity for fine-grained updates
- Examples: `usePremium()`, `useHistoryStorage()`, `usePeerLanguage()`, `useStars()`
- Pattern: Create signal in createRoot → attach rootScope listener → export hook
- Location: `src/stores/*.ts` (11 stores)

**Dialog Storage:**
- Purpose: Efficiently store and query chat conversations with cursor-based pagination
- Examples: Dialog metadata (pinned, unread count, last message)
- Pattern: SlicedArray with offset-based pagination, filtered by folder
- Location: `src/lib/storages/dialogs.ts`

**History Storage (Message Stream):**
- Purpose: Cache message slices per conversation with lazy-loading support
- Examples: Messages in a specific chat, stored in order with gaps for lazy-loading
- Pattern: SlicedArray[mid] keyed by (peerId, threadId, fold), supports backwards/forwards pagination
- Location: Created per peerId in `appMessagesManager.createHistoryStorage()`

**Virtual Peer (Nostra.chat Abstraction):**
- Purpose: Represent a P2P contact without Telegram account
- Examples: Nostr pubkey → synthetic PeerId (negative number)
- Pattern: isVirtualPeer() check in critical paths, routed to ChatAPI instead of Telegram RPC
- Location: `src/lib/nostra/virtual-peers-db.ts`

**MTProto Layer Type (from @layer):**
- Purpose: Type-safe Telegram API contracts
- Examples: Message, Chat, User, InputPeer, MethodDeclMap
- Pattern: Auto-generated from TL schema, imported as `import {Message} from '@layer'`
- Location: `src/layer.d.ts` (664KB auto-generated file)

## Entry Points

**Browser Entry:**
- Location: `src/index.ts`
- Triggers: `<script>` tag in index.html
- Responsibilities:
  1. Load fonts, styles, polyfills
  2. Initialize environment detection (IS_MOBILE, IS_SAFARI, etc.)
  3. Load app state from IndexedDB for current account
  4. Create AppManagers and rootScope
  5. Render root Solid.js component
  6. Set up viewport listeners, keyboard handlers
  7. Initialize Nostr relay (if Nostra.chat enabled)

**Authentication Flow:**
- Location: `src/pages/pageSignIn.ts`, `src/pages/pageAuthCode.ts`, `src/pages/pageSignUp.ts`
- Triggers: User not logged in, accesses app
- Responsibilities:
  1. Display phone/email input, QR code option
  2. Call `apiManager.sendCode()` to request OTP
  3. Validate OTP and sign in
  4. Create/load account state partition
  5. Redirect to main app

**Nostra.chat Identity Loading:**
- Location: `src/lib/nostra/identity.ts`
- Triggers: Called from index.ts, app initialization
- Responsibilities:
  1. Load or create user's Nostr keypair
  2. Set up virtual identity in DB
  3. Subscribe to Nostr relays for incoming P2P messages
  4. Initialize offline queue for failed deliveries

**Deep Link Processing:**
- Location: `src/lib/internalLinkProcessor.ts`
- Triggers: URL fragment (`#/@username`, `#t123456`, etc.), `tg://` protocol handler
- Responsibilities:
  1. Parse internal link format
  2. Resolve username to peerId (call appUsersManager or appChatsManager)
  3. Open chat, show message, apply settings
  4. Supports `t.me` redirects and QR code links

## Error Handling

**Strategy:** Dual-layer error handling with user-visible notifications and silent background retries

**Patterns:**

1. **API Error Handling** (`apiManager.invokeApi()`):
   - Catch MTProto RPC errors (flood wait, auth required, etc.)
   - Log with context via logger
   - Emit error event: `rootScope.dispatchEvent('message_error', {peerId, mid, error})`
   - Component shows toast notification to user
   - Some errors auto-retry with exponential backoff

2. **Manager Method Error Propagation**:
   - AppManager methods throw or return rejected promise
   - Caller decides: crash (unrecoverable), retry (temporary), or suppress (expected)
   - Example: `appMessagesManager.getMessage(peerId, mid)` returns null if not in cache

3. **Worker Communication Errors** (MTProto crypto, file encoding):
   - Messages timeout if worker unresponsive
   - Fallback to main thread (slower but works)
   - Log performance warning

4. **Offline/Network Loss**:
   - Nostra.chat messages queued in offline-queue
   - Telegram messages cached locally, resent when online
   - UI shows draft state until confirmed

5. **Permission Errors** (chat not found, no access):
   - Catch in apiManager
   - Show error dialog, suggest action (join, ask for invite, etc.)

## Cross-Cutting Concerns

**Logging:**
- Framework: `src/lib/logger.ts` with LogTypes enum (error, warn, debug, etc.)
- Pattern: `logger(LogTypes.Error, 'context', message, ...args)`
- Stored: Memory + sent to server if DEBUG enabled
- Used by: Critical manager operations, crypto, network events

**Validation:**
- Pattern: Inline validation in AppManager methods before API call
  - Example: `splitStringByLength(text, TEXT_MESSAGE_MAX_LENGTH)` in appMessagesManager
  - Example: `assumeType()` for type narrowing on polymorphic types
- Errors: Throw or return validation failure, caught by caller

**Authentication:**
- Pattern: Check `rootScope.myId` (current user ID) in every manager
- Unauthenticated: User ID is 0, most operations blocked
- Premium: Check `rootScope.premium` for feature gates
- Multi-account: Managers scoped to `activeAccountNumber`

**Encryption (Nostra.chat):**
- Chat encryption: NIP-04 (Nostr private message standard)
- Storage encryption: User's room key in IndexedDB (passcode protected)
- Transport: WebRTC encrypted channel between peers

**Rate Limiting:**
- Telegram enforces server-side flood wait (returned in error)
- AppManager respects error, doesn't retry immediately
- User sees "Too many requests, try again later" dialog
- Offline queue respects limits before re-queuing

**Caching:**
- Messages: SlicedArray per history, cache size limited by storage quota
- Peers (users/chats): `peersStorage` maps peerId → user/chat object
- Avatars: `appAvatarsManager` caches URLs, auto-refresh on update event
- Stickers: `appStickersManager` caches pack metadata and images

**Performance Optimization:**
- Lazy-loading: History loaded as user scrolls (slice-based pagination)
- Virtual scrolling: Components render only visible messages
- RAF scheduling: DOM updates batched with `fastRaf` or `doubleRaf`
- Worker offloading: Crypto and media encoding run in Web Workers
- Middleware pattern: Debounce frequent events (typing, scroll, resize)
