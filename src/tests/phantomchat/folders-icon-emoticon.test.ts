/**
 * #266 — custom chat folder icon (`filter.emoticon`).
 *
 * Pins three properties:
 *  1. folderEmoticonFallback: the chosen icon is the fallback emoji for any
 *     folder except All Chats, whose built-in icon must stay intact.
 *  2. the icon travels with the folder through the Nostr folders-sync
 *     snapshot round-trip, i.e. it follows the existing folder sync contract
 *     (custom folders are copied wholesale).
 *  3. wiring pins: the sidebar payload consults the fallback, the edit tab
 *     has the picker, and the context menu has the default-folder action —
 *     so a silent unwiring of any call site fails loudly.
 */

import {describe, it, expect, vi} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {folderEmoticonFallback} from '@components/sidebarLeft/foldersSidebarContent/utils';
import {buildSnapshotFromFilters, applySnapshotToFilters} from '@lib/phantomchat/folders-sync-snapshot';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import FiltersStorage from '@lib/storages/filters';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_GROUPS,
  START_LOCAL_ID
} from '@appManagers/constants';
import type {MyDialogFilter} from '@lib/storages/filters';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL);
  f.id = id;
  (f as any).title = {_: 'textWithEntities', text: title, entities: []};
  f.pFlags = {};
  return f;
}

describe('folderEmoticonFallback', () => {
  it('returns the chosen emoji for a custom folder', () => {
    const folder = mkCustom(10, 'Work');
    (folder as any).emoticon = '💼';
    expect(folderEmoticonFallback(folder)).toBe('💼');
  });

  it('returns undefined when no icon was chosen', () => {
    expect(folderEmoticonFallback(mkCustom(10, 'Work'))).toBeUndefined();
  });

  it('never overrides the All Chats built-in icon', () => {
    const allChats = buildLocalFilter(FOLDER_ID_ALL);
    (allChats as any).emoticon = '⭐';
    expect(folderEmoticonFallback(allChats)).toBeUndefined();
  });

  it('treats an empty string as "not chosen"', () => {
    const folder = mkCustom(10, 'Work');
    (folder as any).emoticon = '';
    expect(folderEmoticonFallback(folder)).toBeUndefined();
  });

  it('allows a chosen icon on the renamable Groups folder', () => {
    const groups = buildLocalFilter(FOLDER_ID_GROUPS);
    (groups as any).emoticon = '🎓';
    expect(folderEmoticonFallback(groups)).toBe('🎓');
  });
});

describe('icon follows the folder sync contract', () => {
  it('survives the snapshot round-trip for a custom folder', () => {
    const folder = mkCustom(10, 'Work');
    (folder as any).emoticon = '💼';
    const snapshot = buildSnapshotFromFilters([
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE),
      folder
    ]);
    expect((snapshot.customFolders[0] as any).emoticon).toBe('💼');

    const restored = applySnapshotToFilters([
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ], snapshot);
    const restoredCustom = restored.find((f) => f.id === 10) as any;
    expect(restoredCustom.emoticon).toBe('💼');
  });
});

describe('icon clear survives the real save path', () => {
  // Kai review P2: the edit tab's "Default" action must CLEAR the stored
  // icon, not just delete the property off the edited copy. saveDialogFilter
  // merges the copy into the stored filter with Object.assign(oldFilter,
  // filter), so a deleted property leaves the previous icon on the saved
  // folder and filter_update still emits it. The clearing representation is
  // an explicit empty string, which folderEmoticonFallback treats as
  // "not chosen". Drives the REAL saveDialogFilter merge.
  function makeStorage(work: MyDialogFilter) {
    const storage = new FiltersStorage();
    (storage as any).filters = {[work.id]: work};
    (storage as any).filtersArr = [work];
    (storage as any).localId = START_LOCAL_ID;
    (storage as any).rootScope = {dispatchEvent: vi.fn()};
    (storage as any).appStateManager = {pushToState: vi.fn()};
    return storage;
  }

  it('choose → save → clear → save → reopen ends with no icon', () => {
    const stored = mkCustom(START_LOCAL_ID, 'Work');
    stored.pinnedPeerIds = [];
    const storage = makeStorage(stored);

    // choose 💼 → save
    const chosen = {...stored, emoticon: '💼'} as MyDialogFilter;
    storage.saveDialogFilter(chosen as any);
    expect((storage as any).filters[START_LOCAL_ID].emoticon).toBe('💼');

    // clear (empty-string sentinel) → save
    const cleared = {...(storage as any).filters[START_LOCAL_ID], emoticon: ''} as MyDialogFilter;
    storage.saveDialogFilter(cleared as any);

    // reopen: the old icon must NOT have survived the merge
    const reopened = (storage as any).filters[START_LOCAL_ID];
    expect(reopened.emoticon).toBe('');
    expect(folderEmoticonFallback(reopened)).toBeUndefined();
  });
});

describe('wiring pins', () => {
  it('sidebar payload consults the emoticon fallback (title emoji still wins)', () => {
    const src = readFile('components/sidebarLeft/foldersSidebarContent/index.tsx');
    expect(src).toContain('folderEmoticonFallback(filter)');
    // title emoji keeps precedence, picked icon is the fallback
    expect(src).toContain('cleanTitle?.emoji ?? folderEmoticonFallback(filter)');
  });

  it('edit folder tab has the icon picker and stores it on filter.emoticon', () => {
    const src = readFile('components/sidebarLeft/tabs/editFolder.ts');
    expect(src).toContain('FOLDER_ICON_EMOJIS');
    expect(src).toContain('this.filter.emoticon = emoticon');
    expect(src).toContain('this.filter.emoticon = emoticon || \'\'');
    expect(src).toContain('this.syncFolderIconSelection()');
  });

  it('folder context menu exposes the Set/Remove default-folder actions', () => {
    const src = readFile('helpers/dom/createFolderContextMenu.ts');
    expect(src).toContain('ChatList.Filter.SetDefault');
    expect(src).toContain('ChatList.Filter.RemoveDefault');
    expect(src).toContain('DEFAULT_CHAT_FOLDER_SETTING_KEY');
  });

  it('chat list applies the startup folder and clears the stale preference on delete', () => {
    const src = readFile('lib/appDialogsManager.ts');
    expect(src).toContain('selectStartupFolderTab');
    expect(src).toContain('startupFolderId(');
    expect(src).toContain("setAppSettings(DEFAULT_CHAT_FOLDER_SETTING_KEY, undefined)");
  });
});
