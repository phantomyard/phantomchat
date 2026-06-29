/**
 * Regression: custom folders must NOT report an inflated dialog count, or the
 * virtual list paints permanent "ghost" skeleton rows (issue #42).
 *
 * Root cause (confirmed live against real data, deployed 1.0.x):
 * A custom folder (id >= START_LOCAL_ID) is a client-side *filter* over the
 * global dialog set — no dialog carries `folder_id === filterId`. So when
 * DialogsStorage.getDialogs() falls through to appMessagesManager.getTopMessages
 * (the global folder), `result.count` is the GLOBAL dialog count, not the
 * filtered subset. deferredSortedVirtualList sizes its list to
 * `max(count, realItems)` and pads the surplus with `null`, and every null slot
 * renders as a LoadingDialogSkeleton that never resolves — the grey ghost rows.
 *
 * Proven live: folder "👻Phantoms" (5 included peers) reported count:7 (the
 * global total) while only 5 dialogs existed → 2 permanent ghost rows. With the
 * fix the same probe reports count:5 → zero ghosts.
 *
 * The fix generalises the existing FOLDER_ID_GROUPS guard to every locally
 * filtered folder (Groups + custom filters), excluding the real server folders
 * (All / Archive) and virtual filters (forum / saved). This test drives the
 * REAL getDialogs() so that reverting the guard fails it.
 */
import {describe, it, expect, vi} from 'vitest';
import DialogsStorage, {FilterType} from '@lib/storages/dialogs';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_GROUPS,
  START_LOCAL_ID
} from '@appManagers/constants';

const GLOBAL_COUNT = 7; // what getTopMessages reports for the global folder

function mkDialogs(peerIds: number[]) {
  return peerIds.map((peerId) => ({peerId, folder_id: FOLDER_ID_ALL}));
}

/**
 * Build a DialogsStorage whose collaborators force the getTopMessages branch
 * (global folder not fully loaded, fewer dialogs than the page limit) so the
 * count assignment under test actually runs.
 *
 * @param filteredDialogs the dialogs that genuinely belong to `filterId`
 */
function makeStorage(filterId: number, filteredDialogs: ReturnType<typeof mkDialogs>) {
  const ds = new DialogsStorage();

  const folder = {count: 0 as number, dialogs: filteredDialogs};

  Object.assign(ds as any, {
    cachedResults: {},
    appPeersManager: {isBotforum: () => false},
    appUsersManager: {fillContacts: () => ({cached: true, promise: Promise.resolve()})},
    filtersStorage: {reloadMissingPeerIds: vi.fn(() => undefined as undefined)},
    appMessagesManager: {
      // The global folder reports MORE dialogs than belong to the custom folder.
      getTopMessages: vi.fn(async () => ({
        count: GLOBAL_COUNT,
        dialogs: mkDialogs([1, 2, 3, 4, 5, 6, 7]),
        isEnd: true
      }))
    }
  });

  // Deterministic stubs for the lookups getDialogs performs.
  (ds as any).isFilterIdForForum = () => false;
  (ds as any).isVirtualFilter = () => false;
  (ds as any).getOffsetDate = () => 0;
  (ds as any).isDialogsLoaded = () => false; // force the getTopMessages path
  (ds as any).getFolder = () => folder;
  (ds as any).getFolderDialogs = () => filteredDialogs;
  (ds as any).getDialogIndexKeyByFilterId = () => 'index_0';
  (ds as any).getFilterType = () => FilterType.Folder;
  (ds as any).getDialogIndex = () => 0;

  return {ds, folder};
}

describe('getDialogs count — ghost placeholder rows (issue #42)', () => {
  it('reports the FILTERED count for a custom folder, not the global count', async () => {
    const filtered = mkDialogs([1, 2, 3, 4, 5]); // 5 belong to the custom folder
    const {ds, folder} = makeStorage(START_LOCAL_ID, filtered);

    const res = await ds.getDialogs({filterId: START_LOCAL_ID, limit: 20});

    // Must equal the real membership (5), NOT the inflated global count (7).
    expect(res.count).toBe(5);
    expect(res.count).not.toBe(GLOBAL_COUNT);
    // The cached folder count must also be corrected (drives later loads).
    expect(folder.count).toBe(5);
    // No surplus beyond the dialogs we actually returned → no ghost rows.
    expect(res.count).toBe(res.dialogs.length);
  });

  it('reports the FILTERED count for the Groups system folder', async () => {
    const filtered = mkDialogs([10, 11]);
    const {ds} = makeStorage(FOLDER_ID_GROUPS, filtered);

    const res = await ds.getDialogs({filterId: FOLDER_ID_GROUPS, limit: 20});

    expect(res.count).toBe(2);
    expect(res.count).not.toBe(GLOBAL_COUNT);
  });

  it('still reports the GLOBAL count for the real Archive folder (control)', async () => {
    const filtered = mkDialogs([20, 21, 22]);
    const {ds} = makeStorage(FOLDER_ID_ARCHIVE, filtered);

    const res = await ds.getDialogs({filterId: FOLDER_ID_ARCHIVE, limit: 20});

    // Archive is a real server folder — its server/global count is authoritative.
    expect(res.count).toBe(GLOBAL_COUNT);
  });
});
