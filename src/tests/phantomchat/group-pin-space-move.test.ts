/**
 * #315: a group/session pin entry must move with the row between spaces
 * (Groups 3, Sessions 4, Archive 1). The setter used to write only the bucket
 * it was handed, and archive/unarchive/class repair never touched the order,
 * so an entry stayed behind in the space the row left. These assert the
 * recorded orders, not pFlags: the flag was always right, which is how this
 * survived review.
 *
 * #319: group and session pins bypass tweb's toggleDialogPin, so the pin cap
 * is checked in GroupAPI.setGroupPinnedByPeerId against the space's bucket.
 */
import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: {mirrors: {}}}};
});
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), dispatchEventSingle: vi.fn(), managers: {}}
}));
vi.mock('@lib/phantomchat/phantomchat-sync-triggers', () => ({schedulePublish: vi.fn()}));

import rootScope from '@lib/rootScope';
import {MOUNT_CLASS_TO} from '@config/debug';
import DialogsStorage from '@lib/storages/dialogs';
import {applyGroupDialogFlags, applyGroupDialogFolder, primeGroupKindCache} from '@lib/phantomchat/phantomchat-groups-sync';
import {groupIdToPeerId} from '@lib/phantomchat/group-types';
import {GroupAPI} from '@lib/phantomchat/group-api';

type Kind = 'group' | 'session';

async function setup(kind: Kind) {
  const groupId = (kind === 'group' ? 'a1' : 'b2').repeat(48);
  primeGroupKindCache(groupId, kind);
  const peerId = await groupIdToPeerId(groupId, kind);
  const storage = new DialogsStorage();
  (storage as any).pinnedOrders = {0: [], 1: [], 3: [], 4: []};
  (storage as any).appStateManager = {pushToState: vi.fn()};
  const dialog: any = {_: 'dialog', peerId, folder_id: 0, pFlags: {}};
  (MOUNT_CLASS_TO.apiManagerProxy as any).mirrors.dialogs = {};
  (rootScope.managers as any).dialogsStorage = {
    getDialog: async() => [dialog],
    setDialogPinnedOrder: async(id: any, folder: number, pinned: boolean) => storage.setDialogPinnedOrder(id, folder, pinned),
    pushDialog: vi.fn(async() => {}),
    processChangedUnreadOrUnmuted: vi.fn(async() => {})
  };
  const orders = () => ({
    archive: storage.getPinnedOrders(1).slice(),
    groups: storage.getPinnedOrders(3).slice(),
    sessions: storage.getPinnedOrders(4).slice()
  });
  return {groupId, peerId, orders, space: kind === 'group' ? 'groups' : 'sessions'};
}

describe.each(['group', 'session'] as Kind[])('pin order moves with a %s between its space and Archive (#315)', (kind) => {
  it('pin, archive, unpin in Archive, unarchive: no entry left anywhere', async() => {
    const {groupId, orders, space} = await setup(kind);

    await applyGroupDialogFlags({groupId, kind, pinnedAt: 1});
    expect((orders() as any)[space]).toHaveLength(1);

    await applyGroupDialogFolder({groupId, kind, archivedAt: 5, pinnedAt: 1});
    expect((orders() as any)[space]).toEqual([]);
    expect(orders().archive).toHaveLength(1);

    await applyGroupDialogFlags({groupId, kind, archivedAt: 5, pinnedAt: 0});
    await applyGroupDialogFolder({groupId, kind, archivedAt: 0, pinnedAt: 0});
    expect(orders()).toEqual({archive: [], groups: [], sessions: []});
  });

  it('pin while archived, unarchive: the row heads the pinned block of its space', async() => {
    const {groupId, peerId, orders, space} = await setup(kind);
    const other = 77;
    await (rootScope.managers as any).dialogsStorage.setDialogPinnedOrder(other, space === 'groups' ? 3 : 4, true);

    await applyGroupDialogFolder({groupId, kind, archivedAt: 5});
    await applyGroupDialogFlags({groupId, kind, archivedAt: 5, pinnedAt: 1});
    expect(orders().archive).toEqual([peerId]);

    await applyGroupDialogFolder({groupId, kind, archivedAt: 0, pinnedAt: 1});
    expect(orders().archive).toEqual([]);
    expect((orders() as any)[space]).toEqual([peerId, other]);
  });
});

describe('group/session pin cap (#319)', () => {
  const PEER = -6000000000000009;
  let pinnedOrders: number[];
  let limits: Record<string, number>;
  let store: any;

  beforeEach(() => {
    pinnedOrders = [];
    limits = {pin: 2, folderPin: 1};
    store = {
      getByPeerId: vi.fn(async() => ({groupId: 'g', peerId: PEER})),
      updateInfo: vi.fn(async() => {}),
      get: vi.fn(async(): Promise<any> => undefined)
    };
    (rootScope.managers as any).apiManager = {getLimit: async(type: string) => limits[type]};
    (rootScope.managers as any).dialogsStorage = {getPinnedOrders: async() => pinnedOrders.slice()};
  });

  const pin = (pinned = true) => GroupAPI.prototype.setGroupPinnedByPeerId.call({store, log: {warn: vi.fn()}}, PEER, pinned);

  it('rejects a pin once the space bucket is at the limit, without writing the record', async() => {
    pinnedOrders = [1, 2];
    await expect(pin()).rejects.toMatchObject({type: 'PINNED_DIALOGS_TOO_MUCH'});
    expect(store.updateInfo).not.toHaveBeenCalled();
  });

  it('allows a pin under the limit, and never blocks an unpin', async() => {
    pinnedOrders = [1];
    await pin();
    expect(store.updateInfo).toHaveBeenCalledWith('g', {pinnedAt: expect.any(Number)});

    pinnedOrders = [1, 2, 3];
    store.updateInfo.mockClear();
    await pin(false);
    expect(store.updateInfo).toHaveBeenCalledWith('g', {pinnedAt: null});
  });

  it('uses folderPin for an archived group', async() => {
    store.getByPeerId.mockResolvedValue({groupId: 'g', peerId: PEER, archivedAt: 5});
    pinnedOrders = [1];
    await expect(pin()).rejects.toMatchObject({type: 'PINNED_DIALOGS_TOO_MUCH'});
  });
});
