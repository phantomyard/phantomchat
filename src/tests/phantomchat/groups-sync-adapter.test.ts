import {describe, it, expect} from 'vitest';
import {createGroupsAdapter, type GroupsAdapterDeps} from '@lib/phantomchat/groups-sync-adapter';
import type {GroupRecord} from '@lib/phantomchat/group-types';
import type {SyncMap} from '@lib/phantomchat/sync-crdt';

const G1 = 'group-one';

type Calls = {
  upserted: GroupRecord[];
  removed: string[];
  tombstoned: Array<{conversationId: string; deletedAt: number}>;
};

function makeDeps(
  groups: GroupRecord[],
  tombstones: Array<{conversationId: string; deletedAt: number}>
): {deps: GroupsAdapterDeps; calls: Calls} {
  const calls: Calls = {upserted: [], removed: [], tombstoned: []};
  const deps: GroupsAdapterDeps = {
    listGroups: async() => groups,
    listTombstones: async() => tombstones,
    upsertGroup: async(record) => { calls.upserted.push(record); },
    removeGroup: async(groupId) => { calls.removed.push(groupId); },
    setTombstone: async(conversationId, deletedAt) => { calls.tombstoned.push({conversationId, deletedAt}); }
  };
  return {deps, calls};
}

function group(groupId: string, updatedAtMillis: number, name = 'Group'): GroupRecord {
  return {
    groupId, name, adminPubkey: 'a'.repeat(64), members: ['a'.repeat(64)],
    peerId: -1, createdAt: updatedAtMillis, updatedAt: updatedAtMillis
  };
}

describe('groups adapter read()', () => {
  it('normalises live group updatedAt to seconds', async() => {
    const {deps} = makeDeps([group(G1, 7_000_000, 'Team')], []);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
    expect(map[G1].updatedAt).toBe(7000);
    expect(map[G1].data!.name).toBe('Team');
  });

  it('derives a tombstone from a group:<id> deletion with no live record', async() => {
    const {deps} = makeDeps([], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('ignores non-group tombstones', async() => {
    const {deps} = makeDeps([], [{conversationId: `${'a'.repeat(64)}:${'b'.repeat(64)}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('does not tombstone a group whose live record is NEWER than the delete (deliberate re-create)', async() => {
    const {deps} = makeDeps([group(G1, 9_000_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
  });

  it('resurrection loop: an OLDER live record does not mute the tombstone — the delete wins', async() => {
    // The #155-class bug: any live record used to shadow the tombstone, so a
    // stale record (replayed control, orphan recovery) erased the delete and
    // re-published the group forever. The delete must outrank it instead.
    const {deps} = makeDeps([group(G1, 7_000_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('ties go to the TOMBSTONE (> semantics, consistent with mergeEntry and the receive gates)', async() => {
    // Timestamps are seconds-floored, so a live record updated earlier in the
    // same second as the delete ties. Equality cannot mean a deliberate
    // re-create — the delete must win, exactly as mergeEntry resolves an
    // exact tie (tombstone wins, both argument orders).
    const {deps} = makeDeps([group(G1, 8_080_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('adapter read() and mergeEntry agree on a same-second tie (layers cannot disagree)', async() => {
    // The adapter gate and the CRDT merge must resolve the same tie the same
    // way, or a device whose relay is absent (adapter gate decides) diverges
    // from one that merged against the remote (mergeEntry decides).
    const {mergeEntry} = await import('@lib/phantomchat/sync-crdt');
    const {deps} = makeDeps([group(G1, 8_080_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true); // adapter: tombstone wins the tie
    const replayedLive = {id: G1, updatedAt: 8080, data: group(G1, 8_080_000)};
    expect(mergeEntry(map[G1], replayedLive).deleted).toBe(true); // merge: agrees
    expect(mergeEntry(replayedLive, map[G1]).deleted).toBe(true);
  });
});

describe('groups adapter apply()', () => {
  const empty: SyncMap<GroupRecord> = {};

  it('restores a new group and pins updatedAt to the merged value (millis)', async() => {
    const {deps, calls} = makeDeps([], []);
    const merged: SyncMap<GroupRecord> = {
      [G1]: {id: G1, updatedAt: 7000, data: group(G1, 7_000_000, 'Team')}
    };
    await createGroupsAdapter(deps).apply(merged, empty);
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0].updatedAt).toBe(7_000_000);
    expect(calls.upserted[0].name).toBe('Team');
  });

  it('applies a newer remote update', async() => {
    const {deps, calls} = makeDeps([], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 7000, data: group(G1, 7_000_000, 'Team')}};
    const merged: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 8000, data: group(G1, 8_000_000, 'Team Renamed')}};
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0].name).toBe('Team Renamed');
  });

  it('skips an unchanged group', async() => {
    const {deps, calls} = makeDeps([], []);
    const same: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 7000, data: group(G1, 7_000_000)}};
    await createGroupsAdapter(deps).apply(same, same);
    expect(calls.upserted).toHaveLength(0);
  });

  it('tears down a group deleted remotely', async() => {
    // The store fixture holds the group — before (read() output) is derived
    // from the same store in the real engine, so wasLive and the store
    // snapshot agree.
    const {deps, calls} = makeDeps([group(G1, 7_000_000)], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 7000, data: group(G1, 7_000_000)}};
    const merged: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 9000, deleted: true}};
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.removed).toEqual([G1]);
    expect(calls.tombstoned).toEqual([{conversationId: `group:${G1}`, deletedAt: 9000}]);
  });

  it('persists a remote tombstone even with NOTHING live locally (empty-local device)', async() => {
    // A device that never held the group previously skipped the tombstone
    // write — a replayed group_create then passed the absent-tombstone gate
    // in handleGroupCreate and resurrected the group stamped Date.now(),
    // outranking the durable relay delete forever. The tombstone write is
    // unconditional; only the teardown is conditional on a real store record.
    const {deps, calls} = makeDeps([], []);
    const merged: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 9000, deleted: true}};
    await createGroupsAdapter(deps).apply(merged, empty);
    expect(calls.removed).toEqual([]); // nothing to tear down
    expect(calls.tombstoned).toEqual([{conversationId: `group:${G1}`, deletedAt: 9000}]);
  });

  it('tears down a resurrected group even when read() had already overridden it (wasLive false)', async() => {
    // Robert's review of #179: with the strict compare, read() reports a stale
    // live record as `deleted: true`, so wasLive in apply() is false and the
    // old wasLive-gated teardown never fired — the resurrected group stayed in
    // the store and chat list forever. Teardown now follows store reality.
    const {deps, calls} = makeDeps([group(G1, 7_000_000)], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 8080, deleted: true}};
    const merged: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 8080, deleted: true}};
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.removed).toEqual([G1]);
    expect(calls.tombstoned).toEqual([{conversationId: `group:${G1}`, deletedAt: 8080}]);
  });

  it('resurrection self-heal in read(): a live record that LOSES to a tombstone is removed from the store', async() => {
    // The already-resurrected device never reaches apply(): read() overrides
    // the stale record with the tombstone, merged == local, so the engine
    // skips apply entirely. read() itself must tear the resurrection down or
    // the group stays in the local store and chat list indefinitely.
    const {deps, calls} = makeDeps([group(G1, 7_000_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(calls.removed).toEqual([G1]);
  });

  it('read() teardown of a re-created group never fires (live record NEWER than the tombstone)', async() => {
    // The deliberate re-create path must not be torn down or mutated.
    const {deps, calls} = makeDeps([group(G1, 9_000_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
    expect(calls.removed).toEqual([]);
  });
});
