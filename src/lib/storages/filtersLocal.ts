import type {DialogFilter} from '@layer';
import type {MyDialogFilter} from '@lib/storages/filters';
import copy from '@helpers/object/copy';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';

const LOCAL_FILTER_TEMPLATE: DialogFilter.dialogFilter = {
  _: 'dialogFilter',
  pFlags: {},
  id: 0,
  title: {_: 'textWithEntities', text: '', entities: []},
  exclude_peers: [],
  include_peers: [],
  pinned_peers: [],
  excludePeerIds: [],
  includePeerIds: [],
  pinnedPeerIds: []
};

function literalTitle(text: string): DialogFilter.dialogFilter['title'] {
  return {_: 'textWithEntities', text, entities: []};
}

/**
 * Pure constructor for locally-seeded filters. Does NOT touch dialogsStorage —
 * the caller in FiltersStorage.generateLocalFilter is responsible for adding
 * pinnedPeerIds via getPinnedOrders(id).
 */
export function buildLocalFilter(id: number): MyDialogFilter {
  const filter: MyDialogFilter = {...copy(LOCAL_FILTER_TEMPLATE), id};

  if(id === FOLDER_ID_ALL) {
    filter.pFlags.exclude_archived = true;
  } else if(id === FOLDER_ID_ARCHIVE) {
    filter.pFlags.exclude_unarchived = true;
  } else if(id === FOLDER_ID_PERSONS) {
    filter.pFlags.contacts = true;
    filter.pFlags.non_contacts = true;
    filter.pFlags.exclude_archived = true;
    filter.title = literalTitle('People');
  } else if(id === FOLDER_ID_GROUPS) {
    filter.pFlags.groups = true;
    filter.pFlags.exclude_archived = true;
    filter.title = literalTitle('Groups');
  }

  return filter;
}

/**
 * Titles that were previously shipped as defaults for a given folder id and
 * must still be recognized as defaults during migration. Keep this list
 * small — only strings that were the ACTUAL default at some prior release.
 */
const LEGACY_DEFAULT_TITLES: Record<number, readonly string[]> = {
  [FOLDER_ID_PERSONS]: ['Contacts']
};

/**
 * Returns true for titles produced by buildLocalFilter (unchanged default
 * label) or legacy persisted langpack sentinels. Used by sync snapshot code
 * to avoid recording default titles as user renames.
 */
export function isDefaultLocalTitle(id: number, text: string): boolean {
  if(!text) return true;
  if(text.startsWith('LANGPACK:')) return true; // legacy migration
  const fresh = buildLocalFilter(id).title?.text ?? '';
  if(text === fresh) return true;
  if(LEGACY_DEFAULT_TITLES[id]?.includes(text)) return true;
  return false;
}
