/**
 * Group pin + mark-unread (owner batch 15).
 *
 * Both entries existed in the chat-list context menu and both did nothing for a
 * group-class peer: `messages.toggleDialogPin` and `messages.markDialogUnread`
 * have no group branch, so the virtual server's action-pattern fallback
 * (`.toggle` / `.mark`) answered `true` with no state change — the classic
 * silent-noop trap. A chat survives that because tweb's caller dispatches its
 * own local dialog update; a GROUP cannot, because every `getDialogs` rebuilds
 * the row from the group record, so anything not on the record is gone.
 *
 * The fix has three parts, each pinned here:
 *  1. the flags are RECORD state (`pinnedAt` / `unreadMarkAt`) with the same
 *     absent-vs-`0` contract as `archivedAt`;
 *  2. the mapper stamps them onto the dialog as `pFlags.pinned` /
 *     `pFlags.unread_mark` — the exact flags a chat uses — so the badge and the
 *     pinned ordering work with no group-specific rendering;
 *  3. the virtual server routes both RPCs to GroupAPI for a group peer and
 *     still answers `true`, leaving 1:1 chats on their existing path.
 */
import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

// tweb runtime addition, absent in the test environment (same polyfill as the
// mapper's own suite).
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const mocks = vi.hoisted(() => ({
  setGroupPinnedByPeerId: vi.fn(async() => {}),
  setGroupUnreadMarkByPeerId: vi.fn(async() => {})
}));

vi.mock('@lib/phantomchat/group-api', () => ({
  getGroupAPI: () => ({
    setGroupPinnedByPeerId: mocks.setGroupPinnedByPeerId,
    setGroupUnreadMarkByPeerId: mocks.setGroupUnreadMarkByPeerId
  })
}));
import rootScope from '@lib/rootScope';
import {MOUNT_CLASS_TO} from '@config/debug';
import {applyGroupDialogFlags, primeGroupKindCache, applyGroupDialogFlagsToDialog} from '@lib/phantomchat/phantomchat-groups-sync';
import DialogsStorage from '@lib/storages/dialogs';
import {PhantomChatPeerMapper} from '@lib/phantomchat/phantomchat-peer-mapper';
import {groupIdToPeerId, GROUP_PEER_BASE} from '@lib/phantomchat/group-types';

const GROUP_PEER_ID = -Number(GROUP_PEER_BASE) - 0x1234;

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: {mirrors: {}}}};
});
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), dispatchEventSingle: vi.fn(), managers: {}}
}));

describe('applyGroupDialogFlagsToDialog', () => {
  it('stamps pin + unread dot from the record', () => {
    const dialog: any = {pFlags: {}};

    applyGroupDialogFlagsToDialog(dialog, {pinnedAt: 1000, unreadMarkAt: 2000});

    expect(dialog.pFlags.pinned).toBe(true);
    expect(dialog.pFlags.unread_mark).toBe(true);
  });

  it('DELETES the flags when the record says cleared, not `= false`', () => {
    const dialog: any = {pFlags: {pinned: true, unread_mark: true, view_forum_as_messages: true}};

    applyGroupDialogFlagsToDialog(dialog, {pinnedAt: 0, unreadMarkAt: 0});

    // tweb's unpin path (`handleDialogUnpinning`) deletes too: a lingering
    // `false` key still serialises and re-reports as truthy through some
    // readers, and it would be republished as "a value" instead of "absent".
    expect('pinned' in dialog.pFlags).toBe(false);
    expect('unread_mark' in dialog.pFlags).toBe(false);
    // Unrelated flags on the same row must survive.
    expect(dialog.pFlags.view_forum_as_messages).toBe(true);
  });

  it('treats an absent record field as cleared for the dialog it stamps', () => {
    const dialog: any = {pFlags: {pinned: true}};

    applyGroupDialogFlagsToDialog(dialog, {});

    expect(dialog.pFlags.pinned).toBeUndefined();
  });

  it('is a no-op on a missing dialog (a row that is not materialised yet)', () => {
    expect(() => applyGroupDialogFlagsToDialog(undefined, {pinnedAt: 1})).not.toThrow();
  });

  it('stamps a row that has no pFlags object yet', () => {
    const dialog: any = {};

    applyGroupDialogFlagsToDialog(dialog, {pinnedAt: 1});

    expect(dialog.pFlags.pinned).toBe(true);
  });
});

