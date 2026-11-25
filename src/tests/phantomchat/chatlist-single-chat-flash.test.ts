/**
 * Single-chat flash (2026-11-25): with exactly ONE chat in the Chats space, the
 * empty three-phantom artwork flashed while a phantom was "working".
 *
 * Cause: `canUpdateDialog` measured an update against the list's bottom row —
 * which, with one chat, is that same chat. Bridge snapshots
 * (`createTwebDialog`) carry `index_0 = date * 0x10000`, while the row's stored
 * index from DialogsStorage is `date * 0x10000 + counter`, so a re-dispatch of
 * the same top message (receipts, send bursts, their delayed retries) always
 * ranked just under its own row and got the row deleted. The list hit zero,
 * the empty pane painted, and the retry dispatch re-added the row.
 *
 * Drives the REAL AutonomousDialogList + SortedDialogList + virtual list.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, vi} from 'vitest';
import rootScope from '@lib/rootScope';
import {FOLDER_ID_ALL} from '@appManagers/constants';
import getDialogIndexKey from '@lib/appManagers/utils/dialogs/getDialogIndexKey';

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
  if(typeof (globalThis as any).caches === 'undefined') {
    const makeCache = (): any => ({
      match: async(): Promise<any> => undefined,
      put: async(): Promise<void> => {},
      delete: async(): Promise<void> => {},
      keys: async(): Promise<any[]> => []
    });
    (globalThis as any).caches = {
      open: async(): Promise<any> => makeCache(),
      keys: async(): Promise<any[]> => [],
      delete: async(): Promise<void> => {},
      has: async(): Promise<boolean> => false
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

vi.mock('@environment/webpSupport', () => ({default: true}));
// jsdom cannot decode the empty Chats artwork.
vi.mock('@helpers/dom/renderImageFromUrl', () => ({renderImageFromUrlPromise: async() => {}}));

vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => prop === 'then' ? undefined : anyObj,
    apply: () => anyObj
  });
  return {default: anyObj};
});

vi.mock('@components/sidebarRight', () => ({
  RIGHT_COLUMN_ACTIVE_CLASSNAME: 'is-right-column-shown',
  default: {}
}));
vi.mock('@components/sidebarLeft', () => ({
  LEFT_COLUMN_ACTIVE_CLASSNAME: 'is-left-column-shown',
  default: {}
}));

const INDEX_KEY = getDialogIndexKey(FOLDER_ID_ALL);
const DATE = 1_790_000_000;
/** What DialogsStorage stores for the row: date * 0x10000 + counter. */
const STORED_INDEX = DATE * 0x10000 + 7;
/** What a bridge snapshot carries for the SAME top message. */
const BRIDGE_INDEX = DATE * 0x10000;

function mkChatDialog(peerId: number, index: number) {
  return {
    _: 'dialog',
    peerId,
    folder_id: 0,
    [INDEX_KEY]: index,
    unread_count: 0,
    pFlags: {}
  } as any;
}

vi.setConfig({testTimeout: 60000});

const storedIndexes = new Map<number, number>();

