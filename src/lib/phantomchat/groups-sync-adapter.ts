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
  /** Unix-SECOND stamp of the durable-log install moment (GroupStore meta,
   * written at DB v2 creation/upgrade). Bounds the legacy watermark migration:
   * only watermarks at or before this stamp may be promoted into the durable
   * log — post-cutoff watermarks are clear-history artifacts, never deletes. */
  getLegacyDeleteCutoff: () => Promise<number>;
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
        data: g,
        // The user-intent proof (#180): stamped only by GroupAPI.createGroup
        // (the user's own create gesture) and persisted from remote entries
        // by apply(). Absent = unproven, which is the conservative answer.
        ...(g.deliberateAddAt ? {deliberateAddAt: Math.floor(g.deliberateAddAt / 1000)} : {})
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
    // Legacy migration is EPOCH-BOUNDED, not an every-read inference rule
    // (Kai's round-9 review of #179). messages.deleteHistory keeps writing
    // `group:<id>` watermarks post-release for clear-history while the group
    // stays live — if the durable log transiently lacks a record (startup /
    // recovery window), an unbounded promotion would mint an authoritative
    // cross-device delete from a history watermark. So promotion applies ONLY
    // to watermarks stamped strictly BEFORE the durable-log install second
    // (recorded atomically at DB v2 creation/upgrade; Kai's round-11 review
    // of #179): seconds-floored stamps make equality with the upgrade second
    // order-ambiguous, and ambiguity resolves against promotion. Those
    // eligible may be legacy deletions from before positive delete facts
    // existed; anything later was authored by code that writes durable rows
    // itself. Failed promotions
    // stay retryable on later reads while eligible — the bound is the epoch,
    // not a one-shot flag, so a transient IndexedDB failure cannot permanently
    // lose a legacy delete.
    const cutoffSec = await deps.getLegacyDeleteCutoff();
    for(const t of tombstones) {
      if(!t.conversationId.startsWith(GROUP_PREFIX)) continue;
      const groupId = t.conversationId.slice(GROUP_PREFIX.length);
      if(!groupId) continue;
      // A watermark is only evidence of a GROUP delete when the record is
      // gone — with a live record it may just be "cleared history".
      if(map[groupId]) continue;
      deletes.set(groupId, Math.max(deletes.get(groupId) ?? 0, t.deletedAt));
      // MIGRATE legacy pre-durable-log deletes (Kai's round-7 review of
      // #179): an install that deleted groups before the durable log existed
      // only has this watermark. Promote it into the durable log NOW, while
      // no live record can shadow it — otherwise the first read that DOES see
      // a live record (a stale group_create replay from a relay blob) skips
      // the watermark as a possible history watermark, and the deleted group
      // resurrects with nothing to tear it down. Epoch-bounded with a STRICT
      // boundary (Kai's round-11 review of #179): only watermarks from
      // seconds that fully elapsed before the durable-log install stamp are
      // eligible (see above) — equality is ambiguous (seconds-floored
      // stamps) and resolves AGAINST promotion: a false durable delete is an
      // irreversible cross-device group deletion, while a missed promotion
      // only forfeits durability for groups deleted inside that one upgrade
      // second — and the derived delete still publishes from the watermark
      // on this very read. recordDeletedGroup is monotonic, so promotion
      // converges to a no-op.
      if(t.deletedAt < cutoffSec && (durable.get(groupId) ?? 0) < t.deletedAt) {
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
      // A live record clears the durable delete ONLY when its deliberate-add
      // stamp is strictly NEWER than the delete (#180) — the user re-created
      // the group after deleting it. A plain newer `updatedAt` no longer
      // counts: automatic paths (handleGroupCreate replays, stale pre-#180
      // clients) mint current timestamps without intent. A live group's delete
      // stamp is always durable-sourced here (watermarks are skipped under a
      // live record above — cleared-history rule), so the row being cleared IS
      // the durable row the re-create outranks. Strict compare: seconds-floored
      // stamps make equality ambiguous, and ambiguity resolves against
      // resurrection.
      if(
        liveEntry &&
        typeof liveEntry.deliberateAddAt === 'number' &&
        liveEntry.deliberateAddAt > deletedAt
      ) {
        try {
          await deps.clearDeletedGroup(groupId);
        } catch(err) {
          console.warn(tag, 'read: clearing durable delete for deliberate re-create failed', groupId, err);
        }
        continue;
      }
      // A live record without a deliberate-add proof is a resurrection:
      // remove it from the store, not just from the published map. With the
      // stamp rule a converged device reports `deleted: true` here, so
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

    // Durable delete ids, hoisted once for the rebind resurrection guard.
    // null = the log is unreadable → the guard is skipped entirely.
    let deletedIds: Set<string> | null;
    try {
      deletedIds = new Set((await deps.listDeletedGroups()).map((d) => d.groupId));
    } catch(err) {
      console.warn(tag, 'apply: deletedGroups read failed; skipping rebind guard', err);
      deletedIds = null;
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
        // A stamp-only advance (live/live merge forwarded the max stamp onto
        // the winner) also fires, so the local record carries the proof (#180).
        const stampAdvanced =
          typeof entry.deliberateAddAt === 'number' &&
          entry.deliberateAddAt > (prev?.deliberateAddAt ?? 0);
        if(!wasLive || entry.updatedAt > prev.updatedAt || stampAdvanced) {
          if(!entry.data) continue;
          // REBIND RESURRECTION GUARD (duplicate-groups regression 2026-10-04):
          // a rebind successor record carries a FRESH bound id — the durable
          // delete a departed member holds is keyed on the LEGACY id and
          // can't block it. On a device with neither a live legacy record nor
          // a live successor of that legacy id, the durable delete is this
          // device's authority that the group is GONE: skip the upsert or
          // the group they left comes back under the new id. A device holding
          // a live legacy record (successor synced before the supersede
          // create retired it) or a live successor (the normal post-migration
          // end-state — the durable row for the RETIRED legacy id is expected
          // there) upserts as before. Unreadable delete log → no skip (fail
          // open on sync continuity, not closed).
          const supersededIds = entry.data.supersededGroupIds ?? [];
          if(supersededIds.length > 0 && deletedIds !== null) {
            let resurrectsDepartedGroup = false;
            for(const sid of supersededIds) {
              if(!deletedIds.has(sid)) continue;
              const liveLegacy = storeState ? storeState.has(sid) : true;
              const liveSuccessor = storeState ?
                [...storeState.values()].some((g) => (g.supersededGroupIds ?? []).includes(sid)) :
                true;
              if(!liveLegacy && !liveSuccessor) {
                resurrectsDepartedGroup = true;
                break;
              }
            }
            if(resurrectsDepartedGroup) {
              console.warn(tag, 'apply: skipping successor record for durably-deleted legacy group (departed member):', id);
              continue;
            }
          }
          // A remote LIVE entry legitimately winning over a durable delete is
          // a deliberate re-create — drop the durable delete row (mirrors
          // clearDeletedPeer in the contacts adapter), or read() would tear
          // the restored group down on the next pass.
          if(prev?.deleted) await deps.clearDeletedGroup(id);
          // Pin updatedAt to the merged value (millis) so save() persists a
          // record whose read()-derived seconds match the remote → converged.
          // The record's deliberateAddAt comes from the entry-level stamp —
          // it is the value that survived the merge (max-forwarded), and the
          // data copy may lag it by a merge hop.
          const record: GroupRecord = {
            ...entry.data,
            updatedAt: entry.updatedAt * 1000
          };
          if(typeof entry.deliberateAddAt === 'number') {
            record.deliberateAddAt = entry.deliberateAddAt * 1000;
          }
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
/** v2 (#180): entries may carry `deliberateAddAt`; a fresh `updatedAt` alone
 * no longer clears a durable delete. v1 snapshots are still read (see
 * CrdtSyncDeps.acceptedVersions) and republished at v2. */
export const GROUPS_SYNC_VERSION = 2;
export const GROUPS_SYNC_ACCEPTED_VERSIONS = [1, GROUPS_SYNC_VERSION];
