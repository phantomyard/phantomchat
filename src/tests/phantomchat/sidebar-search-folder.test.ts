import '../setup';
import {describe, expect, it} from 'vitest';
import DialogsStorage, {FilterType} from '@lib/storages/dialogs';
import SearchIndex from '@lib/searchIndex';

describe('sidebar search before self peer hydration', () => {
  const storage = () => {
    const ds = Object.create(DialogsStorage.prototype) as any;
    ds.appPeersManager = {peerId: 0, isBotforum: () => false};
    const dialog = {_: 'dialog', peerId: 123, folder_id: 0, index: 1};
    ds.dialogs = {123: dialog};
    ds.dialogsIndex = new SearchIndex();
    ds.dialogsIndex.indexObject(123, 'Unrelated Contact');
    ds.cachedResults = {};
    ds.getFolderDialogs = () => [dialog];
    ds.getOffsetDate = () => 0;
    ds.isDialogsLoaded = () => true;
    return ds;
  };

  it('classifies folder zero as a folder even while the self peer is zero', () => {
    const ds = storage();
    expect(ds.getFilterType(0)).toBe(FilterType.Folder);
    ds.appPeersManager.peerId = 123;
    expect(ds.getFilterType(123)).toBe(FilterType.Saved);
  });

  it('filters the real sidebar query instead of returning every chat', async() => {
    const ds = storage();
    expect((await ds.getDialogs({query: 'hartle', filterId: 0})).dialogs).toEqual([]);
    expect((await ds.getDialogs({query: 'Unrelated', filterId: 0})).dialogs).toEqual([ds.dialogs[123]]);
  });
});
