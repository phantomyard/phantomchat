/**
 * #364: groups sync is the second writer of group info, and it used to leave
 * the per-field info watermarks alone. A device that learned a rename only
 * through sync then let an older relayed group_info_update (dated after its
 * stale watermark) revert the synced name.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach} from 'vitest';
import {createGroupsAdapter, type GroupsAdapterDeps} from '@lib/phantomchat/groups-sync-adapter';
import {raiseInfoWatermark} from '@lib/phantomchat/group-api';
import type {GroupRecord} from '@lib/phantomchat/group-types';

const G1 = 'group-info-wm';
const wmKey = (field: string) => 'phantomchat:group-wm:' + G1 + ':info:' + field;

function group(updatedAtMillis: number, extra: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: G1, name: 'Old', adminPubkey: 'a'.repeat(64), members: ['a'.repeat(64)],
    peerId: -1, createdAt: 1_000_000, updatedAt: updatedAtMillis, infoUpdatedAt: {name: updatedAtMillis / 1000, description: updatedAtMillis / 1000}, ...extra
  };
}

function deps(local: GroupRecord[], raised: Array<[string, string, number]>): GroupsAdapterDeps {
  return {
    listGroups: async() => local,
    listTombstones: async() => [],
    listDeletedGroups: async() => [],
    recordDeletedGroup: async() => {},
    getLegacyDeleteCutoff: async() => 4_000_000_000,
    clearDeletedGroup: async() => {},
    upsertGroup: async() => {},
    removeGroup: async() => {},
    setTombstone: async() => {},
    raiseInfoWatermark: (groupId, field, tsSec) => {
      raised.push([groupId, field, tsSec]);
      raiseInfoWatermark(groupId, field, tsSec);
    }
  };
}

describe('groups sync advances the info watermarks (#364)', () => {
  beforeEach(() => localStorage.clear());

  it('stamps the watermark of a field the sync upsert changed, at its own source timestamp', async() => {
    const raised: Array<[string, string, number]> = [];
    const local = group(5_000_000, {description: 'Same'});
    const before = {[G1]: {id: G1, updatedAt: 5000, data: local}};
    const merged = {[G1]: {id: G1, updatedAt: 7000, data: group(7_000_000, {name: 'Renamed', description: 'Same'})}};

    await createGroupsAdapter(deps([local], raised)).apply(merged, before);

    expect(raised).toEqual([[G1, 'name', 7000]]);
    expect(localStorage.getItem(wmKey('name'))).toBe('7000');
    // The unchanged description keeps its own watermark.
    expect(localStorage.getItem(wmKey('description'))).toBeNull();
  });

  it('stamps every carried field on a device that had no local record', async() => {
    const raised: Array<[string, string, number]> = [];
    const merged = {[G1]: {id: G1, updatedAt: 7000, data: group(7_000_000, {description: 'About'})}};

    await createGroupsAdapter(deps([], raised)).apply(merged, {});

    expect(raised.map(([, f]) => f).sort()).toEqual(['description', 'name']);
  });

  it('caps a future field stamp at the local clock', async() => {
    const raised: Array<[string, string, number]> = [];
    const now = Math.floor(Date.now() / 1000);
    const record = group((now + 1000) * 1000);
    await createGroupsAdapter(deps([], raised)).apply({[G1]: {id: G1, updatedAt: now + 1000, data: record}}, {});
    expect(raised.every(([, , stamp]) => stamp <= Math.floor(Date.now() / 1000))).toBe(true);
    raiseInfoWatermark(G1, 'avatar', now + 1000);
    expect(Number(localStorage.getItem(wmKey('avatar')))).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('uses field provenance despite a later unrelated entry merge', async() => {
    const raised: Array<[string, string, number]> = [];
    const record = group(9_000_000, {name: 'Renamed', infoUpdatedAt: {name: 7000}});
    await createGroupsAdapter(deps([], raised)).apply({[G1]: {id: G1, updatedAt: 10000, data: record}}, {});
    expect(raised).toEqual([[G1, 'name', 7000]]);
    // A later rename still qualifies, even though it predates the merge stamp.
    raiseInfoWatermark(G1, 'name', 8000);
    expect(localStorage.getItem(wmKey('name'))).toBe('8000');
  });

  it('does not infer field provenance from legacy snapshot merge times', async() => {
    const raised: Array<[string, string, number]> = [];
    const record = group(9_000_000, {infoUpdatedAt: undefined});
    await createGroupsAdapter(deps([], raised)).apply({[G1]: {id: G1, updatedAt: 10000, data: record}}, {});
    expect(raised).toEqual([]);
  });

  it('never lowers a watermark that is already newer', () => {
    localStorage.setItem(wmKey('name'), String(Math.floor(Date.now() / 1000)));
    const held = localStorage.getItem(wmKey('name'));
    raiseInfoWatermark(G1, 'name', 7000);
    expect(localStorage.getItem(wmKey('name'))).toBe(held);
    raiseInfoWatermark(G1, 'description', 7000);
    expect(localStorage.getItem(wmKey('description'))).toBe('7000');
  });
});
