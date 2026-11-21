import {mergeCatalog, type CatalogMap} from './account-catalog';
import {mergeGroupsMaps} from './groups-sync-adapter';
import type {SyncEntry} from './sync-crdt';
import type {GroupRecord} from './group-types';

/** Group existence keeps its established deliberate-add/delete proof rules.
 * Placement registers use catalog revisions independently of group metadata. */
export function mergeAccountCatalog(a: CatalogMap, b: CatalogMap): CatalogMap {
  const result = mergeCatalog(a, b);
  for(const key of Object.keys(result)) {
    if(!key.startsWith('roster:') || !a[key]?.value || !b[key]?.value) continue;
    const id = key.slice(7);
    const left = a[key].value as SyncEntry<GroupRecord>;
    const right = b[key].value as SyncEntry<GroupRecord>;
    const value = mergeGroupsMaps({[id]: left}, {[id]: right})[id];
    result[key] = {...result[key], value};
  }
  return result;
}
