/**
 * Regression: folder chat rows must not bounce / vanish on send or receive.
 *
 * Root cause (confirmed LIVE on Andrew's real IDB, build 1.0.9999):
 *   DialogsStorage.saveDialogs() wipes every `index_N` on a dialog and
 *   regenerates them on each save. A `dialogs_multiupdate` snapshot captured
 *   mid-reindex therefore carries a genuine folder member whose per-filter
 *   index is momentarily `undefined`. AutonomousDialogList keys custom-folder
 *   membership on that index (`getDialogIndex(dialog, index_<localId>)`), so the
 *   member was misclassified as excluded and `updateDialog` yanked the row —
 *   re-adding it a tick later when the index returned. Visible as rows bouncing
 *   / disappearing inside a folder (and the folder list transiently emptying,
 *   flashing the folder-config view). "All Chats" is immune because it keys on
 *   the stable `dialog.folder_id`.
 *
 * The fix (autonomousDialogList/dialogs.ts): before deleting a *shown* custom-
 * folder row on a failed index test, confirm exclusion against the authoritative
 * INDEX-INDEPENDENT predicate FiltersStorage.testDialogForFilter. If it still
 * reports the dialog as a member, the row is kept (repositioned) instead of
 * removed.
 *
 * This test pins the property the fix depends on: testDialogForFilter must
 *   (a) classify an include-listed member correctly even when its per-filter
 *       index is absent (the exact reindex-race window), and
 *   (b) still exclude a genuinely excluded peer (so the fix can't pin unrelated
 *       rows in the list forever).
 * If someone "optimises" testDialogForFilter to read the transient index, (a)
 * fails and the flicker returns.
 */
import {describe, it, expect, vi} from 'vitest';
import FiltersStorage, {type MyDialogFilter} from '@lib/storages/filters';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import getDialogIndex from '@appManagers/utils/dialogs/getDialogIndex';
import getDialogIndexKey from '@appManagers/utils/dialogs/getDialogIndexKey';
import {FOLDER_ID_ALL, FOLDER_ID_GROUPS, FOLDER_ID_ARCHIVE, REAL_FOLDERS, START_LOCAL_ID} from '@appManagers/constants';

function mkDialog(peerId: number, overrides: Record<string, unknown> = {}) {
  return {_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0, ...overrides} as any;
}

function mkCustom(): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL) as any;
  f.id = START_LOCAL_ID;
  f.localId = START_LOCAL_ID;
  f.title = {_: 'textWithEntities', text: 'Work', entities: []};
  f.includePeerIds = [101, 102];
  f.excludePeerIds = [103];
  f.include_peers = [];
  f.exclude_peers = [];
  f.pinned_peers = [];
  return f;
}

function makeStorage(custom: MyDialogFilter, existing: Map<number, any>) {
  const fs = new FiltersStorage();
  const all = buildLocalFilter(FOLDER_ID_ALL);
  const groups = buildLocalFilter(FOLDER_ID_GROUPS);
  const archive = buildLocalFilter(FOLDER_ID_ARCHIVE);

  (fs as any).filters = {
    [FOLDER_ID_ALL]: all,
    [FOLDER_ID_GROUPS]: groups,
    [FOLDER_ID_ARCHIVE]: archive,
    [custom.id]: custom
  };
  (fs as any).rootScope = {dispatchEvent: vi.fn()};
  // testDialogForFilter consults getDialogOnly only as an existence gate for a
  // custom folder; include/exclude membership comes from the filter rules.
  (fs as any).appMessagesManager = {getDialogOnly: (pid: number) => existing.get(pid)};
  // Groups (system folder) matches via pFlags.groups + isAnyGroup. Model chat
  // peers as negative ids; the broadcast channel (-300) is a chat but NOT a
  // group, so Groups must exclude it.
  (fs as any).appPeersManager = {
    isAnyChat: (pid: number) => pid < 0,
    isAnyGroup: (pid: number) => pid < 0 && pid !== -300,
    isBroadcast: (pid: number) => pid === -300
  };
  (fs as any).appUsersManager = {isBot: () => false, isContact: () => false};
  return fs;
}

describe('folder membership is index-independent (row-flicker guard)', () => {
  it('classifies an include-listed member correctly even when its per-filter index is undefined', () => {
    const custom = mkCustom();
    const existing = new Map<number, any>();
    const fs = makeStorage(custom, existing);

    const member = mkDialog(101);
    existing.set(101, member);

    // Reproduce the mid-reindex window: the dialog has NO index for this filter.
    const indexKey = getDialogIndexKey(custom.localId);
    expect(getDialogIndex(member, indexKey)).toBeUndefined();

    // The index-based view would wrongly exclude it here; the authoritative
    // predicate must still report it as a member.
    expect(fs.testDialogForFilterId(member, custom.id)).toBe(true);
  });

  it('still excludes a genuinely excluded peer (fix must not pin unrelated rows)', () => {
    const custom = mkCustom();
    const existing = new Map<number, any>();
    const fs = makeStorage(custom, existing);

    const outsider = mkDialog(103); // present on excludePeerIds
    existing.set(103, outsider);

    expect(fs.testDialogForFilterId(outsider, custom.id)).toBe(false);
  });

  // Kai's #46 blocker: Groups (3) is a REAL_FOLDER but does NOT key on a stable
  // dialog.folder_id — it uses the same transient per-filter index as custom
  // folders, so the row-delete guard must NOT trust the sync test for Groups
  // (it must run the authoritative confirmation). These two assertions pin the
  // invariant that lets the fix do that safely: a Groups member is classified
  // correctly by the index-independent predicate even mid-reindex.
  it('Groups is a REAL_FOLDER yet matches members by rule, not by stable folder_id', () => {
    expect(REAL_FOLDERS.has(FOLDER_ID_GROUPS)).toBe(true);
    // testDialogForFilter only short-circuits on folder_id for All/Archive.
    expect(FOLDER_ID_GROUPS).not.toBe(FOLDER_ID_ALL);
    expect(FOLDER_ID_GROUPS).not.toBe(FOLDER_ID_ARCHIVE);
  });

  it('classifies a Groups member correctly even when its per-filter index is undefined', () => {
    const custom = mkCustom();
    const existing = new Map<number, any>();
    const fs = makeStorage(custom, existing);

    // A chat peer (peerId < 0) belongs in the Groups system folder.
    const groupMember = mkDialog(-200);
    existing.set(-200, groupMember);

    // Mid-reindex window: no per-filter index for the Groups folder.
    const indexKey = getDialogIndexKey(FOLDER_ID_GROUPS);
    expect(getDialogIndex(groupMember, indexKey)).toBeUndefined();

    // The authoritative predicate must still report it as a Groups member, so
    // the guard keeps the row instead of deleting it on the transient signal.
    expect(fs.testDialogForFilterId(groupMember, FOLDER_ID_GROUPS)).toBe(true);

    // And a broadcast channel (a chat, but not a group) must NOT be pinned.
    const broadcast = mkDialog(-300);
    existing.set(-300, broadcast);
    expect(fs.testDialogForFilterId(broadcast, FOLDER_ID_GROUPS)).toBe(false);
  });
});
