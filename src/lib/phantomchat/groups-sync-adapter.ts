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
 * Tombstones are DERIVED, not logged: a group delete removes the store record
 * and writes a `group:<id>` conversation tombstone. So a deleted group is a
 * `group:<id>` tombstone whose group has no live record — and `read()` also
 * tears down any live record that LOSES the LWW compare (a resurrection), so
 * the derived rule self-heals instead of merely reporting the delete.
 */
import type {LocalAdapter} from './crdt-sync';
import type {SyncMap} from './sync-crdt';
import type {GroupRecord} from './group-types';

export type GroupsAdapterDeps = {
  listGroups: () => Promise<GroupRecord[]>;
  listTombstones: () => Promise<Array<{conversationId: string; deletedAt: number}>>;
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

    const tombstones = await deps.listTombstones();
    for(const t of tombstones) {
      if(!t.conversationId.startsWith(GROUP_PREFIX)) continue;
      const groupId = t.conversationId.slice(GROUP_PREFIX.length);
      if(!groupId) continue;
      // Timestamp compare, mirroring contacts-sync-adapter: a live record only
      // outranks the delete when it is NEWER than it (a deliberate re-create).
      // Unconditionally muting a tombstone because any live record exists is
      // the resurrection loop: an older record (stale sync blob, replayed
      // control message, orphan-recovery scan) must LOSE to the delete, not
      // erase it.
      const liveEntry = map[groupId];
      // Strict: on an exact tie the TOMBSTONE wins, matching mergeEntry's
      // invariant and the receive gates that reject timestampSec <= deletedAt.
      // Timestamps are seconds-floored, so a live record updated earlier in
      // the same second as the delete ties — equality cannot mean a deliberate
      // re-create, and letting the live record win here would resurrect it
      // whenever the relay is absent.
      if(liveEntry && liveEntry.updatedAt > t.deletedAt) continue;
      // A live record that LOST the compare is a resurrection: remove it from
      // the store, not just from the published map. With the strict compare a
      // converged device reports `deleted: true` here, so `apply()` never runs
      // (the engine skips it when merged == local) and wasLive in apply() is
      // false — leaving the teardown to apply() would strand the resurrected
      // group in the local store and chat list forever.
      if(liveEntry) {
        try {
          await deps.removeGroup(groupId);
        } catch(err) {
          console.warn(tag, 'read: teardown of resurrected group failed', groupId, err);
        }
      }
      map[groupId] = {id: groupId, updatedAt: t.deletedAt, deleted: true};
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
