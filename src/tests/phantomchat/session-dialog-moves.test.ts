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
const dialogsStorage = {
  getAnyDialog: vi.fn(),
  dropDialogWithEvent: vi.fn().mockResolvedValue(undefined),
  pushDialog: vi.fn().mockResolvedValue(undefined)
};
const setConversationTwebPeerId = vi.fn().mockResolvedValue(0);
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
          invalidateHistoryCache: vi.fn().mockResolvedValue(undefined)
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
  dialogsStorage.getAnyDialog.mockReset().mockResolvedValue(undefined);
  dialogsStorage.dropDialogWithEvent.mockClear();
  dialogsStorage.pushDialog.mockClear();
  setConversationTwebPeerId.mockClear().mockResolvedValue(0);
  record = {groupId: 'ab'.repeat(16), name: 'S', members: [], adminPubkey: 'a'.repeat(64), peerId: TO, kind: 'session', createdAt: 1, updatedAt: 1};
});

describe('moveSyncedGroupToPeer', () => {
  it('re-stamps history and moves the row off the old peer', async() => {
    dialogsStorage.getAnyDialog.mockImplementation(async(peerId: number) =>
      peerId === FROM ? {top_message: 77, index_0: 5 * 0x10000, unread_count: 2, read_inbox_max_id: 70, read_outbox_max_id: 70, pFlags: {}} : undefined);

    await sync.moveSyncedGroupToPeer(record, FROM);

    expect(setConversationTwebPeerId).toHaveBeenCalledWith(`group:${record.groupId}`, TO);
    expect(dialogsStorage.dropDialogWithEvent).toHaveBeenCalledWith(FROM);
    const pushed = dialogsStorage.pushDialog.mock.calls[0][0].dialog;
    expect(pushed.peerId).toBe(TO);
    expect(pushed.top_message).toBe(77);
    expect(pushed.unread_count).toBe(2);
  });

  it('routes later traffic to the new peer', async() => {
    await sync.moveSyncedGroupToPeer({...record, groupId: 'cd'.repeat(16)}, FROM);
    record = {...record, groupId: 'cd'.repeat(16), kind: undefined, peerId: FROM};
    const {groupIdToPeerId} = await import('@lib/phantomchat/group-types');
    expect(await sync.resolveGroupPeerId('cd'.repeat(16))).toBe(await groupIdToPeerId('cd'.repeat(16), 'session'));
  });
});

describe('relocateGroupDialog retry', () => {
  it('reads the moved row when the old one is already gone', async() => {
    dialogsStorage.getAnyDialog.mockImplementation(async(peerId: number) =>
      peerId === TO ? {top_message: 88, index_0: 9 * 0x10000, unread_count: 3, read_inbox_max_id: 80, read_outbox_max_id: 80, pFlags: {pinned: true}} : undefined);

    await sync.relocateGroupDialog(record.groupId, FROM, TO, record);

    const pushed = dialogsStorage.pushDialog.mock.calls[0][0].dialog;
    expect(pushed.top_message).toBe(88);
    expect(pushed.unread_count).toBe(3);
    expect(pushed.pFlags.pinned).toBe(1);
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
