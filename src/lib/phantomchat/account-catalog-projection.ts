import type {InputPeer} from '@layer';
import type {MyDialogFilter} from '@lib/storages/filters';
import {PROTECTED_FOLDERS} from '@appManagers/constants';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import type {GroupRecord} from './group-types';
import {isValidEntry} from './sync-crdt';
import type {CatalogMap, CatalogView} from './account-catalog';

type CatalogFilter = MyDialogFilter & {excludePeerIds?: PeerId[]; exclude_peers?: InputPeer[]};

const BUCKETS = ['include', 'exclude', 'pinned'] as const;
export function catalogFolderId(filter: MyDialogFilter): string {
  return PROTECTED_FOLDERS.has(filter.id) ? `system-${filter.id}` : filter.catalogId || `legacy-${filter.id}`;
}

export function filtersToCatalog(filters: MyDialogFilter[]): CatalogView {
  const view: CatalogView = {};
  const sorted = [...filters].sort((a, b) => (a.localId ?? a.id) - (b.localId ?? b.id));
  view['order:folders'] = sorted.map(catalogFolderId);
  for(const filter of sorted) {
    const folder = catalogFolderId(filter);
    const source = filter as CatalogFilter;
    const definition = {...source};
    delete definition.localId;
    for(const bucket of BUCKETS) {
      // System membership is generated from the group/session class, never copied.
      if(!PROTECTED_FOLDERS.has(filter.id)) {
        const ids = source[`${bucket}PeerIds`] || [];
        const peers = source[`${bucket}_peers`] || [];
        ids.forEach((peerId, index) => {
          view[`member:${folder}:${bucket}:${peerId}`] = {folder, bucket, peerId, peer: peers[index]};
        });
      }
      delete definition[`${bucket}PeerIds`];
      delete definition[`${bucket}_peers`];
    }
    view[`folder:${folder}`] = definition;
    if(!PROTECTED_FOLDERS.has(filter.id)) view[`order:pins:${folder}`] = [...filter.pinnedPeerIds || []];
  }
  return view;
}

/** Strict semantic validation before any remote catalog can touch local state. */
export function validateCatalogProjection(items: CatalogMap): void {
  for(const [key, entry] of Object.entries(items)) {
    if(entry.deleted) continue;
    const value = entry.value as any;
    if(key === 'order:folders') {
      if(!Array.isArray(value) || !value.every((id) => typeof id === 'string')) throw new Error('Invalid folder order');
    } else if(key.startsWith('order:pins:')) {
      if(!Array.isArray(value) || !value.every((id) => typeof id === 'number' && Number.isFinite(id))) throw new Error('Invalid folder pin order');
    } else if(key.startsWith('folder:')) {
      if(!value || !Number.isSafeInteger(value.id) || value.id < 0 || !value.title ||
        typeof value.title.text !== 'string' || !value.pFlags ||
        !['dialogFilter', 'dialogFilterChatlist'].includes(value._)) throw new Error('Invalid folder definition');
      const identity = key.slice(7);
      if(PROTECTED_FOLDERS.has(value.id) ? identity !== `system-${value.id}` :
        identity !== (value.catalogId || `legacy-${value.id}`)) throw new Error('Invalid folder identity');
    } else if(key.startsWith('member:')) {
      if(!value || typeof value.folder !== 'string' || !BUCKETS.includes(value.bucket) ||
        !Number.isFinite(value.peerId) || !value.peer || typeof value.peer._ !== 'string' ||
        key !== `member:${value.folder}:${value.bucket}:${value.peerId}`) throw new Error('Invalid folder membership');
    } else if(key.startsWith('roster:')) {
      if(!isValidEntry(value) || value.id !== key.slice(7) || !/^[a-f0-9]{32,96}$/.test(value.id)) throw new Error('Invalid roster entry');
      if(!value.deleted) {
        const group = value.data as GroupRecord;
        if(!group || group.groupId !== value.id || typeof group.name !== 'string' ||
          typeof group.adminPubkey !== 'string' || !/^[a-f0-9]{64}$/.test(group.adminPubkey) ||
          !Array.isArray(group.members) || !group.members.every((member) => typeof member === 'string' && /^[a-f0-9]{64}$/.test(member)) ||
          !Number.isFinite(group.createdAt) || !Number.isFinite(group.updatedAt) ||
          group.kind !== undefined && group.kind !== 'group' && group.kind !== 'session') throw new Error('Invalid roster record');
      }
    } else if(key.startsWith('archive:')) {
      if(!value || typeof value.groupId !== 'string' || key !== `archive:${value.groupId}` ||
        !Number.isFinite(value.archivedAt) || value.archivedAt < 0 ||
        !Number.isFinite(value.archiveUpdatedAt) || value.archiveUpdatedAt < 0) throw new Error('Invalid archive state');
    } else throw new Error('Unknown catalog key');
  }
}

