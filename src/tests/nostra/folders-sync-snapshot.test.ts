import {describe, it, expect} from 'vitest';
import {buildSnapshotFromFilters, applySnapshotToFilters} from '@lib/nostra/folders-sync-snapshot';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';
import {FOLDERS_SYNC_VERSION} from '@lib/nostra/folders-sync-types';
import type {MyDialogFilter} from '@lib/storages/filters';

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL);
  f.id = id;
  (f as any).title = {_: 'textWithEntities', text: title, entities: []};
  f.pFlags = {};
  return f;
}

describe('buildSnapshotFromFilters', () => {
  it('includes order of all filters and only custom folders in customFolders', () => {
    const filters = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE),
      mkCustom(4, 'Work')
    ];
    const snap = buildSnapshotFromFilters(filters);
    expect(snap.version).toBe(FOLDERS_SYNC_VERSION);
    expect(snap.order).toEqual([0, 2, 3, 1, 4]);
    expect(snap.customFolders).toHaveLength(1);
    expect(snap.customFolders[0].id).toBe(4);
    expect((snap.customFolders[0] as any).title.text).toBe('Work');
  });

  it('records protected-folder renames in protectedTitles, empty when none', () => {
    const persons = buildLocalFilter(FOLDER_ID_PERSONS);
    (persons as any).title = {_: 'textWithEntities', text: 'Amici', entities: []};
    const filters = [
      buildLocalFilter(FOLDER_ID_ALL),
      persons,
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    const snap = buildSnapshotFromFilters(filters);
    expect(snap.protectedTitles?.[FOLDER_ID_PERSONS]?.text).toBe('Amici');
    expect(snap.protectedTitles?.[FOLDER_ID_GROUPS]).toBeUndefined();
  });

  it('omits protectedTitles entries for default literal titles', () => {
    const filters = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    const snap = buildSnapshotFromFilters(filters);
    expect(snap.protectedTitles).toEqual({});
  });
});

describe('applySnapshotToFilters', () => {
  it('replaces custom folders and order, keeps seeded system folders', () => {
    const local: MyDialogFilter[] = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE),
      mkCustom(4, 'Old Custom')
    ];
    const remote = {
      version: 1,
      order: [0, 3, 2, 1, 5],
      customFolders: [mkCustom(5, 'New Custom')],
      protectedTitles: {}
    };
    const result = applySnapshotToFilters(local, remote);
    expect(result.map((f) => f.id)).toEqual([0, 3, 2, 1, 5]);
    expect((result.find((f) => f.id === 5) as any)?.title.text).toBe('New Custom');
    expect(result.find((f) => f.id === 4)).toBeUndefined();
  });

  it('applies protectedTitles to the seeded folders via overlay', () => {
    const local: MyDialogFilter[] = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    const remote = {
      version: 1,
      order: [0, 2, 3, 1],
      customFolders: [] as MyDialogFilter[],
      protectedTitles: {
        [FOLDER_ID_PERSONS]: {_: 'textWithEntities' as const, text: 'Amici', entities: [] as any[]}
      }
    };
    const result = applySnapshotToFilters(local, remote);
    const persons = result.find((f) => f.id === FOLDER_ID_PERSONS);
    expect((persons as any)?.title.text).toBe('Amici');
    const groups = result.find((f) => f.id === FOLDER_ID_GROUPS);
    expect((groups as any)?.title.text).toBe('Groups');
  });

  it('appends system folders missing from remote order at the end', () => {
    const local: MyDialogFilter[] = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    // Remote forgot Persons
    const remote = {
      version: 1,
      order: [0, 3, 1],
      customFolders: [] as MyDialogFilter[],
      protectedTitles: {}
    };
    const result = applySnapshotToFilters(local, remote);
    expect(result.map((f) => f.id)).toContain(FOLDER_ID_PERSONS);
    // Persons appended after explicit order
    expect(result[result.length - 1].id).toBe(FOLDER_ID_PERSONS);
  });
});