describe('createTwebDialog carries pin + unread mark', () => {
  const mapper = new PhantomChatPeerMapper();

  it('sets pFlags.pinned / pFlags.unread_mark from the options', () => {
    const dialog = mapper.createTwebDialog({
      peerId: GROUP_PEER_ID,
      topMessage: 10,
      topMessageDate: 1_700_000_000,
      pinned: true,
      unreadMark: true
    }) as any;

    expect(dialog.pFlags.pinned).toBe(true);
    expect(dialog.pFlags.unread_mark).toBe(true);
  });

  it('leaves the flags off for an unpinned group (the default rebuild)', () => {
    const dialog = mapper.createTwebDialog({
      peerId: GROUP_PEER_ID,
      topMessage: 10,
      topMessageDate: 1_700_000_000
    }) as any;

    expect(dialog.pFlags.pinned).toBeUndefined();
    expect(dialog.pFlags.unread_mark).toBeUndefined();
  });
});

describe('isDialogPinned answers a group from the record flag', () => {
  // The badge and the pinned block both read this. Groups / Sessions DO have a
  // filter object, so the old code answered from `filter.pinnedPeerIds` — an
  // order no group is ever in — and a pinned group rendered with no badge.
  // imported statically below; kept out of the top block so the polyfill above runs first

  it('returns the dialog flag even though the folder order does not list the peer', () => {
    const ds = new DialogsStorage();
    const dialog: any = {_: 'dialog', peerId: GROUP_PEER_ID, pFlags: {pinned: true}, folder_id: 0, unread_count: 0};
    (ds as any).dialogs = {[GROUP_PEER_ID]: dialog};
    (ds as any).filtersStorage = {getFilter: () => ({pinnedPeerIds: [] as any[]})};

    expect(ds.isDialogPinned(GROUP_PEER_ID as any, 3)).toBe(true);
  });

  it('reports an unpinned group as unpinned', () => {
    const ds = new DialogsStorage();
    const dialog: any = {_: 'dialog', peerId: GROUP_PEER_ID, pFlags: {}, folder_id: 0, unread_count: 0};
    (ds as any).dialogs = {[GROUP_PEER_ID]: dialog};
    (ds as any).filtersStorage = {getFilter: () => ({pinnedPeerIds: [] as any[]})};

    expect(ds.isDialogPinned(GROUP_PEER_ID as any, 3)).toBe(false);
  });
});

describe('GroupRecord flag persistence contract', () => {
  // `updateInfo` mirrors archivedAt's absent-vs-cleared rule. Exercised through
  // a minimal store double so the rule is pinned without IndexedDB.
  it('maps null to an explicit 0 and keeps absent fields untouched', async () => {
    const {GroupStore} = await import('@lib/phantomchat/group-store');
    const store: any = Object.create(GroupStore.prototype);

    let saved: any;
    const record: any = {groupId: 'g1', name: 'G', members: [], adminPubkey: 'a', pinnedAt: 5, unreadMarkAt: 6};
    store.get = async() => ({...record});
    store.save = async(rec: any) => {
      saved = rec;
    };

    await store.updateInfo('g1', {pinnedAt: null, name: 'Renamed'});
    expect(saved.pinnedAt).toBe(0);
    // Renaming must not clear a mark the user set.
    expect(saved.unreadMarkAt).toBe(6);

    await store.updateInfo('g1', {unreadMarkAt: 7});
    expect(saved.unreadMarkAt).toBe(7);
    expect(saved.pinnedAt).toBe(5);
  });
});

