/**
 * Groups sync merges name / description / avatar per field, by
 * infoUpdatedAt, on top of whole-record LWW. Without it a device holding a
 * NEWER copy with an OLDER name (a fresh login that rebuilt the session from
 * its replayed create, "New session") overwrote the rename on every device.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach} from 'vitest';
import {createGroupsAdapter, mergeGroupsMaps, type GroupsAdapterDeps} from '@lib/phantomchat/groups-sync-adapter';
import type {GroupRecord} from '@lib/phantomchat/group-types';
import type {SyncMap} from '@lib/phantomchat/sync-crdt';

const G = 'group-name-merge';
const ADMIN = 'a'.repeat(64);

function rec(updatedAtSec: number, extra: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: G, name: 'New session', adminPubkey: ADMIN, members: [ADMIN], peerId: -1, kind: 'session',
    createdAt: 1_000_000, updatedAt: updatedAtSec * 1000, ...extra
  };
}
const map = (r: GroupRecord): SyncMap<GroupRecord> => ({[G]: {id: G, updatedAt: Math.floor(r.updatedAt / 1000), data: r}});

// Desktop: renamed at 5000. Phone: rebuilt from the create, newer record, no name stamp.
const desktop = rec(5000, {name: 'Fix the login bug', infoUpdatedAt: {name: 5000}});
const phone = rec(9000);

describe('mergeGroupsMaps: per-field info merge', () => {
  it('keeps the renamed name when the other copy is newer but never renamed', () => {
    expect(mergeGroupsMaps(map(desktop), map(phone))[G].data?.name).toBe('Fix the login bug');
    expect(mergeGroupsMaps(map(phone), map(desktop))[G].data?.name).toBe('Fix the login bug');
  });

  it('still takes the rest of the record from the newer copy', () => {
    const newer = rec(9000, {members: [ADMIN, 'b'.repeat(64)]});
    const merged = mergeGroupsMaps(map(desktop), map(newer))[G];
    expect(merged.updatedAt).toBe(9000);
    expect(merged.data?.members).toEqual([ADMIN, 'b'.repeat(64)]);
    expect(merged.data?.infoUpdatedAt?.name).toBe(5000);
  });

  it('a genuinely later rename on the newer copy wins', () => {
    const later = rec(9000, {name: 'Auth rework', infoUpdatedAt: {name: 8000}});
    expect(mergeGroupsMaps(map(desktop), map(later))[G].data?.name).toBe('Auth rework');
    expect(mergeGroupsMaps(map(later), map(desktop))[G].data?.name).toBe('Auth rework');
  });

  it('a later rename on the OLDER copy wins over an earlier rename on the newer one', () => {
    const olderRecNewerName = rec(5000, {name: 'B', infoUpdatedAt: {name: 4900}});
    const newerRecOlderName = rec(9000, {name: 'A', infoUpdatedAt: {name: 1000}});
    expect(mergeGroupsMaps(map(newerRecOlderName), map(olderRecNewerName))[G].data?.name).toBe('B');
  });

  it('legacy records with no stamps keep whole-record LWW', () => {
    const a = rec(5000, {name: 'Old'});
    const b = rec(9000, {name: 'New'});
    expect(mergeGroupsMaps(map(a), map(b))[G].data?.name).toBe('New');
    expect(mergeGroupsMaps(map(b), map(a))[G].data?.name).toBe('New');
  });

  it('is idempotent once converged', () => {
    const once = mergeGroupsMaps(map(desktop), map(phone));
    expect(mergeGroupsMaps(once, once)).toEqual(once);
    expect(mergeGroupsMaps(once, map(phone))).toEqual(once);
  });

  it('never revives a tombstone', () => {
    const dead: SyncMap<GroupRecord> = {[G]: {id: G, updatedAt: 9500, deleted: true}};
    expect(mergeGroupsMaps(map(desktop), dead)[G].deleted).toBe(true);
  });
});

describe('groups adapter applies an info-only merge', () => {
  beforeEach(() => localStorage.clear());

  it('upserts when only the name changed and updatedAt is equal', async() => {
    const upserts: GroupRecord[] = [];
    const deps: GroupsAdapterDeps = {
      listGroups: async() => [phone],
      listTombstones: async() => [],
      listDeletedGroups: async() => [],
      recordDeletedGroup: async() => {},
      getLegacyDeleteCutoff: async() => 4_000_000_000,
      clearDeletedGroup: async() => {},
      upsertGroup: async(r) => { upserts.push(r); },
      removeGroup: async() => {},
      setTombstone: async() => {}
    };
    const merged = mergeGroupsMaps(map(phone), map(desktop));
    expect(merged[G].updatedAt).toBe(9000);
    await createGroupsAdapter(deps).apply(merged, map(phone));
    expect(upserts.map((r) => r.name)).toEqual(['Fix the login bug']);
  });
});
