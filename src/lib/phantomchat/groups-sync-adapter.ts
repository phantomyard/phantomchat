/**
 * groups-sync-adapter — plugs the group store into the union-merge CRDT engine,
 * mirroring contacts-sync-adapter.
 *
 * Groups are simpler than contacts in one respect: a GroupRecord already
 * carries an `updatedAt` (bumped by updateMembers / updateInfo), so no schema
 * migration was needed. The record IS the sync payload.
 *
 * Same timestamp discipline as contacts: CRDT `updatedAt` is in **seconds**
 * (the engine's clock), while GroupRecord.updatedAt and the `group:<id>`
 * conversation tombstone speak millis and seconds respectively. Both are
 * normalised to seconds in `read()` and restored to millis on `apply()`, so a
 * live group and a group delete are comparable on the same axis.
 *
 * Deletions are published from a DURABLE deleted-groups log (recorded by
 * GroupAPI's real delete paths), NOT inferred from `group:<id>` conversation
 * tombstones — those are also written by messages.deleteHistory as a mere
 * history watermark while the group stays live, so they may only contribute
 * for groups with no live record (PR #179, review round 5). A resurrected
 * live record that LOSES the LWW compare against a durable delete is torn
 * down by `read()` itself, so the derived rule self-heals instead of merely
 * reporting the delete.
 */
import type {LocalAdapter} from './crdt-sync';
import type {SyncMap} from './sync-crdt';
import type {GroupRecord} from './group-types';
import type {DeletedGroupRecord} from './group-store';

export type GroupsAdapterDeps = {
  listGroups: () => Promise<GroupRecord[]>;
  listTombstones: () => Promise<Array<{conversationId: string; deletedAt: number}>>;
  /** Durable deleted-groups log (PR #179 round 5) — the positive delete fact,
   * independent of conversation watermarks. See recordDeletedGroup. */
  listDeletedGroups: () => Promise<Array<DeletedGroupRecord>>;
  recordDeletedGroup: (groupId: string, deletedAtSeconds: number) => Promise<void>;
  clearDeletedGroup: (groupId: string) => Promise<void>;
  /** Save + materialize a group (store.save + service row + inject dialog). */
  upsertGroup: (record: GroupRecord) => Promise<void>;
  /** Local teardown: delete record + cleanup mirror. */
  removeGroup: (groupId: string) => Promise<void>;
  setTombstone: (conversationId: string, deletedAtSeconds: number) => Promise<void>;
  logPrefix?: string;
};

const GROUP_PREFIX = 'group:';

