import {describe, it, expect, vi} from 'vitest';
import FiltersStorage from '@lib/storages/filters';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {sortFolderItemsByOrder, getFolderItemsInOrder} from '@components/sidebarLeft/foldersSidebarContent/utils';

function storage() {
  const fs = new FiltersStorage() as any;
  fs.localFilters = Object.fromEntries([0, 1, 3, 4].map((id) => [id, buildLocalFilter(id)]));
  return fs;
}

describe('Chats stays leftmost independently of startup preference', () => {
  it('repairs persisted custom/Sessions-first ordering using real seeding', () => {
    const fs = storage();
    const result = fs.prependFilters([8, 4, 3, 0, 1].map(buildLocalFilter));
    expect(result.map((f: any) => f.id)).toEqual([0, 3, 4, 1, 8]);
  });

  it('repairs a legacy remote reorder and publishes Chats-first order', () => {
    const fs = storage();
    fs.filters = {...fs.localFilters};
    fs.filtersArr = Object.values(fs.filters);
    fs.rootScope = {dispatchEvent: vi.fn()};
    fs.appStateManager = {pushToState: vi.fn()};
    fs.onUpdateDialogFilterOrder({_: 'updateDialogFilterOrder', order: [4, 3, 0]});
    expect(fs.rootScope.dispatchEvent).toHaveBeenCalledWith('filter_order', [0, 1, 4, 3]);
    expect(fs.filters[0].localId).toBeLessThan(fs.filters[4].localId);
  });

  it('sorts the vertical rail with Chats first and Archived last, including id zero', async() => {
    const filters = [4, 3, 0, 1, 8].map((id, localId) => ({...buildLocalFilter(id), localId}));
    const managers = {filtersStorage: {getFilter: vi.fn((id) => filters.find((f) => f.id === id))}};
    const result = await getFolderItemsInOrder(filters.map(({id}) => ({id})) as any, managers as any);
    expect(result.map((f) => f.id)).toEqual([0, 4, 3, 8, 1]);
    expect(managers.filtersStorage.getFilter).toHaveBeenCalledWith(0);
  });
});

describe('live sidebar order updates', () => {
  it('keeps Chats first and unknown custom folders before Archived', () => {
    const items = [8, 4, 1, 0, 9, 3].map((id) => ({id}));
    expect(sortFolderItemsByOrder(items, [4, 3, 0]).map((f) => f.id))
    .toEqual([0, 4, 3, 8, 9, 1]);
    expect(items.map((f) => f.id)).toEqual([8, 4, 1, 0, 9, 3]);
  });
  it('keeps custom-folder relative order when the server omits them', () => {
    expect(sortFolderItemsByOrder([9, 0, 8, 1, 3, 4].map((id) => ({id})), [0, 3, 4, 1]).map((f) => f.id))
    .toEqual([0, 3, 4, 9, 8, 1]);
  });
  it('honors explicit custom order while keeping the fixed endpoints', () => {
    expect(sortFolderItemsByOrder([0, 3, 4, 8, 9, 1].map((id) => ({id})), [1, 9, 4, 8, 3, 0]).map((f) => f.id))
    .toEqual([0, 9, 4, 8, 3, 1]);
  });
});
