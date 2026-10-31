/**
 * Tests for phantomchat-message-handler.ts
 *
 * Verifies: message building, mirror injection, peer auto-add,
 * dialog creation, and the full handleIncomingMessage orchestration.
 */

import '../setup';
import {describe, it, expect, beforeEach, afterEach, afterAll, vi} from 'vitest';

// With isolate: false, vi.mock factories persist across files.
// Explicitly unmock rootScope so later test files get the real module.
afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.unmock('@lib/phantomchat/phantomchat-peer-mapper');
  vi.unmock('@stores/peers');
  vi.unmock('@lib/phantomchat/phantomchat-bridge');
  vi.unmock('@lib/phantomchat/nostr-profile');
  vi.unmock('@lib/phantomchat/virtual-peers-db');
  vi.unmock('@lib/phantomchat/message-store');
  vi.unmock('@lib/phantomchat/group-store');
  vi.unmock('@lib/phantomchat/phantomchat-notify');
  vi.restoreAllMocks();
});

// Mock nostr-profile + virtual-peers-db so the auto-inject fire-and-forget
// kind 0 fetch doesn't open real WebSockets in jsdom.
vi.mock('@lib/phantomchat/nostr-profile', () => ({
  fetchNostrProfile: vi.fn().mockResolvedValue(null),
  profileToDisplayName: vi.fn().mockReturnValue(null)
}));
const mockGetPubkey = vi.fn().mockResolvedValue(undefined);
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  getMapping: vi.fn().mockResolvedValue(undefined),
  updateMappingProfile: vi.fn().mockResolvedValue(undefined),
  getPubkey: (...args: any[]) => mockGetPubkey(...args)
}));

// Mock message-store + group-store for resetUnreadForPeer.
const mockMessageStore = {
  getConversationId: vi.fn((a: string, b: string) => `conv-${a.slice(0, 4)}-${b.slice(0, 4)}`),
  countUnread: vi.fn().mockResolvedValue(0),
  getMessages: vi.fn().mockResolvedValue([]),
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  peekReadCursor: vi.fn().mockReturnValue(0)
};
vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => mockMessageStore
}));

// Mock the desktop-notification dispatch so receive-path suppression (#218)
// is observable without a real Notification API.
const mockNotifyIncoming = vi.fn();
vi.mock('@lib/phantomchat/phantomchat-notify', () => ({
  notifyIncoming: (...args: any[]) => mockNotifyIncoming(...args)
}));
const mockGroupStoreGetByPeerId = vi.fn().mockResolvedValue(null);
vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({getByPeerId: (...args: any[]) => mockGroupStoreGetByPeerId(...args)})
}));

// Mock PhantomChatPeerMapper
const mockCreateTwebMessage = vi.fn().mockReturnValue({
  _: 'message',
  mid: 2000000001,
  id: 2000000001,
  peerId: 1000000000000001,
  date: 1712345678,
  message: 'Hello from peer',
  pFlags: {out: false}
});

const mockCreateTwebUser = vi.fn().mockReturnValue({
  _: 'user',
  id: 1000000000000001,
  first_name: 'npub...aabbccdd',
  pFlags: {}
});

const mockCreateTwebDialog = vi.fn().mockReturnValue({
  _: 'dialog',
  peerId: 1000000000000001,
  top_message: 2000000001,
  unread_count: 1,
  pFlags: {}
});

const mockMapPubkey = vi.fn().mockResolvedValue(2000000000000001);

vi.mock('@lib/phantomchat/phantomchat-peer-mapper', () => ({
  PhantomChatPeerMapper: vi.fn().mockImplementation(() => ({
    createTwebMessage: mockCreateTwebMessage,
    createTwebUser: mockCreateTwebUser,
    createTwebDialog: mockCreateTwebDialog,
    mapPubkey: mockMapPubkey
  }))
}));

// Mock rootScope
const mockDispatchEvent = vi.fn();
const mockSetMessageToStorage = vi.fn().mockResolvedValue(undefined);
const mockAppendLocalHistoryMessage = vi.fn().mockResolvedValue(undefined);
const mockInvalidateHistoryCache = vi.fn().mockResolvedValue(undefined);
const mockSetDialogTopMessage = vi.fn().mockResolvedValue(undefined);
const mockInjectP2PUser = vi.fn().mockResolvedValue(undefined);
const mockHasUser = vi.fn().mockResolvedValue(true);

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: (...args: any[]) => mockDispatchEvent(...args),
    managers: {
      appMessagesManager: {
        setMessageToStorage: (...args: any[]) => mockSetMessageToStorage(...args),
        appendLocalHistoryMessage: (...args: any[]) => mockAppendLocalHistoryMessage(...args),
        invalidateHistoryCache: (...args: any[]) => mockInvalidateHistoryCache(...args),
        setDialogTopMessage: (...args: any[]) => mockSetDialogTopMessage(...args),
        readHistory: vi.fn().mockResolvedValue(undefined)
      },
      appUsersManager: {
        injectP2PUser: (...args: any[]) => mockInjectP2PUser(...args),
        hasUser: (...args: any[]) => mockHasUser(...args)
      }
    }
  }
}));

