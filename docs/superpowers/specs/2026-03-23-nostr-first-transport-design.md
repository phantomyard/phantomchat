# Nostra.chat Nostr-First Transport Restructure

**Date:** 2026-03-23
**Status:** Approved
**Scope:** Transport restructure + TypeScript fixes + minimal branding

## Problem Statement

Nostra.chat currently routes chat messages through WebRTC peer-to-peer connections, exposing both users' IP addresses to each other. The Nostr relay is used only as a fallback for offline message storage. This architecture contradicts the project's core privacy goal.

Additionally, the app still presents itself as "Telegram Web" with no routing to the Nostra.chat onboarding flow, and ~10 TypeScript errors introduced by the GSD/M2.7 tool need fixing.

## Design Decisions

- **D041**: Chat messages always route through Nostr relays (IP never exposed in chat)
- **D042**: WebRTC P2P reserved exclusively for future voice/video calls (M007) with explicit IP exposure consent dialog
- **D043**: Multiple Nostr relays (3-5) used in parallel for redundancy; user-configurable with sensible defaults
- **D044**: NIP-04 encryption retained for now; NIP-44 migration deferred to a future milestone. NIP-04 interoperability with standard Nostr clients is a non-goal — Nostra.chat uses its own message format within the NIP-04 envelope.
- **D045**: Only TypeScript errors introduced by GSD/M2.7 are fixed; pre-existing tweb errors are left untouched
- **D046**: Minimal branding (text + routing only); no visual rebrand

## Architecture

### Current (being replaced for chat)

```
ChatAPI -> PrivacyTransport -> PeerTransport (WebRTC, IP exposed)
                            -> NostrRelay (single relay, fallback)
```

### Proposed

```
ChatAPI -> NostrRelayPool (primary, always)
             |-> relay 1 (wss://relay.damus.io)
             |-> relay 2 (wss://nos.lol)
             |-> relay 3 (wss://relay.snort.social)
             publish to all, subscribe from all, deduplicate by event ID

OfflineQueue -> IndexedDB (when all relays are down)
             -> auto-flush on any relay reconnect

WebRTC stack (PeerTransport, peer.ts, peerNegotiation.ts, signaling.ts)
  -> remains in codebase, dormant
  -> activated only for M007 (voice/video calls with consent)
```

### Data Flow: Sending a Message

1. User types message in ChatAPI
2. ChatAPI calls `relayPool.publish(recipientPubkey, plaintext)` — encryption is handled inside the pool
3. NostrRelayPool publishes NIP-04 encrypted event to all connected write-enabled relays in parallel
4. If no relay is connected (`relayPool.isConnected() === false`), message is queued in OfflineQueue (IndexedDB)
5. On any relay reconnect (pool `onStateChange` fires with `connectedCount >= 1`), OfflineQueue flushes automatically

### Data Flow: Receiving a Message

1. NostrRelayPool maintains subscriptions on all connected read-enabled relays
2. Each relay delivers kind-4 events matching our pubkey filter
3. NostrRelayPool deduplicates by Nostr event ID (LRU cache, max 10,000 entries)
4. Deduplicated events are decrypted via NIP-04
5. Decrypted messages delivered to ChatAPI via onMessage callback

### Data Flow: History Backfill

1. On `initialize()`, NostrRelayPool sends a REQ with `since: lastSeenTimestamp` to all read-enabled relays
2. Each relay responds with stored events, ending with EOSE (End of Stored Events)
3. Events are deduplicated and decrypted as normal
4. `lastSeenTimestamp` is persisted in IndexedDB to avoid re-fetching on reconnect

## Component Specifications

### 1. NostrRelayPool (NEW)

**File:** `src/lib/nostra/nostr-relay-pool.ts`

**Purpose:** Manages connections to multiple Nostr relays simultaneously. Publishes events to all connected relays. Subscribes to events from all relays with automatic deduplication.

**Interface:**

