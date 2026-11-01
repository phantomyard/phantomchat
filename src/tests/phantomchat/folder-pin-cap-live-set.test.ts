/**
 * #319: the `folderPin` cap must count the live pinned set, and unpin must
 * splice the list it took its index from.
 *
 * For the system folders `pinned_peers` is not the pinned set. It is seeded
 * empty on every boot (`filtersLocal.ts:18`), re-seeded empty by
 * `prependFilters`, and never re-populated from the persisted bucket — so it
 * only ever held the pins made since this launch. The cap read that list, which
 * offset the limit by the restored pin count and gave a user with twelve
 * restored pins a different limit after every reload. The unpin branch took an
 * index from `pinnedPeerIds` and applied it to `pinned_peers`, i.e. into the
 * wrong array whenever the two had diverged (which they do after the first
 * reload).
 *
 * Both are fixed by dropping the mirror from the real-folder path: the cap
 * reads `filter.pinnedPeerIds.length` (bound to the live order bucket at
 * `filters.ts:226`) and the writes are gated on the folder being custom. Custom
 * folders keep both lists, because there `pinned_peers` is the persisted
 * representation and the two are populated in lockstep.
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

const FOLDER_PIN_LIMIT = 15;

function inputPeer(peerId: number) {
  return {_: 'inputPeerUser', user_id: peerId, access_token: '0', access_hash: '1'};
}

/**
 * A storage with one system folder (Groups) and optional custom folders. The
 * system folder's `pinnedPeerIds` is replaced by the caller's array to mirror
 * `generateLocalFilter` binding it to `dialogsStorage.getPinnedOrders(id)`.
 */
function makeStorage(opts: {groupsPins?: number[]; custom?: MyDialogFilter[]} = {}) {
  const fs = new FiltersStorage();
  const all = buildLocalFilter(FOLDER_ID_ALL);
  const groups = buildLocalFilter(FOLDER_ID_GROUPS) as MyDialogFilter;
  const archive = buildLocalFilter(FOLDER_ID_ARCHIVE);
  groups.pinnedPeerIds = [...(opts.groupsPins ?? [])];

  const filters: Record<string, MyDialogFilter> = {
    [FOLDER_ID_ALL]: all,
    [FOLDER_ID_GROUPS]: groups,
    [FOLDER_ID_ARCHIVE]: archive
  };
  for(const c of opts.custom ?? []) filters[c.id] = c;

  (fs as any).filters = filters;
  (fs as any).filtersArr = [all, groups, archive, ...(opts.custom ?? [])];
  (fs as any).localId = START_LOCAL_ID;
  (fs as any).rootScope = {dispatchEvent: vi.fn()};
  (fs as any).appStateManager = {pushToState: vi.fn()};
  (fs as any).apiManager = {getLimit: vi.fn(async () => FOLDER_PIN_LIMIT)};
  (fs as any).appPeersManager = {
    getInputPeerById: vi.fn((peerId: number) => inputPeer(peerId))
  };
  // The network call is out of scope here; what matters is the local mutation
  // the setter performs before it.
  (fs as any).updateDialogFilter = vi.fn(async (f: MyDialogFilter) => f);

  return {fs, groups, filters};
}

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL) as any;
  f.id = id;
  f.title = {_: 'textWithEntities', text: title, entities: []};
  f.includePeerIds = [];
  f.include_peers = [];
  f.exclude_peers = [];
  f.pinned_peers = [];
  f.pinnedPeerIds = [];
  return f;
}

