import {logSwallow} from './log-swallow';

export const LS_KEY_LAST_PUBLISHED = 'nostra-folders-last-published';
export const LS_KEY_LAST_MODIFIED = 'nostra-folders-last-modified';

function readTs(key: string): number {
  try {
    const v = localStorage.getItem(key);
    if(!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch{
    return 0;
  }
}

function writeTs(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch(e) { logSwallow('FoldersSyncState.writeTs:' + key, e); }
}

export const getLastPublishedAt = (): number => readTs(LS_KEY_LAST_PUBLISHED);
export const setLastPublishedAt = (v: number): void => writeTs(LS_KEY_LAST_PUBLISHED, v);
export const getLastModifiedAt = (): number => readTs(LS_KEY_LAST_MODIFIED);
export const setLastModifiedAt = (v: number): void => writeTs(LS_KEY_LAST_MODIFIED, v);