```typescript
interface RelayConfig {
  url: string;
  read: boolean;   // subscribe from this relay
  write: boolean;  // publish to this relay
}

interface PublishResult {
  successes: string[];                        // event IDs from relays that accepted
  failures: {url: string; error: string}[];   // relays that failed
}

interface RelayPoolOptions {
  relays?: RelayConfig[];                     // if omitted, loads from IndexedDB or uses defaults
  onMessage: (msg: DecryptedMessage) => void;
  onStateChange?: (connectedCount: number, totalCount: number) => void;
}

class NostrRelayPool {
  constructor(options: RelayPoolOptions);

  // Lifecycle
  async initialize(): Promise<void>;  // loads identity, loads relay config from IndexedDB (or defaults), connects to all relays
  disconnect(): void;

  // Messaging
  async publish(recipientPubkey: string, plaintext: string): Promise<PublishResult>;
  subscribeMessages(): void;
  unsubscribeMessages(): void;

  // Relay management (persists to IndexedDB automatically)
  addRelay(config: RelayConfig): void;
  removeRelay(url: string): void;
  getRelays(): RelayConfig[];
  getConnectedCount(): number;

  // State
  getPublicKey(): string;
  isConnected(): boolean;  // true if at least 1 relay is connected
}
```

**Behavior:**
- Each relay gets its own WebSocket connection (reuses existing `NostrRelay` logic internally).
- Publishing: fire-and-forget to all write-enabled relays. Returns `PublishResult` with successes/failures. Considered successful if at least 1 relay accepts.
- Subscribing: subscribe on all read-enabled relays. Dedup via LRU cache of last 10,000 event IDs to prevent unbounded memory growth.
- Per-relay reconnection: exponential backoff (1s, 2s, 4s), max 3 attempts per relay.
- Pool-level recovery: every 60 seconds, retry all failed relays. This ensures temporary network outages don't permanently kill the pool.
- If a relay reconnects after failure, re-subscribe automatically.
- History backfill: on `initialize()` and on relay reconnect, send REQ with `since` filter and handle EOSE properly (the existing `NostrRelay.getMessages()` stub is replaced with real REQ/EOSE handling in the pool).

**Relay config persistence:**
- `NostrRelayPool.initialize()` loads config from IndexedDB key `nostra-relay-config`.
- If no config found, uses `DEFAULT_RELAYS`.
- `addRelay()`/`removeRelay()` persist changes to IndexedDB immediately.
- The Relay Settings UI reads/writes through the pool's public methods, not directly to IndexedDB.

**Default relays:**
```typescript
const DEFAULT_RELAYS: RelayConfig[] = [
  {url: 'wss://relay.damus.io', read: true, write: true},
  {url: 'wss://nos.lol', read: true, write: true},
  {url: 'wss://relay.snort.social', read: true, write: true}
];
```

### 2. ChatAPI (MODIFIED)

**File:** `src/lib/nostra/chat-api.ts`

**Revised constructor:**
```typescript
// Production constructor
constructor(ownId: string);
// Test constructor with DI
constructor(ownId: string, relayPool: NostrRelayPool, offlineQueue: OfflineQueue);

constructor(ownId: string, relayPool?: any, offlineQueue?: any) {
  this.ownId = ownId;
  if(relayPool && offlineQueue) {
    this.relayPool = relayPool;
    this.offlineQueue = offlineQueue;
  } else {
    this.relayPool = new NostrRelayPool({
      onMessage: (msg) => this.handleRelayMessage(msg),
      onStateChange: (connected) => this.handlePoolStateChange(connected)
    });
    this.offlineQueue = new OfflineQueue(this.relayPool);
  }
}
```

**Revised sendMessage() flow:**
```typescript
private async sendMessage(type: ChatMessageType, content: string): Promise<string> {
  const message = this.createMessage(type, content);
  this.history.push(message);

  if(this.relayPool.isConnected()) {
    // Always publish via relay pool — never via WebRTC
    const result = await this.relayPool.publish(peerPubkey, JSON.stringify({...}));
    if(result.successes.length > 0) {
      this.updateMessageStatus(message.id, 'sent');
    } else {
      await this.queueMessage(message.id, content);
    }
  } else {
    // No relays connected — queue for later
    await this.queueMessage(message.id, content);
  }
  return message.id;
}
```

**Removed imports:** `PeerTransport`, `PrivacyTransport`, `TransportState`, `TransportMessage`.