// MOUNT_CLASS_TO is a mutable singleton — set mirrors directly in beforeEach

// Mock stores/peers
vi.mock('@stores/peers', () => ({
  reconcilePeer: vi.fn()
}));

// Mock phantomchat-bridge
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {
    getInstance: () => ({
      deriveAvatarFromPubkeySync: vi.fn().mockReturnValue('avatar-hash')
    })
  }
}));

import {
  buildTwebMessage,
  buildTwebDialog,
  createDialogUpdateQueue,
  injectIntoMirrors,
  dispatchDialogUpdate,
  handleIncomingMessage,
  handleIncomingEdit,
  rehydrateOpenChatOnVisible,
  resetUnreadForPeer,
  applyRemoteReadState,
  reconcileUnreadFromStore,
  getUnreadForPeer,
  startRecoveryWatchdog,
  cancelRecoveryWatchdog
} from '@lib/phantomchat/phantomchat-message-handler';
import {MOUNT_CLASS_TO} from '@config/debug';

const OWN_PUBKEY = 'aaaa'.repeat(16);
const SENDER_PUBKEY = 'bbbb'.repeat(16);
const PEER_ID = 1000000000000001;

const makeData = () => ({
  senderPubkey: SENDER_PUBKEY,
  peerId: PEER_ID,
  mid: 2000000001,
  timestamp: 1712345678,
  message: {content: 'Hello from peer'}
});

