/**
 * Tests for relay-store.ts
 *
 * Verifies: saveEvent, getEvent, queryEvents, pruneOlderThan,
 * enqueueForward, getForwardQueue, removeForward, markForwardAttempt,
 * pruneForwardQueue.
 *
 * Uses fake-indexeddb for real IDB behavior without a browser.
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterAll, vi} from 'vitest';
import {RelayStore, NostrEvent, NIP01Filter} from '@lib/nostra/relay-store';

// ─── Helpers ───────────────────────────────────────────────────────

let dbCounter = 0;

/** Generate a unique DB name per test to avoid fake-indexeddb cross-contamination */
function uniqueDb(): string {
  return `nostra-relay-test-${Date.now()}-${++dbCounter}`;
}

const PK_A = 'aaaa'.repeat(16);
const PK_B = 'bbbb'.repeat(16);
const PK_C = 'cccc'.repeat(16);

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const id = overrides.id || ('ev' + Math.random().toString(36).slice(2, 18).padEnd(16, '0'));
  return {
    id,
    pubkey: PK_A,
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: 'hello',
    tags: [],
    sig: 'sig' + id,
    ...overrides
  };
}

// ─── Test Suite ────────────────────────────────────────────────────

describe('RelayStore — events', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('saves and retrieves an event by id', async() => {
    const ev = makeEvent();
    const saved = await store.saveEvent(ev);
    expect(saved).toBe(true);

    const fetched = await store.getEvent(ev.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(ev.id);
    expect(fetched!.content).toBe(ev.content);
  });

  it('deduplicates events — first write wins, second returns false', async() => {
    const ev = makeEvent({content: 'original'});
    const first = await store.saveEvent(ev);
    expect(first).toBe(true);

    const evDup = {...ev, content: 'duplicate'};
    const second = await store.saveEvent(evDup);
    expect(second).toBe(false);

    // Original content must be preserved
    const fetched = await store.getEvent(ev.id);
    expect(fetched!.content).toBe('original');
  });

  it('queries events by authors filter', async() => {
    const ev1 = makeEvent({pubkey: PK_A});
    const ev2 = makeEvent({pubkey: PK_B});
    const ev3 = makeEvent({pubkey: PK_C});
    await store.saveEvent(ev1);
    await store.saveEvent(ev2);
    await store.saveEvent(ev3);

    const filter: NIP01Filter = {authors: [PK_A, PK_C]};
    const results = await store.queryEvents(filter);
    expect(results).toHaveLength(2);
    const ids = results.map((e) => e.id);
    expect(ids).toContain(ev1.id);
    expect(ids).toContain(ev3.id);
    expect(ids).not.toContain(ev2.id);
  });

  it('queries events by since filter (inclusive)', async() => {
    const now = Math.floor(Date.now() / 1000);
    const old = makeEvent({created_at: now - 100});
    const recent = makeEvent({created_at: now - 10});
    const future = makeEvent({created_at: now + 10});
    await store.saveEvent(old);
    await store.saveEvent(recent);
    await store.saveEvent(future);

    const filter: NIP01Filter = {since: now - 15};
    const results = await store.queryEvents(filter);
    const ids = results.map((e) => e.id);
    expect(ids).toContain(recent.id);
    expect(ids).toContain(future.id);
    expect(ids).not.toContain(old.id);
  });

  it('queries with limit and returns newest first', async() => {
    const now = Math.floor(Date.now() / 1000);
    const ev1 = makeEvent({created_at: now - 30});
    const ev2 = makeEvent({created_at: now - 20});
    const ev3 = makeEvent({created_at: now - 10});
    await store.saveEvent(ev1);
    await store.saveEvent(ev2);
    await store.saveEvent(ev3);

    const filter: NIP01Filter = {limit: 2};
    const results = await store.queryEvents(filter);
    expect(results).toHaveLength(2);
    // Should be the two newest
    expect(results[0].id).toBe(ev3.id);
    expect(results[1].id).toBe(ev2.id);
  });

  it('queries events by #p tag filter', async() => {
    const evWithP = makeEvent({
      tags: [['p', PK_B], ['e', 'someeventid']]
    });
    const evWithoutP = makeEvent({
      tags: [['e', 'anothereventid']]
    });
    const evOtherP = makeEvent({
      tags: [['p', PK_C]]
    });
    await store.saveEvent(evWithP);
    await store.saveEvent(evWithoutP);
    await store.saveEvent(evOtherP);

    const filter: NIP01Filter = {'#p': [PK_B]};
    const results = await store.queryEvents(filter);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(evWithP.id);
  });

  it('prunes events older than retention period', async() => {
    const now = Math.floor(Date.now() / 1000);
    const old1 = makeEvent({created_at: now - 1000});
    const old2 = makeEvent({created_at: now - 500});
    const fresh = makeEvent({created_at: now - 10});
    await store.saveEvent(old1);
    await store.saveEvent(old2);
    await store.saveEvent(fresh);

    const deleted = await store.pruneOlderThan(100); // delete older than 100s
    expect(deleted).toBe(2);

    const remaining = await store.queryEvents({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(fresh.id);
  });
});

describe('RelayStore — forward queue', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('enqueues and retrieves forward entries by target pubkey', async() => {
    const evId1 = 'event-id-1';
    const evId2 = 'event-id-2';
    await store.enqueueForward(PK_A, evId1);
    await store.enqueueForward(PK_A, evId2);
    await store.enqueueForward(PK_B, 'event-id-other');

    const queueA = await store.getForwardQueue(PK_A);
    expect(queueA).toHaveLength(2);
    const eventIds = queueA.map((e) => e.eventId);
    expect(eventIds).toContain(evId1);
    expect(eventIds).toContain(evId2);
  });

  it('removes forward entry after delivery', async() => {
    await store.enqueueForward(PK_A, 'event-to-remove');
    const queue = await store.getForwardQueue(PK_A);
    expect(queue).toHaveLength(1);

    const entryId = queue[0].id!;
    await store.removeForward(entryId);

    const afterRemove = await store.getForwardQueue(PK_A);
    expect(afterRemove).toHaveLength(0);
  });

  it('increments attempt count and updates lastAttempt', async() => {
    const before = Date.now();
    await store.enqueueForward(PK_A, 'event-with-attempts');
    const queue = await store.getForwardQueue(PK_A);
    const entryId = queue[0].id!;
    expect(queue[0].attempts).toBe(0);
    expect(queue[0].lastAttempt).toBe(0);

    await store.markForwardAttempt(entryId);
    const updated = await store.getForwardQueue(PK_A);
    expect(updated[0].attempts).toBe(1);
    expect(updated[0].lastAttempt).toBeGreaterThanOrEqual(before);

    await store.markForwardAttempt(entryId);
    const updated2 = await store.getForwardQueue(PK_A);
    expect(updated2[0].attempts).toBe(2);
  });

  it('prunes expired forward queue entries', async() => {
    // Manually set old storedAt by saving directly
    const db = (store as any).dbPromise
      ? await (store as any).getDB()
      : null;

    // Use store methods but manipulate timestamps via enqueue + direct put
    // Enqueue entries
    await store.enqueueForward(PK_A, 'old-event-1');
    await store.enqueueForward(PK_A, 'old-event-2');
    await store.enqueueForward(PK_B, 'fresh-event');

    // Update stored_at of first two entries to be old (use internal DB access)
    const dbHandle = await (store as any).getDB() as IDBDatabase;
    await new Promise<void>((resolve, reject) => {
      const tx = dbHandle.transaction('forward_queue', 'readwrite');
      const objStore = tx.objectStore('forward_queue');
      const req = objStore.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const entry = cursor.value;
          if(entry.eventId === 'old-event-1' || entry.eventId === 'old-event-2') {
            entry.storedAt = Date.now() - 10000; // 10 seconds old
            cursor.update(entry);
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
    });

    const pruned = await store.pruneForwardQueue(5000); // prune entries older than 5s
    expect(pruned).toBe(2);

    const queueA = await store.getForwardQueue(PK_A);
    expect(queueA).toHaveLength(0);

    const queueB = await store.getForwardQueue(PK_B);
    expect(queueB).toHaveLength(1);
  });
});

describe('RelayStore — query by kinds filter', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should query events by kinds filter', async() => {
    const ev1 = makeEvent({kind: 1059});
    const ev2 = makeEvent({kind: 1});
    const ev3 = makeEvent({kind: 1059});
    await store.saveEvent(ev1);
    await store.saveEvent(ev2);
    await store.saveEvent(ev3);

    const results = await store.queryEvents({kinds: [1059]});
    expect(results).toHaveLength(2);
    const ids = results.map((e) => e.id);
    expect(ids).toContain(ev1.id);
    expect(ids).toContain(ev3.id);
    expect(ids).not.toContain(ev2.id);
  });
});

