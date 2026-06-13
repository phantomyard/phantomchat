# Nostr-First Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Nostra.chat so chat messages always route through a pool of Nostr relays (privacy by default), fix GSD/M2.7 TypeScript errors, and apply minimal Nostra.chat branding.

**Architecture:** `ChatAPI` is rewritten to use a new `NostrRelayPool` (manages N relay WebSocket connections with parallel publish, dedup, reconnection). `OfflineQueue` is simplified to work with the pool. WebRTC stack stays dormant for future M007. Feature flag `nostra-enabled.ts` is deleted — Nostra.chat is always active.

**Tech Stack:** TypeScript, Solid.js, Nostr protocol (NIP-04), WebSocket, IndexedDB, Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-nostr-first-transport-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/lib/nostra/nostr-relay-pool.ts` | Multi-relay manager: connect N relays, publish to all, subscribe with dedup, config persistence |
| `src/tests/nostra/nostr-relay-pool.test.ts` | Unit tests for relay pool |
| `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` | Minimal UI for relay list management (add/remove/status) |

### Already Done (no change needed)
| File | Status |
|------|--------|
| `public/site.webmanifest` | Already branded "Nostra.chat" — verified, no change needed |

### Modified Files
| File | Change |
|------|--------|
| `src/lib/nostra/chat-api.ts` | Rewrite to use NostrRelayPool instead of PeerTransport/PrivacyTransport |
| `src/lib/nostra/offline-queue.ts` | New constructor taking NostrRelayPool |
| `src/lib/nostra/privacy-transport.ts` | Remove OfflineQueue ownership (line 91) |
| `src/lib/nostra/api-manager-stub.ts` | Remove feature flag import + guard (lines 11, 105), fix TS return types |
| `src/lib/nostra/webtor-fallback.ts` | Add `onCircuitChange` to TorWasmEvents interface |
| `src/lib/nostra/nostra-display-bridge.ts` | Remove feature flag guard |
| `src/lib/nostra/nostra-send-bridge.ts` | Remove feature flag guards |
| `src/lib/apiManagerProxy.ts` | Remove feature flag guard |
| `src/lib/appManagers/appUsersManager.ts` | Remove feature flag guard |
| `src/pages/pagesManager.ts` | Remove feature flag guard, Nostra.chat route always active |
| `src/pages/nostra-add-peer-dialog.tsx` | Remove feature flag guard |
| `src/pages/nostra-onboarding-integration.ts` | Remove `enableNostra.chat()` call |
| `src/stores/appState.ts` | Fix SetStoreFunction generic (line 8) |
| `src/stores/appSettings.ts` | Fix SetStoreFunction generic (line 11) |
| `src/helpers/object/setDeepProperty.ts` | Already fixed in prior change (verified: no TS error on current check). Not included in Task 1 commit. |
| `src/tests/nostra/chat-api.test.ts` | Update to mock NostrRelayPool |
| `src/tests/nostra/offline-queue.test.ts` | Update for new constructor |
| `src/tests/nostra/nostra-bridge.test.ts` | Remove feature flag references |
| `src/tests/nostra/virtual-peers-db.test.ts` | Fix addedAt + private access TS errors |
| `vite.config.ts` | Change handlebars context: title/description/url |

### Deleted Files
| File | Reason |
|------|--------|
| `src/lib/nostra/nostra-enabled.ts` | Feature flag no longer needed |

---

## Task 1: Fix TypeScript Errors

**Files:**
- Modify: `src/stores/appState.ts:8`
- Modify: `src/stores/appSettings.ts:11`
- Modify: `src/lib/nostra/api-manager-stub.ts:99,104`
- Modify: `src/lib/nostra/webtor-fallback.ts:33`
- Modify: `src/tests/nostra/virtual-peers-db.test.ts`

- [ ] **Step 1: Fix appState.ts SetStoreFunction**

In `src/stores/appState.ts`, line 8 — remove the second type argument:

```typescript
// Before:
const setAppState: SetStoreFunction<State, Promise<void>> = (...args: any[]) => {
// After:
const setAppState: SetStoreFunction<State> = (...args: any[]) => {
```

The function body stays the same (it returns `Promise<void>` from `setByKey`, but the `SetStoreFunction` type only accepts 1 generic).

- [ ] **Step 2: Fix appSettings.ts SetStoreFunction**

In `src/stores/appSettings.ts`, line 11 — same fix:

```typescript
// Before:
const setAppSettings: SetStoreFunction<StateSettings, Promise<void>> = (...args: any[]) => {
// After:
const setAppSettings: SetStoreFunction<StateSettings> = (...args: any[]) => {
```

- [ ] **Step 3: Fix api-manager-stub.ts implicit any return types**

In `src/lib/nostra/api-manager-stub.ts`, the async function at line 99 and the arrow in the invokeApi replacement need explicit return types:

```typescript
// Line 99 — add explicit return type annotation:
// Before:
(apiManager as any).invokeApi = async function<T extends InvokeApiMethod>(
    method: T,
    ...args: [MethodDeclMap[T]['req']?, InvokeApiOptions?]
  ): Promise<any> {
// This already has Promise<any> — the TS error is on lines 119 and 162 where
// the anonymous function expressions lack return types.
// Fix: ensure the outer function return type is explicit (already is).
// The actual errors are at lines 119 and 162 — add : any to catch callbacks:
```

At line 119, change:
```typescript
// Before:
const pubkey = await bridge.reverseLookup(peerId).catch(() => null);
// This is fine, but check line 119 and 162 actual error locations.
```

Actually, looking at the tsc output, the errors are at lines 119:63 and 162:63. These are the `.catch(() => null)` callbacks. Fix by adding return type:
```typescript
// Before:
.catch(() => null)
// After:
.catch((): null => null)
```

- [ ] **Step 4: Fix webtor-fallback.ts TorWasmEvents interface**

In `src/lib/nostra/webtor-fallback.ts`, line 33 — add `onCircuitChange`:

```typescript
// Before (lines 33-36):
export interface TorWasmEvents {
  onStateChange?: (state: TorState, error?: string) => void;
  onNostrEvent?: (event: NostrEvent) => void;
}

// After:
export interface TorWasmEvents {
  onStateChange?: (state: TorState, error?: string) => void;
  onNostrEvent?: (event: NostrEvent) => void;
  onCircuitChange?: (status: CircuitStatus) => void;
}
```

Note: `CircuitStatus` is defined at line 52 in the same file but AFTER the interface. Move the `CircuitStatus` interface definition above `TorWasmEvents`, or use inline type.

Since `CircuitStatus` is defined later in the file (line 52), the simplest fix is to forward-reference:

```typescript
export interface TorWasmEvents {
  onStateChange?: (state: TorState, error?: string) => void;
  onNostrEvent?: (event: NostrEvent) => void;
  onCircuitChange?: (status: {healthy: boolean; readyCircuits: number; totalCircuits: number; failedCircuits: number; creatingCircuits: number}) => void;
}
```

Or move `CircuitStatus` above `TorWasmEvents` and export it.

- [ ] **Step 5: Fix virtual-peers-db.test.ts**

Add `addedAt` field to test data objects that are missing it. For private field access, use `as any` casts.

Search for test objects like `{pubkey: ..., peerId: ..., displayName: ..., createdAt: ..., lastSeenAt: ...}` and add `addedAt: Date.now()`.

For private access errors (lines 65-66), change:
```typescript
// Before:
mockStore.records
mockStore.indexes
// After:
(mockStore as any).records
(mockStore as any).indexes
```

- [ ] **Step 6: Run tsc to verify fixes**

Run: `npx tsc --noEmit 2>&1 | grep 'src/stores\|src/lib/nostra/api-manager\|src/lib/nostra/webtor\|src/tests/nostra/virtual'`
Expected: No output (all Nostra.chat-related errors fixed). Pre-existing tweb errors may remain.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/tests/nostra/ --reporter=verbose`
Expected: All Nostra.chat tests pass (309+ pass, the 1 bridge test may still fail until Task 5).

- [ ] **Step 8: Commit**

```bash
git add src/stores/appState.ts src/stores/appSettings.ts src/lib/nostra/api-manager-stub.ts src/lib/nostra/webtor-fallback.ts src/tests/nostra/virtual-peers-db.test.ts
git commit -m "fix(ts): resolve GSD/M2.7 TypeScript errors in stores, nostra modules, and tests"
```

---

## Task 2: Create NostrRelayPool

**Files:**
- Create: `src/lib/nostra/nostr-relay-pool.ts`
- Create: `src/tests/nostra/nostr-relay-pool.test.ts`

- [ ] **Step 1: Write the test file with core test cases**

Create `src/tests/nostra/nostr-relay-pool.test.ts`:

```typescript
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// We'll test NostrRelayPool by mocking NostrRelay internally.
// For now, write the test structure. Implementation follows.

describe('NostrRelayPool', () => {
  describe('initialization', () => {
    it('loads default relays when no config in IndexedDB', async() => {
      // Arrange: mock IndexedDB to return nothing
      // Act: new NostrRelayPool({onMessage: vi.fn()})
      // Assert: pool.getRelays() returns 3 default relays
    });

    it('connects to all relays on initialize()', async() => {
      // Assert: getConnectedCount() returns number of relays
    });
  });

  describe('publish', () => {
    it('publishes to all write-enabled relays', async() => {
      // Assert: storeMessage called on each relay
    });

    it('returns successes and failures in PublishResult', async() => {
      // Arrange: one relay throws
      // Assert: result.successes.length === 2, result.failures.length === 1
    });

    it('succeeds if at least one relay accepts', async() => {
      // Arrange: 2 of 3 relays throw
      // Assert: result.successes.length === 1
    });
  });

  describe('deduplication', () => {
    it('delivers each event ID only once', async() => {
      // Arrange: same event arrives from 2 relays
      // Assert: onMessage called once
    });

    it('evicts old entries from LRU cache', async() => {
      // Arrange: fill cache to 10000, then add new event
      // Assert: oldest event ID not in cache
    });
  });

  describe('reconnection', () => {
    it('retries failed relays with exponential backoff', async() => {
      // Arrange: relay WebSocket fails on connect
      // Assert: reconnect attempts with 1s, 2s, 4s delays
    });

    it('pool-level recovery retries all failed relays every 60s', async() => {
      // Arrange: all relays fail
      // Act: advance timers by 60s
      // Assert: all relays attempted again
    });
  });

  describe('relay management', () => {
    it('addRelay connects and persists to config', async() => {});
    it('removeRelay disconnects and persists to config', async() => {});
    it('isConnected returns true when at least 1 relay is up', () => {});
    it('isConnected returns false when all relays are down', () => {});
  });

  describe('history backfill', () => {
    it('calls getMessages(since) on initialize when lastSeenTimestamp > 0', async() => {
      // Arrange: set lastSeenTimestamp in localStorage
      // Assert: getMessages called with timestamp, events delivered via onMessage
    });

    it('backfills from relay on reconnect after failure', async() => {
      // Arrange: relay fails then reconnects
      // Assert: getMessages called on reconnect
    });

    it('updates lastSeenTimestamp as messages arrive', async() => {
      // Arrange: deliver message with created_at
      // Assert: localStorage updated
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/nostra/nostr-relay-pool.test.ts --reporter=verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement NostrRelayPool**

Create `src/lib/nostra/nostr-relay-pool.ts`:

**Design notes:**
- Per-relay reconnection with exponential backoff (1s, 2s, 4s, max 3 attempts) is delegated to the existing `NostrRelay` class — the pool does NOT re-implement this logic.
- Pool-level recovery (every 60s) retries relays that exhausted their per-relay backoff.
- `NostrRelay.initialize()` loads identity internally. Since `initialize()` is called per relay AND the pool loads identity once, there is redundancy. This is acceptable — `loadIdentity()` reads from IndexedDB and is idempotent.
- History backfill: on `initialize()` and on relay reconnect, the pool calls `relay.instance.getMessages(since)` with a stored `lastSeenTimestamp`. The existing `NostrRelay.getMessages()` is a stub returning `[]` — the implementer must replace it with real REQ/EOSE handling (send `["REQ", subId, {kinds: [4], "#p": [pubkey], since: timestamp}]`, collect events until `["EOSE", subId]`).

```typescript
import {Logger, logger} from '@lib/logger';
import {NostrRelay, DecryptedMessage} from './nostr-relay';
import {loadIdentity, StoredIdentity} from './identity';

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface PublishResult {
  successes: string[];
  failures: {url: string; error: string}[];
}

export interface RelayPoolOptions {
  relays?: RelayConfig[];
  onMessage: (msg: DecryptedMessage) => void;
  onStateChange?: (connectedCount: number, totalCount: number) => void;
}

const DEFAULT_RELAYS: RelayConfig[] = [
  {url: 'wss://relay.damus.io', read: true, write: true},
  {url: 'wss://nos.lol', read: true, write: true},
  {url: 'wss://relay.snort.social', read: true, write: true}
];

const RELAY_CONFIG_DB = 'nostra-relay-config';
const RELAY_CONFIG_STORE = 'config';
const DEDUP_MAX_SIZE = 10000;
const LAST_SEEN_KEY = 'nostra-last-seen-timestamp';

export class NostrRelayPool {
  private log: Logger;
  private relays: Map<string, {config: RelayConfig; instance: NostrRelay; connected: boolean}> = new Map();
  private options: RelayPoolOptions;
  private seenEventIds: Set<string> = new Set();
  private seenEventOrder: string[] = []; // for LRU eviction
  private identity: StoredIdentity | null = null;
  private publicKey = '';
  private recoveryInterval: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimestamp = 0;

  constructor(options: RelayPoolOptions) {
    this.options = options;
    this.log = logger('NostrRelayPool');
  }

  async initialize(): Promise<void> {
    this.identity = await loadIdentity();
    if(!this.identity) throw new Error('No identity found');
    this.publicKey = this.identity.publicKey;

    // Load lastSeenTimestamp from IndexedDB for history backfill
    this.lastSeenTimestamp = await this.loadLastSeenTimestamp();

    const configs = this.options.relays ?? await this.loadConfigFromDB() ?? DEFAULT_RELAYS;

    for(const config of configs) {
      this.addRelayInternal(config);
    }

    // Connect all relays
    const connectPromises = Array.from(this.relays.values()).map(async(relay) => {
      try {
        await relay.instance.initialize();
        relay.instance.connect();
        relay.connected = true;
        // History backfill on initial connect
        if(relay.config.read) {
          await this.backfillFromRelay(relay.instance);
        }
      } catch(err) {
        this.log.warn('Failed to connect relay:', relay.config.url, err);
        relay.connected = false;
      }
    });

    await Promise.allSettled(connectPromises);
    this.notifyStateChange();

    // Start pool-level recovery every 60s
    this.recoveryInterval = setInterval(() => this.retryFailedRelays(), 60000);
  }

  disconnect(): void {
    if(this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }
    for(const relay of this.relays.values()) {
      relay.instance.disconnect();
      relay.connected = false;
    }
  }

  async publish(recipientPubkey: string, plaintext: string): Promise<PublishResult> {
    const result: PublishResult = {successes: [], failures: []};
    const writeRelays = Array.from(this.relays.values()).filter(r => r.config.write && r.connected);

    const promises = writeRelays.map(async(relay) => {
      try {
        const eventId = await relay.instance.storeMessage(recipientPubkey, plaintext);
        result.successes.push(eventId);
      } catch(err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failures.push({url: relay.config.url, error: msg});
      }
    });

    await Promise.allSettled(promises);
    return result;
  }

  subscribeMessages(): void {
    for(const relay of this.relays.values()) {
      if(relay.config.read && relay.connected) {
        relay.instance.subscribeMessages();
      }
    }
  }

  unsubscribeMessages(): void {
    for(const relay of this.relays.values()) {
      relay.instance.unsubscribeMessages();
    }
  }

  addRelay(config: RelayConfig): void {
    this.addRelayInternal(config);
    this.saveConfigToDB();
  }

  removeRelay(url: string): void {
    const relay = this.relays.get(url);
    if(relay) {
      relay.instance.disconnect();
      this.relays.delete(url);
      this.saveConfigToDB();
      this.notifyStateChange();
    }
  }

  getRelays(): RelayConfig[] {
    return Array.from(this.relays.values()).map(r => r.config);
  }

  getConnectedCount(): number {
    return Array.from(this.relays.values()).filter(r => r.connected).length;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  isConnected(): boolean {
    return this.getConnectedCount() > 0;
  }

  // --- Internal ---

  private addRelayInternal(config: RelayConfig): void {
    if(this.relays.has(config.url)) return;

    const instance = new NostrRelay(config.url);
    instance.onMessage((msg: DecryptedMessage) => {
      this.handleMessage(msg);
    });

    this.relays.set(config.url, {config, instance, connected: false});
  }

  private handleMessage(msg: DecryptedMessage): void {
    // Deduplicate by event ID
    if(this.seenEventIds.has(msg.id)) return;

    // LRU eviction
    this.seenEventIds.add(msg.id);
    this.seenEventOrder.push(msg.id);
    if(this.seenEventOrder.length > DEDUP_MAX_SIZE) {
      const evicted = this.seenEventOrder.shift()!;
      this.seenEventIds.delete(evicted);
    }

    // Update lastSeenTimestamp
    if(msg.created_at && msg.created_at > this.lastSeenTimestamp) {
      this.lastSeenTimestamp = msg.created_at;
      this.saveLastSeenTimestamp(this.lastSeenTimestamp);
    }

    this.options.onMessage(msg);
  }

  private async backfillFromRelay(instance: NostrRelay): Promise<void> {
    if(this.lastSeenTimestamp === 0) return; // No history to backfill
    try {
      // NOTE: NostrRelay.getMessages() is currently a stub returning [].
      // The implementer must replace it with real REQ/EOSE handling:
      // Send: ["REQ", subId, {kinds: [4], "#p": [this.publicKey], since: this.lastSeenTimestamp}]
      // Collect events until: ["EOSE", subId]
      const messages = await instance.getMessages(this.lastSeenTimestamp);
      for(const msg of messages) {
        this.handleMessage(msg);
      }
    } catch(err) {
      this.log.warn('Backfill failed:', err);
    }
  }

  private async retryFailedRelays(): Promise<void> {
    const failed = Array.from(this.relays.values()).filter(r => !r.connected);
    if(failed.length === 0) return;

    this.log('Retrying', failed.length, 'failed relays');
    for(const relay of failed) {
      try {
        await relay.instance.initialize();
        relay.instance.connect();
        relay.connected = true;
        // Re-subscribe and backfill on reconnect
        if(relay.config.read) {
          relay.instance.subscribeMessages();
          await this.backfillFromRelay(relay.instance);
        }
      } catch {
        // Still failed — will retry next cycle
      }
    }
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.options.onStateChange?.(this.getConnectedCount(), this.relays.size);
  }

  private async loadLastSeenTimestamp(): Promise<number> {
    try {
      const stored = localStorage.getItem(LAST_SEEN_KEY);
      return stored ? parseInt(stored, 10) : 0;
    } catch {
      return 0;
    }
  }

  private saveLastSeenTimestamp(ts: number): void {
    try {
      localStorage.setItem(LAST_SEEN_KEY, String(ts));
    } catch {
      // localStorage may be unavailable
    }
  }

  private async loadConfigFromDB(): Promise<RelayConfig[] | null> {
    try {
      const db = await this.openConfigDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(RELAY_CONFIG_STORE, 'readonly');
        const store = tx.objectStore(RELAY_CONFIG_STORE);
        const req = store.get('relays');
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  private async saveConfigToDB(): Promise<void> {
    try {
      const configs = this.getRelays();
      const db = await this.openConfigDB();
      const tx = db.transaction(RELAY_CONFIG_STORE, 'readwrite');
      const store = tx.objectStore(RELAY_CONFIG_STORE);
      store.put({key: 'relays', value: configs});
    } catch(err) {
      this.log.warn('Failed to save relay config:', err);
    }
  }

  private openConfigDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(RELAY_CONFIG_DB, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(RELAY_CONFIG_STORE)) {
          db.createObjectStore(RELAY_CONFIG_STORE, {keyPath: 'key'});
        }
      };
    });
  }
}
```

- [ ] **Step 4: Fill in test implementations with mocks**

Update the test file with actual mock implementations. Mock `NostrRelay` class, mock `loadIdentity`, mock `indexedDB`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tests/nostra/nostr-relay-pool.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostra/nostr-relay-pool.ts src/tests/nostra/nostr-relay-pool.test.ts
git commit -m "feat: add NostrRelayPool for multi-relay publish, subscribe, and dedup"
```

---

## Task 3: Rewrite ChatAPI to Use NostrRelayPool

**Files:**
- Modify: `src/lib/nostra/chat-api.ts`
- Modify: `src/tests/nostra/chat-api.test.ts`

- [ ] **Step 1: Update chat-api.test.ts to mock NostrRelayPool instead of PeerTransport**

Replace all references to mock transport/relay/offlineQueue with a mock `NostrRelayPool`. The test constructor becomes:

```typescript
// Before:
const api = createChatAPIWithMocks(ownId, mockTransport, mockRelay, mockOfflineQueue);
// After:
const api = new ChatAPI(ownId, mockRelayPool, mockOfflineQueue);
```

Update mock expectations accordingly — `sendText` should call `relayPool.publish()` not `transport.sendMessage()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/nostra/chat-api.test.ts --reporter=verbose`
Expected: FAIL — ChatAPI constructor doesn't accept NostrRelayPool yet.

- [ ] **Step 3: Rewrite ChatAPI**

Rewrite `src/lib/nostra/chat-api.ts`:

Key changes:
- Remove imports: `PeerTransport`, `TransportMessage`, `TransportState`, `PrivacyTransport`
- Add import: `NostrRelayPool` from `./nostr-relay-pool`
- Constructor: accept `NostrRelayPool` + `OfflineQueue` (or create them)
- `connect()`: just `relayPool.initialize()` + `relayPool.subscribeMessages()`
- `sendMessage()`: always `relayPool.publish()`, fallback to offline queue if `!relayPool.isConnected()`
- `disconnect()`: `relayPool.disconnect()`
- State derived from `relayPool.isConnected()`
- Remove all WebRTC-related state tracking

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/nostra/chat-api.test.ts --reporter=verbose`
Expected: All 35 tests PASS (some may need updating if semantics changed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/chat-api.ts src/tests/nostra/chat-api.test.ts
git commit -m "feat: rewrite ChatAPI to use NostrRelayPool (Nostr-first transport)"
```

---

## Task 4: Update OfflineQueue and PrivacyTransport

**Files:**
- Modify: `src/lib/nostra/offline-queue.ts`
- Modify: `src/lib/nostra/privacy-transport.ts`
- Modify: `src/tests/nostra/offline-queue.test.ts`

- [ ] **Step 1: Update offline-queue.test.ts for new constructor**

Replace mock `PeerTransport + NostrRelay` with mock `NostrRelayPool`:

```typescript
// Before:
const queue = new OfflineQueue(mockTransport, mockRelay);
// After:
const queue = new OfflineQueue(mockRelayPool);
```

Update `flush()` test expectations: instead of calling `transport.send()`, it calls `relayPool.publish()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tests/nostra/offline-queue.test.ts --reporter=verbose`
Expected: FAIL — constructor signature mismatch.

- [ ] **Step 3: Rewrite OfflineQueue constructor and flush**

In `src/lib/nostra/offline-queue.ts`:

```typescript
// Remove imports:
import {PeerTransport, TransportMessage, TransportState} from './transport';
import {NostrRelay, createNostrRelay} from './nostr-relay';

// Add import:
import {NostrRelayPool} from './nostr-relay-pool';

// Change constructor:
constructor(relayPool: NostrRelayPool) {
  this.relayPool = relayPool;
  this.log = logger('OfflineQueue');
  // ... restore from IndexedDB same as before ...
}

// Change flush():
async flush(peerOwnId: string): Promise<number> {
  if(!this.relayPool.isConnected()) {
    return 0;
  }
  // ... publish each queued message via relayPool.publish() ...
}
```

Also remove `createOfflineQueue()` factory function (or update it to accept `NostrRelayPool`).

**Auto-flush:** ChatAPI must hook `relayPool.onStateChange` to trigger `offlineQueue.flush()` when `connectedCount` transitions from 0 to >= 1. This ensures queued messages are sent as soon as any relay reconnects.

- [ ] **Step 4: Update PrivacyTransport to remove OfflineQueue**

In `src/lib/nostra/privacy-transport.ts`, line 91:

```typescript
// Remove this line:
this.offlineQueue = new OfflineQueue(this.peerTransport, this.nostrRelay);

// Remove the offlineQueue field declaration
// Remove all this.offlineQueue references in the class
```

This is a minimal change — PrivacyTransport no longer owns an OfflineQueue. The queue is owned by ChatAPI.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/tests/nostra/offline-queue.test.ts --reporter=verbose`
Expected: All 24 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostra/offline-queue.ts src/lib/nostra/privacy-transport.ts src/tests/nostra/offline-queue.test.ts
git commit -m "feat: update OfflineQueue to use NostrRelayPool, remove from PrivacyTransport"
```

---

## Task 5: Remove Feature Flag (nostra-enabled.ts)

**Files:**
- Delete: `src/lib/nostra/nostra-enabled.ts`
- Modify: 10 files (see list below)

- [ ] **Step 1: Delete nostra-enabled.ts**

```bash
rm src/lib/nostra/nostra-enabled.ts
```

- [ ] **Step 2: Remove feature flag from api-manager-stub.ts**

In `src/lib/nostra/api-manager-stub.ts`:
- Remove line 11: `import {isNostraEnabled} from './nostra-enabled';`
- Remove lines 105-107 (the guard):
```typescript
// Remove:
if(!isNostraEnabled()) {
  return stub._original!(method, ...args);
}
```

- [ ] **Step 3: Remove feature flag from nostra-display-bridge.ts**

Find `isNostraEnabled` import and guard, remove both. The display logic always runs.

- [ ] **Step 4: Remove feature flag from nostra-send-bridge.ts**

Find `isNostraEnabled` imports and all guards, remove them.

- [ ] **Step 5: Remove feature flag from apiManagerProxy.ts**

Find `isNostraEnabled` import and guard, remove both.

- [ ] **Step 6: Remove feature flag from appUsersManager.ts**

Find `isNostraEnabled` import and guard, remove both.

- [ ] **Step 7: Remove feature flag from pagesManager.ts**

Find `isNostraEnabled` import and routing guard, remove both. Nostra.chat route is always active.

- [ ] **Step 8: Remove feature flag from nostra-add-peer-dialog.tsx**

Find `isNostraEnabled` import and guard, remove both.

- [ ] **Step 9: Remove enableNostra.chat() from nostra-onboarding-integration.ts**

Find `enableNostra.chat` import and call, remove both.

- [ ] **Step 10: Update nostra-bridge.test.ts**

Remove any `enableNostra.chat()` / `isNostraEnabled` setup calls from tests. Remove any `vi.mock('./nostra-enabled')` statements.

- [ ] **Step 11: Verify no remaining references**

Run: `grep -r 'nostra-enabled\|isNostraEnabled\|enableNostra.chat\|disableNostra.chat' src/`
Expected: No output.

- [ ] **Step 12: Run all Nostra.chat tests**

Run: `npx vitest run src/tests/nostra/ --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 13: Commit**

```bash
git rm src/lib/nostra/nostra-enabled.ts
git add src/lib/nostra/api-manager-stub.ts src/lib/nostra/nostra-display-bridge.ts src/lib/nostra/nostra-send-bridge.ts src/lib/apiManagerProxy.ts src/lib/appManagers/appUsersManager.ts src/pages/pagesManager.ts src/pages/nostra-add-peer-dialog.tsx src/pages/nostra-onboarding-integration.ts src/tests/nostra/nostra-bridge.test.ts
git commit -m "feat: remove nostra-enabled feature flag — Nostra.chat always active"
```

---

## Task 6: Relay Settings UI

**Files:**
- Create: `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`

- [ ] **Step 1: Create the Relay Settings component**

Create `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`:

```typescript
// Minimal Solid.js component for relay management
// Features:
// - List current relays with connection status (green/red dot)
// - Add relay: text input for wss:// URL + read/write toggles
// - Remove relay: delete button per row
// - Reset to defaults button
// All operations go through NostrRelayPool methods
```

The component follows existing sidebar tab patterns (see other files in `src/components/sidebarLeft/tabs/`).

- [ ] **Step 2: Wire into sidebar navigation**

Add a menu entry in `src/components/sidebarLeft/tabs/settings.ts` that opens the relay settings tab. Follow the pattern used by other settings entries (e.g., `privacyAndSecurity`, `generalSettings`) — add a row item with click handler that calls `this.slider.createTab(AppNostraRelaySettingsTab)`.

- [ ] **Step 3: Basic smoke test**

Verify the component renders, add/remove relay calls pool methods, and the reset button restores defaults.

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebarLeft/tabs/nostraRelaySettings.ts src/components/sidebarLeft/tabs/settings.ts
git commit -m "feat: add Relay Settings UI for managing Nostr relay list"
```

---

## Task 7: Branding — Vite Config + Entry Point Routing

**Files:**
- Modify: `vite.config.ts:33-38`
- Modify: `src/index.ts` (early in file)

- [ ] **Step 1: Update vite.config.ts handlebars context**

In `vite.config.ts`, lines 33-38:

```typescript
// Before:
const handlebarsPlugin = handlebars({
  context: {
    title: 'Telegram Web',
    description: 'Telegram is a cloud-based mobile and desktop messaging app with a focus on security and speed.',
    url: 'https://web.telegram.org/k/',
    origin: 'https://web.telegram.org/'
  }
});

// After:
const handlebarsPlugin = handlebars({
  context: {
    title: 'Nostra.chat',
    description: 'Nostra.chat is a privacy-first messaging app with end-to-end encryption and anonymous relay-based delivery.',
    url: 'https://nostra.chat/',
    origin: 'https://nostra.chat/'
  }
});
```

- [ ] **Step 2: Add Nostra.chat identity check to src/index.ts**

**IMPORTANT:** Do NOT add a top-level IIFE. The identity check must go inside the existing `DOMContentLoaded` handler, around line 518 (after `let authState = stateResult.state.authState;`), BEFORE the Telegram auth page renders at line 551.

Add at the top of the file (imports section):
```typescript
import {loadIdentity} from '@lib/nostra/identity';
```

Then inside the DOMContentLoaded handler, just before line 551 (`if(authState._ !== 'authStateSignedIn')`), add:

```typescript
  // Nostra.chat identity check — intercept before Telegram auth flow
  try {
    const nostraIdentity = await loadIdentity();
    if(!nostraIdentity) {
      // No Nostra.chat identity — show onboarding instead of Telegram login
      const {initOnboarding} = await import('@/pages/nostra/onboarding');
      initOnboarding();
      return; // Skip Telegram auth flow entirely
    }
    // Identity exists — continue to normal chat initialization
  } catch(err) {
    console.error('[Nostra.chat] Failed to check identity:', err);
    // Fall through to existing Telegram auth on error
  }
```

This integrates into the existing async DOMContentLoaded handler (which is already `async` — see line 383+). The `return` statement stops the handler from proceeding to the Telegram auth page.

- [ ] **Step 3: Verify dev server shows "Nostra.chat" title**

Run: `pnpm start &` then `curl -s http://localhost:8080 | grep '<title>'`
Expected: `<title>Nostra.chat</title>`

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts src/index.ts
git commit -m "feat: Nostra.chat branding and identity-based entry point routing"
```

---

## Task 8: Integration Test — Full Flow

**Files:** None created. This is a verification task.

- [ ] **Step 1: Run full Nostra.chat test suite**

Run: `npx vitest run src/tests/nostra/ --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 2: Run tsc type check**

Run: `npx tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: Count should be less than or equal to the pre-existing tweb errors (~25). No new errors from Nostra.chat code.

- [ ] **Step 3: Run production build**

Run: `pnpm build`
Expected: Build succeeds without errors.

- [ ] **Step 4: Run dev server and verify**

Run: `pnpm start`, open http://localhost:8080
Expected:
- Page title is "Nostra.chat"
- If no identity in IndexedDB: onboarding page shown
- No console errors related to Nostra.chat modules

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
# List specific changed files from `git status` — do not use `git add -A`
git add <changed-files-here>
git commit -m "fix: integration fixups for Nostr-first transport"
```