export function createGroupsAdapter(deps: GroupsAdapterDeps): LocalAdapter<GroupRecord> {
  const tag = deps.logPrefix || '[groups-sync-adapter]';

  const read = async(): Promise<SyncMap<GroupRecord>> => {
    const map: SyncMap<GroupRecord> = {};

    const groups = await deps.listGroups();
    for(const g of groups) {
      map[g.groupId] = {
        id: g.groupId,
        updatedAt: Math.floor((g.updatedAt ?? g.createdAt ?? 0) / 1000),
        data: g
      };
    }

    // Deletions: the durable log first (positive delete evidence), then the
    // legacy derived watermarks. Latest stamp per group wins. The two sources
    // are NOT equivalent: a `group:<id>` conversation tombstone is also
    // written by messages.deleteHistory / channels.deleteHistory as a HISTORY
    // watermark while the group stays live — so a watermark under a LIVE
    // record must never delete the group (Robert's round-5 review of #179).
    // Watermarks therefore only contribute for groups with no live record,
    // and only DURABLE rows may tear a resurrected group down.
    const deletes = new Map<string, number>();
    const durable = new Map<string, number>();
    for(const d of await deps.listDeletedGroups()) {
      if(!(d.deletedAt > 0)) continue;
      durable.set(d.groupId, d.deletedAt);
      deletes.set(d.groupId, Math.max(deletes.get(d.groupId) ?? 0, d.deletedAt));
    }

    const tombstones = await deps.listTombstones();
    for(const t of tombstones) {
      if(!t.conversationId.startsWith(GROUP_PREFIX)) continue;
      const groupId = t.conversationId.slice(GROUP_PREFIX.length);
      if(!groupId) continue;
      // A watermark is only evidence of a GROUP delete when the record is
      // gone — with a live record it may just be "cleared history".
      if(map[groupId]) continue;
      deletes.set(groupId, Math.max(deletes.get(groupId) ?? 0, t.deletedAt));
      // MIGRATE legacy pre-durable-log deletes (Kai's round-7 review of #179):
      // an install that deleted groups before the durable log existed only has
      // this watermark. Promote it into the durable log NOW, while no live
      // record can shadow it — otherwise the first read that DOES see a live
      // record (a stale group_create replay from a relay blob) skips the
      // watermark as a possible history watermark, and the deleted group
      // resurrects with nothing to tear it down. Only promote when the
      // watermark carries a fact the durable log doesn't already have;
      // recordDeletedGroup is monotonic, so this converges and is a no-op on
      // every later read.
      if((durable.get(groupId) ?? 0) < t.deletedAt) {
        try {
          await deps.recordDeletedGroup(groupId, t.deletedAt);
          durable.set(groupId, t.deletedAt);
        } catch(err) {
          // Non-fatal: the derived delete still publishes this pass; the
          // promotion is retried on the next read.
          console.warn(tag, 'read: legacy watermark promotion to durable log failed', groupId, err);
        }
      }
    }

    for(const [groupId, deletedAt] of deletes) {
      const liveEntry = map[groupId];
      // A live record only outranks the delete when it is NEWER than it — a
      // deliberate re-create. Strict compare: on an exact tie the DELETE wins,
      // matching mergeEntry's invariant and the receive gates that reject
      // timestampSec <= deletedAt. Timestamps are seconds-floored, so a live
      // record updated earlier in the same second as the delete ties, and
      // equality cannot mean a deliberate re-create.
      if(liveEntry && liveEntry.updatedAt > deletedAt) continue;
      // A live record that LOST to a DURABLE delete row is a resurrection:
      // remove it from the store, not just from the published map. With the
      // strict compare a converged device reports `deleted: true` here, so
      // `apply()` never runs (the engine skips it when merged == local) and
      // wasLive in apply() is false — leaving the teardown to apply() would
      // strand the resurrected group in the local store and chat list forever.
      // Watermark-sourced deletes never reach this branch with a live record
      // (skipped above) — the cleared-history rule is preserved.
      if(liveEntry) {
        try {
          await deps.removeGroup(groupId);
        } catch(err) {
          console.warn(tag, 'read: teardown of resurrected group failed', groupId, err);
        }
      }
      map[groupId] = {id: groupId, updatedAt: deletedAt, deleted: true};
    }

    return map;
  };

  const apply = async(merged: SyncMap<GroupRecord>, before: SyncMap<GroupRecord>): Promise<void> => {
    // Store reality at entry: `before` can mark an id `deleted` (read() overrode
    // a stale live record with a tombstone) while the record still sits in the
    // store, so wasLive alone can't tell "already torn down" from "resurrected".
    // Robert's review of #179: decide teardown from the store, not the map.
    let storeState: Map<string, GroupRecord> | null = null;
    try {
      const groups = await deps.listGroups();
      storeState = new Map(groups.map((g) => [g.groupId, g]));
    } catch(err) {
      console.warn(tag, 'apply: store snapshot failed; falling back to map-derived teardown', err);
    }

    for(const id of Object.keys(merged)) {
      const entry = merged[id];
      const prev = before[id];
      const wasLive = !!prev && !prev.deleted;

      try {
        if(entry.deleted) {
          // Persist the delete durably even when this device had nothing live:
          // a delete learned from another device must be re-publishable from
          // here too, otherwise this device contributes only an ABSENCE and a
          // stale blob elsewhere can revive the group again.
          await deps.recordDeletedGroup(id, entry.updatedAt);
          // Tear down whenever the store still holds the record — even when
          // wasLive is false (read() had already overridden a stale live
          // record with the tombstone, so the map lost the evidence).
          const stillStored = storeState ? storeState.has(id) : wasLive;
          if(stillStored) {
            await deps.removeGroup(id);
          }
          // Persist the tombstone even with no local record: a device that
          // never held the group must still remember the delete, or a
          // replayed group_create passes the absent-tombstone gate in
          // handleGroupCreate and resurrects the group stamped with a fresh
          // Date.now() that outranks the durable delete forever.
          await deps.setTombstone(`${GROUP_PREFIX}${id}`, entry.updatedAt);
          continue;
        }

        // entry live — restore or update when the remote mutation is newer.
        if(!wasLive || entry.updatedAt > prev.updatedAt) {
          if(!entry.data) continue;
          // A remote LIVE entry legitimately winning over a durable delete is
          // a deliberate re-create — drop the durable delete row (mirrors
          // clearDeletedPeer in the contacts adapter), or read() would tear
          // the restored group down on the next pass.
          if(prev?.deleted) await deps.clearDeletedGroup(id);
          // Pin updatedAt to the merged value (millis) so save() persists a
          // record whose read()-derived seconds match the remote → converged.
          const record: GroupRecord = {...entry.data, updatedAt: entry.updatedAt * 1000};
          await deps.upsertGroup(record);
        }
      } catch(err) {
        console.warn(tag, 'apply failed for', id, err);
      }
    }
  };

  return {read, apply};
}

export const GROUPS_SYNC_D_TAG = 'phantomchat.chat/groups';
export const GROUPS_SYNC_VERSION = 1;
