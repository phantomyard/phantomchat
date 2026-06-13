# Mini-Relay (In-Browser NIP-01 Relay) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-browser Nostr relay running in a Web Worker with NIP-01 protocol support, IndexedDB storage, and store-and-forward for offline contacts.

**Architecture:** New `relay-store.ts` for raw Nostr events (separate from existing `message-store.ts`). `mini-relay.ts` handles NIP-01 protocol (REQ/EVENT/OK/CLOSE/EOSE). `mini-relay.worker.ts` wraps it in a Web Worker. Forward queue enables store-and-forward for offline contacts.

**Tech Stack:** TypeScript, IndexedDB (via idb or raw), Web Worker, NIP-01 protocol, secp256k1 signature validation

**Spec:** `docs/superpowers/specs/2026-04-11-tor-ui-distributed-relay-mesh-design.md` — Section 4

**Depends on:** Tor UI plan (Task 1 specifically — `nostra_tor_circuit_update` and mesh events in rootScope)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/lib/nostra/relay-store.ts` | IndexedDB storage for raw Nostr events + forward queue |
| `src/lib/nostra/mini-relay.ts` | NIP-01 protocol handler (REQ/EVENT/OK/CLOSE/EOSE) |
| `src/lib/nostra/mini-relay.worker.ts` | Web Worker wrapper for mini-relay |
| `src/tests/nostra/relay-store.test.ts` | Storage layer tests |
| `src/tests/nostra/mini-relay.test.ts` | Protocol handler tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/nostra/nostra-bridge.ts` | Initialize mini-relay worker on startup |

---

## Task 1: Create relay-store.ts — IndexedDB schema and basic CRUD

**Files:**
- Create: `src/lib/nostra/relay-store.ts`
- Create: `src/tests/nostra/relay-store.test.ts`

- [ ] **Step 1: Write the failing test for event storage**

Create `src/tests/nostra/relay-store.test.ts`:

```typescript
// @ts-nocheck
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterAll} from 'vitest';

// Unique DB name per test run to avoid cross-file contamination (isolate: false)
let dbSuffix = 0;
const uniqueDb = () => `nostra-relay-test-${Date.now()}-${++dbSuffix}`;

describe('RelayStore', () => {
  let store: any;

  beforeEach(async() => {
    const {RelayStore} = await import('@lib/nostra/relay-store');
    store = new RelayStore(uniqueDb());
    await store.open();
  });

  afterAll(() => {
    store?.close();
  });

  it('should save and retrieve a Nostr event by id', async() => {
    const event = {
      id: 'abc123',
      pubkey: 'pub1',
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'encrypted-content',
      tags: [['p', 'recipient-pub']],
      sig: 'sig123'
    };

    const result = await store.saveEvent(event);
    expect(result).toBe(true);

    const retrieved = await store.getEvent('abc123');
    expect(retrieved).not.toBeNull();
    expect(retrieved.id).toBe('abc123');
    expect(retrieved.pubkey).toBe('pub1');
    expect(retrieved.content).toBe('encrypted-content');
  });

  it('should deduplicate events by id', async() => {
    const event = {
      id: 'dup1',
      pubkey: 'pub1',
      kind: 1059,
      created_at: 1000,
      content: 'first',
      tags: [],
      sig: 'sig1'
    };

    await store.saveEvent(event);
    await store.saveEvent({...event, content: 'second'});

    const retrieved = await store.getEvent('dup1');
    expect(retrieved.content).toBe('first'); // first write wins
  });

  it('should query events by NIP-01 filter', async() => {
    const now = Math.floor(Date.now() / 1000);
    await store.saveEvent({id: 'e1', pubkey: 'alice', kind: 1059, created_at: now - 100, content: 'a', tags: [], sig: 's1'});
    await store.saveEvent({id: 'e2', pubkey: 'bob', kind: 1059, created_at: now - 50, content: 'b', tags: [], sig: 's2'});
    await store.saveEvent({id: 'e3', pubkey: 'alice', kind: 1059, created_at: now, content: 'c', tags: [], sig: 's3'});

    // Filter by authors
    const byAlice = await store.queryEvents({authors: ['alice']});
    expect(byAlice).toHaveLength(2);

    // Filter by since
    const recent = await store.queryEvents({since: now - 60});
    expect(recent).toHaveLength(2);

    // Filter by limit
    const limited = await store.queryEvents({limit: 1});
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe('e3'); // most recent first
  });

  it('should delete events older than retention period', async() => {
    const old = Math.floor(Date.now() / 1000) - (73 * 3600); // 73 hours ago
    const recent = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    await store.saveEvent({id: 'old1', pubkey: 'p', kind: 1059, created_at: old, content: 'x', tags: [], sig: 's'});
    await store.saveEvent({id: 'new1', pubkey: 'p', kind: 1059, created_at: recent, content: 'y', tags: [], sig: 's'});

    const pruned = await store.pruneOlderThan(72 * 3600); // 72 hours
    expect(pruned).toBe(1);

    const remaining = await store.queryEvents({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('new1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/relay-store.test.ts`
