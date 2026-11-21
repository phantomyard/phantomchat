import {stableStringify} from './sync-crdt';

export const CATALOG_TAG = 'phantomchat.chat/catalog-v1';
export type CatalogRevision = {counter: number; device: string};
export type CatalogEntry = {revision: CatalogRevision; value?: unknown; deleted?: true};
export type CatalogMap = Record<string, CatalogEntry>;
export type CatalogView = Record<string, unknown>;

export function compareRevision(a: CatalogRevision, b: CatalogRevision): number {
  return a.counter - b.counter || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
}

/** Absence never deletes. Every entry is an independent last-writer-wins register. */
export function mergeCatalog(a: CatalogMap, b: CatalogMap): CatalogMap {
  const out = {...a};
  for(const [key, entry] of Object.entries(b)) {
    const previous = out[key];
    const order = previous ? compareRevision(entry.revision, previous.revision) : 1;
    if(order > 0 || order === 0 && stableStringify(entry) > stableStringify(previous)) out[key] = entry;
  }
  return out;
}

export function parseCatalog(plaintext: string): CatalogMap {
  const snapshot = JSON.parse(plaintext);
  if(snapshot?.version !== 1 || !snapshot.items || Array.isArray(snapshot.items) || typeof snapshot.items !== 'object') {
    throw new Error('Unreadable account catalog');
  }
  const entries = Object.entries(snapshot.items);
  if(entries.length > 50000) throw new Error('Account catalog is too large');
  for(const [key, entry] of entries as Array<[string, CatalogEntry]>) {
    if(!/^(folder|member|archive|order|roster):/.test(key) || !entry ||
      !Number.isSafeInteger(entry.revision?.counter) || entry.revision.counter < 0 ||
      entry.revision.counter >= Number.MAX_SAFE_INTEGER ||
      typeof entry.revision.device !== 'string' || !entry.revision.device || entry.revision.device.length > 200 ||
      (entry.deleted !== undefined && entry.deleted !== true) ||
      (entry.deleted ? entry.value !== undefined : entry.value === undefined)) {
      throw new Error('Invalid account catalog entry');
    }
  }
  return snapshot.items;
}

export type CatalogState = {
  device: string;
  counter: number;
  items: CatalogMap;
  observed: CatalogView;
  initialized: boolean;
  publishedAt: number;
  legacyImported?: boolean;
};

export function emptyCatalogState(): CatalogState {
  return {device: crypto.randomUUID(), counter: 0, items: {}, observed: {}, initialized: false, publishedAt: 0};
}

export function writeCatalogValue(state: CatalogState, key: string, value: unknown): CatalogEntry {
  state.counter = Math.max(state.counter, ...Object.values(state.items).map((e) => e.revision.counter)) + 1;
  if(!Number.isSafeInteger(state.counter)) throw new Error('Catalog revision exhausted');
  const entry: CatalogEntry = {revision: {counter: state.counter, device: state.device}};
  if(value === undefined) entry.deleted = true;
  else entry.value = value;
  state.items[key] = entry;
  if(value === undefined) delete state.observed[key];
  else state.observed[key] = value;
  return entry;
}

/** Bootstrap cached entries at revision zero; real edits always outrank migration. */
export function observeCatalog(state: CatalogState, view: CatalogView, prefix?: string, bootstrapFolderStamp = 0): void {
  const keys = new Set([...Object.keys(view), ...Object.keys(state.observed)]);
  for(const key of keys) {
    if(prefix && !key.startsWith(prefix)) continue;
    if(!state.initialized) {
      if(view[key] !== undefined && !state.items[key]) {
        const value = view[key] as {archiveUpdatedAt?: number};
        const stamp = key.startsWith('archive:') ? value.archiveUpdatedAt || 0 : bootstrapFolderStamp;
        const migration = String(stamp).padStart(16, '0');
        state.items[key] = {revision: {counter: 0, device: 'legacy-' + migration}, value: view[key]};
      }
    } else if(stableStringify(view[key]) !== stableStringify(state.observed[key])) {
      writeCatalogValue(state, key, view[key]);
    }
  }
  if(prefix) {
    for(const key of Object.keys(state.observed)) if(key.startsWith(prefix)) delete state.observed[key];
    for(const [key, value] of Object.entries(view)) if(key.startsWith(prefix)) state.observed[key] = value;
  } else state.observed = view;
  state.initialized = true;
}
