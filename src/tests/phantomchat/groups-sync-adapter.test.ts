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

  it('does not tombstone a group that still has a live record', async() => {
    const {deps} = makeDeps([group(G1, 9_000_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
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
    const {deps, calls} = makeDeps([], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 7000, data: group(G1, 7_000_000)}};
    const merged: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 9000, deleted: true}};
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.removed).toEqual([G1]);
    expect(calls.tombstoned).toEqual([{conversationId: `group:${G1}`, deletedAt: 9000}]);
  });
});