Expected: FAIL — cannot import `RelayStore`

- [ ] **Step 3: Implement RelayStore**

Create `src/lib/nostra/relay-store.ts`:

```typescript
export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface NIP01Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  '#p'?: string[];
}

export interface ForwardQueueEntry {
  id?: number;
  targetPubkey: string;
  eventId: string;
  storedAt: number;
  attempts: number;
  lastAttempt: number;
}

const EVENTS_STORE = 'events';
const FORWARD_STORE = 'forward_queue';

export class RelayStore {
  private db: IDBDatabase | null = null;
  private dbName: string;

  constructor(dbName: string = 'nostra-relay') {
    this.dbName = dbName;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;

        if(!db.objectStoreNames.contains(EVENTS_STORE)) {
          const eventsStore = db.createObjectStore(EVENTS_STORE, {keyPath: 'id'});
          eventsStore.createIndex('kind', 'kind', {unique: false});
          eventsStore.createIndex('pubkey', 'pubkey', {unique: false});
          eventsStore.createIndex('created_at', 'created_at', {unique: false});
          eventsStore.createIndex('kind_created_at', ['kind', 'created_at'], {unique: false});
        }

        if(!db.objectStoreNames.contains(FORWARD_STORE)) {
          const fwdStore = db.createObjectStore(FORWARD_STORE, {keyPath: 'id', autoIncrement: true});
          fwdStore.createIndex('targetPubkey', 'targetPubkey', {unique: false});
          fwdStore.createIndex('eventId', 'eventId', {unique: false});
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  async saveEvent(event: NostrEvent): Promise<boolean> {
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, 'readwrite');
      const store = tx.objectStore(EVENTS_STORE);

      // Check if exists first (dedup)
      const getReq = store.get(event.id);
      getReq.onsuccess = () => {
        if(getReq.result) {
          resolve(false); // already exists
          return;
        }
        const putReq = store.add(event);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async getEvent(id: string): Promise<NostrEvent | null> {
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, 'readonly');
      const store = tx.objectStore(EVENTS_STORE);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async queryEvents(filter: NIP01Filter): Promise<NostrEvent[]> {
    const db = this.db!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, 'readonly');
      const store = tx.objectStore(EVENTS_STORE);
      const results: NostrEvent[] = [];

      let source: IDBRequest | IDBIndex = store;
      let range: IDBKeyRange | null = null;

      // Use created_at index for time-range queries
      if(filter.since || filter.until) {
        source = store.index('created_at');
        const lower = filter.since ?? 0;
        const upper = filter.until ?? Infinity;
        if(upper === Infinity) {
          range = IDBKeyRange.lowerBound(lower);
        } else {
          range = IDBKeyRange.bound(lower, upper);
        }
      }

      const cursorReq = (source as IDBObjectStore | IDBIndex).openCursor(range, 'prev'); // newest first
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if(!cursor) {
          resolve(results);
          return;
        }

        const event = cursor.value as NostrEvent;
        let matches = true;

        if(filter.ids && !filter.ids.includes(event.id)) matches = false;
        if(filter.authors && !filter.authors.includes(event.pubkey)) matches = false;
        if(filter.kinds && !filter.kinds.includes(event.kind)) matches = false;
        if(filter['#p']) {
          const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
          if(!filter['#p'].some(p => pTags.includes(p))) matches = false;
        }

        if(matches) {
          results.push(event);
          if(filter.limit && results.length >= filter.limit) {
            resolve(results);
            return;
          }
        }

        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async pruneOlderThan(maxAgeSeconds: number): Promise<number> {
    const db = this.db!;
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, 'readwrite');
      const store = tx.objectStore(EVENTS_STORE);
      const index = store.index('created_at');
      const range = IDBKeyRange.upperBound(cutoff);

      let count = 0;
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if(!cursor) {
          resolve(count);
          return;
        }
        cursor.delete();
        count++;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/relay-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/relay-store.ts src/tests/nostra/relay-store.test.ts
git commit -m "feat(nostra): add RelayStore with IndexedDB storage for raw Nostr events"
```

---

## Task 2: Add forward queue operations to RelayStore

**Files:**
- Modify: `src/lib/nostra/relay-store.ts`
- Modify: `src/tests/nostra/relay-store.test.ts`