describe('#319: folderPin cap counts the live pinned set', () => {
  it('counts pins restored on load, not only the ones made since launch', async () => {
    // Twelve pins the user restored from disk. `pinned_peers` is empty here
    // because that is what a real folder looks like after a reload.
    const restored = Array.from({length: 12}, (_, i) => 5000 + i);
    const {fs, groups} = makeStorage({groupsPins: restored});
    expect(groups.pinned_peers).toHaveLength(0);

    for(let i = 0; i < 3; i++) {
      await (fs as any).toggleDialogPin(6000 + i, FOLDER_ID_GROUPS);
    }
    expect(groups.pinnedPeerIds).toHaveLength(FOLDER_PIN_LIMIT);

    // The sixteenth attempt must be refused. Before the fix the cap read the
    // empty mirror, so this call was accepted and the folder ended up with 16.
    await expect((fs as any).toggleDialogPin(7000, FOLDER_ID_GROUPS))
      .rejects.toMatchObject({type: 'PINNED_DIALOGS_TOO_MUCH'});
    expect(groups.pinnedPeerIds).toHaveLength(FOLDER_PIN_LIMIT);
    expect(groups.pinnedPeerIds).not.toContain(7000);
  });

  it('reports the same limit before and after a reload', async () => {
    // Same twelve pins, reached two ways: fresh (pins made this session, so the
    // old code saw them) and restored (the old code saw zero). Both must refuse
    // at the same count.
    const restored = Array.from({length: 12}, (_, i) => 5000 + i);
    const {fs: restoredFs, groups: restoredGroups} = makeStorage({groupsPins: restored});
    const {fs: freshFs, groups: freshGroups} = makeStorage();

    for(let i = 0; i < 12; i++) {
      await (freshFs as any).toggleDialogPin(5000 + i, FOLDER_ID_GROUPS);
    }
    expect(freshGroups.pinnedPeerIds).toHaveLength(12);

    for(const [fs, folder] of [[restoredFs, restoredGroups], [freshFs, freshGroups]] as const) {
      let accepted = 0;
      for(let i = 0; i < 6; i++) {
        try {
          await (fs as any).toggleDialogPin(8000 + i, FOLDER_ID_GROUPS);
          accepted++;
        } catch {
          break;
        }
      }
      expect(accepted).toBe(FOLDER_PIN_LIMIT - 12);
      expect(folder.pinnedPeerIds).toHaveLength(FOLDER_PIN_LIMIT);
    }
  });

  it('a system folder keeps no pinned_peers mirror', async () => {
    const {fs, groups} = makeStorage();
    await (fs as any).toggleDialogPin(4242, FOLDER_ID_GROUPS);

    expect(groups.pinnedPeerIds).toEqual([4242]);
    // The mirror is not written for a real folder: nothing reads it and the
    // next boot would discard it anyway.
    expect(groups.pinned_peers).toHaveLength(0);

    await (fs as any).toggleDialogPin(4242, FOLDER_ID_GROUPS);
    expect(groups.pinnedPeerIds).toHaveLength(0);
    expect(groups.pinned_peers).toHaveLength(0);
  });

  // Honest scope: this case passes before the fix too. Today the two lists can
  // only diverge at the tail, so the wrong-array splice is either aligned or past
  // the end and does nothing. It is here as a CONTRACT pin — unpin reads the
  // bucket and writes the bucket, and the mirror is not a write target any more
  // — because once #315's move hook sweeps the bucket the indexes diverge
  // mid-array and the same line would start removing the wrong peer.
  it('unpin reads the order and the index from the same list', async () => {
    // Diverged exactly as a reload leaves them: two restored pins in the bucket,
    // and one pin made this session (the only entry the mirror ever had).
    const restored = [9101, 9102];
    const {fs, groups} = makeStorage({groupsPins: restored});
    (groups as any).pinned_peers = [inputPeer(9200)];
    (groups.pinnedPeerIds as number[]).push(9200);

    await (fs as any).toggleDialogPin(9200, FOLDER_ID_GROUPS);

    // The unpinned peer is gone from the bucket, the restored pins survive in
    // order, and the stale mirror is left alone rather than being spliced at an
    // index that pointed into the bucket.
    expect(groups.pinnedPeerIds).toEqual(restored);
    expect((groups as any).pinned_peers).toEqual([inputPeer(9200)]);
  });
});

describe('#319: custom folders keep both lists', () => {
  it('pins and unpins in lockstep so the persisted representation still syncs', async () => {
    const custom = mkCustom(START_LOCAL_ID, 'Work');
    const {fs} = makeStorage({custom: [custom]});

    await (fs as any).toggleDialogPin(4300, START_LOCAL_ID);
    expect(custom.pinnedPeerIds).toEqual([4300]);
    expect((custom as any).pinned_peers).toEqual([inputPeer(4300)]);

    await (fs as any).toggleDialogPin(4300, START_LOCAL_ID);
    expect(custom.pinnedPeerIds).toHaveLength(0);
    expect((custom as any).pinned_peers).toHaveLength(0);
  });
});
