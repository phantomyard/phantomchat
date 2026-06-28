import {describe, expect, it, beforeEach} from 'vitest';
import 'fake-indexeddb/auto';
import AppStorage from '@lib/storage';
import IDBStorage from '@lib/files/idb';
import {getDatabaseState} from '@config/databases/state';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';

// Regression guard for the folder-wipe-on-restart bug.
//
// tweb shipped two object stores per name (`session` + `session__encrypted`)
// and AppStorage picked between them per-instance via an async
// `isUsingPasscode()` resolution. Reads and writes could resolve that switch
// at different instants, so a boot read landed on the empty encrypted store
// while writes had gone to the plain one — silently wiping local-only state
// (custom folders / `filtersArr`) on every restart.
//
// PhantomChat collapses this to a single, unconditional plain store. These
// tests pin that invariant: storage must ignore passcode state entirely.

async function readUntil<T>(fn: () => Promise<T>, timeout = 2000): Promise<T> {
  const start = Date.now();
  let value = await fn();
  while((value === undefined || value === null) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 10));
    value = await fn();
  }
  return value;
}

describe('AppStorage single-store (no passcode encryption switch)', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase('tweb-account-1');
    indexedDB.deleteDatabase('tweb-account-1_test');
    indexedDB.deleteDatabase('tweb-account-2');
    indexedDB.deleteDatabase('tweb-account-2_test');
  });

  it('writes land in the plain store even when passcode resolves true', async() => {
    // Simulate "passcode on" — pre-fix this routed storage to the encrypted twin.
    DeferredIsUsingPasscode.resolveDeferred(true);

    const db = getDatabaseState(1);
    const storage = new AppStorage(db, 'session');
    await storage.set({filtersArr: [0, 1, 3, 4]});

    // Physically read the PLAIN object store, bypassing AppStorage's cache.
    const raw = new IDBStorage(db, 'session');
    const value = await readUntil(() => raw.get<number[]>('filtersArr'));
    expect(value).toEqual([0, 1, 3, 4]);
  });

  it('a fresh reader instance sees prior writes regardless of passcode state', async() => {
    DeferredIsUsingPasscode.resolveDeferred(true);

    const db = getDatabaseState(2);
    const writer = new AppStorage(db, 'session');
    await writer.set({filtersArr: [0, 1, 3, 9]});
    // Flush is fire-and-forget inside AppStorage; let the IDB commit settle.
    await readUntil(() => new IDBStorage(db, 'session').get<number[]>('filtersArr'));

    // A separate instance (no shared in-memory cache) must read the same store.
    const reader = new AppStorage(db, 'session');
    expect(await reader.get('filtersArr', false)).toEqual([0, 1, 3, 9]);
  });
});