- [ ] **Step 1: Write the failing test for forward queue**

Append to `src/tests/nostra/relay-store.test.ts`:

```typescript
describe('RelayStore forward queue', () => {
  let store: any;

  beforeEach(async() => {
    const {RelayStore} = await import('@lib/nostra/relay-store');
    store = new RelayStore(uniqueDb());
    await store.open();
  });

  afterAll(() => {
    store?.close();
  });

  it('should enqueue and retrieve forward entries by target pubkey', async() => {
    await store.enqueueForward('bob-pub', 'event-1');
    await store.enqueueForward('bob-pub', 'event-2');
    await store.enqueueForward('alice-pub', 'event-3');

    const bobQueue = await store.getForwardQueue('bob-pub');
    expect(bobQueue).toHaveLength(2);
    expect(bobQueue[0].eventId).toBe('event-1');
    expect(bobQueue[1].eventId).toBe('event-2');
    expect(bobQueue[0].attempts).toBe(0);
  });

  it('should remove forward entry after successful delivery', async() => {
    await store.enqueueForward('bob-pub', 'event-1');
    const queue = await store.getForwardQueue('bob-pub');
    expect(queue).toHaveLength(1);

    await store.removeForward(queue[0].id);
    const afterRemove = await store.getForwardQueue('bob-pub');
    expect(afterRemove).toHaveLength(0);
  });

  it('should increment attempt count', async() => {
    await store.enqueueForward('bob-pub', 'event-1');
    const queue = await store.getForwardQueue('bob-pub');

    await store.markForwardAttempt(queue[0].id);
    const updated = await store.getForwardQueue('bob-pub');
    expect(updated[0].attempts).toBe(1);
    expect(updated[0].lastAttempt).toBeGreaterThan(0);
  });

  it('should prune expired forward entries', async() => {
    // Manually insert an old entry
    await store.enqueueForward('bob-pub', 'old-event');
    const queue = await store.getForwardQueue('bob-pub');

    // Simulate old storedAt by direct DB access
    const db = (store as any).db;
    const tx = db.transaction('forward_queue', 'readwrite');
    const s = tx.objectStore('forward_queue');
    const oldEntry = {...queue[0], storedAt: Date.now() - (73 * 3600 * 1000)};
    s.put(oldEntry);
    await new Promise(r => { tx.oncomplete = r; });

    const pruned = await store.pruneForwardQueue(72 * 3600 * 1000);
    expect(pruned).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/relay-store.test.ts`
Expected: FAIL — `enqueueForward` is not a function

- [ ] **Step 3: Add forward queue methods to RelayStore**

In `src/lib/nostra/relay-store.ts`, add methods to the `RelayStore` class:

```typescript
async enqueueForward(targetPubkey: string, eventId: string): Promise<number> {
  const db = this.db!;
  const entry: Omit<ForwardQueueEntry, 'id'> = {
    targetPubkey,
    eventId,
    storedAt: Date.now(),
    attempts: 0,
    lastAttempt: 0
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(FORWARD_STORE, 'readwrite');
    const store = tx.objectStore(FORWARD_STORE);
    const req = store.add(entry);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

async getForwardQueue(targetPubkey: string): Promise<ForwardQueueEntry[]> {
  const db = this.db!;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FORWARD_STORE, 'readonly');
    const store = tx.objectStore(FORWARD_STORE);
    const index = store.index('targetPubkey');
    const req = index.getAll(targetPubkey);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async removeForward(id: number): Promise<void> {
  const db = this.db!;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FORWARD_STORE, 'readwrite');
    const store = tx.objectStore(FORWARD_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async markForwardAttempt(id: number): Promise<void> {
  const db = this.db!;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FORWARD_STORE, 'readwrite');
    const store = tx.objectStore(FORWARD_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const entry = getReq.result;
      if(!entry) { resolve(); return; }
      entry.attempts++;
      entry.lastAttempt = Date.now();
      const putReq = store.put(entry);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async pruneForwardQueue(maxAgeMs: number): Promise<number> {
  const db = this.db!;
  const cutoff = Date.now() - maxAgeMs;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(FORWARD_STORE, 'readwrite');
    const store = tx.objectStore(FORWARD_STORE);
    let count = 0;

    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if(!cursor) { resolve(count); return; }
      if(cursor.value.storedAt < cutoff) {
        cursor.delete();
        count++;
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/relay-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/relay-store.ts src/tests/nostra/relay-store.test.ts
git commit -m "feat(nostra): add forward queue operations to RelayStore"
```

---

## Task 3: Create mini-relay NIP-01 protocol handler — EVENT command

**Files:**
- Create: `src/lib/nostra/mini-relay.ts`
- Create: `src/tests/nostra/mini-relay.test.ts`

