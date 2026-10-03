import {describe, it, expect} from 'vitest';
import {createGroupsAdapter, type GroupsAdapterDeps} from '@lib/phantomchat/groups-sync-adapter';
import type {GroupRecord} from '@lib/phantomchat/group-types';
import type {SyncMap} from '@lib/phantomchat/sync-crdt';

const G1 = 'group-one';

type Calls = {
  upserted: GroupRecord[];
  removed: string[];
  tombstoned: Array<{conversationId: string; deletedAt: number}>;
  recordedDeletes: Array<{groupId: string; deletedAt: number}>;
  clearedDeletes: string[];
};

type DeletedGroup = {groupId: string; deletedAt: number};

/** Default migration cutoff for fixtures: far in the future, so every fixture
 * watermark counts as legacy (pre-durable-log) unless a test opts out. */
const CUTOFF = 4_000_000_000;

function makeDeps(
  groups: GroupRecord[],
  tombstones: Array<{conversationId: string; deletedAt: number}>,
  deletedGroups: DeletedGroup[] = [],
  cutoffSec: number = CUTOFF
): {deps: GroupsAdapterDeps; calls: Calls} {
  const calls: Calls = {upserted: [], removed: [], tombstoned: [], recordedDeletes: [], clearedDeletes: []};
  const deps: GroupsAdapterDeps = {
    listGroups: async() => groups,
    listTombstones: async() => tombstones,
    listDeletedGroups: async() => deletedGroups,
    recordDeletedGroup: async(groupId, deletedAt) => { calls.recordedDeletes.push({groupId, deletedAt}); },
    getLegacyDeleteCutoff: async() => cutoffSec,
    clearDeletedGroup: async(groupId) => { calls.clearedDeletes.push(groupId); },
    upsertGroup: async(record) => { calls.upserted.push(record); },
    removeGroup: async(groupId) => { calls.removed.push(groupId); },
    setTombstone: async(conversationId, deletedAt) => { calls.tombstoned.push({conversationId, deletedAt}); }
  };
  return {deps, calls};
}

