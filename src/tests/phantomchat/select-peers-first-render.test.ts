/**
 * Forward picker follow-ups:
 *  1. The popup shows as soon as the first rows paint, not after the whole
 *     initial chain (chats -> archive -> every group -> first contacts page).
 *     On an account with many groups/contacts the old wait made Forward feel
 *     frozen.
 *  2. Forward never offers your own account ("Saved Messages"): PhantomChat
 *     has no Saved Messages.
 *
 * Builds the REAL AppSelectPeers (constructor + renderResults wrapper); only
 * the worker-facing managers and per-row DOM rendering are stubbed.
 */
import 'fake-indexeddb/auto';
import '../setup';
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import rootScope from '@lib/rootScope';
import {FOLDER_ID_ALL, FOLDER_ID_GROUPS} from '@appManagers/constants';

const SELF = 1_000_000_003;
const USER_A = 1_000_000_001;
const USER_B = 1_000_000_002;
const FOLDER_ARCHIVED = 1;

vi.hoisted(() => {
  if(!(globalThis as any).Worker) (globalThis as any).Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  if(typeof (globalThis as any).caches === 'undefined') {
    const makeCache = (): any => ({match: async(): Promise<any> => undefined, put: async(): Promise<void> => {}, delete: async(): Promise<void> => {}, keys: async(): Promise<any[]> => []});
    (globalThis as any).caches = {open: async(): Promise<any> => makeCache(), keys: async(): Promise<any[]> => [], delete: async(): Promise<void> => {}, has: async(): Promise<boolean> => false};
  }
  if(typeof (globalThis as any).matchMedia === 'undefined') {
    (globalThis as any).matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}});
  }
});

vi.mock('@lib/apiManagerProxy', () => ({
  default: {mirrors: {dialogs: {}}, getPeer: (id: number) => ({_: 'chat', id, pFlags: {}}), getChat: (): any => undefined, isBotforum: () => false}
}));
vi.mock('@components/sidebarRight', () => ({RIGHT_COLUMN_ACTIVE_CLASSNAME: 'is-right-column-shown', default: {}}));
vi.mock('@components/sidebarLeft', () => ({LEFT_COLUMN_ACTIVE_CLASSNAME: 'is-left-column-shown', default: {}}));

let dialogIndex = 1e9;
const mkDialog = (peerId: number) => ({_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0, index_0: --dialogIndex}) as any;

vi.setConfig({testTimeout: 120000, hookTimeout: 120000});

let AppSelectPeers: any;
let getMiddleware: any;

function build(options: {firstRenderOnFirstRows?: boolean, exceptSelf?: boolean}, getDialogs: any) {
  const rendered: number[][] = [];
  const onFirstRender = vi.fn();
  const selector = new AppSelectPeers({
    appendTo: document.createElement('div'),
    managers: {
      dialogsStorage: {getDialogs},
      appUsersManager: {
        getContactsPeerIds: async(): Promise<number[]> => [],
        testSelfSearch: async() => true
      }
    },
    middleware: getMiddleware().get(),
    peerType: ['dialogs'],
    onFirstRender,
    // Row DOM is out of scope; record what would be painted.
    renderResultsFunc: async(peerIds: number[]) => {
      rendered.push(peerIds);
    },
    noPlaceholder: true,
    noSearch: true,
    ...options
  });
  return {selector, rendered, onFirstRender};
}

const flush = async(n = 20) => {
  for(let i = 0; i < n; ++i) await new Promise((r) => setTimeout(r, 0));
};

describe('peer picker — first render and self row', () => {
  beforeAll(async() => {
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
    getMiddleware = (await import('@helpers/middleware')).getMiddleware;
  }, 120000);

  beforeEach(() => {
    (rootScope as any).myId = SELF;
  });

  // Groups never resolve: the rest of the chain is still loading.
  const slowTail = () => vi.fn(async({filterId}: any) => {
    if(filterId === FOLDER_ID_ALL) return {dialogs: [mkDialog(USER_A), mkDialog(USER_B)], isEnd: true};
    if(filterId === FOLDER_ARCHIVED) return {dialogs: [], isEnd: true};
    if(filterId === FOLDER_ID_GROUPS) return new Promise(() => {});
  });

  it('fires onFirstRender once the first rows paint, while groups are still loading', async() => {
    const {rendered, onFirstRender} = build({firstRenderOnFirstRows: true, exceptSelf: true}, slowTail());
    await flush();
    expect(rendered.flat()).toEqual([USER_A, USER_B]);
    expect(onFirstRender).toHaveBeenCalledTimes(1);
  });

  it('keeps the old wait-for-everything behaviour when not opted in', async() => {
    const {onFirstRender} = build({exceptSelf: true}, slowTail());
    await flush();
    expect(onFirstRender).not.toHaveBeenCalled();
  });

  it('fires onFirstRender exactly once across first rows and chain completion', async() => {
    const getDialogs = vi.fn(async({filterId}: any) => {
      if(filterId === FOLDER_ID_ALL) return {dialogs: [mkDialog(USER_A)], isEnd: true};
      return {dialogs: [], isEnd: true};
    });
    const {onFirstRender} = build({firstRenderOnFirstRows: true, exceptSelf: true}, getDialogs);
    await flush();
    expect(onFirstRender).toHaveBeenCalledTimes(1);
  });

  it('still fires when the picker has nothing to show', async() => {
    const getDialogs = vi.fn(async() => ({dialogs: [] as any[], isEnd: true}));
    const {onFirstRender} = build({firstRenderOnFirstRows: true, exceptSelf: true}, getDialogs);
    await flush();
    expect(onFirstRender).toHaveBeenCalledTimes(1);
  });

  it('never renders your own account when exceptSelf is set', async() => {
    const getDialogs = vi.fn(async({filterId}: any) => {
      if(filterId === FOLDER_ID_ALL) return {dialogs: [mkDialog(SELF), mkDialog(USER_A)], isEnd: true};
      return {dialogs: [], isEnd: true};
    });
    const {rendered} = build({exceptSelf: true}, getDialogs);
    await flush();
    expect(rendered.flat()).not.toContain(SELF);
    expect(rendered.flat()).toContain(USER_A);
  });

  it('without exceptSelf the Telegram "Saved Messages" row is your own account', async() => {
    const getDialogs = vi.fn(async({filterId}: any) => {
      if(filterId === FOLDER_ID_ALL) return {dialogs: [mkDialog(USER_A)], isEnd: true};
      return {dialogs: [], isEnd: true};
    });
    const {rendered} = build({}, getDialogs);
    await flush();
    expect(rendered.flat()).toContain(SELF);
  });
});