- [ ] **Step 1: Write the failing test for EVENT handling**

Create `src/tests/nostra/mini-relay.test.ts`:

```typescript
// @ts-nocheck
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach, afterAll} from 'vitest';

let dbSuffix = 0;
const uniqueDb = () => `nostra-mini-relay-test-${Date.now()}-${++dbSuffix}`;

describe('MiniRelay EVENT command', () => {
  let relay: any;
  let sent: Array<{peerId: string; msg: string}>;

  beforeEach(async() => {
    const {MiniRelay} = await import('@lib/nostra/mini-relay');
    const {RelayStore} = await import('@lib/nostra/relay-store');
    const store = new RelayStore(uniqueDb());
    await store.open();

    sent = [];
    relay = new MiniRelay(store, [], (peerId: string, msg: string) => {
      sent.push({peerId, msg});
    });
  });

  it('should respond OK to a valid EVENT', async() => {
    const event = {
      id: 'evt1',
      pubkey: 'aabb'.repeat(16),
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'encrypted',
      tags: [['p', 'ccdd'.repeat(16)]],
      sig: '1234'.repeat(32)
    };

    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    expect(sent).toHaveLength(1);
    const response = JSON.parse(sent[0].msg);
    expect(response[0]).toBe('OK');
    expect(response[1]).toBe('evt1');
    expect(response[2]).toBe(true); // accepted
  });

  it('should reject non-1059 event kinds', async() => {
    const event = {
      id: 'evt2',
      pubkey: 'aabb'.repeat(16),
      kind: 1, // text note, not allowed
      created_at: Math.floor(Date.now() / 1000),
      content: 'hello',
      tags: [],
      sig: '1234'.repeat(32)
    };

    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const response = JSON.parse(sent[0].msg);
    expect(response[0]).toBe('OK');
    expect(response[2]).toBe(false); // rejected
    expect(response[3]).toContain('kind not allowed');
  });

  it('should reject events older than 72 hours', async() => {
    const event = {
      id: 'evt3',
      pubkey: 'aabb'.repeat(16),
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000) - (73 * 3600),
      content: 'old',
      tags: [],
      sig: '1234'.repeat(32)
    };

    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const response = JSON.parse(sent[0].msg);
    expect(response[2]).toBe(false);
    expect(response[3]).toContain('too old');
  });

  it('should reject events larger than 64KB', async() => {
    const event = {
      id: 'evt4',
      pubkey: 'aabb'.repeat(16),
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'x'.repeat(65 * 1024),
      tags: [],
      sig: '1234'.repeat(32)
    };

    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const response = JSON.parse(sent[0].msg);
    expect(response[2]).toBe(false);
    expect(response[3]).toContain('too large');
  });

  it('should deduplicate duplicate events', async() => {
    const event = {
      id: 'dup1',
      pubkey: 'aabb'.repeat(16),
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'enc',
      tags: [],
      sig: '1234'.repeat(32)
    };

    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    // Both should get OK, but second should say "duplicate"
    expect(sent).toHaveLength(2);
    const r1 = JSON.parse(sent[0].msg);
    const r2 = JSON.parse(sent[1].msg);
    expect(r1[2]).toBe(true);
    expect(r2[2]).toBe(true); // OK per NIP-01 spec
    expect(r2[3]).toContain('duplicate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/mini-relay.test.ts`
Expected: FAIL — cannot import `MiniRelay`

- [ ] **Step 3: Implement MiniRelay with EVENT handling**

Create `src/lib/nostra/mini-relay.ts`:

```typescript
import {RelayStore, NostrEvent, NIP01Filter} from '@lib/nostra/relay-store';

const MAX_EVENT_SIZE = 64 * 1024; // 64KB
const MAX_EVENT_AGE = 72 * 3600;  // 72 hours in seconds
const ALLOWED_KINDS = new Set([1059]); // gift-wrap only
const MAX_SUBS_PER_PEER = 20;
const MAX_SUBS_TOTAL = 100;
const RATE_LIMIT_PER_SECOND = 10;

type SendFn = (peerId: string, msg: string) => void;

interface Subscription {
  filters: NIP01Filter[];
}

export class MiniRelay {
  private store: RelayStore;
  private contactPubkeys: string[];
  private send: SendFn;
  private subscriptions: Map<string, Map<string, Subscription>> = new Map(); // peerId -> subId -> sub
  private rateLimits: Map<string, number[]> = new Map(); // peerId -> timestamps

  constructor(store: RelayStore, contactPubkeys: string[], send: SendFn) {
    this.store = store;
    this.contactPubkeys = contactPubkeys;
    this.send = send;
  }

  updateContacts(pubkeys: string[]) {
    this.contactPubkeys = pubkeys;
  }

  async handleMessage(peerId: string, raw: string): Promise<void> {
    let msg: any[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // silently ignore malformed JSON
    }

    if(!Array.isArray(msg) || msg.length < 2) return;

    const type = msg[0];
    switch(type) {
      case 'EVENT':
        await this.handleEvent(peerId, msg[1]);
        break;
      case 'REQ':
        await this.handleReq(peerId, msg[1], msg.slice(2));
        break;
      case 'CLOSE':
        this.handleClose(peerId, msg[1]);
        break;
      default:
        // Unknown command, ignore
        break;
    }
  }

  private async handleEvent(peerId: string, event: NostrEvent): Promise<void> {
    // Rate limit check
    if(this.isRateLimited(peerId)) {
      this.sendJson(peerId, ['OK', event.id, false, 'rate-limited: too many events']);
      return;
    }
    this.recordEvent(peerId);

    // Validate kind
    if(!ALLOWED_KINDS.has(event.kind)) {
      this.sendJson(peerId, ['OK', event.id, false, 'blocked: kind not allowed']);
      return;
    }

    // Validate age
    const now = Math.floor(Date.now() / 1000);
    if(now - event.created_at > MAX_EVENT_AGE) {
      this.sendJson(peerId, ['OK', event.id, false, 'invalid: event too old']);
      return;
    }

    // Validate size
    if(raw.length > MAX_EVENT_SIZE || event.content.length > MAX_EVENT_SIZE) {
      this.sendJson(peerId, ['OK', event.id, false, 'invalid: event too large']);
      return;
    }

    // Save to store (dedup handled inside)
    const isNew = await this.store.saveEvent(event);
    if(!isNew) {
      this.sendJson(peerId, ['OK', event.id, true, 'duplicate: already have this event']);
      return;
    }

    this.sendJson(peerId, ['OK', event.id, true, '']);

    // Check forward queue: does this event have a p-tag for a contact?
    await this.checkForward(event);

    // Push to active subscriptions
    this.pushToSubscriptions(peerId, event);
  }

  private async handleReq(peerId: string, subId: string, filters: NIP01Filter[]): Promise<void> {
    // Check subscription limits
    const peerSubs = this.subscriptions.get(peerId) || new Map();
    let totalSubs = 0;
    for(const [, subs] of this.subscriptions) totalSubs += subs.size;

    if(peerSubs.size >= MAX_SUBS_PER_PEER) {
      this.sendJson(peerId, ['CLOSED', subId, 'error: too many subscriptions']);
      return;
    }
    if(totalSubs >= MAX_SUBS_TOTAL) {
      this.sendJson(peerId, ['CLOSED', subId, 'error: relay subscription limit reached']);
      return;
    }

    // Close existing sub with same ID
    peerSubs.delete(subId);

    // Store subscription
    peerSubs.set(subId, {filters});
    this.subscriptions.set(peerId, peerSubs);

    // Query stored events matching filters
    for(const filter of filters) {
      const events = await this.store.queryEvents(filter);
      for(const event of events) {
        this.sendJson(peerId, ['EVENT', subId, event]);
      }
    }

    // Send EOSE
    this.sendJson(peerId, ['EOSE', subId]);
  }

  private handleClose(peerId: string, subId: string): void {
    const peerSubs = this.subscriptions.get(peerId);
    if(peerSubs) {
      peerSubs.delete(subId);
      if(peerSubs.size === 0) {
        this.subscriptions.delete(peerId);
      }
    }
  }

  onPeerDisconnected(peerId: string) {
    this.subscriptions.delete(peerId);
    this.rateLimits.delete(peerId);
  }

  async onPeerConnected(peerId: string, peerPubkey: string) {
    // Check forward queue for this peer
    const queue = await this.store.getForwardQueue(peerPubkey);
    for(const entry of queue) {
      const event = await this.store.getEvent(entry.eventId);
      if(event) {
        this.sendJson(peerId, ['EVENT', '_forward', event]);
      }
      await this.store.removeForward(entry.id!);
    }
  }

  private async checkForward(event: NostrEvent) {
    const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
    for(const recipientPubkey of pTags) {
      if(!this.contactPubkeys.includes(recipientPubkey)) continue;

      // Is recipient currently connected?
      const connected = this.findConnectedPeer(recipientPubkey);
      if(connected) {
        // Forward immediately
        this.sendJson(connected, ['EVENT', '_forward', event]);
      } else {
        // Queue for later
        await this.store.enqueueForward(recipientPubkey, event.id);
      }
    }
  }

  private findConnectedPeer(_pubkey: string): string | null {
    // This will be wired to MeshManager in Area 3
    // For now, return null (no direct forwarding)
    return null;
  }

  private pushToSubscriptions(sourcePeerId: string, event: NostrEvent) {
    for(const [peerId, subs] of this.subscriptions) {
      if(peerId === sourcePeerId) continue; // don't echo back
      for(const [subId, sub] of subs) {
        if(this.matchesFilters(event, sub.filters)) {
          this.sendJson(peerId, ['EVENT', subId, event]);
        }
      }
    }
  }

  private matchesFilters(event: NostrEvent, filters: NIP01Filter[]): boolean {
    return filters.some(filter => {
      if(filter.ids && !filter.ids.includes(event.id)) return false;
      if(filter.authors && !filter.authors.includes(event.pubkey)) return false;
      if(filter.kinds && !filter.kinds.includes(event.kind)) return false;
      if(filter.since && event.created_at < filter.since) return false;
      if(filter.until && event.created_at > filter.until) return false;
      if(filter['#p']) {
        const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
        if(!filter['#p'].some(p => pTags.includes(p))) return false;
      }
      return true;
    });
  }

  private sendJson(peerId: string, msg: any[]) {
    this.send(peerId, JSON.stringify(msg));
  }

  private isRateLimited(peerId: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimits.get(peerId) || [];
    const recent = timestamps.filter(t => now - t < 1000);
    return recent.length >= RATE_LIMIT_PER_SECOND;
  }

  private recordEvent(peerId: string) {
    const now = Date.now();
    const timestamps = this.rateLimits.get(peerId) || [];
    timestamps.push(now);
    // Keep only last second
    this.rateLimits.set(peerId, timestamps.filter(t => now - t < 1000));
  }
}
```