describe('RelayStore — query by ids filter', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should query events by ids filter', async() => {
    const ev1 = makeEvent({id: 'filter-id-e1'});
    const ev2 = makeEvent({id: 'filter-id-e2'});
    const ev3 = makeEvent({id: 'filter-id-e3'});
    await store.saveEvent(ev1);
    await store.saveEvent(ev2);
    await store.saveEvent(ev3);

    const results = await store.queryEvents({ids: ['filter-id-e1', 'filter-id-e3']});
    expect(results).toHaveLength(2);
    const ids = results.map((e) => e.id);
    expect(ids).toContain('filter-id-e1');
    expect(ids).toContain('filter-id-e3');
    expect(ids).not.toContain('filter-id-e2');
  });
});

describe('RelayStore — combined filters', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should combine multiple filter fields', async() => {
    const now = Math.floor(Date.now() / 1000);
    const aliceOld = makeEvent({pubkey: PK_A, created_at: now - 200});
    const aliceRecent = makeEvent({pubkey: PK_A, created_at: now - 10});
    const bobRecent = makeEvent({pubkey: PK_B, created_at: now - 5});
    await store.saveEvent(aliceOld);
    await store.saveEvent(aliceRecent);
    await store.saveEvent(bobRecent);

    const results = await store.queryEvents({authors: [PK_A], since: now - 50, limit: 1});
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(aliceRecent.id);
  });
});

