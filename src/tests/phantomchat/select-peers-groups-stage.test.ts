/**
 * Pins the Groups stage of the peer picker's dialog walk (#283 / #340).
 *
 * Chats (0) excludes group chats by presentation rule, so a picker that walks
 * 0 -> 1 -> contacts loses every group. `getMoreGroups` is that third stage and
 * the only foldered enumeration that yields them; nothing pinned it before.
 *
 * Drives the REAL AppSelectPeers methods on a prototype-hosted instance; only
 * DOM-facing collaborators are stubbed. `@environment/webpSupport` is imported
 * for real on purpose — three existing tests mock the probe, so a mock here
 * would leave this import chain unproven (#342 review note).
 */
import 'fake-indexeddb/auto';
import '../setup';
// Number/String peerId helpers (isUser, toChatId) are a side-effect polyfill;
// filterByRights calls peerId.isUser() on raw numbers.
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import rootScope from '@lib/rootScope';
import {FOLDER_ID_ALL, FOLDER_ID_GROUPS} from '@appManagers/constants';
import webpSupport from '@environment/webpSupport';

const SELF = 1_000_000_003;
const USER_A = 1_000_000_001;
const USER_B = 1_000_000_002;
const GROUP_A = -1_000_000_001;
const GROUP_B = -1_000_000_002;
const FOLDER_ARCHIVED = 1;

// Browser APIs jsdom lacks but the component's import graph touches at module
// scope: setWorkerProxy (apiManagerProxy) reaches for `Worker`,
// CacheStorageController for `caches`, the picker's layout for `matchMedia`.
const {peers} = vi.hoisted(() => {
  if(!(globalThis as any).Worker) (globalThis as any).Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  if(typeof (globalThis as any).caches === 'undefined') {
    const makeCache = (): any => ({match: async(): Promise<any> => undefined, put: async(): Promise<void> => {}, delete: async(): Promise<void> => {}, keys: async(): Promise<any[]> => []});
    (globalThis as any).caches = {open: async(): Promise<any> => makeCache(), keys: async(): Promise<any[]> => [], delete: async(): Promise<void> => {}, has: async(): Promise<boolean> => false};
  }
  if(typeof (globalThis as any).matchMedia === 'undefined') {
    (globalThis as any).matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}});
  }
  return {peers: new Map<number, any>()};
});

// The real proxy spawns MTProto workers on import; the rights filter is the
// only consumer here, so a Map lookup is enough.
vi.mock('@lib/apiManagerProxy', () => ({
  default: {getPeer: (id: number) => peers.get(id) ?? {_: 'chat', id, pFlags: {}}}
}));

// The sidebar singletons (via appSearchSuper) walk a bootstrapped DOM at
// construct; this walk needs neither.
vi.mock('@components/sidebarRight', () => ({
  RIGHT_COLUMN_ACTIVE_CLASSNAME: 'is-right-column-shown',
  default: {}
}));
vi.mock('@components/sidebarLeft', () => ({
  LEFT_COLUMN_ACTIVE_CLASSNAME: 'is-left-column-shown',
  default: {}
}));

const mkDialog = (peerId: number) => ({_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0}) as any;

let AppSelectPeers: any;
let instance: any;
let getDialogs: any;

function harness() {
  const target = Object.create(AppSelectPeers.prototype);
  target.loadedWhat = {};
  target.tempIds = {};
  target.query = '';
  target.peerType = []; // renderSaved gates on 'dialogs' — keep it out of the walk
  target.folderId = FOLDER_ID_ALL;
  target.offsetIndex = 0;
  target.renderedPeerIds = new Set();
  target.chatRightsActions = undefined;
  target.renderResultsFunc = vi.fn();
  target.getMoreContacts = vi.fn();
  getDialogs = vi.fn();
  target.managers = {dialogsStorage: {getDialogs}};
  return target;
}

// setConfig's testTimeout does NOT cover hooks, and the component import — the
// slowest part, a cold transform + module-scope solid computations — happens in
// beforeAll. That import alone measured ~17s on CI hardware (#344 review), so
// the default 10s hook budget is not enough; keep two orders of headroom.
vi.setConfig({testTimeout: 120000, hookTimeout: 120000});