**State model simplified:** `ChatState` is now derived from `relayPool.isConnected()`:
- `connected` = at least 1 relay is up
- `disconnected` = no relays connected
- `connecting` removed (pool handles this internally)

### 3. OfflineQueue (MODIFIED)

**File:** `src/lib/nostra/offline-queue.ts`

**Changes:**
- New constructor: `constructor(relayPool: NostrRelayPool)`
- Old constructor `(PeerTransport, NostrRelay)` replaced entirely. `PrivacyTransport` is moved to the "modified" list (see below).
- `flush()` publishes via `relayPool.publish()` instead of transport
- Trigger: flush on `relayPool.onStateChange` when `connectedCount` goes from 0 to >= 1

### 4. PrivacyTransport (MODIFIED — no longer "untouched")

**File:** `src/lib/nostra/privacy-transport.ts`

**Changes:**
- Remove the `OfflineQueue` construction at line 91 (`new OfflineQueue(this.peerTransport, this.nostrRelay)`)
- Remove `offlineQueue` field and all references to it
- `PrivacyTransport` retains its WebRTC + Tor wrapping for future M007 use, but no longer owns an OfflineQueue
- This is a minimal change to avoid a compile error from the OfflineQueue constructor change

### 5. Relay Settings UI (NEW)

**File:** `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`

**Purpose:** Minimal UI for managing relay list.

**Features:**
- List current relays with connection status indicator (green/red dot)
- Add relay: text input for WebSocket URL + read/write toggles
- Remove relay: delete button per relay
- Reset to defaults button
- All operations go through `NostrRelayPool` methods (which persist to IndexedDB internally)

### 6. nostra-enabled.ts (DELETED)

Feature flag removed. Nostra.chat is always active.

**All files that import from `nostra-enabled.ts` must be updated:**

| File | Current usage | Change |
|------|--------------|--------|
| `src/lib/nostra/nostra-enabled.ts` | Module itself | Delete file |
| `src/pages/nostra-add-peer-dialog.tsx` | `if(!isNostraEnabled())` guard | Remove guard, code always runs |
| `src/pages/pagesManager.ts` | Routing guard | Remove guard, Nostra.chat route always active |
| `src/pages/nostra-onboarding-integration.ts` | Calls `enableNostra.chat()` | Remove call (no-op now) |
| `src/lib/apiManagerProxy.ts` | Guard on API interception | Remove guard, Nostra.chat interception always active |
| `src/lib/nostra/nostra-display-bridge.ts` | Guard on display logic | Remove guard |
| `src/lib/nostra/nostra-send-bridge.ts` | Guards on send logic | Remove guards |
| `src/lib/nostra/api-manager-stub.ts` | Guard on Nostra.chat routing + import | Remove guard AND fix broken import |
| `src/lib/appManagers/appUsersManager.ts` | Guard on P2P user lookup | Remove guard |
| `src/tests/nostra/nostra-bridge.test.ts` | Test cases using flag | Remove flag setup from tests |

## TypeScript Fixes

| # | File | Error | Fix |
|---|------|-------|-----|
| 1 | `src/stores/appState.ts` | `SetStoreFunction<State, Promise<void>>` — generic accepts only 1 arg | Remove second type arg `Promise<void>`, use `SetStoreFunction<State>` and handle async wrapper separately |
| 2 | `src/stores/appSettings.ts` | Same issue | Same fix |
| 3 | `src/helpers/object/setDeepProperty.ts` | Implicit `any` index expression | Add type assertion `as keyof typeof obj` |
| 4 | `src/lib/nostra/api-manager-stub.ts` | Implicit `any` return (x2) + broken import after flag deletion | Add explicit `: any` return type annotations; remove `isNostraEnabled` import (addressed in section 6) |
| 5 | `src/lib/nostra/webtor-fallback.ts` | `onCircuitChange` missing on `TorWasmEvents` | Add `onCircuitChange` property to `TorWasmEvents` interface |
| 6 | `src/tests/nostra/virtual-peers-db.test.ts` | `addedAt` missing in test data, private field access (x4) | Add `addedAt` field to test objects, use `as any` cast for private access in tests |

## Branding Changes