describe('virtual server routes the two RPCs for a group peer', () => {
  const {setGroupPinnedByPeerId, setGroupUnreadMarkByPeerId} = mocks;

  beforeEach(() => {
    setGroupPinnedByPeerId.mockClear();
    setGroupUnreadMarkByPeerId.mockClear();
  });

  it('messages.toggleDialogPin persists on the group record', async () => {
    const {PhantomChatMTProtoServer} = await import('@lib/phantomchat/virtual-mtproto-server');
    const server = new PhantomChatMTProtoServer();

    const result = await server.handleMethod('messages.toggleDialogPin', {
      peer: {_: 'inputDialogPeer', peer: {_: 'inputPeerChat', chat_id: Math.abs(GROUP_PEER_ID)}},
      pinned: true
    });

    expect(setGroupPinnedByPeerId).toHaveBeenCalledWith(GROUP_PEER_ID, true);
    expect(result).toBe(true);
  });

  it('messages.markDialogUnread sets the dot on the group record', async () => {
    const {PhantomChatMTProtoServer} = await import('@lib/phantomchat/virtual-mtproto-server');
    const server = new PhantomChatMTProtoServer();

    const result = await server.handleMethod('messages.markDialogUnread', {
      peer: {_: 'inputDialogPeer', peer: {_: 'inputPeerChat', chat_id: Math.abs(GROUP_PEER_ID)}},
      unread: true
    });

    expect(setGroupUnreadMarkByPeerId).toHaveBeenCalledWith(GROUP_PEER_ID, true);
    expect(result).toBe(true);
  });

  it('leaves a 1:1 peer alone — no group write, same `true` answer as before', async () => {
    const {PhantomChatMTProtoServer} = await import('@lib/phantomchat/virtual-mtproto-server');
    const server = new PhantomChatMTProtoServer();

    const result = await server.handleMethod('messages.toggleDialogPin', {
      peer: {_: 'inputDialogPeer', peer: {_: 'inputPeerUser', user_id: 1_000_000_000_000_042}},
      pinned: true
    });

    expect(setGroupPinnedByPeerId).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('Worker-owned pin order', () => {
  it('persists pins and removals in the Worker instead of mutating an RPC copy', async() => {
    const ds = new DialogsStorage();
    const workerOrders: any[] = [1, 2];
    const save = vi.fn();
    (ds as any).pinnedOrders = {3: workerOrders};
    (ds as any).appStateManager = {pushToState: save};
    // A bridge read returns a structured clone, so editing it cannot persist.
    const copy = structuredClone(ds.getPinnedOrders(3));
    copy.unshift(GROUP_PEER_ID as any);
    expect(workerOrders).toEqual([1, 2]);

    await Promise.resolve(ds.setDialogPinnedOrder(GROUP_PEER_ID as any, 3, true));
    expect(workerOrders).toEqual([GROUP_PEER_ID, 1, 2]);
    ds.setDialogPinnedOrder(GROUP_PEER_ID as any, 3, true);
    expect(workerOrders).toEqual([GROUP_PEER_ID, 1, 2]);
    ds.setDialogPinnedOrder(GROUP_PEER_ID as any, 3, false);
    expect(workerOrders).toEqual([1, 2]);
    expect(save).toHaveBeenCalledTimes(3);
  });
});

describe('live flags through asynchronous manager proxies', () => {
  it('awaits the Worker mutation before pushing the reindexed dialog', async() => {
    const groupId = 'ab'.repeat(48);
    primeGroupKindCache(groupId, 'group');
    const peerId = await groupIdToPeerId(groupId, 'group');
    const dialog: any = {_: 'dialog', peerId, pFlags: {}, folder_id: 0};
    const worker = new DialogsStorage();
    (worker as any).pinnedOrders = {3: []};
    (worker as any).appStateManager = {pushToState: vi.fn()};
    const mutation = vi.fn(async(id, folder, pinned) => {
      await Promise.resolve();
      worker.setDialogPinnedOrder(id, folder, pinned);
    });
    const push = vi.fn(async({dialog: row}) => {
      expect(worker.getPinnedOrders(3).includes(peerId as any)).toBe(!!row.pFlags.pinned);
    });    (MOUNT_CLASS_TO.apiManagerProxy as any).mirrors.dialogs = {[peerId]: dialog};
    (rootScope.managers as any).dialogsStorage = {
      getDialog: async() => [structuredClone(dialog)],
      getPinnedOrders: async(folder: number) => structuredClone(worker.getPinnedOrders(folder)),
      setDialogPinnedOrder: mutation,
      pushDialog: push
    };

    await applyGroupDialogFlags({groupId, pinnedAt: 1, unreadMarkAt: 1});
    expect(mutation).toHaveBeenLastCalledWith(peerId, 3, true);
    expect(push).toHaveBeenCalledOnce();
    // Pin the call shape, not just that a push happened: without `offsetDate: 0`
    // pushDialog falls back to the top message's date and can drop the row.
    expect(push).toHaveBeenLastCalledWith({dialog: expect.anything(), offsetDate: 0});
    await applyGroupDialogFlags({groupId, pinnedAt: 0, unreadMarkAt: 0});
    expect(mutation).toHaveBeenLastCalledWith(peerId, 3, false);
    expect(worker.getPinnedOrders(3)).toEqual([]);
  });
});

/**
 * Robert's blocker at f5ac796: `pushDialog({dialog})` without `offsetDate: 0`
 * falls back to the top message's date. For a row that is NOT pinned, an
 * offset older than the folder's saved offset in a folder that is not loaded
 * runs `dropDialog` and returns BEFORE `setDialogToState` — so a flag-only
 * change silently deleted the persisted row. Same defect #307 fixed in
 * `relocateGroupDialog` / `applyGroupDialogFolder`.
 *
 * This exercises the REAL `DialogsStorage.pushDialog` rather than a spy, so the
 * drop branch is the production one: an archived group whose Archive folder is
 * not loaded, with a saved offset newer than its top message.
 */
describe('flag changes never drop the persisted row (real pushDialog)', () => {
  it('keeps an unloaded-Archive row instead of dropping it', async() => {
    const groupId = 'cd'.repeat(48);
    primeGroupKindCache(groupId, 'group');
    const peerId = await groupIdToPeerId(groupId, 'group');

    const storage = new DialogsStorage();
    // Archive (folder 1) is not loaded and its saved offset is NEWER than the
    // top message, which is exactly the shape that trips the drop.
    (storage as any).allDialogsLoaded = {1: false, 3: false};
    (storage as any).dialogs = {};
    (storage as any).dialogsOffsetDate = {1: 5_000, 3: 5_000};
    (storage as any).getDialogMessageForState = () => ({date: 1_000});
    (storage as any).processDialogForFilters = vi.fn();
    (storage as any).setDialogToState = vi.fn();
    const drop = vi.spyOn(storage, 'dropDialog').mockImplementation((() => [] as any[]) as any);

    const dialog: any = {
      _: 'dialog',
      peerId,
      folder_id: 1,
      top_message: 42,
      unread_count: 0,
      pFlags: {}
    };
    (MOUNT_CLASS_TO.apiManagerProxy as any).mirrors.dialogs = {};
    (rootScope.managers as any).dialogsStorage = Object.assign(storage, {
      getDialog: async() => [structuredClone(dialog)],
      setDialogPinnedOrder: vi.fn(async() => {})
    });
    (storage as any).pushDialog = storage.pushDialog.bind(storage);

    await applyGroupDialogFlags({groupId, archivedAt: 1, unreadMarkAt: 1});

    expect(drop).not.toHaveBeenCalled();
    expect((storage as any).setDialogToState).toHaveBeenCalled();
    // Sanity: the pre-fix call shape (no offsetDate) really does drop here.
    drop.mockClear();
    (storage as any).setDialogToState = vi.fn();
    storage.pushDialog({dialog: {...dialog}});
    expect(drop).toHaveBeenCalled();
  });
});

/**
 * Owner bug 2026-11-01: pin a group, then unpin it — the badge went away but the
 * row stayed at the very top of the list.
 *
 * Two independent halves, both pinned below:
 *
 *  1. STORAGE. The Groups folder sorts on `index_3`, which
 *     `setDialogIndexInFilter` rebuilds. With the peer no longer in the folder's
 *     pinned order the group took the `generateIndexForDialog` path, which asks
 *     `appMessagesManager.getMessageByPeer` for the top message — and a group's
 *     messages live in the PhantomChat stores, not in that one, so `topDate`
 *     stayed 0 and fell through to `topDate ||= now`. The unpinned row was
 *     stamped with the CURRENT time: still above every chat.
 *
 *  2. DISPATCH. The row handed to the list came from a read taken BEFORE
 *     `pushDialog`, so it still carried the pinned index (same shape as #318's
 *     archive bug).
 */
describe('unpin drops the pinned sort position (real DialogsStorage reindex)', () => {
  const PINNED_BLOCK_FLOOR = 0x7fff0000 * 0x10000;

  /** A DialogsStorage with just enough runtime to run the real reindex. */
  const makeStorage = (peerId: number) => {
    const ds: any = new DialogsStorage();
    ds.clear(true);
    ds.appStateManager = {pushToState: vi.fn()};
    ds.timeManager = {getServerTimeOffset: (): number => 0};
    ds.dialogs = {};
    ds.dialogsOffsetDate = {};
    ds.allDialogsLoaded = {0: true, 1: true, 3: true, 4: true};
    ds.getDialogMessageForState = (): undefined => undefined;
    ds.setDialogToState = vi.fn();
    ds.rootScope = {dispatchEvent: vi.fn()};
    ds.peersStorage = {requestPeer: (): undefined => undefined, requestPeersForKey: (): undefined => undefined};
    ds.appMessagesIdsManager = {clearMessageId: (id: number): number => id};
    ds.appNotificationsManager = {isPeerLocalMuted: (): boolean => false};
    ds.appPeersManager = {
      peerId: 1,
      // The Worker has no message for a group peer — the whole point of the bug.
      getMessageByPeer: (): undefined => undefined,
      isBotforum: (): boolean => false,
      isForum: (): boolean => false,
      isChannel: (): boolean => false,
      getOutputPeer: (): any => ({})
    };
    ds.appChatsManager = {isChannel: (): boolean => false, getChat: (): undefined => undefined};
    ds.appMessagesManager = {
      getMessageByPeer: (): undefined => undefined,
      getHistoryStorage: (): any => ({history: []}),
      getDialogUnreadCount: (): number => 0
    };

    const filter: any = {id: 3, pinnedPeerIds: ds.getPinnedOrders(3)};
    ds.filtersStorage = {
      getFilters: (): any => ({3: filter}),
      getFilter: (): any => filter,
      testDialogForFilter: (): boolean => true
    };

    return {ds, filter, peerId};
  };

  it('re-stamps index_3 from the row`s own anchor instead of "now"', async() => {
    const groupId = 'ef'.repeat(48);
    primeGroupKindCache(groupId, 'group');
    const peerId = GROUP_PEER_ID;
    const {ds} = makeStorage(peerId);

    // Last message an hour ago: the anchor PhantomChatPeerMapper stamps.
    const anchor = (Math.floor(Date.now() / 1000) - 3600) * 0x10000;
    const dialog: any = {
      _: 'dialog',
      peerId,
      folder_id: 0,
      top_message: 42,
      unread_count: 0,
      pFlags: {},
      index_0: anchor,
      index_3: anchor
    };
    ds.dialogs[peerId] = dialog;

    ds.setDialogPinnedOrder(peerId, 3, true);
    ds.pushDialog({dialog, offsetDate: 0});
    expect(dialog.index_3).toBe(PINNED_BLOCK_FLOOR);
    expect(ds.getPinnedOrders(3)).toEqual([peerId]);

    delete dialog.pFlags.pinned;
    ds.setDialogPinnedOrder(peerId, 3, false);
    ds.pushDialog({dialog, offsetDate: 0});

    expect(ds.getPinnedOrders(3)).toEqual([]);
    // The bug: this was `now * 0x10000`, i.e. the top of the whole list.
    expect(dialog.index_3).toBe(anchor);
    expect(dialog.index_3).toBeLessThan(PINNED_BLOCK_FLOOR);

    // Control: the pre-fix computation really does jump to "now" here.
    const control = ds.generateIndexForDialog(dialog, true, undefined, false);
    expect(control).toBeGreaterThan(anchor);
    expect(Math.floor(control / 0x10000)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
  });

  it('keeps a chat on the old recompute path (its index_0 holds the pinned index)', async() => {
    const ds: any = new DialogsStorage();
    ds.timeManager = {getServerTimeOffset: () => 0};
    ds.dialogsNum = 0;
    const chatPeerId = 1_000_000_000_000_042;

    const messageDate = Math.floor(Date.now() / 1000) - 7200;
    const chat: any = {_: 'dialog', peerId: chatPeerId, folder_id: 0, top_message: 7, pFlags: {}, index_0: 0x7fff0000 * 0x10000};
    ds.appMessagesManager = {getMessageByPeer: (): any => ({date: messageDate})};
    ds.appPeersManager = {peerId: 1, isBotforum: (): boolean => false, isChannel: (): boolean => false};
    ds.filtersStorage = {testDialogForFilter: (): boolean => true};

    const filter: any = {id: 3, pinnedPeerIds: []};
    const index = ds.setDialogIndexInFilter(chat, 'index_3', filter);

    // A chat is re-anchored from its top message, not from index_0.
    expect(Math.floor(index / 0x10000)).toBe(messageDate);
  });
});

describe('the dispatched row is the one the Worker reindexed', () => {
  it('dispatches the post-push read, not the stale pre-push clone', async() => {
    const groupId = 'a1'.repeat(48);
    primeGroupKindCache(groupId, 'group');
    const peerId = await groupIdToPeerId(groupId, 'group');

    const stale = {_: 'dialog', peerId, pFlags: {pinned: true}, folder_id: 0, index_3: 0x7fff0000 * 0x10000};
    const reindexed = {_: 'dialog', peerId, pFlags: {}, folder_id: 0, index_3: 1_000 * 0x10000};

    let reads = 0;
    (MOUNT_CLASS_TO.apiManagerProxy as any).mirrors.dialogs = {[peerId]: structuredClone(stale)};
    (rootScope.managers as any).dialogsStorage = {
      // First read: the live row. Second read: what the Worker holds after the push.
      getDialog: async() => [structuredClone(++reads === 1 ? stale : reindexed)],
      setDialogPinnedOrder: vi.fn(async() => {}),
      pushDialog: vi.fn(async() => {})
    };
    const dispatched: any[] = [];
    (rootScope as any).dispatchEvent = vi.fn((event: string, payload: any) => {
      if(event === 'dialogs_multiupdate') dispatched.push(payload.values().next().value.dialog);
    });

    await applyGroupDialogFlags({groupId, pinnedAt: 0, unreadMarkAt: 0});

    expect(reads).toBe(2);
    expect(dispatched[0]).toBeTruthy();
    // The bug: the list was handed the pinned index and kept the row pinned.
    expect(dispatched[0].index_3).toBe(1_000 * 0x10000);
    expect(dispatched[0].pFlags.pinned).toBeUndefined();
    // The mirror has to be honest too — the next message repaint reads it.
    expect((MOUNT_CLASS_TO.apiManagerProxy as any).mirrors.dialogs[peerId].index_3).toBe(1_000 * 0x10000);
  });
});
