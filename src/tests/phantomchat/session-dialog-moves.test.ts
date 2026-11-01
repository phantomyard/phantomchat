/**
 * Regression coverage for the live dialog paths: a synced class change moves the
 * row, a delayed repaint cannot restore a row that left, an archived session stays
 * archived when a message arrives, and a retried move keeps the row's state.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, afterAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : +this;
  };
}

const FROM = -3000000000000001;
const TO = -13000000000000001;

const proxy = {mirrors: {peers: {} as any, chats: {} as any, messages: {} as any, dialogs: {} as any}};
const dispatchEvent = vi.fn();
// Behaves like the real storage so a test can assert which rows SURVIVE a fault,
// not just which calls were made.
const rows = new Map<number, any>();
const dialogsStorage = {
  getAnyDialog: vi.fn(),
  getDialog: vi.fn(),
  dropDialogWithEvent: vi.fn(),
  pushDialog: vi.fn()
};
const setConversationTwebPeerId = vi.fn().mockResolvedValue(0);
const invalidateHistoryCache = vi.fn().mockResolvedValue(undefined);
let record: any;

let sync: typeof import('@lib/phantomchat/phantomchat-groups-sync');

const lastDialog = (peerId: number) => {
  const calls = dispatchEvent.mock.calls.filter((c) => c[0] === 'dialogs_multiupdate' && c[1].has(peerId));
  return calls.length ? calls[calls.length - 1][1].get(peerId).dialog : undefined;
};
const repaints = (peerId: number) =>
  dispatchEvent.mock.calls.filter((c) => c[0] === 'dialogs_multiupdate' && c[1].has(peerId)).length;

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@config/debug', async() => {
    const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
    return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: proxy}};
  });
  vi.doMock('@lib/phantomchat/group-store', () => ({
    GroupStore: class {},
    getGroupStore: (): any => ({get: async(): Promise<any> => record, getByPeerId: async(): Promise<any> => null, getAll: async(): Promise<any[]> => []})
  }));
  vi.doMock('@lib/phantomchat/message-store', () => ({
    getMessageStore: (): any => ({
      setConversationTwebPeerId,
      getTombstone: async(): Promise<number> => 0,
      getByEventId: async(): Promise<any> => null,
      saveMessage: async(): Promise<void> => undefined
    })
  }));
  vi.doMock('@lib/phantomchat/ensure-sender-user-injected', () => ({ensureSenderUserInjected: vi.fn().mockResolvedValue({isNewPeer: false})}));
  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent,
      dispatchEventSingle: vi.fn(),
      addEventListener: vi.fn(),
      managers: {
        dialogsStorage,
        appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)},
        appMessagesManager: {
          setMessageToStorage: vi.fn().mockResolvedValue(undefined),
          invalidateHistoryCache
        }
      }
    }
  }));
  vi.doMock('@stores/peers', () => ({reconcilePeer: vi.fn()}));
  sync = await import('@lib/phantomchat/phantomchat-groups-sync');
});

afterAll(() => {
  for(const m of ['@config/debug', '@lib/phantomchat/group-store', '@lib/phantomchat/message-store', '@lib/phantomchat/ensure-sender-user-injected', '@lib/rootScope', '@stores/peers']) vi.doUnmock(m);
  vi.resetModules();
});

beforeEach(() => {
  proxy.mirrors = {peers: {}, chats: {}, messages: {}, dialogs: {}};
  dispatchEvent.mockClear();
  rows.clear();
  dialogsStorage.getAnyDialog.mockReset().mockImplementation(async(peerId: number) => rows.get(peerId));
  dialogsStorage.getDialog.mockReset().mockImplementation(async(peerId: number) => [rows.get(peerId)]);
  dialogsStorage.dropDialogWithEvent.mockReset().mockImplementation(async(peerId: number) => { rows.delete(peerId); });
  dialogsStorage.pushDialog.mockReset().mockImplementation(async({dialog}: any) => { rows.set(dialog.peerId, dialog); });
  setConversationTwebPeerId.mockClear().mockResolvedValue(0);
  invalidateHistoryCache.mockReset().mockResolvedValue(undefined);
  record = {groupId: 'ab'.repeat(16), name: 'S', members: [], adminPubkey: 'a'.repeat(64), peerId: TO, kind: 'session', createdAt: 1, updatedAt: 1};
});

const oldRow = () => ({peerId: FROM, top_message: 77, index_0: 5 * 0x10000, unread_count: 2, read_inbox_max_id: 70, read_outbox_max_id: 70, pFlags: {}});
const historyPeer = () => setConversationTwebPeerId.mock.calls[setConversationTwebPeerId.mock.calls.length - 1][1];
const existing = () => ({peerId: FROM, kind: 'group' as const, archivedAt: undefined as number});
const move = (next = record, save = vi.fn().mockResolvedValue(undefined)) =>
  sync.moveSyncedGroupToPeer(next, existing(), save);

describe('moveSyncedGroupToPeer', () => {
  it('re-stamps history, moves the row off the old peer and saves the record', async() => {
    rows.set(FROM, oldRow());
    const save = vi.fn().mockResolvedValue(undefined);

    await move(record, save);

    expect(setConversationTwebPeerId).toHaveBeenCalledWith(`group:${record.groupId}`, TO);
    expect(save).toHaveBeenCalledTimes(1);
    expect(rows.has(FROM)).toBe(false);
    const pushed = rows.get(TO);
    expect(pushed.peerId).toBe(TO);
    expect(pushed.top_message).toBe(77);
    expect(pushed.unread_count).toBe(2);
  });

  it('routes later traffic to the new peer', async() => {
    await move({...record, groupId: 'cd'.repeat(16)});
    record = {...record, groupId: 'cd'.repeat(16), kind: undefined, peerId: FROM};
    const {groupIdToPeerId} = await import('@lib/phantomchat/group-types');
    expect(await sync.resolveGroupPeerId('cd'.repeat(16))).toBe(await groupIdToPeerId('cd'.repeat(16), 'session'));
  });
});

describe('a failed move keeps the group on one peer id with a row', () => {
  beforeEach(() => {
    rows.set(FROM, oldRow());
  });

  /** History and a dialog row are together on the old id; the record was not saved. */
  const expectStillOnOldPeer = (save: any) => {
    expect(save).not.toHaveBeenCalled();
    expect(rows.get(FROM)?.top_message).toBe(77);
    expect(rows.has(TO)).toBe(false);
    expect(historyPeer()).toBe(FROM);
    expect(proxy.mirrors.dialogs[TO]).toBeUndefined();
  };

  it('lands the new row before touching the old one', async() => {
    await move();
    expect(dialogsStorage.pushDialog.mock.invocationCallOrder[0])
    .toBeLessThan(dialogsStorage.dropDialogWithEvent.mock.invocationCallOrder[0]);
  });

  it('cannot lose the row to the not-yet-loaded folder branch of pushDialog', async() => {
    await move();
    expect(dialogsStorage.pushDialog.mock.calls[0][0].offsetDate).toBe(0);
  });

  it('pushDialog rejecting rolls everything back and propagates', async() => {
    dialogsStorage.pushDialog.mockRejectedValueOnce(new Error('quota'));
    const save = vi.fn();
    await expect(move(record, save)).rejects.toThrow('quota');
    expectStillOnOldPeer(save);
  });

  it('pushDialog resolving without a row is a failure, not a silent loss', async() => {
    dialogsStorage.pushDialog.mockResolvedValueOnce(undefined);
    const save = vi.fn();
    await expect(move(record, save)).rejects.toThrow('did not land');
    expectStillOnOldPeer(save);
  });

  it('a failed read aborts before anything changes', async() => {
    dialogsStorage.getAnyDialog.mockRejectedValueOnce(new Error('worker down'));
    const save = vi.fn();
    await expect(move(record, save)).rejects.toThrow('worker down');
    expect(dialogsStorage.pushDialog).not.toHaveBeenCalled();
    expect(dialogsStorage.dropDialogWithEvent).not.toHaveBeenCalled();
    expectStillOnOldPeer(save);
  });

  it('a failed history re-stamp is rolled back, because it can land part-way', async() => {
    setConversationTwebPeerId.mockRejectedValueOnce(new Error('idb'));
    const save = vi.fn();
    await expect(move(record, save)).rejects.toThrow('idb');
    expect(dialogsStorage.pushDialog).not.toHaveBeenCalled();
    expectStillOnOldPeer(save);
  });

  it('a failed move does not leave later traffic routed to the new peer', async() => {
    const groupId = 'ef'.repeat(16);
    dialogsStorage.pushDialog.mockRejectedValueOnce(new Error('quota'));
    await expect(move({...record, groupId})).rejects.toThrow('quota');
    record = {...record, groupId, kind: 'group', peerId: FROM};
    const {groupIdToPeerId} = await import('@lib/phantomchat/group-types');
    expect(await sync.resolveGroupPeerId(groupId)).toBe(await groupIdToPeerId(groupId, 'group'));
  });

  it('a failed record save moves the row and history back, keeping the row state', async() => {
    const save = vi.fn().mockRejectedValue(new Error('peerId collision'));
    await expect(move(record, save)).rejects.toThrow('peerId collision');
    expect(rows.has(TO)).toBe(false);
    expect(rows.get(FROM)?.top_message).toBe(77);
    expect(rows.get(FROM)?.unread_count).toBe(2);
    expect(historyPeer()).toBe(FROM);
  });

  it('keeps history with the row when the row cannot be moved back', async() => {
    const save = vi.fn().mockRejectedValue(new Error('peerId collision'));
    dialogsStorage.pushDialog
    .mockImplementationOnce(async({dialog}: any) => { rows.set(dialog.peerId, dialog); })
    .mockRejectedValueOnce(new Error('quota'));
    await expect(move(record, save)).rejects.toThrow('peerId collision');
    expect(rows.has(TO)).toBe(true);
    expect(historyPeer()).toBe(TO);
  });
});

