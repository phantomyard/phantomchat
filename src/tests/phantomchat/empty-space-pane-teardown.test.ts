/**
 * Empty-space pane teardown (owner batch 13, 2026-10-31).
 *
 * Symptom: a space that loaded with nothing in it (e.g. Sessions with one
 * session created after boot, or opened before the session's row was injected)
 * keeps its "Nothing here yet" pane forever. The pane is torn down from the
 * LOAD path only:
 *
 *   - `DialogsPlaceholder.detach()` is called by `loadDialogsInner` /
 *     `loadDialogs`, and the shimmer placeholder blocks the scrollable
 *     (`overflowY: hidden`) while attached;
 *   - the empty-space pane (`.empty-placeholder`, the `#` + "Nothing here yet"
 *     panel) is removed by `checkIfPlaceholderNeeded()`, which reaches the
 *     manager through the sorted list's length effect — and that effect is
 *     gated on `wasAtLeastOnceFetched()`, which only the load path sets.
 *
 * So a row arriving through live traffic (`dialogs_multiupdate`, a phantom's
 * reply) into an already-loaded-empty space renders *underneath* both and the
 * space looks blank exactly while a phantom is answering.
 *
 * The fix: `updateDialog` adding a row notifies the manager (which re-runs the
 * empty-pane check) and detaches the loading placeholder.
 *
 * This drives the REAL AutonomousDialogList + SortedDialogList + deferred
 * virtual list against the REAL AppDialogsManager singleton, stubbing only the
 * canvas placeholder (jsdom has no 2d context) and DOM-facing collaborators.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, vi} from 'vitest';
import rootScope from '@lib/rootScope';
import {FOLDER_ID_SESSION} from '@appManagers/constants';
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

const INDEX_KEY = getDialogIndexKey(FOLDER_ID_SESSION);

/** A session dialog: membership in the Sessions space is the per-filter index. */
function mkSessionDialog(peerId: number, index: number) {
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

describe('empty-space pane teardown for a space that loaded empty', () => {
  beforeAll(async() => {
    (rootScope as any).myId = 999002;
    (rootScope as any).managers = {
      dialogsStorage: {
        getFolderDialogs: (): any[] => [],
        getDialogIndex: (): number => 10,
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

  async function makeList(checkIfPlaceholderNeeded: any) {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const {AutonomousDialogList} = await import('@components/autonomousDialogList/dialogs');
    const {default: MTProtoMessagePort} = await import('@lib/mainWorker/mainMessagePort');

    (MTProtoMessagePort as any).INSTANCE = {invokeVoid: vi.fn()};

    const adm = appDialogsManager as any;
    adm.checkIfPlaceholderNeeded = checkIfPlaceholderNeeded;
    adm.addListDialog = (): any => ({dom: {listEl: document.createElement('div')}});
    adm.onListLengthChange = (): void => void adm._onListLengthChange();
    adm.filterId = FOLDER_ID_SESSION;

    const list = new AutonomousDialogList({filterId: FOLDER_ID_SESSION, appDialogsManager: adm});
    adm.xd = list;
    adm.xds = {[FOLDER_ID_SESSION]: list};
    list.generateScrollable({id: FOLDER_ID_SESSION, localId: 2} as any);

    return {adm, list};
  }

  it('detaches the loading placeholder and re-runs the empty-pane check when a live row arrives', async() => {
    const checkIfPlaceholderNeeded = vi.fn();
    const {list} = await makeList(checkIfPlaceholderNeeded);

    // The canvas placeholder cannot construct under jsdom (no 2d context) —
    // stub the instance, keep the real detach contract.
    const detach = vi.fn();
    (list as any).createPlaceholder = () => ({detach} as any);
    list.checkForDialogsPlaceholder();
    expect((list as any).placeholder).toBeTruthy();

    // The space loaded and found nothing — this is what sets the
    // `wasAtLeastOnceFetched` gate that disables the length effect.
    list.sortedList.addDeferredItems([], 0);
    checkIfPlaceholderNeeded.mockClear();

    const dialog = mkSessionDialog(202, 10);
    rootScope.dispatchEvent('dialogs_multiupdate', new Map([[dialog.peerId, {dialog}]]) as any);

    await vi.waitFor(() => {
      expect(list.sortedList.getVisibleRowsCount()).toBe(1);
    });
    // The pane's own teardown runs through the manager…
    await vi.waitFor(() => {
      expect(checkIfPlaceholderNeeded).toHaveBeenCalled();
    });
    // …and the loading skeleton (which blocks the scrollable) is released.
    expect(detach).toHaveBeenCalled();
  });

  it('renders a live row in a space whose load was empty even without the skeleton', async() => {
    const checkIfPlaceholderNeeded = vi.fn();
    const {list} = await makeList(checkIfPlaceholderNeeded);
    list.sortedList.addDeferredItems([], 0);
    checkIfPlaceholderNeeded.mockClear();

    const dialog = mkSessionDialog(203, 10);
    rootScope.dispatchEvent('dialogs_multiupdate', new Map([[dialog.peerId, {dialog}]]) as any);

    await vi.waitFor(() => {
      expect(list.sortedList.getVisibleRowsCount()).toBe(1);
    });
    expect(checkIfPlaceholderNeeded).toHaveBeenCalled();
  });

  it('removes the rendered "nothing here yet" pane once a row exists', async() => {
    const {default: appDialogsManager} = await import('@lib/appDialogsManager');
    const adm = appDialogsManager as any;
    // Read the REAL method off the prototype: earlier tests in this file
    // replace the instance property with a spy, and this test needs the
    // production teardown that walks the rendered pane out of the DOM.
    const checkIfPlaceholderNeeded: () => void =
      (Object.getPrototypeOf(adm) as any).checkIfPlaceholderNeeded.bind(adm);
    const {list} = await makeList(checkIfPlaceholderNeeded);

    const chatList = list.sortedList.list;
    // The virtual list is not attached to the document in a test — give it the
    // parent the empty pane actually lives in.
    const host = document.createElement('div');
    host.append(chatList);
    const pane = document.createElement('div');
    pane.classList.add('empty-placeholder', 'empty-placeholder-folder');
    host.append(pane);
    host.classList.add('with-placeholder');

    // Empty space → the pane is needed and stays.
    checkIfPlaceholderNeeded();
    expect(host.querySelector('.empty-placeholder')).toBeTruthy();

    const dialog = mkSessionDialog(204, 10);
    rootScope.dispatchEvent('dialogs_multiupdate', new Map([[dialog.peerId, {dialog}]]) as any);

    await vi.waitFor(() => {
      expect(list.sortedList.getVisibleRowsCount()).toBe(1);
    });
    await vi.waitFor(() => {
      expect(host.querySelector('.empty-placeholder')).toBeNull();
    });
    expect(host.classList.contains('with-placeholder')).toBe(false);
  });
});
