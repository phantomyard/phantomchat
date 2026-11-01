/**
 * Archive must leave the Sessions / Groups space WITHOUT a reload.
 *
 * Symptom (owner, 2026-11-01): "when I archive a group in sessions list, it
 * archives it ok but it does not refresh the sessions view and the group is
 * still visible... if I navigate away and come back it clears it from the
 * folder."
 *
 * Cause: `applyGroupDialogFolder` moved the row with `pushDialog`, and the
 * per-folder index recompute that decides membership (`processDialogForFilters`
 * → `index_4` / `index_3`) happens inside DialogsStorage — which, from the main
 * thread, is a MessagePort PROXY. The dialog is cloned on the way over, so the
 * object that gets dispatched to the chat list still carries the index of the
 * space the row just left. `AutonomousDialogList.testDialogForFilter` keys
 * membership for Sessions / Groups on that transient index, so the list
 * repainted the archived row as a genuine member, and only a rebuilt space
 * (navigate away and back) agreed with storage.
 *
 * The fix pins the dispatch to the row storage now holds, and never lets the
 * fallback dispatch a row that still claims a folder it no longer belongs to.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import {isSessionPeer} from '@lib/phantomchat/group-types';

// jsdom lacks the observers the real AppDialogsManager / SortedDialogList pull
// in through appImManager (same shims as empty-space-pane-teardown.test.ts).
vi.hoisted(() => {
  if(typeof globalThis.IntersectionObserver === 'undefined') {
    (globalThis as any).IntersectionObserver = class {
      constructor(_cb: any, _opts?: any) {}
      observe() {} unobserve() {} disconnect() {} takeRecords(): any[] { return []; }
    };
  }
  if(typeof (globalThis as any).ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class {
      constructor(_cb: any) {}
      observe() {} unobserve() {} disconnect() {}
    };
  }
  if(typeof (globalThis as any).Worker === 'undefined') {
    (globalThis as any).Worker = class Worker {
      addEventListener(_type: string, _listener: any) {}
      postMessage(_message?: any) {}
      terminate() {}
    };
  }
  if(typeof (globalThis as any).matchMedia === 'undefined') {
    (globalThis as any).matchMedia = (): any => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    });
  }
});

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : +this;
  };
}

const GROUP_ID = 'ab'.repeat(48);

const proxy = {mirrors: {peers: {} as any, chats: {} as any, messages: {} as any, dialogs: {} as any}};
const dispatchEvent = vi.fn();
// Behaves like the real storage: `pushDialog` recomputes the per-folder indices
// on ITS copy (which is what the MessagePort does in production), and
// `getDialog` reads that copy back.
const rows = new Map<number, any>();
const dialogsStorage = {
  getAnyDialog: vi.fn(async(peerId: number) => rows.has(peerId) ? [rows.get(peerId)] : []),
  getDialog: vi.fn(async(peerId: number) => rows.has(peerId) ? [structuredClone(rows.get(peerId))] : []),
  pushDialog: vi.fn(async({dialog}: {dialog: any}) => {
    const stored = structuredClone(dialog);
    const liveKey = isSessionPeer(stored.peerId) ? 'index_4' : 'index_3';
    delete stored.index_3;
    delete stored.index_4;
    if(stored.folder_id === 1) stored.index_1 = stored.index_0;
    else stored[liveKey] = stored.index_0;
    rows.set(stored.peerId, stored);
  })
};

let sync: typeof import('@lib/phantomchat/phantomchat-groups-sync');
let peerId: number;

const lastDialog = (id: number) => {
  const calls = dispatchEvent.mock.calls.filter((c) => c[0] === 'dialogs_multiupdate' && c[1].has(id));
  return calls.length ? calls[calls.length - 1][1].get(id).dialog : undefined;
};

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@config/debug', async() => {
    const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
    return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: proxy}};
  });
  vi.doMock('@lib/phantomchat/group-store', () => ({
    GroupStore: class {},
    getGroupStore: (): any => ({
      get: async(): Promise<any> => ({groupId: GROUP_ID, kind: 'session', name: 'Session'}),
      getByPeerId: async(): Promise<any> => null,
      getAll: async(): Promise<any[]> => []
    })
  }));
  vi.doMock('@lib/phantomchat/message-store', () => ({
    getMessageStore: (): any => ({
      setConversationTwebPeerId: vi.fn(),
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
  peerId = await sync.resolveGroupPeerId(GROUP_ID);
});

beforeEach(() => {
  dispatchEvent.mockClear();
  dialogsStorage.getDialog.mockClear();
  dialogsStorage.pushDialog.mockClear();
  rows.clear();
  (proxy.mirrors.dialogs as any) = {};
});

const liveRow = (id: number) => ({
  _: 'dialog',
  peerId: id,
  folder_id: 0,
  index_0: 9 * 0x10000,
  index_4: 9 * 0x10000,
  top_message: 9,
  unread_count: 0,
  pFlags: {}
} as any);

describe('applyGroupDialogFolder: the dispatched row is the reindexed one', () => {
  it('drops index_4 from the row handed to the Sessions list', async() => {
    const live = liveRow(peerId);
    rows.set(peerId, structuredClone(live));
    (proxy.mirrors.dialogs as any)[peerId] = live;

    await sync.applyGroupDialogFolder({groupId: GROUP_ID, kind: 'session', archivedAt: 1234});

    const dispatched = lastDialog(peerId);
        expect(dispatched).toBeTruthy();
    expect(dispatched.folder_id).toBe(1);
    // The whole bug: this used to still be defined, so the list kept the row.
    expect(dispatched.index_4).toBeUndefined();
    // The clone that was handed to the worker was never mutated into the
    // dispatched row — the dispatch is a row read back from storage.
    expect(live.index_4).toBe(9 * 0x10000);
  });

  it('re-stamps index_4 when the row comes back out of the archive', async() => {
    const archived = {...liveRow(peerId), folder_id: 1, index_1: 9 * 0x10000};
    delete archived.index_4;
    rows.set(peerId, structuredClone(archived));
    (proxy.mirrors.dialogs as any)[peerId] = archived;

    await sync.applyGroupDialogFolder({groupId: GROUP_ID, kind: 'session'});

    const dispatched = lastDialog(peerId);
    expect(dispatched.folder_id).toBe(0);
    expect(dispatched.index_4).toBe(9 * 0x10000);
  });

  it('clears the live-folder indices when the row cannot be read back', async() => {
    const live = {...liveRow(peerId), index_3: 9 * 0x10000};
    rows.set(peerId, structuredClone(live));
    (proxy.mirrors.dialogs as any)[peerId] = live;
    // First read returns the live row; the post-push re-read comes back empty.
    dialogsStorage.getDialog
      .mockImplementationOnce(async() => [structuredClone(live)])
      .mockImplementationOnce(async(): Promise<any[]> => []);

    await sync.applyGroupDialogFolder({groupId: GROUP_ID, kind: 'session', archivedAt: 1234});

    const dispatched = lastDialog(peerId);
    expect(dispatched.folder_id).toBe(1);
    expect(dispatched.index_4).toBeUndefined();
    expect(dispatched.index_3).toBeUndefined();
  });
});

/**
 * Lena's point 2 at `feba3dd`: the re-read has to RESOLVE, not quietly fall back.
 * `getDialog` walks the `REAL_FOLDERS` arrays while `processDialogForFilter`
 * inserts the row into the destination folder's array, so an archived row is
 * found even when the Archive folder was never loaded. The suite above models
 * that by hand; this one drives the REAL `DialogsStorage` so the claim rests on
 * production code. It deliberately stops at the storage boundary — no port, no
 * dispatch — because the port simulation above is already the honest model, and
 * booting tweb's state machinery here would only test the shims instead.
 */
