import 'fake-indexeddb/auto';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {reconcileCatalogDialogs} from '@lib/phantomchat/catalog-dialog-projection';

let AppMessagesManager: typeof import('@appManagers/appMessagesManager').AppMessagesManager;
let ApiUpdatesManager: typeof import('@appManagers/apiUpdatesManager').ApiUpdatesManager;
beforeAll(async() => {
  ({AppMessagesManager} = await import('@appManagers/appMessagesManager'));
  ({ApiUpdatesManager} = await import('@appManagers/apiUpdatesManager'));
}, 30000);

describe('catalog chat-list projection', () => {
  it('repairs missing and misplaced rows even when the group records already agree', async() => {
    const reload = vi.fn().mockResolvedValue(undefined), sweep = vi.fn().mockResolvedValue(undefined);
    const groups: any[] = [
      {groupId: 'missing', peerId: -12e15, kind: 'session'},
      {groupId: 'archived', peerId: -13e15, kind: 'session', archivedAt: 10},
      {groupId: 'wrong-index', peerId: -14e15, kind: 'session'},
      {groupId: 'correct', peerId: -3e15, kind: 'group'}
    ];
    await reconcileCatalogDialogs({
      groups: async() => groups,
      dialogs: async() => [
        {peerId: -13e15, folder_id: 0, index_4: 1},
        {peerId: -14e15, folder_id: 0, index_3: 1},
        {peerId: -3e15, folder_id: 0, index_3: 1},
        {peerId: -15e15, folder_id: 0, index_4: 1} // orphan: swept independently
      ], reload, sweep
    }, new AbortController().signal);
    expect(reload.mock.calls.map(([id]) => id)).toEqual([-12e15, -13e15, -14e15]);
    expect(sweep).toHaveBeenCalledOnce();
    expect(sweep.mock.invocationCallOrder[0]).toBeGreaterThan(reload.mock.invocationCallOrder[2]);
  });

  it('does not reload or sweep after an abandoned worker read', async() => {
    const controller = new AbortController();
    const reload = vi.fn(), sweep = vi.fn();
    await expect(reconcileCatalogDialogs({
      groups: async() => { controller.abort(); return []; }, dialogs: async() => [], reload, sweep
    }, controller.signal)).rejects.toThrow('abandoned');
    expect(reload).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled();
  });
});

describe('synthetic groups never subscribe to Telegram channel differences', () => {
  it.each([-3e15, -14490086722032440])('peer %s bypasses polling even with missing cached membership', (peerId) => {
    const manager = Object.assign(Object.create(AppMessagesManager.prototype), {
      appChatsManager: {isInChat: () => false, isForum: () => false}
    });
    expect(manager.isFetchIntervalNeeded(peerId)).toBe(false);
    const updates = Object.assign(Object.create(ApiUpdatesManager.prototype), {subscriptions: {}});
    expect(() => updates.subscribeToChannelUpdates(-peerId)).not.toThrow();
    expect(updates.subscriptions).toEqual({});
  });
});
