/**
 * #339: a staged batch that fails after a file published the caption consumes
 * the wording, but the files left in the tray are retried from the same
 * composer. The failure path used to run `onMessageSent(true, true)`, which
 * also cleared the reply target, `scheduleDate` and `sendSilent`, so the
 * retry went out as a stand-alone, immediate, loud message.
 *
 * Drives the real `ChatInput.sendMessage` / `consumeComposerAfterBatch` /
 * `onMessageSent` against a stub composer; only the tray and the managers are
 * fakes.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi, beforeAll} from 'vitest';

vi.hoisted(() => {
  for(const name of ['IntersectionObserver', 'ResizeObserver']) {
    if(typeof (globalThis as any)[name] === 'undefined') {
      (globalThis as any)[name] = class {
        observe() {} unobserve() {} disconnect() {} takeRecords(): any[] { return []; }
      };
    }
  }
  if(typeof (globalThis as any).Worker === 'undefined') {
    (globalThis as any).Worker = class {
      addEventListener() {} postMessage() {} terminate() {}
    };
  }
  if(typeof (globalThis as any).caches === 'undefined') {
    const cache = (): any => ({match: async(): Promise<any> => undefined, put: async() => {}, delete: async() => {}, keys: async(): Promise<any[]> => []});
    (globalThis as any).caches = {open: async() => cache(), keys: async(): Promise<any[]> => [], delete: async() => {}, has: async() => false};
  }
  if(typeof (globalThis as any).matchMedia === 'undefined') {
    (globalThis as any).matchMedia = (): any => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}});
  }
});

vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : anyObj),
    apply: () => anyObj
  });
  return {default: anyObj};
});

vi.mock('@components/sidebarRight', () => ({RIGHT_COLUMN_ACTIVE_CLASSNAME: 'is-right-column-shown', default: {}}));
vi.mock('@components/sidebarLeft', () => ({LEFT_COLUMN_ACTIVE_CLASSNAME: 'is-left-column-shown', default: {}}));

let ChatInput: any;
let ChatType: any;

beforeAll(async() => {
  const {setAppStateSilent} = await import('@stores/appState');
  setAppStateSilent({accountContentSettings: {value: undefined}, appConfig: {}} as any);
  // Modules pulled in by the composer read a few managers at import time.
  const rootScope = (await import('@lib/rootScope')).default as any;
  rootScope.myId = 999003;
  rootScope.managers = {
    dialogsStorage: {getFolderDialogs: (): any[] => [], getDialogIndex: (): number => 10, getDialogOnly: async(): Promise<any> => undefined},
    apiManager: {getAccountNumber: async(): Promise<number> => 1},
    rootScope: {getPremium: async(): Promise<any> => undefined},
    appPaymentsManager: {
      getStarsStatus: async(): Promise<any> => ({balance: '0'}),
      getStarsStatusTon: async(): Promise<any> => ({balance: {amount: '0'}})
    },
    appStoriesManager: {
      getAllStories: async(): Promise<any> => ({_: 'stories.allStories', pFlags: {has_more: false}, peer_stories: [] as any[], chats: [] as any[], users: [] as any[]}),
      getPeerStories: async(): Promise<any> => undefined,
      getStealthMode: async(): Promise<any> => ({_: 'stories.stealthMode'})
    }
  };
  ChatInput = (await import('@components/chat/input')).default;
  ({ChatType} = await import('@components/chat/chat'));
}, 120_000);

function composer(batch: {captionPublished: boolean, failed?: any}) {
  const clearHelper = vi.fn(function(this: any) {
    this.replyToMsgId = undefined;
  });
  const input: any = Object.create(ChatInput.prototype);
  Object.assign(input, {
    chat: {type: ChatType.Chat, peerId: 1, threadId: undefined},
    sendingMessage: false,
    btnSend: undefined,
    replyToMsgId: 42,
    scheduleDate: 1_900_000_000,
    sendSilent: true,
    attachmentTray: {hasFiles: () => true},
    getPendingAttachmentCaption: () => 'please look at these',
    sendPendingAttachments: vi.fn(async() => ({sent: [] as any[], remaining: [] as any[], ...batch})),
    managers: {
      appDraftsManager: {clearDraft: vi.fn()},
      appMessagesManager: {readAllHistory: vi.fn()},
      appEmojiManager: {pushRecentEmoji: vi.fn()}
    },
    getValueAndEntities: () => ({totalEntities: [] as any[]}),
    clearInput: vi.fn(async() => {}),
    clearHelper,
    updateSendBtn: vi.fn()
  });
  return input;
}

describe('a failed batch keeps reply, schedule and silent for the retry (#339)', () => {
  it('consumes the published caption but not the send state', async() => {
    const input = composer({captionPublished: true, failed: {file: {name: 'b.png'}}});

    await input.sendMessage();

    // The wording is spent.
    expect(input.managers.appDraftsManager.clearDraft).toHaveBeenCalled();
    expect(input.clearInput).toHaveBeenCalled();
    // The retry still carries the reply and the schedule, silently.
    expect(input.clearHelper).not.toHaveBeenCalled();
    expect(input.replyToMsgId).toBe(42);
    expect(input.scheduleDate).toBe(1_900_000_000);
    expect(input.sendSilent).toBe(true);
  });

  it('a fully published batch still clears everything', async() => {
    const input = composer({captionPublished: true});

    await input.sendMessage();

    expect(input.clearHelper).toHaveBeenCalled();
    expect(input.scheduleDate).toBeUndefined();
    expect(input.sendSilent).toBeUndefined();
  });
});