### index.html
- `<title>` -> "Nostra.chat"
- `<meta name="description">` -> "Nostra.chat is a privacy-first messaging app with end-to-end encryption and anonymous relay-based delivery."
- `og:title`, `og:description` -> Nostra.chat equivalents
- `<meta name="application-name">` -> "Nostra.chat"
- `<meta name="apple-mobile-web-app-title">` -> "Nostra.chat"
- `<meta name="mobile-web-app-title">` -> "Nostra.chat"

### public/site.webmanifest
- `name` -> "Nostra.chat"
- `short_name` -> "Nostra.chat"

### Entry Point Routing (src/index.ts)

**Flow:**
1. App starts, shows a brief loading indicator
2. Async check: `loadIdentity()` from IndexedDB
3. If identity exists → initialize `NostrRelayPool` + `ChatAPI`, render chat interface
4. If no identity → render Nostra.chat onboarding (`src/pages/nostra/onboarding.ts`)
5. After onboarding completes → reload app (identity now exists, step 3 runs)

**Edge cases:**
- IndexedDB unavailable: show error message "Nostra.chat requires local storage to work"
- Telegram login flow: code remains in codebase but is never routed to. No explicit "switch to Telegram" option.

## Files Modified Summary

### Created
- `src/lib/nostra/nostr-relay-pool.ts`
- `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`
- `src/tests/nostra/nostr-relay-pool.test.ts`

### Modified
- `src/lib/nostra/chat-api.ts` — rewritten to use NostrRelayPool
- `src/lib/nostra/offline-queue.ts` — new constructor, relay pool integration
- `src/lib/nostra/privacy-transport.ts` — remove OfflineQueue ownership
- `src/lib/nostra/api-manager-stub.ts` — TS fix + flag removal
- `src/lib/nostra/webtor-fallback.ts` — TS fix
- `src/lib/nostra/nostra-display-bridge.ts` — flag removal
- `src/lib/nostra/nostra-send-bridge.ts` — flag removal
- `src/lib/apiManagerProxy.ts` — flag removal
- `src/lib/appManagers/appUsersManager.ts` — flag removal
- `src/pages/pagesManager.ts` — flag removal + routing change
- `src/pages/nostra-add-peer-dialog.tsx` — flag removal
- `src/pages/nostra-onboarding-integration.ts` — flag removal
- `src/stores/appState.ts` — TS fix
- `src/stores/appSettings.ts` — TS fix
- `src/helpers/object/setDeepProperty.ts` — TS fix
- `src/tests/nostra/virtual-peers-db.test.ts` — TS fix
- `src/tests/nostra/chat-api.test.ts` — updated for NostrRelayPool mock
- `src/tests/nostra/offline-queue.test.ts` — updated for new constructor
- `src/tests/nostra/nostra-bridge.test.ts` — flag removal
- `index.html` — branding
- `public/site.webmanifest` — branding
- `src/index.ts` — entry point routing

### Deleted
- `src/lib/nostra/nostra-enabled.ts`

### Not Modified
- `src/lib/nostra/transport.ts` (PeerTransport)
- `src/lib/nostra/peer.ts` (PeerChannel)
- `src/lib/nostra/peerNegotiation.ts` (PerfectNegotiation)
- `src/lib/nostra/signaling.ts` (NostrSignaler)
- `src/lib/nostra/nostr-relay.ts` (used internally by pool)
- All original tweb code (components, managers, styles)

## Testing Strategy

- Existing `chat-api.test.ts` (35 tests) updated to use `NostrRelayPool` mock
- New `nostr-relay-pool.test.ts`: multi-relay publish (success/partial failure), dedup (LRU eviction), reconnection (per-relay + pool-level 60s retry), add/remove relay, REQ/EOSE backfill, config persistence
- Existing `offline-queue.test.ts` (24 tests) updated for new constructor signature
- Existing `nostr-relay.test.ts` (16 tests) unchanged (NostrRelay is used internally by pool)
- `nostra-bridge.test.ts` updated to remove feature flag references
- Relay Settings UI: basic test that add/remove relay calls pool methods correctly

## External Dependencies

No new npm dependencies. NostrRelayPool uses native WebSocket, same as existing NostrRelay.
