import {describe, it, expect} from 'vitest';
import type {DialogFilter} from '@layer';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';
import {buildLocalFilter, isDefaultLocalTitle} from '@lib/storages/filtersLocal';

describe('buildLocalFilter', () => {
  it('builds All Chats with exclude_archived flag', () => {
    const f = buildLocalFilter(FOLDER_ID_ALL) as DialogFilter.dialogFilter;
    expect(f.id).toBe(FOLDER_ID_ALL);
    expect(f.pFlags.exclude_archived).toBe(true);
    expect(f.pFlags.contacts).toBeFalsy();
    expect(f.pFlags.groups).toBeFalsy();
  });

  it('builds Archive with exclude_unarchived flag', () => {
    const f = buildLocalFilter(FOLDER_ID_ARCHIVE) as DialogFilter.dialogFilter;
    expect(f.id).toBe(FOLDER_ID_ARCHIVE);
    expect(f.pFlags.exclude_unarchived).toBe(true);
  });

  it('builds Persons with contacts + non_contacts + exclude_archived', () => {
    const f = buildLocalFilter(FOLDER_ID_PERSONS) as DialogFilter.dialogFilter;
    expect(f.id).toBe(FOLDER_ID_PERSONS);
    expect(f.pFlags.contacts).toBe(true);
    expect(f.pFlags.non_contacts).toBe(true);
    expect(f.pFlags.exclude_archived).toBe(true);
    expect(f.pFlags.groups).toBeFalsy();
    expect(f.pFlags.broadcasts).toBeFalsy();
  });

  it('builds Groups with groups + exclude_archived', () => {
    const f = buildLocalFilter(FOLDER_ID_GROUPS) as DialogFilter.dialogFilter;
    expect(f.id).toBe(FOLDER_ID_GROUPS);
    expect(f.pFlags.groups).toBe(true);
    expect(f.pFlags.exclude_archived).toBe(true);
    expect(f.pFlags.contacts).toBeFalsy();
  });

  it('uses literal English titles for Persons and Groups', () => {
    expect(buildLocalFilter(FOLDER_ID_PERSONS).title.text).toBe('People');
    expect(buildLocalFilter(FOLDER_ID_GROUPS).title.text).toBe('Groups');
  });

  it('isDefaultLocalTitle recognizes fresh seeds, empty, and legacy LANGPACK', () => {
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'People')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_GROUPS, 'Groups')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, '')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'LANGPACK:FilterContacts')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Amici')).toBe(false);
  });

  it('isDefaultLocalTitle recognizes legacy "Contacts" title for FOLDER_ID_PERSONS as default', () => {
    // Legacy users shipped with 'Contacts' as the persons-folder title; we want the
    // migration path to overwrite that with the new default on next boot.
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Contacts')).toBe(true);
    // Other folders do not treat 'Contacts' as a default:
    expect(isDefaultLocalTitle(FOLDER_ID_GROUPS, 'Contacts')).toBe(false);
    // Other arbitrary legacy strings are not whitelisted:
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Chats')).toBe(false);
  });
});

import findAndSplice from '@helpers/array/findAndSplice';

// Minimal re-implementation of FiltersStorage.prependFilters core logic,
// without dialogsStorage access — so we can unit-test the ordering invariants.
function prependForTest(existing: DialogFilter[]): DialogFilter[] {
  const filters: any[] = existing.slice();
  const allIdx = filters.findIndex((f: any) => f.id === FOLDER_ID_ALL);
  if(allIdx === -1) filters.unshift(buildLocalFilter(FOLDER_ID_ALL));
  const ensure = (id: number, index: number) => {
    findAndSplice(filters, (f: any) => f.id === id);
    filters.splice(index, 0, buildLocalFilter(id));
  };
  ensure(FOLDER_ID_PERSONS, 1);
  ensure(FOLDER_ID_GROUPS, 2);
  ensure(FOLDER_ID_ARCHIVE, 3);
  return filters;
}

describe('prependFilters seed ordering', () => {
  it('seeds all 4 system folders for an empty array', () => {
    const out = prependForTest([]);
    expect(out.map((f: any) => f.id)).toEqual([0, 2, 3, 1]);
  });

  it('inserts Persons and Groups for users with [ALL, ARCHIVE] only', () => {
    const existing = [buildLocalFilter(FOLDER_ID_ALL), buildLocalFilter(FOLDER_ID_ARCHIVE)];
    const out = prependForTest(existing);
    expect(out.map((f: any) => f.id)).toEqual([0, 2, 3, 1]);
  });

  it('preserves user custom folders at the tail', () => {
    const custom = {
      ...buildLocalFilter(FOLDER_ID_ALL),
      id: 42,
      title: {_: 'textWithEntities' as const, text: 'Work', entities: [] as never[]}
    };
    const existing = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_ARCHIVE),
      custom as any
    ];
    const out = prependForTest(existing);
    expect(out.map((f: any) => f.id)).toEqual([0, 2, 3, 1, 42]);
    expect((out[4] as any).title.text).toBe('Work');
  });
});
