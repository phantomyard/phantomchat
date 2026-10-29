/**
 * code-sessions-sync-adapter — plugs the Code Mode session store into the
 * generic union-merge CRDT engine (crdt-sync.ts), mirroring
 * contacts-sync-adapter / groups-sync-adapter.
 *
 * WHY A SEPARATE DOMAIN (#279)
 * Andrew's rule: sessions sync across devices. The GROUP gives us the thread
 * and its membership (it already rides `phantomchat.chat/groups`), but the
 * session's own intent — its rail title, whether that title is still the
 * auto-derived one, and whether it is archived — is not group data. Putting it
 * here keeps the group record untouched (no rename fights between "the chat's
 * name" and "my session label") and gives the flags a proper tombstone.
 *
 * DELETES ARE TERMINAL HERE, unlike contacts and groups.
 * A session's id is the id of a group minted FOR that session; deleting a
 * session can never be undone by re-creating the same id (a new session always
 * mints a new group id). So a tombstone does not need the deliberate-add dance
 * those domains need — a deleted session is deleted, whatever the clocks say.
 * read() therefore publishes the tombstone as authoritative and apply() tears
 * the record down.
 *
 * Timestamps: CRDT `updatedAt` is unix SECONDS (the engine's clock);
 * CodeSessionRecord.updatedAt is millis, and the tombstone store speaks
 * seconds. Normalised in read(), restored to millis in apply().
 */
import type {LocalAdapter} from './crdt-sync';
import type {SyncMap} from './sync-crdt';
import type {CodeSessionRecord, CodeSessionTombstone} from './code-sessions-db';

/** The payload published per session. Local activity/badges are NOT synced. */
export type CodeSessionSyncData = {
  groupId: string;
  title: string;
  autoNamed: boolean;
  archived: boolean;
  peerPubkey: string;
  createdAt: number;
};

export type CodeSessionsAdapterDeps = {
  listSessions: () => Promise<CodeSessionRecord[]>;
  listTombstones: () => Promise<CodeSessionTombstone[]>;
  saveSession: (record: CodeSessionRecord) => Promise<void>;
  deleteSession: (groupId: string) => Promise<void>;
  recordDeleted: (groupId: string, deletedAtSeconds: number) => Promise<void>;
  /** Local-only turn state is meaningless for a deleted session. */
  forgetRuntime?: (groupId: string) => Promise<void>;
  logPrefix?: string;
};

function toSyncData(record: CodeSessionRecord): CodeSessionSyncData {
  return {
    groupId: record.groupId,
    title: record.title,
    autoNamed: !!record.autoNamed,
    archived: !!record.archived,
    peerPubkey: record.peerPubkey,
    createdAt: record.createdAt
  };
}

export function createCodeSessionsAdapter(deps: CodeSessionsAdapterDeps): LocalAdapter<CodeSessionSyncData> {
  const tag = deps.logPrefix || '[code-sessions-sync-adapter]';

  const read = async(): Promise<SyncMap<CodeSessionSyncData>> => {
    const map: SyncMap<CodeSessionSyncData> = {};

    for(const record of await deps.listSessions()) {
      if(!record?.groupId) continue;
      map[record.groupId] = {
        id: record.groupId,
        updatedAt: Math.floor((record.updatedAt || record.createdAt || 0) / 1000),
        data: toSyncData(record)
      };
    }

    // Tombstones are terminal (see the header). A deleted entry REPLACES any
    // live record in the published map, so a stale blob can never win back.
    for(const tombstone of await deps.listTombstones()) {
      if(!tombstone?.groupId || !(tombstone.deletedAt > 0)) continue;
      map[tombstone.groupId] = {id: tombstone.groupId, updatedAt: tombstone.deletedAt, deleted: true};

      // A live record that survived a delete learned elsewhere is a
      // resurrection: apply() is skipped when the merge is a no-op, so the
      // teardown has to happen here or the row sits in the rail forever.
      if(map[tombstone.groupId] && await deps.listSessions().then((sessions) => sessions.some((s) => s.groupId === tombstone.groupId))) {
        try {
          await deps.deleteSession(tombstone.groupId);
          await deps.forgetRuntime?.(tombstone.groupId);
        } catch(err) {
          console.warn(tag, 'read: teardown of deleted session failed', tombstone.groupId, err);
        }
      }
    }

    return map;
  };

  const apply = async(merged: SyncMap<CodeSessionSyncData>, before: SyncMap<CodeSessionSyncData>): Promise<void> => {
    for(const id of Object.keys(merged)) {
      const entry = merged[id];
      const prev = before[id];

      try {
        if(entry.deleted) {
          await deps.recordDeleted(id, entry.updatedAt);
          await deps.deleteSession(id);
          await deps.forgetRuntime?.(id);
          continue;
        }

        const data = entry.data;
        if(!data) continue;

        const wasLive = !!prev && !prev.deleted;
        // Restore when the remote is new to us, newer than us, or archived
        // differently — the archive flag is a boolean register, so a remote
        // flip must be applied even if its clock is only equal.
        const archivedChanged = wasLive && prev.data?.archived !== data.archived;
        if(wasLive && entry.updatedAt <= prev.updatedAt && !archivedChanged) continue;

        await deps.saveSession({
          groupId: id,
          title: data.title,
          autoNamed: data.autoNamed,
          archived: data.archived,
          peerPubkey: data.peerPubkey,
          createdAt: data.createdAt,
          // Pin to the merged clock (millis) so read() derives the same
          // seconds back and the maps converge.
          updatedAt: entry.updatedAt * 1000
        });
      } catch(err) {
        console.warn(tag, 'apply failed for', id, err);
      }
    }
  };

  return {read, apply};
}

export const CODE_SESSIONS_SYNC_D_TAG = 'phantomchat.chat/code-sessions';
export const CODE_SESSIONS_SYNC_VERSION = 1;
export const CODE_SESSIONS_SYNC_ACCEPTED_VERSIONS = [CODE_SESSIONS_SYNC_VERSION];
