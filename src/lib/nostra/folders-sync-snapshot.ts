import type {MyDialogFilter} from '@lib/storages/filters';
import type {FolderSnapshot} from '@lib/nostra/folders-sync-types';
import {FOLDERS_SYNC_VERSION} from '@lib/nostra/folders-sync-types';
import {isDefaultLocalTitle} from '@lib/storages/filtersLocal';
import {START_LOCAL_ID, PROTECTED_FOLDERS} from '@appManagers/constants';
import copy from '@helpers/object/copy';

/**
 * Serializes the user's current filter array into a snapshot suitable for
 * publishing to Nostr. System folder definitions are NEVER included — they
 * are re-seeded locally by prependFilters(). Only their order (in `order`)
 * and user renames (in `protectedTitles`) travel across the wire.
 */
export function buildSnapshotFromFilters(filters: MyDialogFilter[]): FolderSnapshot {
  const order = filters.map((f) => f.id);
  const customFolders = filters
  .filter((f) => f.id >= START_LOCAL_ID)
  .map((f) => copy(f));

  const protectedTitles: Record<number, MyDialogFilter['title']> = {};
  for(const f of filters) {
    if(!PROTECTED_FOLDERS.has(f.id)) continue;
    const text = (f as any).title?.text ?? '';
    if(!isDefaultLocalTitle(f.id, text)) {
      protectedTitles[f.id] = copy((f as any).title);
    }
  }

  return {
    version: FOLDERS_SYNC_VERSION,
    order,
    customFolders,
    protectedTitles
  };
}

/**
 * Applies a remote snapshot to the caller's local filters. System folders
 * are preserved from the local array (carrying their generated pFlags and
 * pinned peers), with protectedTitles overlaid. Custom folders come entirely
 * from the snapshot.
 *
 * The result is ordered by snapshot.order. System folders missing from the
 * remote order are appended at the end so the caller's subsequent
 * prependFilters() call re-slots them.
 */
export function applySnapshotToFilters(
  local: MyDialogFilter[],
  snapshot: FolderSnapshot
): MyDialogFilter[] {
  const byId = new Map<number, MyDialogFilter>();

  // System folders come from local (preserves generated pFlags + pinned peers)
  for(const f of local) {
    if(PROTECTED_FOLDERS.has(f.id)) {
      const overlay = snapshot.protectedTitles?.[f.id];
      byId.set(f.id, overlay ? ({...f, title: overlay} as MyDialogFilter) : f);
    }
  }

  // Custom folders come from snapshot
  for(const f of snapshot.customFolders) {
    byId.set(f.id, copy(f));
  }

  const out: MyDialogFilter[] = [];
  for(const id of snapshot.order) {
    const f = byId.get(id);
    if(f) out.push(f);
  }

  // Append any system folder the remote order forgot
  for(const f of local) {
    if(PROTECTED_FOLDERS.has(f.id) && !out.find((x) => x.id === f.id)) {
      out.push(f);
    }
  }

  return out;
}
