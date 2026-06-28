import type {MyDialogFilter} from '@lib/storages/filters';
import type {DialogFilter} from '@layer';

export const FOLDERS_SYNC_VERSION = 1;
export const FOLDERS_SYNC_D_TAG = 'phantomchat.chat/folders';
export const FOLDERS_SYNC_KIND = 30078;

// rootScope events that must mark folders as locally modified + schedule a
// publish. MUST include 'filter_new' — a freshly created folder dispatches
// only 'filter_new' (filters.ts saveDialogFilter), so omitting it meant new
// folders never bumped localModifiedAt nor published, and a stale remote
// snapshot wiped them on the next boot (reconcile -> remote-wins).
export const FOLDER_SYNC_TRIGGER_EVENTS = [
  'filter_new',
  'filter_update',
  'filter_delete',
  'filter_order'
] as const;

export type FolderTitle = DialogFilter.dialogFilter['title'];

export type FolderSnapshot = {
  version: number;
  order: number[];                        // full order including system IDs
  customFolders: MyDialogFilter[];        // only IDs >= START_LOCAL_ID (4)
  protectedTitles?: Record<number, FolderTitle>;
};

export function isValidSnapshot(obj: unknown): obj is FolderSnapshot {
  if(!obj || typeof obj !== 'object') return false;
  const s = obj as FolderSnapshot;
  return (
    typeof s.version === 'number' &&
    Array.isArray(s.order) &&
    s.order.every((n) => typeof n === 'number') &&
    Array.isArray(s.customFolders)
  );
}