function group(
  groupId: string,
  updatedAtMillis: number,
  name = 'Group',
  deliberateAddAtMillis?: number
): GroupRecord {
  return {
    groupId, name, adminPubkey: 'a'.repeat(64), members: ['a'.repeat(64)],
    peerId: -1, createdAt: updatedAtMillis, updatedAt: updatedAtMillis,
    ...(deliberateAddAtMillis !== undefined ? {deliberateAddAt: deliberateAddAtMillis} : {})
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

  it('#180: a live record NEWER than the delete but WITHOUT a stamp loses (auto-minted stamps no longer resurrect)', async() => {
    // A stale client's replayed group_create / orphan recovery re-creates the
    // record with a FRESH Date.now() stamp. Under the old rule that outranked
    // the durable delete; now only a deliberate-add proof clears a delete.
    const {deps, calls} = makeDeps([group(G1, 9_000_000)], [], [{groupId: G1, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(calls.removed).toEqual([G1]); // resurrection torn down
  });

  it('#180: a live record with a deliberate stamp NEWER than the delete wins and clears the durable row', async() => {
    const {deps, calls} = makeDeps(
      [group(G1, 9_000_000, 'Team', 8_500_000)],
      [],
      [{groupId: G1, deletedAt: 8080}]
    );
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
    expect(map[G1].deliberateAddAt).toBe(8500); // 8_500_000ms -> 8500s
    expect(calls.clearedDeletes).toEqual([G1]); // store converges with the merge
    expect(calls.removed).toHaveLength(0);
  });

  it('#180: a deliberate stamp OLDER than the delete loses (re-create proof predates the delete)', async() => {
    const {deps} = makeDeps(
      [group(G1, 9_000_000, 'Team', 7_000_000)],
      [],
      [{groupId: G1, deletedAt: 8080}]
    );
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
  });

  it('clear-history regression: a group:<id> WATERMARK under a live record is NOT a delete', async() => {
    // Robert's round-5 review of #179: messages.deleteHistory for a group peer
    // writes a `group:<id>` tombstone (history watermark) while the group
    // record stays live. Only a DURABLE delete row may tear a live group
    // down — the watermark just means the history was cleared.
    const {deps, calls} = makeDeps([group(G1, 7_000_000)], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
    expect(map[G1].updatedAt).toBe(7000);
    expect(calls.removed).toEqual([]);
  });

  it('resurrection loop: an OLDER live record does not mute a DURABLE delete — the delete wins', async() => {
    // The #155-class bug: any live record used to shadow the tombstone, so a
    // stale record (replayed control, orphan recovery) erased the delete and
    // re-published the group forever. A durable delete row must outrank it.
    const {deps, calls} = makeDeps([group(G1, 7_000_000)], [], [{groupId: G1, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
    expect(calls.removed).toEqual([G1]); // resurrection torn down in read()
  });

  it('ties go to the DELETE (> semantics, consistent with mergeEntry and the receive gates)', async() => {
    // Timestamps are seconds-floored, so a live record updated earlier in the
    // same second as the delete ties. Equality cannot mean a deliberate
    // re-create — the delete must win, exactly as mergeEntry resolves an
    // exact tie (tombstone wins, both argument orders).
    const {deps} = makeDeps([group(G1, 8_080_000)], [], [{groupId: G1, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('adapter read() and mergeEntry agree on a same-second tie (layers cannot disagree)', async() => {
    // The adapter gate and the CRDT merge must resolve the same tie the same
    // way, or a device whose relay is absent (adapter gate decides) diverges
    // from one that merged against the remote (mergeEntry decides).
    const {mergeEntry} = await import('@lib/phantomchat/sync-crdt');
    const {deps} = makeDeps([group(G1, 8_080_000)], [], [{groupId: G1, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true); // adapter: delete wins the tie
    const replayedLive = {id: G1, updatedAt: 8080, data: group(G1, 8_080_000)};
    expect(mergeEntry(map[G1], replayedLive).deleted).toBe(true); // merge: agrees
    expect(mergeEntry(replayedLive, map[G1]).deleted).toBe(true);
  });
});

describe('groups adapter read(): legacy watermark migration (round 7)', () => {
  // Kai's round-7 review of #179: an install that deleted groups before the
  // durable log existed only holds the conversation watermark. read() must
  // PROMOTE it into the durable log while no live record can shadow it, or
  // the first read that sees a stale live record skips the watermark as a
  // possible history watermark and the deleted group resurrects.

  it('promotes a legacy pre-durable-log tombstone into the durable log on first read', async() => {
    const {deps, calls} = makeDeps([], [{conversationId: `group:${G1}`, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
    expect(calls.recordedDeletes).toContainEqual({groupId: G1, deletedAt: 8080});
  });

  it('does not re-promote when the durable log already covers the watermark (idempotent)', async() => {
    const {deps, calls} = makeDeps(
      [],
      [{conversationId: `group:${G1}`, deletedAt: 8080}],
      [{groupId: G1, deletedAt: 8080}]
    );
    await createGroupsAdapter(deps).read();
    expect(calls.recordedDeletes).toHaveLength(0);
  });

  it('promotes a watermark NEWER than the durable row (max semantics)', async() => {
    const {deps, calls} = makeDeps(
      [],
      [{conversationId: `group:${G1}`, deletedAt: 9090}],
      [{groupId: G1, deletedAt: 7000}]
    );
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(9090);
    expect(calls.recordedDeletes).toContainEqual({groupId: G1, deletedAt: 9090});
  });

  it('round-trip: the promoted legacy delete survives a later stale live record', async() => {
    // End-to-end across two reads: first read promotes the legacy watermark
    // into the durable log; a stale record replays; the next read must tear
    // the resurrection down instead of muting the only delete evidence.
    const durableLog: DeletedGroup[] = [];
    const liveGroups: GroupRecord[] = [];
    const calls: Calls = {upserted: [], removed: [], tombstoned: [], recordedDeletes: [], clearedDeletes: []};
    const deps: GroupsAdapterDeps = {
      listGroups: async() => liveGroups,
      listTombstones: async() => [{conversationId: `group:${G1}`, deletedAt: 8080}],
      listDeletedGroups: async() => durableLog,
      recordDeletedGroup: async(groupId, deletedAt) => {
        calls.recordedDeletes.push({groupId, deletedAt});
        durableLog.push({groupId, deletedAt});
      },
      getLegacyDeleteCutoff: async() => CUTOFF,
      clearDeletedGroup: async(groupId) => { calls.clearedDeletes.push(groupId); },
      upsertGroup: async(record) => { calls.upserted.push(record); },
      removeGroup: async(groupId) => { calls.removed.push(groupId); },
      setTombstone: async(conversationId, deletedAt) => { calls.tombstoned.push({conversationId, deletedAt}); }
    };

    // Read 1: legacy tombstone only — group was deleted pre-durable-log.
    const first = await createGroupsAdapter(deps).read();
    expect(first[G1].deleted).toBe(true);
    expect(durableLog).toContainEqual({groupId: G1, deletedAt: 8080});

    // A stale record replays (relay blob / orphan recovery).
    liveGroups.push(group(G1, 7_000_000));

    // Read 2: the promoted durable delete wins and tears the resurrection down.
    const second = await createGroupsAdapter(deps).read();
    expect(second[G1].deleted).toBe(true);
    expect(second[G1].updatedAt).toBe(8080);
    expect(calls.removed).toEqual([G1]);
  });

  it('promotion failure is non-fatal: the derived delete still publishes this pass', async() => {
    const deps: GroupsAdapterDeps = {
      listGroups: async() => [],
      listTombstones: async() => [{conversationId: `group:${G1}`, deletedAt: 8080}],
      listDeletedGroups: async() => [],
      recordDeletedGroup: async() => { throw new Error('idb closed'); },
      getLegacyDeleteCutoff: async() => CUTOFF,
      clearDeletedGroup: async() => {},
      upsertGroup: async() => {},
      removeGroup: async() => {},
      setTombstone: async() => {}
    };
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('POST-cutoff watermark is NEVER promoted (Kai round 9: bounded migration, not an every-read rule)', async() => {
    // messages.deleteHistory keeps writing `group:<id>` watermarks after the
    // durable log exists — as clear-HISTORY marks while the group stays live.
    // If the durable log transiently lacks the record, an unbounded promotion
    // would mint an authoritative cross-device delete from that watermark.
    // A watermark stamped AFTER the durable-log install moment must never be
    // promoted — even with no live record and no durable row.
    const {deps, calls} = makeDeps(
      [],
      [{conversationId: `group:${G1}`, deletedAt: 8080}],
      [],
      8000 // cutoff before the watermark
    );
    const map = await createGroupsAdapter(deps).read();
    expect(calls.recordedDeletes).toHaveLength(0);
    // The derived delete still publishes this pass (watermark contributes
    // while no live record shadows it) — only the durable PROMOTION is gated.
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('POST-cutoff watermark under a later stale live record cannot resurrect a phantom delete', async() => {
    // The failure mode Kai flagged: clear-history watermark + transient
    // durable-log gap + stale live record. Post-cutoff, the promotion must
    // not fire, so a later live record is never torn down by an invented
    // durable delete.
    const {deps, calls} = makeDeps(
      [group(G1, 7_000_000)],
      [{conversationId: `group:${G1}`, deletedAt: 8080}],
      [],
      8000
    );
    const map = await createGroupsAdapter(deps).read();
    expect(calls.recordedDeletes).toHaveLength(0);
    expect(map[G1].deleted).toBeFalsy();
  });

  it('EXACT-cutoff watermark (deletedAt == cutoff) is NEVER promoted — strict boundary (Kai round 11)', async() => {
    // Tombstone stamps are seconds-floored, so a watermark carrying the
    // upgrade's own second is order-ambiguous: it may predate the upgrade
    // (legacy delete) or follow it (a clear-history watermark from code that
    // also writes durable rows). Ambiguity must resolve AGAINST promotion —
    // the old `<=` promoted a post-upgrade same-second clear-history
    // watermark into an authoritative durable group delete.
    const {deps, calls} = makeDeps(
      [],
      [{conversationId: `group:${G1}`, deletedAt: 8080}],
      [],
      8080 // cutoff == watermark stamp
    );
    const map = await createGroupsAdapter(deps).read();
    expect(calls.recordedDeletes).toHaveLength(0);
    // The derived delete still publishes this pass — only the durable
    // PROMOTION is gated on the strict boundary.
    expect(map[G1].deleted).toBe(true);
    expect(map[G1].updatedAt).toBe(8080);
  });

  it('watermark one second before the cutoff still promotes (legacy window open up to the boundary)', async() => {
    const {deps, calls} = makeDeps(
      [],
      [{conversationId: `group:${G1}`, deletedAt: 8079}],
      [],
      8080
    );
    await createGroupsAdapter(deps).read();
    expect(calls.recordedDeletes).toContainEqual({groupId: G1, deletedAt: 8079});
  });

  it('PRE-cutoff watermark still promotes (migration window stays open until it succeeds)', async() => {
    const {deps, calls} = makeDeps(
      [],
      [{conversationId: `group:${G1}`, deletedAt: 8080}],
      [],
      9000
    );
    await createGroupsAdapter(deps).read();
    expect(calls.recordedDeletes).toContainEqual({groupId: G1, deletedAt: 8080});
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
    expect(calls.recordedDeletes).toEqual([{groupId: G1, deletedAt: 9000}]);
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
    // ...and the delete is recorded durably so THIS device can re-publish it.
    expect(calls.recordedDeletes).toEqual([{groupId: G1, deletedAt: 9000}]);
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
    expect(calls.recordedDeletes).toEqual([{groupId: G1, deletedAt: 8080}]);
  });

  it('resurrection self-heal in read(): a live record that LOSES to a DURABLE delete is removed from the store', async() => {
    // The already-resurrected device never reaches apply(): read() overrides
    // the stale record with the delete, merged == local, so the engine
    // skips apply entirely. read() itself must tear the resurrection down or
    // the group stays in the local store and chat list indefinitely.
    const {deps, calls} = makeDeps([group(G1, 7_000_000)], [], [{groupId: G1, deletedAt: 8080}]);
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBe(true);
    expect(calls.removed).toEqual([G1]);
  });

  it('read() teardown of a re-created group never fires when the deliberate stamp outranks the durable delete', async() => {
    // The deliberate re-create path must not be torn down or mutated. Under
    // #180 "re-created" means STAMPED — a plain newer updatedAt no longer
    // spares the record (see the #180 tests above).
    const {deps, calls} = makeDeps(
      [group(G1, 9_000_000, 'Team', 8_500_000)],
      [],
      [{groupId: G1, deletedAt: 8080}]
    );
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
    expect(calls.removed).toEqual([]);
  });

  it('a bare WATERMARK newer than the live record leaves the group live (clear-history, not delete)', async() => {
    // Robert's round-5 regression for #179: deleteHistory writes a group:<id>
    // tombstone as a history watermark while the group stays live. That
    // watermark is newer than updatedAt (which only moves on
    // updateMembers/updateInfo) — the old read() tore the LIVE group down
    // and every other device followed. Only a durable delete may win.
    const {deps, calls} = makeDeps(
      [group(G1, 7_000_000)],
      [{conversationId: `group:${G1}`, deletedAt: 8080}]
    );
    const map = await createGroupsAdapter(deps).read();
    expect(map[G1].deleted).toBeFalsy();
    expect(map[G1].updatedAt).toBe(7000);
    expect(calls.removed).toEqual([]);
  });

  it('apply(): a live entry winning over prev.deleted clears the durable delete (deliberate re-create)', async() => {
    // Mirrors clearDeletedPeer in the contacts adapter: when a remote LIVE
    // entry legitimately beats this device's delete, the durable row must
    // go, or read() tears the re-created group back down on the next pass.
    const {deps, calls} = makeDeps([], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 8080, deleted: true}};
    const merged: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 9000, data: group(G1, 9_000_000)}};
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.clearedDeletes).toEqual([G1]);
    expect(calls.upserted).toHaveLength(1);
  });

  it('#180: a remote deliberate re-create persists its stamp into the local record', async() => {
    // The merged entry's entry-level stamp is the one that survived the merge
    // (max-forwarded); the saved record must carry it, or this device's next
    // read() exports an unstamped entry and loses a later tombstone compare.
    const {deps, calls} = makeDeps([], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 8080, deleted: true}};
    const merged: SyncMap<GroupRecord> = {
      [G1]: {id: G1, updatedAt: 9000, deliberateAddAt: 8600, data: group(G1, 9_000_000)}
    };
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0].deliberateAddAt).toBe(8_600_000); // seconds -> millis
    expect(calls.clearedDeletes).toEqual([G1]);
  });

  it('#180: a stamp-only advance upserts without a name/updatedAt change', async() => {
    // A live/live merge forwarded the max stamp onto the winner without
    // moving updatedAt — the local record must still learn the proof.
    const {deps, calls} = makeDeps([group(G1, 7_000_000, 'Team')], []);
    const before: SyncMap<GroupRecord> = {[G1]: {id: G1, updatedAt: 7000, data: group(G1, 7_000_000, 'Team')}};
    const merged: SyncMap<GroupRecord> = {
      [G1]: {id: G1, updatedAt: 7000, deliberateAddAt: 8000, data: group(G1, 7_000_000, 'Team')}
    };
    await createGroupsAdapter(deps).apply(merged, before);
    expect(calls.upserted).toHaveLength(1);
    expect(calls.upserted[0].deliberateAddAt).toBe(8_000_000);
    expect(calls.upserted[0].name).toBe('Team');
  });
});
