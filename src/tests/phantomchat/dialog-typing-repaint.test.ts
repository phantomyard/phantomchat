/**
 * Chat-list typing indicator survives a subtitle repaint.
 *
 * Symptom (2026-11-02): the chat header says "Robbie is working" while the
 * chat-list row for the same chat shows nothing. The row is painted once from
 * `peer_typings`, and the next dialog repaint — `dialog_flush`,
 * `dialogs_multiupdate`, a new message — goes through
 * `AppDialogsManager.setLastMessageN`, which rewrites `lastMessageSpan` whole
 * and dropped the indicator. When that repaint has no last message to show yet,
 * the row is left *empty*, so nothing indicates the chat is in flight.
 *
 * The fix is the header's model: re-derive from `typingsInPeer` at paint time.
 * These tests drive the REAL `setLastMessageN` and assert the row's final
 * subtitle, with only the typing store and unrelated managers stubbed.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, vi} from 'vitest';

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

// appDialogsManager touches the manager proxy for isBotforum(); the subtitle
// path under test never reads it.
vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => {
      if(prop === 'then') return undefined;
      // isBotforum decides the "NoMessagesYet" text; these are P2P rows.
      if(prop === 'isBotforum') return () => false;
      return anyObj;
    },
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

// The subtitle path formats the timestamp with a locale-aware helper that
// throws under jsdom's ICU; the search-hit case below needs the paint to reach
// its end, so stub just the formatter.
vi.mock('@helpers/date', async(importOriginal) => {
  const actual = await importOriginal<any>();
  return {...actual, formatDateAccordingToTodayNew: (): string => '12:00'};
});

const PEER_ID = 4242;
const EMPTY_ROW = {_: 'dialog', peerId: PEER_ID, folder_id: 0, unread_count: 0, pFlags: {}} as any;

// A message-search hit: same `setLastMessage` path, but the row shows the
// matched snippet rather than a chat-list subtitle.
const SEARCH_HIT = {
  _: 'message',
  mid: 778899,
  message: 'needle in text',
  date: 1700000000,
  fromId: PEER_ID,
  peerId: PEER_ID,
  pFlags: {}
} as any;

function typingContainer(text = 'Robbie is working') {
  const container = document.createElement('span');
  container.classList.add('online', 'peer-typing-container');
  container.textContent = text;
  return container;
}

function makeDialogElement() {
  const lastMessageSpan = document.createElement('span');
  const dom = {
    lastMessageSpan,
    lastTimeSpan: document.createElement('span'),
    listEl: document.createElement('div'),
    titleSpan: document.createElement('span'),
    titleSpanContainer: document.createElement('span'),
    statusSpan: document.createElement('span')
  };
  return {
    dom,
    createPinnedBadge: () => {},
    createUnreadBadge: () => {},
    createUnreadAvatarBadge: () => {},
    createMentionsBadge: () => {},
    createReactionsBadge: () => {},
    subtitleRow: document.createElement('div')
  } as any;
}

describe('chat-list typing indicator across a subtitle repaint', () => {
  let adm: any;
  let appImManager: any;
  let getPeerTyping: ReturnType<typeof vi.fn>;

  beforeAll(async() => {
    // appDialogsManager pulls in the Solid stores; give them an appState.
    const {setAppStateSilent} = await import('@stores/appState');
    setAppStateSilent({accountContentSettings: {value: undefined}, appConfig: {}} as any);

    // Modules pulled in by appDialogsManager read a few managers at import
    // time (stars, stories, account). The subtitle path under test reads none.
    const rootScope = (await import('@lib/rootScope')).default as any;
    rootScope.myId = 999002;
    rootScope.managers = {
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

    adm = (await import('@lib/appDialogsManager')).default as any;
    appImManager = (await import('@lib/appImManager')).default;

    // Only the subtitle plumbing is under test.
    adm.setUnreadMessagesN = () => {};
    // The reported case: the dialog repaint lands before the last message is
    // resolvable, so getLastMessageForDialog returns nothing to show.
    adm.getLastMessageForDialog = (): {lastMessage?: any, draftMessage?: any} => ({lastMessage: undefined, draftMessage: undefined});

    getPeerTyping = vi.fn(async(): Promise<HTMLElement | undefined> => undefined);
    appImManager.getPeerTyping = getPeerTyping;
  }, 120_000);

  it('shows "is working" on a row whose repaint found no last message', async() => {
    getPeerTyping.mockImplementation(async() => typingContainer());

    const dialogElement = makeDialogElement();
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, setUnread: null});

    await vi.waitFor(() => {
      expect(dialogElement.dom.lastMessageSpan.textContent).toBe('Robbie is working');
    });
    expect(dialogElement.dom.lastMessageSpan.classList.contains('user-typing')).toBe(true);
    expect(getPeerTyping).toHaveBeenCalledWith(PEER_ID, undefined, undefined);
  });

  it('leaves the row blank when nobody is working', async() => {
    getPeerTyping.mockImplementation(async(): Promise<HTMLElement | undefined> => undefined);

    const dialogElement = makeDialogElement();
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, setUnread: null});

    await vi.waitFor(() => expect(getPeerTyping).toHaveBeenCalled());
    expect(dialogElement.dom.lastMessageSpan.textContent).toBe('');
    expect(dialogElement.dom.lastMessageSpan.classList.contains('user-typing')).toBe(false);
  });

  it('re-reads the store on every repaint instead of keeping the first result', async() => {
    const dialogElement = makeDialogElement();

    getPeerTyping.mockImplementation(async() => typingContainer());
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, setUnread: null});
    await vi.waitFor(() => {
      expect(dialogElement.dom.lastMessageSpan.textContent).toBe('Robbie is working');
    });

    // Typing stops: the expiry tick repaints, and the row must clear itself.
    getPeerTyping.mockImplementation(async(): Promise<HTMLElement | undefined> => undefined);
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, setUnread: null});
    await vi.waitFor(() => {
      expect(dialogElement.dom.lastMessageSpan.textContent).toBe('');
    });
    expect(dialogElement.dom.lastMessageSpan.classList.contains('user-typing')).toBe(false);
  });

  it('drops a paint superseded by a newer repaint of the same row', async() => {
    const dialogElement = makeDialogElement();

    // First repaint resolves late, after the second one has already run.
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    getPeerTyping.mockImplementationOnce(async() => {
      await firstGate;
      return typingContainer('stale');
    }).mockImplementation(async() => typingContainer('Robbie is working'));

    const repaint = () => adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, setUnread: null});
    const first = repaint();
    const second = repaint();

    await second;
    await vi.waitFor(() => {
      expect(dialogElement.dom.lastMessageSpan.textContent).toBe('Robbie is working');
    });

    releaseFirst();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dialogElement.dom.lastMessageSpan.textContent).toBe('Robbie is working');
  });

  it('leaves a search hit alone when that peer is working', async() => {
    // Message search and the peer-profile preview paint through the same
    // method with `setUnread: false`. Those rows have no typing lifecycle, so
    // painting the indicator there replaced the matched snippet with
    // "Robbie is working" and stranded it after typing stopped.
    getPeerTyping.mockClear();
    getPeerTyping.mockImplementation(async() => typingContainer());
    adm.getLastMessageForDialog = (): {lastMessage?: any, draftMessage?: any} => ({lastMessage: SEARCH_HIT, draftMessage: undefined});

    const dialogElement = makeDialogElement();
    // Search rows paint with a real PeerId; stub the two methods this path reads.
    const searchPeer = {isAnyChat: (): boolean => false, toPeerId: (): number => PEER_ID};
    await adm.setLastMessageN({
      dialog: {...EMPTY_ROW, peerId: searchPeer} as any,
      dialogElement,
      highlightWord: 'needle',
      setUnread: false
    });

    // Give a stray paint every chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dialogElement.dom.lastMessageSpan.textContent).toContain('needle in text');
    expect(dialogElement.dom.lastMessageSpan.textContent).not.toContain('is working');
    expect(dialogElement.dom.lastMessageSpan.classList.contains('user-typing')).toBe(false);
    expect(getPeerTyping).not.toHaveBeenCalled();
  });

  it('treats a caller that omits setUnread as a list row', async() => {
    // The discriminator used to be `setUnread !== null && !setUnread` with a
    // `false` default, so omitting the field silently made the row a search
    // hit with no typing line.
    adm.getLastMessageForDialog = (): {lastMessage?: any, draftMessage?: any} => ({lastMessage: undefined, draftMessage: undefined});
    getPeerTyping.mockImplementation(async() => typingContainer());

    const dialogElement = makeDialogElement();
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement});

    await vi.waitFor(() => {
      expect(dialogElement.dom.lastMessageSpan.textContent).toBe('Robbie is working');
    });
  });

  it('does not paint typing at the no-last-message exit of a search hit', async() => {
    getPeerTyping.mockClear();
    getPeerTyping.mockImplementation(async() => typingContainer());
    adm.getLastMessageForDialog = (): {lastMessage?: any, draftMessage?: any} => ({});

    const dialogElement = makeDialogElement();
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, highlightWord: 'needle', setUnread: false});
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getPeerTyping).not.toHaveBeenCalled();
    expect(dialogElement.dom.lastMessageSpan.textContent).not.toContain('is working');
  });

  it('drops a late event-path typing paint once a newer subtitle was written', async() => {
    const {AutonomousDialogListBase} = await import('@components/autonomousDialogList/base');
    adm.getLastMessageForDialog = (): {lastMessage?: any, draftMessage?: any} => ({lastMessage: undefined, draftMessage: undefined});
    const dialogElement = makeDialogElement();
    const list = {
      getDialogKey: (): number => PEER_ID,
      getDialogDom: (): any => dialogElement.dom
    };

    // peer_typings fires; the chat-peer lookup (PeerTitle.update) is slow.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getPeerTyping.mockImplementationOnce(async() => {
      await gate;
      return typingContainer('stale is working');
    });
    const late = AutonomousDialogListBase.prototype.setTyping.call(list, EMPTY_ROW);

    // Typing stops and the subtitle is repainted before the lookup returns.
    getPeerTyping.mockImplementation(async(): Promise<HTMLElement> => undefined);
    await adm.setLastMessageN({dialog: EMPTY_ROW, dialogElement, setUnread: null});
    await new Promise((resolve) => setTimeout(resolve, 20));

    release();
    await late;

    expect(dialogElement.dom.lastMessageSpan.textContent).not.toContain('is working');
    expect(dialogElement.dom.lastMessageSpan.classList.contains('user-typing')).toBe(false);
  });
});