describe('peer picker — Groups stage (getMoreGroups)', () => {
  beforeAll(async() => {
    // The import graph reaches module-scope solid computations that read the
    // app-state store and rootScope.managers (stores/stars prefetches on
    // mount), so seed both minimally before importing the component.
    (rootScope as any).myId = SELF;
    (rootScope as any).managers = {
      appPaymentsManager: {
        getStarsStatus: async() => ({balance: '0'}),
        getStarsStatusTon: async() => ({balance: {amount: '0'}})
      },
      apiManager: {getAccountNumber: async(): Promise<number> => 1},
      rootScope: {getPremium: async(): Promise<any> => undefined}
    };
    const {setAppStateSilent} = await import('@stores/appState');
    setAppStateSilent({accountContentSettings: {value: undefined}, appConfig: {}} as any);
    AppSelectPeers = (await import('@components/appSelectPeers')).default;
  }, 120000);

  beforeEach(() => {
    (rootScope as any).myId = SELF;
    peers.clear();
    instance = harness();
  });

  // Note: this asserts the probe resolves to a boolean, not that it is unmocked —
  // a mock returning a boolean would pass too. What it pins down is that the real
  // module was imported and evaluated without throwing in this environment.
  it('the WebP probe resolves to a boolean through the real module import', () => {
    expect(webpSupport).not.toBeUndefined();
    expect(typeof webpSupport).toBe('boolean');
  });

  it('walks Chats -> Archived -> Groups and pins the Groups call shape', async() => {
    getDialogs.mockImplementation(async({filterId}: any) => {
      if(filterId === FOLDER_ID_ALL) return {dialogs: [mkDialog(USER_A)], isEnd: true};
      if(filterId === FOLDER_ARCHIVED) return {dialogs: [mkDialog(USER_B)], isEnd: true};
      return {dialogs: [mkDialog(GROUP_A), mkDialog(GROUP_B)], isEnd: true};
    });

    await instance.getMoreDialogs();

    expect(getDialogs.mock.calls.map((c: any[]) => c[0].filterId)).toEqual([FOLDER_ID_ALL, FOLDER_ARCHIVED, FOLDER_ID_GROUPS]);
    expect(getDialogs.mock.calls[2][0]).toEqual({filterId: FOLDER_ID_GROUPS, forceLocal: true, skipMigrated: true, limit: 1000});
    expect(instance.loadedWhat).toMatchObject({dialogs: true, archived: true, groups: true});
    expect(instance.renderResultsFunc.mock.calls.map((c: any[]) => c[0])).toEqual([[USER_A], [USER_B], [GROUP_A, GROUP_B]]);
    expect(instance.getMoreContacts).toHaveBeenCalledTimes(1);
  });

  it('re-requests the same folder on a short page instead of advancing', async() => {
    getDialogs
    .mockResolvedValueOnce({dialogs: [mkDialog(USER_A)], isEnd: false})
    .mockResolvedValueOnce({dialogs: [mkDialog(USER_A)], isEnd: true})
    .mockResolvedValueOnce({dialogs: [mkDialog(USER_B)], isEnd: true})
    .mockResolvedValueOnce({dialogs: [mkDialog(GROUP_A)], isEnd: true});

    await instance.getMoreDialogs();

    expect(getDialogs.mock.calls.map((c: any[]) => c[0].filterId)).toEqual([FOLDER_ID_ALL, FOLDER_ID_ALL, FOLDER_ARCHIVED, FOLDER_ID_GROUPS]);
  });

  it('skips the Groups fetch under a query — the search already covered groups', async() => {
    instance.query = 'ann';
    instance.loadedWhat = {dialogs: true, archived: true};

    await instance.getMoreGroups();

    expect(getDialogs).not.toHaveBeenCalled();
    expect(instance.loadedWhat.groups).toBe(true);
    expect(instance.renderResultsFunc).toHaveBeenCalledWith([]);
    expect(instance.getMoreContacts).toHaveBeenCalledTimes(1);
  });

  it('drops self and every group the rights filter rejects', async() => {
    instance.folderId = FOLDER_ID_GROUPS;
    instance.chatRightsActions = ['send_plain'];
    // hasRights reads default_banned_rights; A bans send_plain, B does not.
    const chat = (banned: boolean) => ({_: 'chat', pFlags: {}, default_banned_rights: {_: 'chatBannedRights', pFlags: banned ? {send_plain: true} : {}}});
    peers.set(GROUP_A, chat(true));
    peers.set(GROUP_B, chat(false));
    getDialogs.mockResolvedValue({dialogs: [mkDialog(SELF), mkDialog(GROUP_A), mkDialog(GROUP_B)], isEnd: true});

    await instance.getMoreGroups();

    expect(instance.renderResultsFunc).toHaveBeenCalledWith([GROUP_B]);
  });

  it('loads Groups once however many entry points fire', async() => {
    instance.loadedWhat = {dialogs: true, archived: true};
    getDialogs.mockResolvedValue({dialogs: [mkDialog(GROUP_A)], isEnd: true});

    await instance.getMoreGroups();
    await instance.getMoreGroups();
    await instance.getMoreDialogs();

    expect(getDialogs).toHaveBeenCalledTimes(1);
    expect(instance.renderResultsFunc).toHaveBeenCalledTimes(1);
  });
});
