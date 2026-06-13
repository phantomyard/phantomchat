/**
 * Tests for phantomchat-message-handler.ts
 *
 * Verifies: message building, mirror injection, peer auto-add,
 * dialog creation, and the full handleIncomingMessage orchestration.
 */

import '../setup';
import {describe, it, expect, beforeEach, afterAll, vi} from 'vitest';

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
  setReadCursor: vi.fn().mockResolvedValue(undefined)
};
vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => mockMessageStore
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
const mockInvalidateHistoryCache = vi.fn().mockResolvedValue(undefined);
const mockSetDialogTopMessage = vi.fn().mockResolvedValue(undefined);
const mockInjectP2PUser = vi.fn().mockResolvedValue(undefined);

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: (...args: any[]) => mockDispatchEvent(...args),
    managers: {
      appMessagesManager: {
        setMessageToStorage: (...args: any[]) => mockSetMessageToStorage(...args),
        invalidateHistoryCache: (...args: any[]) => mockInvalidateHistoryCache(...args),
        setDialogTopMessage: (...args: any[]) => mockSetDialogTopMessage(...args)
      },
      appUsersManager: {
        injectP2PUser: (...args: any[]) => mockInjectP2PUser(...args)
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
  injectIntoMirrors,
  dispatchDialogUpdate,
  handleIncomingMessage,
  handleIncomingEdit,
  resetUnreadForPeer
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

    it('pushes to Worker storage via setMessageToStorage', async() => {
      const msg = {mid: 2000000001, id: 2000000001};
      await injectIntoMirrors(PEER_ID, msg, SENDER_PUBKEY);

      expect(mockSetMessageToStorage).toHaveBeenCalledWith(
        `${PEER_ID}_history`,
        msg
      );
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
      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'dialogs_multiupdate',
        expect.any(Map)
      );

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
      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'dialogs_multiupdate',
        expect.any(Map)
      );
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

    it('injectIntoMirrors: setMessageToStorage rejection is swallowed + logged', async() => {
      mockSetMessageToStorage.mockRejectedValueOnce(new Error('IDB closed'));

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
      expect(mockMessageStore.setReadCursor).toHaveBeenCalledWith('group-abc', 50);
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
});