describe('single-chat Chats space never drops its only row on a same-message update', () => {
  beforeAll(async() => {
    (rootScope as any).myId = 999003;
    (rootScope as any).managers = {
      dialogsStorage: {
        getFolderDialogs: (): any[] => [],
        getDialogIndex: (key: number): number => storedIndexes.get(key) ?? 10,
        getDialogOnly: async(): Promise<any> => undefined
      },
      apiManager: {getAccountNumber: async(): Promise<number> => 1},
      rootScope: {getPremium: async(): Promise<any> => undefined},
      appPaymentsManager: {
        getStarsStatus: async(): Promise<any> => ({balance: '0'}),
        getStarsStatusTon: async(): Promise<any> => ({balance: {amount: '0'}})
      },
      appStoriesManager: {
        getAllStories: async(): Promise<any> => ({_: 'stories.allStories' as const, pFlags: {has_more: false}, peer_stories: [] as any[], chats: [] as any[], users: [] as any[]}),
        getPeerStories: async(): Promise<any> => undefined,
        getStealthMode: async(): Promise<any> => ({_: 'stories.stealthMode'})
      }
    };

    const {setAppStateSilent} = await import('@stores/appState');
    setAppStateSilent({
      accountContentSettings: {value: undefined},
      appConfig: {}
    } as any);
  });

  async function makeList(peers: Array<[number, number]>) {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const {AutonomousDialogList} = await import('@components/autonomousDialogList/dialogs');
    const {default: MTProtoMessagePort} = await import('@lib/mainWorker/mainMessagePort');

    (MTProtoMessagePort as any).INSTANCE = {invokeVoid: vi.fn()};

    const adm = appDialogsManager as any;
    adm.checkIfPlaceholderNeeded = vi.fn();
    adm.addListDialog = (): any => ({dom: {listEl: document.createElement('div')}});
    adm.setLastMessageN = vi.fn();
    adm.onListLengthChange = vi.fn();
    adm.filterId = FOLDER_ID_ALL;

    const list = new AutonomousDialogList({filterId: FOLDER_ID_ALL, appDialogsManager: adm});
    adm.xd = list;
    adm.xds = {[FOLDER_ID_ALL]: list};
    list.generateScrollable({id: FOLDER_ID_ALL, localId: 0} as any);

    for(const [peerId, index] of peers) storedIndexes.set(peerId, index);
    const items = await Promise.all(peers.map(([peerId]) => list.sortedList.createItemForKey(peerId)));
    list.sortedList.addDeferredItems(items, peers.length);
    // A paginated load that has not proven it reached the end — the state in
    // which the bottom-row comparison is consulted at all.
    (list as any).hasReachedTheEnd = false;

    return {adm, list};
  }

  it('keeps the only row when a bridge snapshot of the same message arrives', async() => {
    const peerId = 4101;
    const {list} = await makeList([[peerId, STORED_INDEX]]);
    expect(list.sortedList.getVisibleRowsCount()).toBe(1);

    const deleteSpy = vi.spyOn(list.sortedList, 'delete');
    await list.updateDialog(mkChatDialog(peerId, BRIDGE_INDEX));

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(list.sortedList.getVisibleRowsCount()).toBe(1);
  });

  it('keeps the only row through a dialogs_multiupdate burst', async() => {
    const peerId = 4102;
    const {list} = await makeList([[peerId, STORED_INDEX]]);
    const counts: number[] = [];
    const deleteSpy = vi.spyOn(list.sortedList, 'delete');

    for(let i = 0; i < 3; ++i) {
      const dialog = mkChatDialog(peerId, BRIDGE_INDEX);
      rootScope.dispatchEvent('dialogs_multiupdate', new Map([[peerId, {dialog}]]) as any);
      await new Promise((r) => setTimeout(r, 0));
      counts.push(list.sortedList.itemsLength());
    }

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(counts).toEqual([1, 1, 1]);
  });

  it('still drops a row that falls below ANOTHER row while more pages remain', async() => {
    const top = 4103, bottom = 4104;
    const {list} = await makeList([[top, STORED_INDEX], [bottom, STORED_INDEX - 0x10000 * 60]]);
    expect(list.sortedList.getVisibleRowsCount()).toBe(2);

    // `top` now sorts older than `bottom`, and older pages are not loaded:
    // the existing pagination rule must still remove it.
    await list.updateDialog(mkChatDialog(top, STORED_INDEX - 0x10000 * 3600));
    expect(list.sortedList.has(top)).toBe(false);
    expect(list.sortedList.has(bottom)).toBe(true);
  });

  it('waits before painting the empty artwork when a list that had rows drops to zero', async() => {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const adm = appDialogsManager as any;
    // Earlier cases stub this on the singleton; the grace timer must re-enter the real one.
    delete adm.checkIfPlaceholderNeeded;
    const realCheck = adm.checkIfPlaceholderNeeded;
    adm.managers = {appUsersManager: {getContacts: async(): Promise<any[]> => []}};

    const part = document.createElement('div');
    const chatList = document.createElement('ul');
    part.append(chatList);
    let rows = 1;
    adm.filterId = FOLDER_ID_ALL;
    adm.chatListHadRows = false;
    adm.xd = {sortedList: {list: chatList, hasFetchedDialogs: () => true, itemsLength: () => rows}};

    vi.useFakeTimers();
    try {
      realCheck.call(adm); // one row on screen
      expect(part.querySelector('.empty-placeholder')).toBeNull();

      rows = 0; // the row is swapped out for a frame
      realCheck.call(adm);
      expect(part.querySelector('.empty-placeholder')).toBeNull();

      rows = 1; // …and back before the grace period ends
      realCheck.call(adm);
      vi.advanceTimersByTime(1000);
      expect(part.querySelector('.empty-placeholder')).toBeNull();

      rows = 0; // genuinely empty: the artwork still appears, just later
      realCheck.call(adm);
      expect(part.querySelector('.empty-placeholder')).toBeNull();
      vi.advanceTimersByTime(300);
      expect(part.querySelector('.empty-placeholder')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
