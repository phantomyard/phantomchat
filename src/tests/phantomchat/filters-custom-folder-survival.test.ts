/**
 * Regression: a user's CUSTOM folder must survive a PWA restart.
 *
 * Root cause it guards (confirmed live, Carbon, 1.0.130):
 * The virtual MTProto server returns `messages.getDialogFilters: []` — it is
 * NOT authoritative for custom folders, which live in local state and sync
 * cross-device over Nostr via FoldersSync. At boot an `updateDialogFilters`
 * update fires, and FiltersStorage.onUpdateDialogFilters() re-fetches the
 * server filter list (only the seeded system folders [All, Groups, Archive]),
 * then DELETED every local folder absent from that list — wiping every custom
 * folder (id >= START_LOCAL_ID) off disk on every restart.
 *
 * Proven live: injecting processLocalUpdate({_:'updateDialogFilters'}) shrank
 * the persisted filtersArr from [4,0,3,1] to [0,3,1] with no restart.
 *
 * The fix skips custom folders (id >= START_LOCAL_ID) in the server-reconcile
 * deletion loop. This test drives the REAL onUpdateDialogFilters so that
 * removing the guard fails it.
 */
import {describe, it, expect, vi} from 'vitest';
import FiltersStorage, {type MyDialogFilter} from '@lib/storages/filters';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_GROUPS,
  START_LOCAL_ID
} from '@appManagers/constants';

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL) as any;
  f.id = id;
  f.title = {_: 'textWithEntities', text: title, entities: []};
  f.includePeerIds = [101, 102, 103, 104];
  f.include_peers = [];
  f.exclude_peers = [];
  f.pinned_peers = [];
  return f;
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeStorage(custom: MyDialogFilter[]) {
  const fs = new FiltersStorage();
  const all = buildLocalFilter(FOLDER_ID_ALL);
  const groups = buildLocalFilter(FOLDER_ID_GROUPS);
  const archive = buildLocalFilter(FOLDER_ID_ARCHIVE);

  const filters: Record<string, MyDialogFilter> = {
    [FOLDER_ID_ALL]: all,
    [FOLDER_ID_GROUPS]: groups,
    [FOLDER_ID_ARCHIVE]: archive
  };
  for(const c of custom) filters[c.id] = c;

  (fs as any).filters = filters;
  (fs as any).filtersArr = [all, groups, archive, ...custom];
  (fs as any).localId = START_LOCAL_ID;
  (fs as any).rootScope = {dispatchEvent: vi.fn()};
  (fs as any).appStateManager = {pushToState: vi.fn()};

  // The virtual server is authoritative for system folders only — it never
  // reports custom folders. This mirrors getDialogFilters(true) returning the
  // prepended system set.
  (fs as any).getDialogFilters = vi.fn(async () => [all, groups, archive]);

  return fs;
}

describe('onUpdateDialogFilters — custom folder survival', () => {
  it('does NOT delete a custom folder when the server reports only system folders', async () => {
    const work = mkCustom(START_LOCAL_ID, 'Work');
    const fs = makeStorage([work]);

    const deletions: number[] = [];
    const realDelete = (fs as any).onUpdateDialogFilter;
    (fs as any).onUpdateDialogFilter = vi.fn((update: any) => {
      if(update && !update.filter) deletions.push(update.id);
      return realDelete.call(fs, update);
    });

    await (fs as any).onUpdateDialogFilters({_: 'updateDialogFilters'});
    await flushMicrotasks();

    // The custom folder must NOT have been deleted...
    expect(deletions).not.toContain(START_LOCAL_ID);
    // ...and it must still be present in the live + persisted filter set.
    expect((fs as any).filters[START_LOCAL_ID]).toBeDefined();
    expect((fs as any).filtersArr.some((f: MyDialogFilter) => f.id === START_LOCAL_ID)).toBe(true);
  });

  it('preserves multiple custom folders across a reconcile', async () => {
    const ids = [START_LOCAL_ID, START_LOCAL_ID + 1, START_LOCAL_ID + 5];
    const fs = makeStorage(ids.map((id, i) => mkCustom(id, `Folder${i}`)));

    await (fs as any).onUpdateDialogFilters({_: 'updateDialogFilters'});
    await flushMicrotasks();

    for(const id of ids) {
      expect((fs as any).filters[id]).toBeDefined();
    }
  });

  it('advances localId past a surviving custom folder so the next folder cannot collide', async () => {
    // Survivor sits at a localId ABOVE the system folders. onUpdateDialogFilterOrder
    // resets localId to START_LOCAL_ID and only walks the server-returned order
    // (system folders), so without the extra pass the counter never advances past
    // the survivor → the next created folder reuses its localId → duplicate localId.
    const survivor = mkCustom(START_LOCAL_ID, 'Work');
    const survivorLocalId = (START_LOCAL_ID + 4) as MyDialogFilter['localId'];
    survivor.localId = survivorLocalId;
    const fs = makeStorage([survivor]);

    await (fs as any).onUpdateDialogFilters({_: 'updateDialogFilters'});
    await flushMicrotasks();

    // Counter must be strictly past the survivor's localId.
    expect((fs as any).localId).toBeGreaterThan(survivorLocalId);
    // And the survivor must keep its localId (no clobber).
    expect((fs as any).filters[START_LOCAL_ID].localId).toBe(survivorLocalId);
  });

  it('still deletes a system folder the server omits (real reconcile intact)', async () => {
    // A custom folder is present; assert the guard targets only custom ids, not
    // a wholesale disable of the reconcile.
    const fs = makeStorage([mkCustom(START_LOCAL_ID, 'Work')]);

    const deletions: number[] = [];
    const realDelete = (fs as any).onUpdateDialogFilter;
    (fs as any).onUpdateDialogFilter = vi.fn((update: any) => {
      if(update && !update.filter) deletions.push(update.id);
      return realDelete.call(fs, update);
    });

    // Server now returns ONLY All + Archive (system Groups id 3 omitted).
    const all = (fs as any).filters[FOLDER_ID_ALL];
    const archive = (fs as any).filters[FOLDER_ID_ARCHIVE];
    (fs as any).getDialogFilters = vi.fn(async () => [all, archive]);

    await (fs as any).onUpdateDialogFilters({_: 'updateDialogFilters'});
    await flushMicrotasks();

    // System folder id 3 (< START_LOCAL_ID) is still eligible for reconcile
    // deletion; the custom folder is not touched.
    expect(deletions).toContain(FOLDER_ID_GROUPS);
    expect(deletions).not.toContain(START_LOCAL_ID);
  });
});