describe('once the new row has landed the move succeeds', () => {
  beforeEach(() => {
    rows.set(FROM, oldRow());
  });

  it('a failed drop of the old row does not undo it', async() => {
    dialogsStorage.dropDialogWithEvent.mockRejectedValueOnce(new Error('drop failed'));
    const save = vi.fn().mockResolvedValue(undefined);
    await move(record, save);
    expect(rows.has(TO)).toBe(true);
    expect(historyPeer()).toBe(TO);
    expect(save).toHaveBeenCalled();
  });

  it('a failed history-cache invalidation does not undo it', async() => {
    invalidateHistoryCache.mockRejectedValue(new Error('invalidate failed'));
    const save = vi.fn().mockResolvedValue(undefined);
    await move(record, save);
    expect(rows.has(FROM)).toBe(false);
    expect(rows.has(TO)).toBe(true);
    expect(historyPeer()).toBe(TO);
    expect(save).toHaveBeenCalled();
  });
});

describe('relocateGroupDialog retry', () => {
  const movedRow = () => ({peerId: TO, top_message: 88, index_0: 9 * 0x10000, unread_count: 3, read_inbox_max_id: 80, read_outbox_max_id: 80, pFlags: {pinned: true}});

  it('accepts a row that already moved, without pushing over it', async() => {
    const row = movedRow();
    rows.set(TO, row);

    await sync.relocateGroupDialog(record.groupId, FROM, TO, record);

    expect(dialogsStorage.pushDialog).not.toHaveBeenCalled();
    expect(rows.get(TO)).toBe(row);
    expect(lastDialog(TO)).toBe(row);
  });

  it('never rejects on that path, so a caller cannot restore history to an id with no row', async() => {
    rows.set(TO, movedRow());
    Object.defineProperty(proxy.mirrors, 'peers', {get() { throw new Error('mirror down'); }});
    await expect(sync.relocateGroupDialog(record.groupId, FROM, TO, record)).resolves.toBeUndefined();
  });

  it('keeps an existing target row when a re-push over it fails', async() => {
    const row = movedRow();
    rows.set(FROM, oldRow());
    rows.set(TO, row);
    dialogsStorage.pushDialog.mockRejectedValueOnce(new Error('quota'));

    await expect(sync.relocateGroupDialog(record.groupId, FROM, TO, record)).rejects.toThrow('quota');

    expect(rows.get(TO)).toBe(row);
    expect(rows.has(FROM)).toBe(true);
    expect(dialogsStorage.dropDialogWithEvent).not.toHaveBeenCalled();
  });
});