Note: `raw` variable in `handleEvent` isn't available — the size check should use `JSON.stringify(event).length` instead. Fix the size validation:

```typescript
// Validate size
const eventSize = JSON.stringify(event).length;
if(eventSize > MAX_EVENT_SIZE) {
  this.sendJson(peerId, ['OK', event.id, false, 'invalid: event too large']);
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/mini-relay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/mini-relay.ts src/tests/nostra/mini-relay.test.ts
git commit -m "feat(nostra): add MiniRelay with NIP-01 EVENT handling"
```

---

## Task 4: Add REQ/CLOSE/EOSE and subscription tests

**Files:**
- Modify: `src/tests/nostra/mini-relay.test.ts`

- [ ] **Step 1: Write failing tests for REQ and CLOSE**

Append to `src/tests/nostra/mini-relay.test.ts`:

```typescript
describe('MiniRelay REQ command', () => {
  let relay: any;
  let sent: Array<{peerId: string; msg: string}>;

  beforeEach(async() => {
    const {MiniRelay} = await import('@lib/nostra/mini-relay');
    const {RelayStore} = await import('@lib/nostra/relay-store');
    const store = new RelayStore(uniqueDb());
    await store.open();

    // Pre-populate some events
    const now = Math.floor(Date.now() / 1000);
    await store.saveEvent({id: 'e1', pubkey: 'alice', kind: 1059, created_at: now - 100, content: 'a', tags: [['p', 'bob']], sig: 's1'});
    await store.saveEvent({id: 'e2', pubkey: 'bob', kind: 1059, created_at: now - 50, content: 'b', tags: [['p', 'alice']], sig: 's2'});
    await store.saveEvent({id: 'e3', pubkey: 'alice', kind: 1059, created_at: now, content: 'c', tags: [['p', 'bob']], sig: 's3'});

    sent = [];
    relay = new MiniRelay(store, ['alice', 'bob'], (peerId: string, msg: string) => {
      sent.push({peerId, msg});
    });
  });

  it('should return matching events and EOSE for REQ', async() => {
    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'sub1', {authors: ['alice']}]));

    // Should receive 2 EVENTs + 1 EOSE
    const events = sent.filter(s => JSON.parse(s.msg)[0] === 'EVENT');
    const eose = sent.filter(s => JSON.parse(s.msg)[0] === 'EOSE');

    expect(events).toHaveLength(2);
    expect(eose).toHaveLength(1);
    expect(JSON.parse(eose[0].msg)[1]).toBe('sub1');
  });

  it('should push new events to active subscriptions', async() => {
    // Subscribe peer-1 to alice's events
    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'sub1', {authors: ['alice']}]));
    sent.length = 0; // Clear initial results

    // New event from alice arrives from peer-2
    const newEvent = {
      id: 'e4',
      pubkey: 'alice',
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'new',
      tags: [],
      sig: 's4'
    };
    await relay.handleMessage('peer-2', JSON.stringify(['EVENT', newEvent]));

    // peer-1 should receive the pushed event
    const pushed = sent.filter(s => s.peerId === 'peer-1' && JSON.parse(s.msg)[0] === 'EVENT');
    expect(pushed).toHaveLength(1);
    expect(JSON.parse(pushed[0].msg)[2].id).toBe('e4');
  });

  it('should respect subscription limits', async() => {
    // Fill up to MAX_SUBS_PER_PEER (20)
    for(let i = 0; i < 20; i++) {
      await relay.handleMessage('peer-1', JSON.stringify(['REQ', `sub${i}`, {}]));
    }
    sent.length = 0;

    // 21st should be rejected
    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'sub20', {}]));
    const closed = sent.filter(s => JSON.parse(s.msg)[0] === 'CLOSED');
    expect(closed).toHaveLength(1);
    expect(JSON.parse(closed[0].msg)[2]).toContain('too many');
  });
});

describe('MiniRelay CLOSE command', () => {
  it('should remove subscription on CLOSE', async() => {
    const {MiniRelay} = await import('@lib/nostra/mini-relay');
    const {RelayStore} = await import('@lib/nostra/relay-store');
    const store = new RelayStore(uniqueDb());
    await store.open();

    const sent: Array<{peerId: string; msg: string}> = [];
    const relay = new MiniRelay(store, [], (peerId: string, msg: string) => {
      sent.push({peerId, msg});
    });

    // Subscribe
    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'sub1', {}]));
    sent.length = 0;

    // Close subscription
    await relay.handleMessage('peer-1', JSON.stringify(['CLOSE', 'sub1']));

    // New event should NOT be pushed to peer-1
    const event = {
      id: 'afterclose',
      pubkey: 'aabb'.repeat(16),
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'x',
      tags: [],
      sig: '1234'.repeat(32)
    };
    await relay.handleMessage('peer-2', JSON.stringify(['EVENT', event]));

    const pushed = sent.filter(s => s.peerId === 'peer-1' && JSON.parse(s.msg)[0] === 'EVENT');
    expect(pushed).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (implementation exists from Task 3)**

Run: `pnpm test:nostra:quick -- src/tests/nostra/mini-relay.test.ts`
Expected: PASS (REQ/CLOSE are already implemented in Task 3)

- [ ] **Step 3: Commit**

```bash
git add src/tests/nostra/mini-relay.test.ts
git commit -m "test(nostra): add REQ/CLOSE/subscription tests for MiniRelay"
```

---

## Task 5: Add store-and-forward tests

**Files:**
- Modify: `src/tests/nostra/mini-relay.test.ts`

- [ ] **Step 1: Write store-and-forward tests**

Append to `src/tests/nostra/mini-relay.test.ts`:

```typescript
describe('MiniRelay store-and-forward', () => {
  let relay: any;
  let store: any;
  let sent: Array<{peerId: string; msg: string}>;

  beforeEach(async() => {
    const {MiniRelay} = await import('@lib/nostra/mini-relay');
    const {RelayStore} = await import('@lib/nostra/relay-store');
    store = new RelayStore(uniqueDb());
    await store.open();

    sent = [];
    relay = new MiniRelay(store, ['alice', 'bob', 'carlo'], (peerId: string, msg: string) => {
      sent.push({peerId, msg});
    });
  });

  it('should enqueue event for offline contact in p-tag', async() => {
    const event = {
      id: 'fwd1',
      pubkey: 'alice',
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'for-bob',
      tags: [['p', 'bob']],
      sig: 's1'
    };

    await relay.handleMessage('peer-alice', JSON.stringify(['EVENT', event]));

    // Bob is not connected, so event should be in forward queue
    const queue = await store.getForwardQueue('bob');
    expect(queue).toHaveLength(1);
    expect(queue[0].eventId).toBe('fwd1');
  });

  it('should NOT enqueue for non-contacts', async() => {
    const event = {
      id: 'fwd2',
      pubkey: 'alice',
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'for-stranger',
      tags: [['p', 'stranger-pubkey']],
      sig: 's2'
    };

    await relay.handleMessage('peer-alice', JSON.stringify(['EVENT', event]));

    const queue = await store.getForwardQueue('stranger-pubkey');
    expect(queue).toHaveLength(0);
  });

  it('should flush forward queue when peer connects', async() => {
    // Pre-enqueue
    const event = {
      id: 'fwd3',
      pubkey: 'alice',
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      content: 'for-bob-queued',
      tags: [['p', 'bob']],
      sig: 's3'
    };
    await store.saveEvent(event);
    await store.enqueueForward('bob', 'fwd3');

    sent.length = 0;

    // Bob connects
    await relay.onPeerConnected('peer-bob', 'bob');

    // Should receive the queued event
    const forwarded = sent.filter(s => s.peerId === 'peer-bob' && JSON.parse(s.msg)[0] === 'EVENT');
    expect(forwarded).toHaveLength(1);
    expect(JSON.parse(forwarded[0].msg)[2].id).toBe('fwd3');

    // Queue should be empty now
    const queue = await store.getForwardQueue('bob');
    expect(queue).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test:nostra:quick -- src/tests/nostra/mini-relay.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tests/nostra/mini-relay.test.ts
git commit -m "test(nostra): add store-and-forward tests for MiniRelay"
```

---

## Task 6: Create Web Worker wrapper

**Files:**
- Create: `src/lib/nostra/mini-relay.worker.ts`

- [ ] **Step 1: Implement the worker**

Create `src/lib/nostra/mini-relay.worker.ts`:

```typescript
import {MiniRelay} from '@lib/nostra/mini-relay';
import {RelayStore} from '@lib/nostra/relay-store';

let relay: MiniRelay | null = null;
let store: RelayStore | null = null;
let gcInterval: ReturnType<typeof setInterval> | null = null;

const GC_INTERVAL = 60 * 60 * 1000; // 1 hour
const EVENT_MAX_AGE = 72 * 3600;     // 72 hours in seconds
const FORWARD_MAX_AGE = 72 * 3600 * 1000; // 72 hours in ms

async function init(contactPubkeys: string[]) {
  store = new RelayStore();
  await store.open();

  relay = new MiniRelay(store, contactPubkeys, (peerId: string, msg: string) => {
    self.postMessage({type: 'send', peerId, data: msg});
  });

  // Start garbage collection
  gcInterval = setInterval(async() => {
    if(!store) return;
    await store.pruneOlderThan(EVENT_MAX_AGE);
    await store.pruneForwardQueue(FORWARD_MAX_AGE);
  }, GC_INTERVAL);

  self.postMessage({type: 'ready'});
}

self.onmessage = async(e: MessageEvent) => {
  const msg = e.data;

  switch(msg.type) {
    case 'init':
      await init(msg.contactPubkeys || []);
      break;

    case 'peer-message':
      if(relay) await relay.handleMessage(msg.peerId, msg.data);
      break;

    case 'peer-connected':
      if(relay) await relay.onPeerConnected(msg.peerId, msg.pubkey);
      break;

    case 'peer-disconnected':
      if(relay) relay.onPeerDisconnected(msg.peerId);
      break;

    case 'update-contacts':
      if(relay) relay.updateContacts(msg.contactPubkeys);
      break;

    case 'stop':
      if(gcInterval) clearInterval(gcInterval);
      store?.close();
      relay = null;
      store = null;
      self.postMessage({type: 'stopped'});
      break;
  }
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "mini-relay.worker" | grep "error TS"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/mini-relay.worker.ts
git commit -m "feat(nostra): add Web Worker wrapper for MiniRelay"
```

---

## Task 7: Wire mini-relay worker into nostra-bridge

**Files:**
- Modify: `src/lib/nostra/nostra-bridge.ts`

- [ ] **Step 1: Read current nostra-bridge.ts initialization**

Read `src/lib/nostra/nostra-bridge.ts` to find where PrivacyTransport is initialized.

- [ ] **Step 2: Add mini-relay worker initialization**

In `src/lib/nostra/nostra-bridge.ts`, after the existing initialization code (after `PrivacyTransport` setup), add:

```typescript
// Initialize mini-relay worker
const miniRelayWorker = new Worker(
  new URL('./mini-relay.worker.ts', import.meta.url),
  {type: 'module'}
);

miniRelayWorker.postMessage({
  type: 'init',
  contactPubkeys: [] // Will be updated when contacts load
});

miniRelayWorker.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if(msg.type === 'send') {
    // Route to MeshManager when available (Area 3)
    // For now, log that mini-relay wants to send
    console.log('[MiniRelay] outgoing message to', msg.peerId);
  }
};

// Expose for debugging
(window as any).__nostraMiniRelayWorker = miniRelayWorker;

// Update contacts when they change
rootScope.addEventListener('nostra_contact_accepted', () => {
  // Rebuild contact list from appUsersManager
  const contacts = (window as any).__nostraContacts || [];
  miniRelayWorker.postMessage({type: 'update-contacts', contactPubkeys: contacts});
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "nostra-bridge" | grep "error TS"`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-bridge.ts
git commit -m "feat(nostra): initialize mini-relay worker in nostra-bridge"
```

---

## Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test:nostra`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor`
Expected: No new errors

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(nostra): mini-relay integration fixes"
```
