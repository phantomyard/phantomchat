/**
 * #180 — store-level invariants for the deliberate-add stamp.
 *
 * The stamp is the ONLY proof that may clear a durable contact delete in the
 * contacts CRDT merge. Two store invariants are load-bearing:
 *
 *  1. storeMapping NEVER mints it — every automatic persistence path
 *     (message receive, history backfill, sync restores) goes through
 *     storeMapping, so minting there would stamp resurrections as deliberate.
 *  2. setDeliberateAddAt is monotonic — a stale remote entry can never lower
 *     the local proof, and it is a no-op without a live mapping.
 *
 * Follows virtual-peers-db-migration.test.ts: fresh IDBFactory + resetModules
 * per test so the module singleton reopens against a clean database.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';

const PK = 'c'.repeat(64);

/** Fresh module handle against a clean fake IDB. */
async function freshDb() {
  const mod = await import('@lib/phantomchat/virtual-peers-db');
  return {
    storeMapping: mod.storeMapping,
    setDeliberateAddAt: mod.setDeliberateAddAt,
    getMapping: mod.getMapping
  };
}

describe('virtual-peers-db deliberateAddAt (#180)', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    vi.resetModules();
  });

  it('storeMapping does NOT mint a stamp on create (automatic paths stay unproven)', async() => {
    const {storeMapping, getMapping} = await freshDb();
    await storeMapping(PK, 1, 'Alice');
    const m = await getMapping(PK);
    expect(m).toBeTruthy();
    expect(m!.deliberateAddAt).toBeUndefined();
  });

  it('storeMapping preserves an existing stamp across idempotent re-persist', async() => {
    const {storeMapping, setDeliberateAddAt, getMapping} = await freshDb();

    // No mapping yet -> the stamp write is a no-op.
    await setDeliberateAddAt(PK, 5_000_000);
    expect(await getMapping(PK)).toBeUndefined();

    await storeMapping(PK, 1, 'Alice');
    await setDeliberateAddAt(PK, 5_000_000);
    // The message path re-persists with no identity payload — stamp survives.
    await storeMapping(PK, 1);
    const m = await getMapping(PK);
    expect(m!.deliberateAddAt).toBe(5_000_000);
  });

  it('setDeliberateAddAt is monotonic — a lower value never overwrites', async() => {
    const {storeMapping, setDeliberateAddAt, getMapping} = await freshDb();
    await storeMapping(PK, 1, 'Alice');
    await setDeliberateAddAt(PK, 5_000_000);
    await setDeliberateAddAt(PK, 4_000_000); // stale remote stamp
    const m = await getMapping(PK);
    expect(m!.deliberateAddAt).toBe(5_000_000);
  });
});