describe('RelayStore — until filter', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should respect until filter', async() => {
    const base = Math.floor(Date.now() / 1000);
    const ev100 = makeEvent({created_at: base - 200});
    const ev200 = makeEvent({created_at: base - 100});
    const ev300 = makeEvent({created_at: base});
    await store.saveEvent(ev100);
    await store.saveEvent(ev200);
    await store.saveEvent(ev300);

    const results = await store.queryEvents({until: base - 50});
    const ids = results.map((e) => e.id);
    expect(ids).toContain(ev100.id);
    expect(ids).toContain(ev200.id);
    expect(ids).not.toContain(ev300.id);
  });
});

describe('RelayStore — empty filter returns all newest first', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should return all events newest first with empty filter', async() => {
    const now = Math.floor(Date.now() / 1000);
    const ev1 = makeEvent({created_at: now - 30});
    const ev2 = makeEvent({created_at: now - 20});
    const ev3 = makeEvent({created_at: now - 10});
    await store.saveEvent(ev1);
    await store.saveEvent(ev2);
    await store.saveEvent(ev3);

    const results = await store.queryEvents({});
    expect(results).toHaveLength(3);
    expect(results[0].id).toBe(ev3.id);
    expect(results[1].id).toBe(ev2.id);
    expect(results[2].id).toBe(ev1.id);
  });
});

describe('RelayStore — getEvent non-existent', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should return null for non-existent event id', async() => {
    const result = await store.getEvent('does-not-exist');
    // RelayStore returns undefined (IDB getAll miss) for missing events
    expect(result).toBeFalsy();
  });
});

describe('RelayStore — forward queue duplicate eventId', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should allow duplicate eventId in forward queue', async() => {
    await store.enqueueForward(PK_A, 'dup-event-id');
    await store.enqueueForward(PK_A, 'dup-event-id');

    const queue = await store.getForwardQueue(PK_A);
    expect(queue).toHaveLength(2);
    expect(queue.every((e) => e.eventId === 'dup-event-id')).toBe(true);
  });
});

describe('RelayStore — forward queue multiple targets', () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore(uniqueDb());
  });

  it('should maintain separate queues per target pubkey', async() => {
    await store.enqueueForward('alice', 'e1');
    await store.enqueueForward('bob', 'e2');
    await store.enqueueForward('alice', 'e3');

    const aliceQueue = await store.getForwardQueue('alice');
    expect(aliceQueue).toHaveLength(2);

    const bobQueue = await store.getForwardQueue('bob');
    expect(bobQueue).toHaveLength(1);
  });
});
