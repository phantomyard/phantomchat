/**
 * v1 → v2 migration: every existing contact mapping gains an `updatedAt`
 * backfilled from `addedAt`.
 *
 * Uses fake-indexeddb (a real IDB implementation) rather than the hand-rolled
 * mock in virtual-peers-db.test.ts, because the migration path only runs when
 * a v1 store with existing data is reopened at v2 — which needs true
 * cross-version persistence, cursors, and a live versionchange transaction.
 */
import {describe, test, expect, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';

const DB_NAME = 'phantomchat-virtual-peers';
const STORE_NAME = 'mappings';

/** Seed a v1 database exactly as the pre-#73 schema wrote it: no updatedAt. */
function seedV1(records: Array<{pubkey: string; peerId: number; displayName?: string; addedAt: number}>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE_NAME, {keyPath: 'pubkey'});
      store.createIndex('peerId', 'peerId', {unique: false});
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for(const r of records) store.put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('virtual-peers-db v1→v2 migration', () => {
  beforeEach(() => {
    // Fresh IDB per test, and drop the module singleton so getDB() reopens.
    indexedDB = new IDBFactory();
    vi.resetModules();
  });

  test('backfills updatedAt = addedAt on every existing mapping', async() => {
    await seedV1([
      {pubkey: 'a'.repeat(64), peerId: 111, displayName: 'Alice', addedAt: 1000},
      {pubkey: 'b'.repeat(64), peerId: 222, addedAt: 2000}
    ]);

    // Reopening through the real module runs DB_VERSION=2's onupgradeneeded.
    const {getAllMappings} = await import('@lib/phantomchat/virtual-peers-db');
    const all = await getAllMappings();

    const alice = all.find((m) => m.pubkey === 'a'.repeat(64))!;
    const bob = all.find((m) => m.pubkey === 'b'.repeat(64))!;

    expect(alice.updatedAt).toBe(1000);
    expect(bob.updatedAt).toBe(2000);
    // Original fields survive the upgrade untouched.
    expect(alice.displayName).toBe('Alice');
    expect(alice.addedAt).toBe(1000);
  });

  test('a fresh v2 database needs no backfill and reads/writes cleanly', async() => {
    const {storeMapping, getMapping} = await import('@lib/phantomchat/virtual-peers-db');
    await storeMapping('c'.repeat(64), 333, 'Carol');
    const rec = await getMapping('c'.repeat(64));
    expect(rec!.updatedAt).toBeGreaterThan(0);
    expect(rec!.addedAt).toBeGreaterThan(0);
  });

  test('idempotent message-path touch does NOT advance updatedAt', async() => {
    const {storeMapping, getMapping} = await import('@lib/phantomchat/virtual-peers-db');
    await storeMapping('d'.repeat(64), 444, 'Dave');
    const first = (await getMapping('d'.repeat(64)))!.updatedAt;

    // Simulate the inbound-message idempotent write (pubkey + peerId only).
    await new Promise((r) => setTimeout(r, 5));
    await storeMapping('d'.repeat(64), 444);
    const second = (await getMapping('d'.repeat(64)))!.updatedAt;

    expect(second).toBe(first);
  });

  test('an explicit rename DOES advance updatedAt', async() => {
    const {storeMapping, setMappingDisplayName, getMapping} = await import('@lib/phantomchat/virtual-peers-db');
    await storeMapping('e'.repeat(64), 555, 'Eve');
    const first = (await getMapping('e'.repeat(64)))!.updatedAt;

    await new Promise((r) => setTimeout(r, 5));
    await setMappingDisplayName('e'.repeat(64), 'Eve (work)');
    const second = (await getMapping('e'.repeat(64)))!.updatedAt;

    expect(second).toBeGreaterThan(first);
  });
});
