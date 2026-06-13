import type {MyDialogFilter} from '@lib/storages/filters';
import type {DialogFilter} from '@layer';

export const FOLDERS_SYNC_VERSION = 1;
export const FOLDERS_SYNC_D_TAG = 'nostra.chat/folders';
export const FOLDERS_SYNC_KIND = 30078;

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
