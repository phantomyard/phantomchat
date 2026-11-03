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
    peerId: -1, createdAt: 1_000_000, updatedAt: updatedAtMillis, ...extra
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

  it('stamps the watermark of a field the sync upsert changed, at the merged updatedAt', async() => {
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

  it('never lowers a watermark that is already newer', () => {
    localStorage.setItem(wmKey('name'), String(Math.floor(Date.now() / 1000)));
    const held = localStorage.getItem(wmKey('name'));
    raiseInfoWatermark(G1, 'name', 7000);
    expect(localStorage.getItem(wmKey('name'))).toBe(held);
    raiseInfoWatermark(G1, 'description', 7000);
    expect(localStorage.getItem(wmKey('description'))).toBe('7000');
  });
});
