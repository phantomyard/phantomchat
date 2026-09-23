/**
 * Integration regression for the top-bar avatar visibility rule (PR #161,
 * Kai's review round 1).
 *
 * The rule hides the chat top bar avatar while the left bar shows a single
 * item. Round 1 derived the count from
 * `dialogsStorage.getFolderDialogs(FOLDER_ID_ALL)`, which is wrong twice:
 *
 *  1. PhantomChat injects brand-new peers/groups through `dialogs_multiupdate`
 *     (dispatchDialogUpdate / dispatchGroupDialogUpdate) before the dialog is
 *     saved into storage — the autonomous list visibly adds the row while
 *     storage still lacks it. A user going from one chat to two through live
 *     traffic therefore kept `single-dialog` and the avatar stayed hidden.
 *  2. It always counted All Chats and had no folder-switch listener.
 *
 * The fix counts the rows the ACTIVE list actually renders
 * (`appDialogsManager.xd.sortedList.getVisibleRowsCount()`), and reacts to
 * `chatlist_length_change`, dispatched by AppDialogsManager whenever a
 * rendered row is added/removed (the virtual list's length effect) and on
 * folder switch (onTabChange).
 *
 * This test drives the REAL AutonomousDialogList + SortedDialogList +
 * deferred virtual list against the REAL AppDialogsManager singleton and the
 * REAL ChatTopbar#updateTopbarAvatarVisibility — only DOM-facing collaborators
 * are stubbed — and pins:
 *   - a live-added second dialog flips the topbar 1 → 2 while storage still
 *     reports ONE dialog (the exact round-1 mismatch), through the real
 *     event → list → length-effect → dispatch → topbar chain,
 *   - pinning/unpinning the All Chats archive row (a PINNED row, invisible
 *     to itemsLength) flips the topbar too — round-2 review: the length
 *     effect subscribed only to regular items, so an archive-row toggle at
 *     one rendered row left a stale `single-dialog` class, and
 *   - onTabChange (folder switch) fires chatlist_length_change as well.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, vi} from 'vitest';
import rootScope from '@lib/rootScope';
import {FOLDER_ID_ALL} from '@appManagers/constants';
import getDialogIndexKey from '@lib/appManagers/utils/dialogs/getDialogIndexKey';
import {shouldShowTopbarAvatar} from '@lib/phantomchat/topbar-avatar';

// Polyfill browser APIs unavailable in jsdom (needed by transitive imports
// such as scrollable's module-level IntersectionObserver). vi.hoisted runs
// before any import resolution — same pattern as onboarding-npub.test.ts.
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
  // setWorkerProxy (transitive import of apiManagerProxy) references the
  // Worker global at module level, and ApiManagerProxy constructs one at
  // import; node's jsdom environment lacks it. The stub only needs the port
  // surface attachWorkerToPort touches — no real thread is spawned.
  if(typeof (globalThis as any).Worker === 'undefined') {
    (globalThis as any).Worker = class Worker {
      addEventListener(_type: string, _listener: any) {}
      postMessage(_message?: any) {}
      terminate() {}
    };
  }
  // CacheStorageController (transitive import in the topbar graph) touches
  // the Cache API at construct; jsdom does not provide `caches`.
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

// Module-level canvas probing in transitive imports crashes under jsdom
// (toDataURL is unimplemented) — stub the result instead of running it.
vi.mock('@environment/webpSupport', () => ({default: true}));

// The real apiManagerProxy constructs MTProto workers and fetches worker URLs
// at import time (network in tests). Nothing in this regression touches it —
// stub it with an everything-any callable object.
vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => prop === 'then' ? undefined : anyObj,
    apply: () => anyObj
  });
  return {default: anyObj};
});

// The appSidebarRight/appSidebarLeft singletons (transitive imports) walk
// a bootstrapped DOM at construct; nothing in this regression needs them.
vi.mock('@components/sidebarRight', () => ({
  RIGHT_COLUMN_ACTIVE_CLASSNAME: 'is-right-column-shown',
  default: {}
}));
vi.mock('@components/sidebarLeft', () => ({
  LEFT_COLUMN_ACTIVE_CLASSNAME: 'is-left-column-shown',
  default: {}
}));

const INDEX_KEY = getDialogIndexKey(FOLDER_ID_ALL);

function mkDialog(peerId: number, index: number) {
  return {
    _: 'dialog',
    peerId,
    folder_id: FOLDER_ID_ALL,
    [INDEX_KEY]: index,
    unread_count: 0,
    pFlags: {}
  } as any;
}

// dialog2 arrives through live traffic and is deliberately NEVER in this
// storage view — that staleness is the round-1 bug.
const dialog1 = mkDialog(101, 10);
const dialog2 = mkDialog(102, 20);

const staleStorageDialogs = [dialog1];

// The real topbar/graph import is heavy (thousands of modules transform in
// the worker) — give the file room beyond the 5s default.
vi.setConfig({testTimeout: 60000});

describe('top bar avatar — live-added second dialog (PR #161 regression)', () => {
  beforeAll(async() => {
    // The list machinery reads collaborators off the rootScope singleton.
    (rootScope as any).myId = 999001;
    (rootScope as any).managers = {
      dialogsStorage: {
        getFolderDialogs: () => staleStorageDialogs,
        // Must agree with each dialog's own index_N field — canUpdateDialog
        // compares the live dialog's index against the list's bottom row.
        getDialogIndex: (key: number): number => key === dialog1.peerId ? 10 : 20,
        getDialogOnly: async(): Promise<any> => undefined
      },
      // rootScope.dispatchEvent's cross-context broadcast consults these;
      // stores/premium.ts (transitive via topbar) reads managers.rootScope.
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

    // Module-level solid computations in the topbar import graph (e.g.
    // stores/contentSettings) read the app-state store; seed a minimal one.
    const {setAppStateSilent} = await import('@stores/appState');
    setAppStateSilent({
      accountContentSettings: {value: undefined},
      appConfig: {}
    } as any);
  });

  it('flips the topbar from single-dialog to avatar through the live chain', async() => {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const {AutonomousDialogList} = await import('@components/autonomousDialogList/dialogs');
    const {default: MTProtoMessagePort} = await import('@lib/mainWorker/mainMessagePort');
    const {default: ChatTopbar} = await import('@components/chat/topbar');

    // No main worker in tests — silence rootScope.dispatchEvent's broadcast.
    (MTProtoMessagePort as any).INSTANCE = {invokeVoid: vi.fn()};

    const adm = appDialogsManager as any;
    // DOM-facing collaborators of the real manager, stubbed:
    adm.checkIfPlaceholderNeeded = vi.fn();
    adm.addListDialog = (): any => ({dom: {listEl: document.createElement('div')}});
    // Exactly what start() wires in production:
    adm.onListLengthChange = (): void => void adm._onListLengthChange();
    adm.filterId = FOLDER_ID_ALL;

    const list = new AutonomousDialogList({filterId: FOLDER_ID_ALL, appDialogsManager: adm});
    adm.xd = list;
    adm.xds = {[FOLDER_ID_ALL]: list};
    list.generateScrollable({id: FOLDER_ID_ALL, localId: FOLDER_ID_ALL} as any);

    // The REAL topbar surface, minus its heavy DOM construction: only the
    // method under test and its container matter.
    const topbar = Object.create(ChatTopbar.prototype) as any;
    topbar.container = document.createElement('div');
    // Mirrors the one listener line constructPeerHelpers registers:
    const onChatlistChange = (): void => topbar.updateTopbarAvatarVisibility();
    rootScope.addEventListener('chatlist_length_change', onChatlistChange);
    try {
      topbar.updateTopbarAvatarVisibility();
      expect(topbar.container.classList.contains('single-dialog')).toBe(true);
      expect(list.sortedList.getVisibleRowsCount()).toBe(0);

      // Simulate the initial folder load (what loadDialogsInner does on
      // boot): one dialog rendered.
      const item = await list.sortedList.createItemForKey(dialog1.peerId);
      list.sortedList.addDeferredItems([item], 1);
      await vi.waitFor(() => {
        expect(list.sortedList.getVisibleRowsCount()).toBe(1);
      });
      topbar.updateTopbarAvatarVisibility();
      expect(topbar.container.classList.contains('single-dialog')).toBe(true);

      // Live traffic: a brand-new peer arrives via dialogs_multiupdate
      // BEFORE storage has it. The list visibly adds the row — the user now
      // sees two chats.
      rootScope.dispatchEvent('dialogs_multiupdate', new Map([[dialog2.peerId, {dialog: dialog2}]]) as any);

      // Through the real chain (list add → virtual-list length effect →
      // _onListLengthChange dispatch → topbar listener) the class must flip
      // without anyone calling storage first.
      await vi.waitFor(() => {
        expect(topbar.container.classList.contains('single-dialog')).toBe(false);
      });

      expect(list.sortedList.getVisibleRowsCount()).toBe(2);
      expect(shouldShowTopbarAvatar(list.sortedList.getVisibleRowsCount())).toBe(true);

      // The round-1 count source would still say "one dialog" — pin the
      // mismatch: storage is stale, rendered rows are not.
      expect((rootScope as any).managers.dialogsStorage.getFolderDialogs(FOLDER_ID_ALL)).toHaveLength(1);
    } finally {
      rootScope.removeEventListener('chatlist_length_change', onChatlistChange);
    }
  });

  it('flips the topbar when the All Chats archive row is pinned/unpinned', async() => {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const {AutonomousDialogList} = await import('@components/autonomousDialogList/dialogs');
    const {default: MTProtoMessagePort} = await import('@lib/mainWorker/mainMessagePort');
    const {default: ChatTopbar} = await import('@components/chat/topbar');

    (MTProtoMessagePort as any).INSTANCE = {invokeVoid: vi.fn()};

    const adm = appDialogsManager as any;
    adm.checkIfPlaceholderNeeded = vi.fn();
    adm.addListDialog = (): any => ({dom: {listEl: document.createElement('div')}});
    adm.onListLengthChange = (): void => void adm._onListLengthChange();
    adm.filterId = FOLDER_ID_ALL;

    // Real FOLDER_ID_ALL list, so it owns a customPinnedDialog + archive
    // state exactly as production does.
    const list = new AutonomousDialogList({filterId: FOLDER_ID_ALL, appDialogsManager: adm});
    adm.xd = list;
    adm.xds = {[FOLDER_ID_ALL]: list};
    list.generateScrollable({id: FOLDER_ID_ALL, localId: FOLDER_ID_ALL} as any);

    const topbar = Object.create(ChatTopbar.prototype) as any;
    topbar.container = document.createElement('div');
    const onChatlistChange = (): void => topbar.updateTopbarAvatarVisibility();
    rootScope.addEventListener('chatlist_length_change', onChatlistChange);
    try {
      topbar.updateTopbarAvatarVisibility();
      expect(topbar.container.classList.contains('single-dialog')).toBe(true);
      expect(list.sortedList.getVisibleRowsCount()).toBe(0);

      // One regular dialog rendered — a single chat, avatar hidden.
      const item = await list.sortedList.createItemForKey(dialog1.peerId);
      list.sortedList.addDeferredItems([item], 1);
      await vi.waitFor(() => {
        expect(list.sortedList.getVisibleRowsCount()).toBe(1);
      });
      topbar.updateTopbarAvatarVisibility();
      expect(topbar.container.classList.contains('single-dialog')).toBe(true);

      // An archived dialog appears → onHasArchiveDialogChanged(true) pins the
      // archive row. The count goes 1 → 2 through a PINNED row: itemsLength
      // never moves, so the round-2 effect (subscribed to itemsLength only)
      // stayed silent and the class went stale.
      await (list as any).onHasArchiveDialogChanged(true);

      await vi.waitFor(() => {
        expect(topbar.container.classList.contains('single-dialog')).toBe(false);
      });
      expect(list.sortedList.getVisibleRowsCount()).toBe(2);

      // Archive empties again → row unpinned, back to a single rendered row.
      await (list as any).onHasArchiveDialogChanged(false);

      await vi.waitFor(() => {
        expect(topbar.container.classList.contains('single-dialog')).toBe(true);
      });
      expect(list.sortedList.getVisibleRowsCount()).toBe(1);
    } finally {
      rootScope.removeEventListener('chatlist_length_change', onChatlistChange);
    }
  });

  it('fires chatlist_length_change on folder switch (onTabChange)', async() => {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const adm = appDialogsManager as any;
    adm.filterId = FOLDER_ID_ALL;
    adm.xd = adm.xds = {[FOLDER_ID_ALL]: {reset: vi.fn(), onChatsScroll: vi.fn() as () => void}};
    adm.cancelChatlistUpdatesFetching = undefined;

    let fired = false;
    const onChatlistChange = (): void => {fired = true;};
    rootScope.addEventListener('chatlist_length_change', onChatlistChange);
    try {
      adm.onTabChange();
      expect(fired).toBe(true);
      expect(adm.xd.reset).toHaveBeenCalled();
    } finally {
      rootScope.removeEventListener('chatlist_length_change', onChatlistChange);
    }
  });
});