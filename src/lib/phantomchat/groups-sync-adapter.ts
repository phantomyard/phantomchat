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
 * `group:<id>` tombstone whose group has no live record.
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
    const live = new Set<string>();
    for(const g of groups) {
      live.add(g.groupId);
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
      if(!groupId || live.has(groupId)) continue;
      map[groupId] = {id: groupId, updatedAt: t.deletedAt, deleted: true};
    }

    return map;
  };

  const apply = async(merged: SyncMap<GroupRecord>, before: SyncMap<GroupRecord>): Promise<void> => {
    for(const id of Object.keys(merged)) {
      const entry = merged[id];
      const prev = before[id];
      const wasLive = !!prev && !prev.deleted;

      try {
        if(entry.deleted) {
          if(wasLive) {
            await deps.removeGroup(id);
            await deps.setTombstone(`${GROUP_PREFIX}${id}`, entry.updatedAt);
          }
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