describe('phantomchat-message-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up MOUNT_CLASS_TO mirrors directly on the mutable singleton
    MOUNT_CLASS_TO.apiManagerProxy = {
      mirrors: {messages: {}, peers: {}}
    };
    (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID}};
  });

  describe('buildTwebMessage', () => {
    it('creates a tweb message from incoming data', () => {
      const result = buildTwebMessage(makeData());
      expect(mockCreateTwebMessage).toHaveBeenCalledWith({
        mid: 2000000001,
        peerId: PEER_ID,
        fromPeerId: PEER_ID,
        date: 1712345678,
        text: 'Hello from peer',
        isOutgoing: false
      });
      expect(result).toBeDefined();
      expect(result.mid).toBe(2000000001);
    });
  });

  describe('buildTwebDialog', () => {
    it('creates dialog with topMessage as msg object', () => {
      const msg = {mid: 2000000001, id: 2000000001, date: 1712345678};
      const dialog = buildTwebDialog(PEER_ID, msg, 1712345678);
      expect(mockCreateTwebDialog).toHaveBeenCalled();
      // topMessage should be the msg object, not just the ID
      expect(dialog.topMessage).toBe(msg);
    });
  });

  describe('injectIntoMirrors', () => {
    it('injects message into messages mirror', async() => {
      const msg = {mid: 2000000001, id: 2000000001};
      await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      const storageKey = `${PEER_ID}_history`;
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.messages[storageKey]).toBeDefined();
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.messages[storageKey][2000000001]).toBe(msg);
    });

    it('pushes to Worker history via appendLocalHistoryMessage (object + mid slice)', async() => {
      const msg = {mid: 2000000001, id: 2000000001};
      await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(mockAppendLocalHistoryMessage).toHaveBeenCalledWith(msg);
    });

    it('auto-adds unknown sender as peer', async() => {
      const msg = {mid: 2000000001, id: 2000000001};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(true);
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.peers[PEER_ID]).toBeDefined();
      expect(mockCreateTwebUser).toHaveBeenCalled();
    });

    it('skips peer creation if peer already exists', async() => {
      MOUNT_CLASS_TO.apiManagerProxy.mirrors.peers[PEER_ID] = {_: 'user', id: PEER_ID};
      const msg = {mid: 2000000001, id: 2000000001};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(false);
      expect(mockCreateTwebUser).not.toHaveBeenCalled();
    });

    it('re-injects into worker when mirror has peer but hasUser is false', async() => {
      // Regression for the 1:1 typing indicator bug: the mirror can be
      // populated without injectP2PUser having completed. tweb's
      // onUpdateUserTyping silently drops the tick when hasUser() is false
      // (1:1 has no group-branch fallback). ensureSenderUserInjected must
      // detect this gap and re-inject into the worker.
      MOUNT_CLASS_TO.apiManagerProxy.mirrors.peers[PEER_ID] = {
        _: 'user',
        id: PEER_ID,
        first_name: 'Bot Alice',
        p2pPubkey: SENDER_PUBKEY
      };
      mockHasUser.mockResolvedValueOnce(false); // worker doesn't have user
      const msg = {mid: 2000000001, id: 2000000001};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(false);
      // Must NOT clobber the mirror with a fresh hex-fallback name
      expect(mockCreateTwebUser).not.toHaveBeenCalled();
      // Must re-inject into the worker using the existing mirror name
      expect(mockInjectP2PUser).toHaveBeenCalledWith(
        SENDER_PUBKEY,
        PEER_ID,
        'Bot Alice',
        expect.any(String)
      );
    });
  });

  describe('dispatchDialogUpdate', () => {
    it('dispatches dialogs_multiupdate immediately', () => {
      const dialog = {_: 'dialog'};
      dispatchDialogUpdate(PEER_ID, dialog);

      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'dialogs_multiupdate',
        expect.any(Map)
      );
    });
  });

  describe('handleIncomingMessage', () => {
    it('returns null for own echo', async() => {
      const data = makeData();
      data.senderPubkey = OWN_PUBKEY;
      const result = await handleIncomingMessage(data, OWN_PUBKEY);
      expect(result).toBeNull();
    });

    it('builds message, injects mirrors, dispatches events', async() => {
      const result = await handleIncomingMessage(makeData(), OWN_PUBKEY);

      expect(result).not.toBeNull();
      expect(result!.peerId).toBe(PEER_ID);
      expect(result!.msg).toBeDefined();
      expect(result!.dialog).toBeDefined();

      // Should have dispatched history_append
      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'history_append',
        expect.objectContaining({peerId: PEER_ID})
      );

      // Should have dispatched dialogs_multiupdate
      await vi.waitFor(() => expect(mockDispatchEvent).toHaveBeenCalledWith(
          'dialogs_multiupdate',
          expect.any(Map)
      ));

      // Should have invalidated history cache
      expect(mockInvalidateHistoryCache).toHaveBeenCalledWith(PEER_ID);
    });

    it('bumps Worker dialog index via setDialogTopMessage so chat list re-sorts', async() => {
      await handleIncomingMessage(makeData(), OWN_PUBKEY);

      expect(mockSetDialogTopMessage).toHaveBeenCalledTimes(1);
      const [msgArg] = mockSetDialogTopMessage.mock.calls[0];
      expect(msgArg.mid).toBe(2000000001);
      expect(msgArg.peerId).toBe(PEER_ID);
    });

    it('tolerates setDialogTopMessage failure (e.g. dialog not yet in dialogsStorage)', async() => {
      mockSetDialogTopMessage.mockRejectedValueOnce(new Error('no dialog'));
      const result = await handleIncomingMessage(makeData(), OWN_PUBKEY);
      expect(result).not.toBeNull();
      // Local dialogs_multiupdate dispatch is still expected for new-peer path
      await vi.waitFor(() => expect(mockDispatchEvent).toHaveBeenCalledWith(
          'dialogs_multiupdate',
          expect.any(Map)
      ));
    });

    it('keeps closed-chat history local until that chat is opened', async() => {
      (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID + 1}};

      await handleIncomingMessage(makeData(), OWN_PUBKEY);

      expect(mockAppendLocalHistoryMessage).not.toHaveBeenCalled();
      expect(mockDispatchEvent).not.toHaveBeenCalledWith('history_append', expect.anything());
      expect(mockInvalidateHistoryCache).toHaveBeenCalledWith(PEER_ID);
      expect((MOUNT_CLASS_TO.apiManagerProxy as any).mirrors.messages[`${PEER_ID}_history`][2000000001]).toBeDefined();
    });
  });

  describe('dialog update coalescing', () => {
    it('gives late arrivals a full replay delay', async() => {
      vi.useFakeTimers();
      try {
        const dispatch = vi.fn();
        const queue = createDialogUpdateQueue(dispatch, 500);

        queue.enqueue(1, {top_message: 1});
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(490);
        queue.enqueue(2, {top_message: 2});
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatch).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10);
        expect(dispatch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(490);
        expect(dispatch).toHaveBeenCalledTimes(3);
        expect([...dispatch.mock.calls[2][0].keys()]).toEqual([1, 2]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Error / logSwallow branches introduced in PR #37. Kept in-file rather
  // than a sibling test file because vitest 0.34 `isolate: false` shares
  // the module cache across files, and any sibling that re-declares the
  // same module-level vi.mock entries produces order-dependent flakes.
  describe('error paths', () => {
    const OTHER_PUBKEY = 'eeee'.repeat(16);
    let debugSpy: any;

    beforeEach(() => {
      mockSetMessageToStorage.mockResolvedValue(undefined);
      mockInjectP2PUser.mockResolvedValue(undefined);
      debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    it('persistUnreadCounts: setItem throw during message handling does not crash', async() => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceeded');
      });

      const result = await handleIncomingMessage(makeData(), OWN_PUBKEY);

      expect(result).not.toBeNull();
      expect(result!.msg).toBeDefined();
      setItemSpy.mockRestore();
    });

    it('injectIntoMirrors: appendLocalHistoryMessage rejection is swallowed + logged', async() => {
      mockAppendLocalHistoryMessage.mockRejectedValueOnce(new Error('IDB closed'));

      const msg = {mid: 3000000002, id: 3000000002};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(true);
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.messages[`${PEER_ID}_history`][3000000002]).toBe(msg);
      const calls = debugSpy.mock.calls.map((c: any[]) => c.join(' '));
      expect(calls.some((s: string) => s.includes('[MessageHandler] non-critical'))).toBe(true);
    });

    it('injectIntoMirrors: reconcilePeer rejection is swallowed (new peer still injected)', async() => {
      const peers = await import('@stores/peers');
      (peers.reconcilePeer as any).mockImplementationOnce(() => {
        throw new Error('store unavailable');
      });

      const msg = {mid: 3000000003, id: 3000000003};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(true);
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.peers[PEER_ID]).toBeDefined();
    });

    it('injectIntoMirrors: injectP2PUser rejection is swallowed', async() => {
      mockInjectP2PUser.mockRejectedValueOnce(new Error('worker gone'));

      const msg = {mid: 3000000004, id: 3000000004};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(true);
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.peers[PEER_ID]).toBeDefined();
    });

    it('injectIntoMirrors: no apiManagerProxy → does not throw, reports isNewPeer=false', async() => {
      MOUNT_CLASS_TO.apiManagerProxy = undefined;

      const msg = {mid: 3000000005, id: 3000000005};
      const result = await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(result.isNewPeer).toBe(false);
    });

    it('handleIncomingEdit: setMessageToStorage rejection is swallowed but message_edit still dispatches', async() => {
      MOUNT_CLASS_TO.apiManagerProxy = {
        mirrors: {
          messages: {
            [`${PEER_ID}_history`]: {
              42: {mid: 42, peerId: PEER_ID, message: 'old', edit_date: 0}
            }
          },
          peers: {}
        }
      };
      mockSetMessageToStorage.mockRejectedValueOnce(new Error('IDB fail'));

      await handleIncomingEdit({
        peerId: PEER_ID,
        mid: 42,
        senderPubkey: OTHER_PUBKEY,
        originalEventId: 'chat-100-1',
        newContent: 'new content',
        editedAt: 1712400000
      }, OWN_PUBKEY);

      const stored = MOUNT_CLASS_TO.apiManagerProxy.mirrors.messages[`${PEER_ID}_history`][42];
      expect(stored.message).toBe('new content');
      expect(stored.edit_date).toBe(1712400000);

      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'message_edit',
        expect.objectContaining({peerId: PEER_ID, mid: 42})
      );
    });

    it('handleIncomingEdit: no-op when sender equals ownPubkey (self-edit)', async() => {
      await handleIncomingEdit({
        peerId: PEER_ID,
        mid: 99,
        senderPubkey: OWN_PUBKEY,
        originalEventId: 'chat-100-9',
        newContent: 'skipped',
        editedAt: 1712500000
      }, OWN_PUBKEY);

      expect(mockDispatchEvent).not.toHaveBeenCalledWith('message_edit', expect.anything());
      expect(mockSetMessageToStorage).not.toHaveBeenCalled();
    });
  });

  describe('selected conversation arrivals', () => {
    beforeEach(() => {
      mockMessageStore.setReadCursor.mockResolvedValue(undefined);
      mockMessageStore.peekReadCursor.mockReturnValue(0);
    });

    it('persists incoming messages as read without waiting for the cursor write', async() => {
      mockMessageStore.setReadCursor.mockReturnValueOnce(new Promise(() => {}));
      await handleIncomingMessage(makeData(), OWN_PUBKEY);
      expect(getUnreadForPeer(PEER_ID)).toBe(0);
      expect(mockMessageStore.setReadCursor).toHaveBeenCalledWith('conv-aaaa-bbbb', 2000000001);
      expect(mockCreateTwebDialog.mock.calls.at(-1)![0].unreadCount).toBe(0);
    });

    it('rechecks selection after asynchronous receive work', async() => {
      (MOUNT_CLASS_TO as any).appImManager.chat.peerId = 0;
      mockSetDialogTopMessage.mockImplementationOnce(async() => {
        (MOUNT_CLASS_TO as any).appImManager.chat.peerId = PEER_ID;
      });
      await handleIncomingMessage(makeData(), OWN_PUBKEY);
      expect(getUnreadForPeer(PEER_ID)).toBe(0);
      expect(mockMessageStore.setReadCursor).toHaveBeenCalledWith('conv-aaaa-bbbb', 2000000001);
    });

    it('leaves the arrival unread when mobile Back lands during Worker work', async() => {
      // The bug this pins: `chatIsOpen` is snapshotted before the awaits, so an
      // OR with the live predicate let a stale `true` win and wrote a durable
      // read cursor for a message the user never saw.
      mockSetDialogTopMessage.mockImplementationOnce(async() => {
        (MOUNT_CLASS_TO as any).appImManager.isChatVisible = false;
      });
      await handleIncomingMessage(makeData(), OWN_PUBKEY);
      expect(mockMessageStore.setReadCursor).not.toHaveBeenCalled();
      expect(getUnreadForPeer(PEER_ID)).toBe(1);
    });

    it('counts arrivals after mobile Back retains the peer behind a hidden pane', async() => {
      await handleIncomingMessage(makeData(), OWN_PUBKEY);
      mockMessageStore.setReadCursor.mockClear();
      (MOUNT_CLASS_TO as any).appImManager.isChatVisible = false;
      await handleIncomingMessage({...makeData(), mid: 2000000002}, OWN_PUBKEY);
      expect(getUnreadForPeer(PEER_ID)).toBe(1);
      expect(mockMessageStore.setReadCursor).not.toHaveBeenCalled();
    });

    it('counts new messages again after the chat is deselected', async() => {
      await handleIncomingMessage(makeData(), OWN_PUBKEY);
      mockMessageStore.setReadCursor.mockClear();
      (MOUNT_CLASS_TO as any).appImManager.chat.peerId = 0;
      await handleIncomingMessage({...makeData(), mid: 2000000002}, OWN_PUBKEY);
      expect(getUnreadForPeer(PEER_ID)).toBe(1);
      expect(mockMessageStore.setReadCursor).not.toHaveBeenCalled();
    });
  });

  describe('resetUnreadForPeer', () => {
    const GROUP_PEER_ID = -2_000_000_000_000_001;

    beforeEach(() => {
      (window as any).__phantomchatOwnPubkey = OWN_PUBKEY;
      mockGetPubkey.mockResolvedValue(SENDER_PUBKEY);
      mockMessageStore.countUnread.mockResolvedValue(0);
      mockMessageStore.getMessages.mockResolvedValue([]);
      mockMessageStore.setReadCursor.mockResolvedValue(undefined);
      mockGroupStoreGetByPeerId.mockResolvedValue(null);
    });

    it('clears the mirrored badge before IndexedDB answers', async() => {
      MOUNT_CLASS_TO.apiManagerProxy.mirrors.dialogs = {
        [PEER_ID]: {peerId: PEER_ID, unread_count: 7, pFlags: {}}
      };
      let release: (value: number) => void;
      mockMessageStore.countUnread.mockReturnValueOnce(new Promise<number>((resolve) => { release = resolve; }));
      const pending = resetUnreadForPeer(PEER_ID);
      expect(MOUNT_CLASS_TO.apiManagerProxy.mirrors.dialogs[PEER_ID].unread_count).toBe(0);
      expect(mockDispatchEvent).toHaveBeenCalledWith('dialogs_multiupdate', expect.any(Map));
      // Let resolveConversation's dynamic imports settle, then unblock IDB.
      await vi.waitFor(() => expect(mockMessageStore.countUnread).toHaveBeenCalled());
      release!(7);
      await pending;
    });

    it('does not mark later arrivals read after leaving during a storage lookup', async() => {
      mockMessageStore.countUnread.mockResolvedValue(2);
      let release: (value: any[]) => void;
      mockMessageStore.getMessages.mockReturnValueOnce(new Promise<any[]>((resolve) => { release = resolve; }));
      const pending = resetUnreadForPeer(PEER_ID);
      await vi.waitFor(() => expect(mockMessageStore.getMessages).toHaveBeenCalled());
      (MOUNT_CLASS_TO as any).appImManager.chat.peerId = 0;
      mockDispatchEvent.mockClear();
      release!([{mid: 100}]);
      await pending;
      expect(mockMessageStore.setReadCursor).not.toHaveBeenCalled();
      expect(mockDispatchEvent).not.toHaveBeenCalled();
    });

    it('abandons a delayed reset when mobile Back hides a retained peer', async() => {
      mockMessageStore.countUnread.mockResolvedValue(2);
      let release: (value: any[]) => void;
      mockMessageStore.getMessages.mockReturnValueOnce(new Promise<any[]>((resolve) => { release = resolve; }));
      const pending = resetUnreadForPeer(PEER_ID);
      await vi.waitFor(() => expect(mockMessageStore.getMessages).toHaveBeenCalled());
      (MOUNT_CLASS_TO as any).appImManager.isChatVisible = false;
      mockDispatchEvent.mockClear();
      release!([{mid: 100}]);
      await pending;
      expect(mockMessageStore.setReadCursor).not.toHaveBeenCalled();
      expect(mockDispatchEvent).not.toHaveBeenCalled();
    });

    it('advances a selected chat cursor even when a stale counter is already zero', async() => {
      mockMessageStore.getMessages.mockResolvedValue([{mid: 123}]);
      await resetUnreadForPeer(PEER_ID);
      expect(mockMessageStore.setReadCursor).toHaveBeenCalledWith(expect.stringContaining('conv-'), 123);
    });

    it('post-reload: dispatches dialogs_multiupdate even when lastDialogs/mirror are empty', async() => {
      // Simulate post-reload state: getDialogs at boot returned unread_count > 0
      // (countUnread reads from IDB), but no live message arrived this session
      // so the in-memory `lastDialogs` map and the proxy mirror are both empty.
      mockMessageStore.countUnread.mockResolvedValue(3);
      mockMessageStore.getMessages.mockResolvedValue([{
        mid: 99,
        eventId: 'event-99',
        senderPubkey: SENDER_PUBKEY,
        content: 'Hi',
        timestamp: 1712345678,
        isOutgoing: false,
        twebPeerId: PEER_ID
      }]);

      await resetUnreadForPeer(PEER_ID);

      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'dialogs_multiupdate',
        expect.any(Map)
      );
      // Defensive cursor advance so a future getDialogs reports 0 unread.
      expect(mockMessageStore.setReadCursor).toHaveBeenCalledWith(
        expect.stringContaining('conv-'),
        99
      );
    });

    it('cleared-dialog top message carries media from the stored row (2026-10-05 restart regression)', async() => {
      // Fresh peer id: earlier tests in this describe leave `lastDialogs`
      // populated for PEER_ID, which short-circuits the store rebuild.
      const MEDIA_PEER_ID = 1000000000000002;
      mockGetPubkey.mockResolvedValue(SENDER_PUBKEY);
      // resetUnreadForPeer rebuilds the dialog preview from the store. The
      // rebuilt top message used to omit media, and its write into tweb's
      // render cache flipped media bubbles to empty shells after restart.
      mockMessageStore.countUnread.mockResolvedValue(2);
      mockMessageStore.getMessages.mockResolvedValue([{
        mid: 77,
        eventId: 'event-77',
        senderPubkey: SENDER_PUBKEY,
        content: 'voice caption',
        timestamp: 1712345678,
        isOutgoing: false,
        twebPeerId: PEER_ID,
        type: 'file',
        fileMetadata: {
          url: 'https://nostr.download/77.bin',
          sha256: '77',
          mimeType: 'audio/ogg; codecs=opus',
          size: 1234,
          keyHex: 'aabb',
          ivHex: 'ccdd',
          mediaType: 'voice',
          duration: 3
        }
      }]);

      await resetUnreadForPeer(MEDIA_PEER_ID);

      const call = mockCreateTwebMessage.mock.calls.find((c: any[]) => (c[0] as any)?.mid === 77);
      expect(call).toBeDefined();
      expect((call![0] as any).media).toBeDefined();
      expect((call![0] as any).text).toBe('voice caption');
    });

    it('group: clears badge when group has unread messages in store', async() => {
      mockGroupStoreGetByPeerId.mockResolvedValue({
        groupId: 'group-abc',
        name: 'Test Group',
        members: [],
        adminPubkey: OWN_PUBKEY,
        peerId: GROUP_PEER_ID,
        createdAt: 0,
        updatedAt: 0
      });
      mockMessageStore.countUnread.mockResolvedValue(2);
      mockMessageStore.getMessages.mockResolvedValue([{
        mid: 50,
        eventId: 'g-event-50',
        senderPubkey: SENDER_PUBKEY,
        content: 'msg in group',
        timestamp: 1712345678,
        isOutgoing: false,
        twebPeerId: GROUP_PEER_ID
      }]);

      await resetUnreadForPeer(GROUP_PEER_ID);

      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'dialogs_multiupdate',
        expect.any(Map)
      );
      // #207: the group conversation key is canonical `group:<groupId>`. The
      // old bare key meant this cursor write silently missed the real rows, so
      // the badge reappeared after every restart.
      expect(mockMessageStore.setReadCursor).toHaveBeenCalledWith('group:group-abc', 50);
    });

    it('no-op when no source has unread (cache empty, mirror empty, store has 0)', async() => {
      mockMessageStore.countUnread.mockResolvedValue(0);

      await resetUnreadForPeer(PEER_ID);

      const dialogCalls = mockDispatchEvent.mock.calls.filter(
        (c) => c[0] === 'dialogs_multiupdate'
      );
      expect(dialogCalls.length).toBe(0);
      expect(mockMessageStore.setReadCursor).not.toHaveBeenCalled();
    });

    it('handles missing __phantomchatOwnPubkey gracefully (no throw)', async() => {
      delete (window as any).__phantomchatOwnPubkey;
      // Should not throw — just no-ops because conv resolution returns null.
      await expect(resetUnreadForPeer(PEER_ID)).resolves.toBeUndefined();
    });
  });

  describe('cross-device read state (#217)', () => {
    beforeEach(() => {
      (window as any).__phantomchatOwnPubkey = OWN_PUBKEY;
      mockGetPubkey.mockResolvedValue(SENDER_PUBKEY);
      mockMessageStore.countUnread.mockResolvedValue(0);
      mockMessageStore.getMessages.mockResolvedValue([]);
      mockGroupStoreGetByPeerId.mockResolvedValue(null);
    });

    it('applyRemoteReadState: repaints the badge from the store without a click', async() => {
      // Sync learned ANOTHER device read further; the cursor has already
      // advanced monotonically. Two messages remain above the synced cursor —
      // the badge must shrink to the DERIVED count and the dispatch must carry
      // it, so stale blue bubbles clear themselves.
      mockMessageStore.countUnread.mockResolvedValue(2);
      mockMessageStore.getMessages.mockResolvedValue([{
        mid: 88,
        eventId: 'event-88',
        senderPubkey: SENDER_PUBKEY,
        content: 'still unread',
        timestamp: 1712345678,
        isOutgoing: false,
        twebPeerId: PEER_ID
      }]);

      await applyRemoteReadState(PEER_ID);

      const call = mockDispatchEvent.mock.calls.find((c) => c[0] === 'dialogs_multiupdate');
      expect(call).toBeDefined();
      expect((call![1] as Map<any, any>).get(PEER_ID).dialog.unread_count).toBe(2);
      expect(getUnreadForPeer(PEER_ID)).toBe(2);
    });

    it('applyRemoteReadState: a fully-read conversation clears the stale counter to 0', async() => {
      mockMessageStore.countUnread.mockResolvedValue(5);
      mockMessageStore.getMessages.mockResolvedValue([{
        mid: 90,
        eventId: 'event-90',
        senderPubkey: SENDER_PUBKEY,
        content: 'hi',
        timestamp: 1712345678,
        isOutgoing: false,
        twebPeerId: PEER_ID
      }]);
      await applyRemoteReadState(PEER_ID);
      expect(getUnreadForPeer(PEER_ID)).toBe(5);

      mockMessageStore.countUnread.mockResolvedValue(0);
      await applyRemoteReadState(PEER_ID);
      const calls = mockDispatchEvent.mock.calls.filter((c) => c[0] === 'dialogs_multiupdate');
      const last = calls[calls.length - 1];
      expect((last[1] as Map<any, any>).get(PEER_ID).dialog.unread_count).toBe(0);
      expect(getUnreadForPeer(PEER_ID)).toBe(0);
    });

    it('reconcileUnreadFromStore: normalizes stale counter-map entries at boot', async() => {
      // The counter map persists in localStorage across reloads; entries can
      // predate a read done on another device. Boot reconciliation re-derives
      // every entry from the store so the next live increment starts from
      // truth instead of a stale device-local ghost.
      mockMessageStore.countUnread.mockResolvedValue(5);
      await applyRemoteReadState(PEER_ID);
      expect(getUnreadForPeer(PEER_ID)).toBe(5);

      mockMessageStore.countUnread.mockResolvedValue(0);
      await reconcileUnreadFromStore();
      expect(getUnreadForPeer(PEER_ID)).toBe(0);
    });
  });

  describe('cross-device read state — receive path (#218)', () => {
    // Fresh peer id: the module-level unread counter map persists across
    // tests in this file, so the assertions must own their counter.
    const RX_PEER = 1000000000000042;
    const makeRxData = (mid: number, extra: Record<string, unknown> = {}) => ({
      senderPubkey: SENDER_PUBKEY,
      peerId: RX_PEER,
      mid,
      timestamp: 1712345678,
      message: {content: 'Hello from peer', ...extra}
    });

    beforeEach(async() => {
      (window as any).__phantomchatOwnPubkey = OWN_PUBKEY;
      mockGetPubkey.mockResolvedValue(SENDER_PUBKEY);
      mockMessageStore.peekReadCursor.mockReturnValue(0);
      mockMessageStore.countUnread.mockResolvedValue(0);
      mockMessageStore.getMessages.mockResolvedValue([]);
      mockGroupStoreGetByPeerId.mockResolvedValue(null);
      // RX_PEER's chat is CLOSED (PEER_ID is the open one) — these tests pin
      // the closed-chat receive path, where the round-1 bug lived.
      (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID}};
      // The counter map is module state shared across tests in this file —
      // derive RX_PEER to 0 from the store so each test owns its count.
      await reconcileUnreadFromStore();
    });

    it('cursor-first/message-second: a cursor-covered backfill does not badge a closed chat', async() => {
      // The read cursor (local, or learned from another device and applied)
      // already covers this mid; the relay is backfilling history that was
      // read elsewhere. Round 1 repainted only on cursor ADVANCE, so the
      // handler's unconditional +1 left a blue badge nothing would clear.
      mockMessageStore.peekReadCursor.mockReturnValue(2000000042);
      const result = await handleIncomingMessage(makeRxData(2000000042), OWN_PUBKEY);

      expect(result).not.toBeNull();
      expect(getUnreadForPeer(RX_PEER)).toBe(0);
      const dialogCall = mockCreateTwebDialog.mock.calls.at(-1)![0];
      expect(dialogCall.unreadCount).toBe(0);
    });

    it('cursor-covered backfill suppresses the desktop notification', async() => {
      mockMessageStore.peekReadCursor.mockReturnValue(2000000042);
      await handleIncomingMessage(makeRxData(2000000042), OWN_PUBKEY);
      expect(mockNotifyIncoming).not.toHaveBeenCalled();

      // An uncovered message right after still notifies exactly once.
      mockMessageStore.peekReadCursor.mockReturnValue(2000000042);
      await handleIncomingMessage(makeRxData(2000000043), OWN_PUBKEY);
      expect(mockNotifyIncoming).toHaveBeenCalledTimes(1);
    });

    it('a message beyond the cursor still increments and notifies', async() => {
      mockMessageStore.peekReadCursor.mockReturnValue(2000000042);
      await handleIncomingMessage(makeRxData(2000000043), OWN_PUBKEY);
      expect(getUnreadForPeer(RX_PEER)).toBe(1);
      expect(mockNotifyIncoming).toHaveBeenCalledTimes(1);
    });

    it('a covered backfill never erases a badge held by a genuinely unread newer message', async() => {
      // Out-of-order backfill: the newer message lands first (unread, +1),
      // then an OLDER already-read one arrives. The covered message must not
      // reset the counter — the badge belongs to the newer message.
      mockMessageStore.peekReadCursor.mockReturnValue(2000000042);
      await handleIncomingMessage(makeRxData(2000000043), OWN_PUBKEY);
      expect(getUnreadForPeer(RX_PEER)).toBe(1);

      await handleIncomingMessage(makeRxData(2000000042), OWN_PUBKEY);
      expect(getUnreadForPeer(RX_PEER)).toBe(1);
    });

    it('derives the P2P conversation key without an IDB lookup', async() => {
      mockMessageStore.peekReadCursor.mockReturnValue(0);
      await handleIncomingMessage(makeRxData(2000000042), OWN_PUBKEY);
      // getConversationId mock: sorted-pubkey key over own + sender.
      expect(mockMessageStore.peekReadCursor).toHaveBeenCalledWith('conv-aaaa-bbbb');
    });

    it('derives the canonical group conversation key from the dispatch payload', async() => {
      mockMessageStore.peekReadCursor.mockReturnValue(2000000042);
      await handleIncomingMessage(
        makeRxData(2000000042, {groupId: 'group-abc'}),
        OWN_PUBKEY
      );
      expect(mockMessageStore.peekReadCursor).toHaveBeenCalledWith('group:group-abc');
      expect(getUnreadForPeer(RX_PEER)).toBe(0);
    });
  });

  describe('visible-transition rehydration (#117)', () => {
    afterEach(() => {
      delete (MOUNT_CLASS_TO as any).appImManager;
    });

    it('invalidates the open chat cache and dispatches history_reload', async() => {
      (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID}};

      await rehydrateOpenChatOnVisible(100_000);

      expect(mockInvalidateHistoryCache).toHaveBeenCalledWith(PEER_ID);
      const reloadCalls = mockDispatchEvent.mock.calls.filter((c) => c[0] === 'history_reload');
      expect(reloadCalls.length).toBe(1);
      expect(reloadCalls[0][1]).toBe(PEER_ID);
    });

    it('no-ops when no chat is open', async() => {
      (MOUNT_CLASS_TO as any).appImManager = {chat: null};

      await rehydrateOpenChatOnVisible(200_000);

      expect(mockInvalidateHistoryCache).not.toHaveBeenCalled();
      expect(mockDispatchEvent.mock.calls.filter((c) => c[0] === 'history_reload').length).toBe(0);
    });

    it('no-ops when appImManager is not mounted yet', async() => {
      delete (MOUNT_CLASS_TO as any).appImManager;

      await rehydrateOpenChatOnVisible(250_000);

      expect(mockInvalidateHistoryCache).not.toHaveBeenCalled();
    });

    it('throttles rapid hide/show flicker', async() => {
      (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID}};

      await rehydrateOpenChatOnVisible(300_000);
      await rehydrateOpenChatOnVisible(305_000); // inside the 10s window
      expect(mockInvalidateHistoryCache).toHaveBeenCalledTimes(1);

      await rehydrateOpenChatOnVisible(311_000); // past the window
      expect(mockInvalidateHistoryCache).toHaveBeenCalledTimes(2);
    });

    it('does NOT arm the recovery watchdog (watchdog is owned by bubbles)', async() => {
      (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID}};
      const spy = vi.spyOn(globalThis, 'setTimeout');

      await rehydrateOpenChatOnVisible(400_000);

      // startRecoveryWatchdog uses two setTimeout calls (button at 8s, reload at 15s)
      const watchdogTimeouts = spy.mock.calls.filter(([, ms]) => ms === 8_000 || ms === 15_000);
      expect(watchdogTimeouts.length).toBe(0);

      spy.mockRestore();
    });

    it('module-level visibilitychange listener triggers rehydration on visible', async() => {
      (MOUNT_CLASS_TO as any).appImManager = {chat: {peerId: PEER_ID}};
      // jsdom visibilityState defaults to 'visible'; real Date.now() is far
      // past the injected timestamps above, so the throttle does not block.
      document.dispatchEvent(new Event('visibilitychange'));
      // The listener fire-and-forgets an async fn: flush past the awaited
      // invalidateHistoryCache + dispatch (microtask chain, macrotask covers it).
      await new Promise((r) => setTimeout(r, 0));

      expect(mockInvalidateHistoryCache).toHaveBeenCalledWith(PEER_ID);
      expect(mockDispatchEvent.mock.calls.filter((c) => c[0] === 'history_reload').length).toBe(1);
    });
  });
});