describe('the archived row is readable out of the real folder arrays', () => {
  it('clears the live-folder index and inserts into a never-loaded Archive', async() => {
    const {default: DialogsStorage} = await import('@lib/storages/dialogs');
    const storage = new DialogsStorage();

    (storage as any).folders = {};
    (storage as any).dialogs = {};
    (storage as any).allDialogsLoaded = {0: true, 1: false, 3: true, 4: true};
    (storage as any).appPeersManager = {
      peerId: 0x777,
      isBotforum: () => false,
      isMuted: () => false,
      isChannel: () => false
    };
    (storage as any).appMessagesManager = {
      getMessageByPeer: () => ({date: 1_000, pFlags: {}, mid: 9})
    };
    const archivedOnly = (dialog: any) => dialog.folder_id === 1;
    const sessionPeer = (dialog: any) => isSessionPeer(dialog.peerId);
    (storage as any).filtersStorage = {
      getFilters: () => ({
        0: {id: 0, pinnedPeerIds: [] as any[]},
        1: {id: 1, pinnedPeerIds: [] as any[]},
        3: {id: 3, pinnedPeerIds: [] as any[]},
        4: {id: 4, pinnedPeerIds: [] as any[]}
      }),
      getFilter: (id: number) => ({id, pinnedPeerIds: [] as any[]}),
      // Archive holds only archived rows; Groups / Sessions hold the row only
      // while it is live and its peer class matches the space.
      testDialogForFilter: (dialog: any, filter: any) => {
        if(filter.id === 1) return archivedOnly(dialog);
        if(archivedOnly(dialog)) return false;
        if(filter.id === 4) return sessionPeer(dialog);
        if(filter.id === 3) return !sessionPeer(dialog);
        return true;
      }
    };
    vi.spyOn(storage as any, 'prepareFolderUnreadCountModifyingByDialog').mockImplementation(() => () => {});
    (storage as any).peersStorage = {requestPeersForKey: () => {}, releasePeer: () => {}};

    const row = {...liveRow(peerId), folder_id: 1} as any;

    // Real production reindex, over all four filters as `processDialogForFilters`
    // does: this is the code that decides membership and clears the live indices.
    (storage as any).processDialogForFilters(row);

    expect((storage as any).getFolder(0).dialogs.length).toBe(0);
    expect((storage as any).getFolder(1).dialogs.length).toBe(1);
    expect(row.index_4).toBeUndefined();

    // And the row the fix reads back is the one in Archive — Archive itself was
    // never loaded, which is the case that used to make this fall back.
    const [found] = storage.getDialog(peerId as any) as any[];
    expect(found).toBeTruthy();
    expect(found).toBe(row);
    expect(found.folder_id).toBe(1);
    expect(found.index_4).toBeUndefined();
  });
});