describe('applyGroupDialogFolder', () => {
  it('cannot lose the row to the not-yet-loaded folder branch of pushDialog', async() => {
    const peerId = await sync.resolveGroupPeerId(record.groupId);
    rows.set(peerId, {peerId, top_message: 5, pFlags: {}});
    await sync.applyGroupDialogFolder({...record, archivedAt: 123});
    expect(dialogsStorage.pushDialog.mock.calls[0][0].offsetDate).toBe(0);
  });
});

describe('delayed repaint', () => {
  it('does not restore a row that was cleaned up inside the window', async() => {
    const peerId = await sync.resolveGroupPeerId(record.groupId);
    vi.useFakeTimers();
    try {
      await sync.injectGroupCreateDialog(record.groupId, 1, 100, record);
      const first = repaints(peerId);
      expect(first).toBeGreaterThan(0);
      await sync.cleanupGroupChatInjection(peerId);
      vi.advanceTimersByTime(600);
      expect(repaints(peerId)).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still repaints a row that stayed', async() => {
    const peerId = await sync.resolveGroupPeerId(record.groupId);
    vi.useFakeTimers();
    try {
      await sync.injectGroupCreateDialog(record.groupId, 1, 100, record);
      const first = repaints(peerId);
      vi.advanceTimersByTime(600);
      expect(repaints(peerId)).toBe(first + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('message in an archived session', () => {
  const rumor = () => ({id: 'e'.repeat(64), created_at: 1700000000, content: JSON.stringify({id: 'm1', content: 'hi', type: 'text', timestamp: 1700000000})});

  it('keeps the incoming snapshot in the archive', async() => {
    record.archivedAt = 123;
    await sync.handleGroupIncoming('a'.repeat(64), record.groupId, rumor(), 'b'.repeat(64), vi.fn());
    const dialog = lastDialog(await sync.resolveGroupPeerId(record.groupId));
    expect(dialog.folder_id).toBe(1);
    expect(dialog.index_4).toBeUndefined();
  });

  it('keeps a live session in Sessions', async() => {
    await sync.handleGroupIncoming('a'.repeat(64), record.groupId, {...rumor(), id: 'f'.repeat(64)}, 'b'.repeat(64), vi.fn());
    const dialog = lastDialog(await sync.resolveGroupPeerId(record.groupId));
    expect(dialog.folder_id).toBe(0);
    expect(dialog.index_4).toBeDefined();
  });
});