export function catalogToFilters(local: MyDialogFilter[], items: CatalogMap): MyDialogFilter[] {
  const definitions = Object.entries(items).filter(([key, entry]) => key.startsWith('folder:') && !entry.deleted);
  // Stable assignment also preserves two offline creations that chose the same numeric UI id.
  definitions.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const used = new Set<number>(PROTECTED_FOLDERS);
  let next = Math.max(5, ...definitions.map(([, e]) => (e.value as MyDialogFilter).id)) + 1;
  const filters = new Map<string, CatalogFilter>();
  for(const [key, entry] of definitions) {
    const identity = key.slice(7);
    const definition = entry.value as MyDialogFilter;
    const system = PROTECTED_FOLDERS.has(definition.id);
    const id = system || !used.has(definition.id) ? definition.id : next++;
    used.add(id);
    const filter: CatalogFilter = system ? {...(local.find((f) => f.id === id) || buildLocalFilter(id)), title: definition.title} :
      {...definition, id, catalogId: identity};
    if(!system) for(const bucket of BUCKETS) {
      filter[`${bucket}PeerIds`] = [];
      filter[`${bucket}_peers`] = [];
    }
    filters.set(identity, filter);
  }
  for(const [key, entry] of Object.entries(items).sort(([a], [b]) => a < b ? -1 : 1)) {
    if(!key.startsWith('member:') || entry.deleted) continue;
    const {folder, bucket, peerId, peer} = entry.value as {folder: string; bucket: typeof BUCKETS[number]; peerId: PeerId; peer: InputPeer};
    const filter = filters.get(folder);
    if(!filter || PROTECTED_FOLDERS.has(filter.id)) continue;
    filter[`${bucket}PeerIds`].push(peerId);
    filter[`${bucket}_peers`].push(peer);
  }
  for(const [identity, filter] of filters) {
    if(PROTECTED_FOLDERS.has(filter.id)) continue;
    const order = items[`order:pins:${identity}`]?.value as PeerId[] || [];
    const ranks = new Map(order.map((id, index) => [id, index]));
    const pins = filter.pinnedPeerIds.map((id, index) => ({id, peer: filter.pinned_peers[index]}));
    pins.sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length) || +a.id - +b.id);
    filter.pinnedPeerIds = pins.map((pin) => pin.id);
    filter.pinned_peers = pins.map((pin) => pin.peer);
  }
  const order = items['order:folders']?.value as string[] || [];
  const ids = [...new Set([...order, ...filters.keys()])];
  return ids.flatMap((identity) => filters.has(identity) ? [filters.get(identity)!] : []).map((filter, localId) => ({...filter, localId: localId as MyDialogFilter['localId']}));
}

export function groupsToCatalog(groups: GroupRecord[]): CatalogView {
  return Object.fromEntries(groups.map((group) => [`archive:${group.groupId}`, {
    groupId: group.groupId, archivedAt: group.archivedAt || 0, archiveUpdatedAt: group.archiveUpdatedAt || group.archivedAt || 0
  }]));
}
