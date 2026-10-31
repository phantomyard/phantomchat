/**
 * Group class reconcile — repair records whose stored peerId was derived from
 * the WRONG class.
 *
 * Why this has to exist: a group's class (classic group vs session) is baked
 * into its peerId at FIRST INGEST (`groupIdToPeerId(groupId, kind)`), and
 * `isSessionPeer()` is a pure range test on that stored id. Folder membership is
 * the same test. Nothing re-derives the id afterwards:
 *
 *   - a `group_create` replay that would carry `groupKind` is dropped by the
 *     live-record guard (the record already exists);
 *   - `groups-sync-adapter.apply()` deliberately keeps the LOCAL kind, so a
 *     remote class can never re-key a device that already holds a record.
 *
 * So a device that ingested a session BEFORE the class existed — the batch-10
 * `tags: ['session']` era, or a classic-looking record with no class field at
 * all — keeps a group-range peerId forever: Groups claims the row and Sessions
 * stays empty, while a device that ingested it later (correct class) shows it in
 * Sessions. Same code, diverged local data. That is the reported split between
 * the PWA and the desktop build.
 *
 * The repair: adopt the class (explicit `kind`, else the legacy
 * `tags: ['session']` marker), re-derive the peerId, re-stamp the conversation's
 * rows (`group:<groupId>` keeps its key), move the dialog row onto the new peer
 * id, then save the record. Idempotent — a converged record costs one range test
 * and no writes.
 *
 * NOT a substitute for a real class-change protocol: `kind` is documented as
 * immutable after create, and this only ever repairs a record against its OWN
 * class marker. It never invents a class, and it never downgrades a session that
 * is already in the session range.
 */
import {groupIdToPeerId, isSessionPeer} from './group-types';
import type {GroupKind, GroupRecord} from './group-types';

/** The batch-10 class marker: `tags: ['session']`, retired by the peer-class
 *  refactor. Records written by that build still carry it and nothing reads it. */
export const LEGACY_SESSION_TAG = 'session';

/** A stored record as it actually exists on disk: the retired `tags` field is
 *  not in the type any more, but batch-10 records still carry it. */
type StoredGroupRecord = GroupRecord & {tags?: unknown};

/**
 * The class a record is SUPPOSED to have. An explicit `kind` wins; a legacy
 * `tags: ['session']` marker is the only other evidence, and everything else is
 * a classic group (the pre-class default).
 */
export function intendedGroupKind(record: Pick<GroupRecord, 'kind'> & {tags?: unknown}): GroupKind {
  if(record.kind === 'session' || record.kind === 'group') return record.kind;
  const tags = record.tags;
  return Array.isArray(tags) && tags.includes(LEGACY_SESSION_TAG) ? 'session' : 'group';
}

export type GroupClassReconcileDeps = {
  listGroups: () => Promise<StoredGroupRecord[]>;
  saveGroup: (record: GroupRecord) => Promise<void>;
  /** Re-stamp a conversation's stored rows onto a new tweb peer id. */
  rekeyConversation: (conversationId: string, twebPeerId: number) => Promise<number>;
  /** Move the persisted dialog row + its mirrors onto a new peer id. */
  relocateDialog: (args: {record: GroupRecord; fromPeerId: number; toPeerId: number}) => Promise<void>;
  log?: (...args: any[]) => void;
};

export interface GroupClassRepair {
  groupId: string;
  kind: GroupKind;
  fromPeerId: number;
  toPeerId: number;
  /** Only the record was normalised — the peerId was already canonical. */
  recordOnly: boolean;
}

/** Drop the retired `tags` field and set the class, for a store write. */
function normalised(record: StoredGroupRecord, kind: GroupKind, peerId?: number): GroupRecord {
  const next: StoredGroupRecord = {...record, kind};
  delete next.tags;
  if(peerId !== undefined) next.peerId = peerId;
  return next;
}

/**
 * One pass over the group store. Returns the repairs applied (empty = converged).
 *
 * A record is SKIPPED unless it disagrees with itself: either an explicit `kind`
 * contradicts the peerId's range, or a legacy `session` tag is present with no
 * class field. A plain classic group — the overwhelming majority — therefore
 * costs one boolean and no hash.
 */
export async function reconcileGroupPeerClasses(
  deps: GroupClassReconcileDeps
): Promise<GroupClassRepair[]> {
  let records: StoredGroupRecord[];
  try {
    records = await deps.listGroups();
  } catch(err) {
    deps.log?.('group store unreadable — skipping', err);
    return [];
  }

  const repairs: GroupClassRepair[] = [];
  for(const record of records) {
    if(!record?.groupId || typeof record.peerId !== 'number') continue;

    const kind = intendedGroupKind(record);
    const hasLegacyTags = Array.isArray(record.tags) && record.tags.length > 0;
    // Cheap self-contradiction test: an explicit class that disagrees with the
    // peerId's range, or a tag-era session with no class field at all.
    const classDisagrees = record.kind === 'session' ? !isSessionPeer(record.peerId) :
      record.kind === 'group' ? isSessionPeer(record.peerId) : false;
    const legacyTagged = !record.kind && kind === 'session';

    if(!classDisagrees && !legacyTagged) {
      // Converged. Still stamp a missing class field once, so later boots short-
      // circuit on the range test alone. `save()` is a raw put — it does not
      // touch updatedAt, so this can never publish a CRDT mutation.
      if(record.kind !== kind || hasLegacyTags) {
        try {
          await deps.saveGroup(normalised(record, kind));
        } catch(err) {
          deps.log?.('record normalise failed for', record.groupId.slice(0, 8), err);
        }
      }
      continue;
    }

    let canonical: number;
    try {
      canonical = await groupIdToPeerId(record.groupId, kind);
    } catch(err) {
      deps.log?.('peer-id derivation failed for', record.groupId.slice(0, 8), err);
      continue;
    }

    if(canonical === record.peerId) {
      // Only the class field / tags were missing — nothing to re-key.
      try {
        await deps.saveGroup(normalised(record, kind));
        repairs.push({groupId: record.groupId, kind, fromPeerId: record.peerId, toPeerId: canonical, recordOnly: true});
      } catch(err) {
        deps.log?.('record normalise failed for', record.groupId.slice(0, 8), err);
      }
      continue;
    }

    // Real re-key. Order matters: history, then the dialog row, then the record.
    // A crash mid-way is safe because the record still claims the OLD peerId, so
    // the next boot re-runs the same idempotent steps.
    const migrated = normalised(record, kind, canonical);
    try {
      await deps.rekeyConversation(`group:${record.groupId}`, canonical);
      await deps.relocateDialog({record: migrated, fromPeerId: record.peerId, toPeerId: canonical});
      await deps.saveGroup(migrated);
      repairs.push({groupId: record.groupId, kind, fromPeerId: record.peerId, toPeerId: canonical, recordOnly: false});
      deps.log?.('re-keyed', record.groupId.slice(-8), record.peerId, '→', canonical, `(${kind})`);
    } catch(err) {
      // A peerId collision (the unique store index) is the realistic failure:
      // log and leave the record alone — the old id still renders, nothing is
      // half-migrated.
      deps.log?.('class re-key failed for', record.groupId.slice(0, 8), err);
    }
  }

  return repairs;
}
