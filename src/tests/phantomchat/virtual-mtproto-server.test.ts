/**
 * Tests for PhantomChatMTProtoServer
 *
 * Verifies that handleMethod routes to correct handlers and returns
 * properly-shaped MTProto responses built from mocked store data.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

// ─── Polyfills ────────────────────────────────────────────────────────

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

// ─── Mocks ────────────────────────────────────────────────────────────

const PEER_PUBKEY = 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344';
const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const CONVERSATION_ID = [OWN_PUBKEY, PEER_PUBKEY].sort().join(':');
const PEER_ID = 1234567890123456;
const MID = 999000000001;

const mockMessage = {
  eventId: 'ev001',
  conversationId: CONVERSATION_ID,
  senderPubkey: PEER_PUBKEY,
  content: 'hello world',
  type: 'text' as const,
  timestamp: 1700000000,
  deliveryState: 'delivered' as const,
  mid: MID,
  twebPeerId: PEER_ID,
  isOutgoing: false
};

// Hoisted mock references for resetModules/doMock pattern
const mockStore = vi.hoisted(() => ({
  getAllConversationIds: vi.fn(),
  getMessages: vi.fn(),
  getByMid: vi.fn(),
  getConversationId: vi.fn((a: string, b: string) => [a, b].sort().join(':')),
  saveMessage: vi.fn(),
  deleteByMid: vi.fn(),
  deleteMessages: vi.fn(),
  getReadCursor: vi.fn(),
  setReadCursor: vi.fn(),
  countUnread: vi.fn(),
  getTombstone: vi.fn().mockResolvedValue(0),
  setTombstone: vi.fn().mockResolvedValue(undefined)
}));

const mockGetPubkey = vi.hoisted(() => vi.fn());
const mockRemoveMapping = vi.hoisted(() => vi.fn());

// rootScope is reached via dynamic `await import('@lib/rootScope')` inside
// handlers that dispatch UI events (e.g. deleteContacts → conversation_deleted).
// The real rootScope.dispatchEvent fires an async MTProtoMessagePort call that
// rejects in the test env; mock it to a no-op spy so dispatches are observable
// and don't leak unhandled rejections.
const mockDispatchEvent = vi.hoisted(() => vi.fn());

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => mockStore
}));

vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  getPubkey: mockGetPubkey,
  getMapping: vi.fn(),
  getDB: vi.fn(),
  storeMapping: vi.fn(),
  getAllMappings: vi.fn().mockResolvedValue([]),
  removeMapping: mockRemoveMapping,
  updateMappingProfile: vi.fn()
}));

// peer-profile-cache mock — prevents real WebSocket connections in tests
vi.mock('@lib/phantomchat/peer-profile-cache', () => ({
  loadCachedPeerProfile: vi.fn().mockReturnValue(null),
  refreshPeerProfileFromRelays: vi.fn().mockResolvedValue(undefined),
  saveCachedPeerProfile: vi.fn(),
  clearPeerProfileCache: vi.fn()
}));

// group-store dynamic import mock
vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    getAll: vi.fn().mockResolvedValue([]),
    getByPeerId: vi.fn().mockResolvedValue(null)
  })
}));

// PhantomChatBridge mock for mapper.mapPubkey / mapper.mapEventId
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {
    getInstance: () => ({
      mapPubkeyToPeerId: vi.fn().mockResolvedValue(1234567890123456),
      mapEventIdToMid: vi.fn().mockResolvedValue(999000000001)
    })
  }
}));

// ─── Dynamic module loading ──────────────────────────────────────────

let PhantomChatMTProtoServer: any;
let getMessageStore: any;
let getPubkey: any;

beforeAll(async() => {
  // Re-register mocks via doMock to override any contamination from
  // other test files (e.g. message-requests.test.ts mocks virtual-peers-db
  // with only getDB, missing getPubkey/getMapping).
  vi.resetModules();

  vi.doMock('@lib/phantomchat/message-store', () => ({
    getMessageStore: () => mockStore
  }));
  vi.doMock('@lib/phantomchat/virtual-peers-db', () => ({
    getPubkey: mockGetPubkey,
    getMapping: vi.fn(),
    getDB: vi.fn(),
    storeMapping: vi.fn(),
    getAllMappings: vi.fn().mockResolvedValue([]),
    removeMapping: mockRemoveMapping,
    updateMappingProfile: vi.fn()
  }));
  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent: mockDispatchEvent,
      dispatchEventSingle: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  }));
  vi.doMock('@lib/phantomchat/peer-profile-cache', () => ({
    loadCachedPeerProfile: vi.fn().mockReturnValue(null),
    refreshPeerProfileFromRelays: vi.fn().mockResolvedValue(undefined),
    saveCachedPeerProfile: vi.fn(),
    clearPeerProfileCache: vi.fn()
  }));
  vi.doMock('@lib/phantomchat/group-store', () => ({
    getGroupStore: () => ({
      getAll: vi.fn().mockResolvedValue([]),
      getByPeerId: vi.fn().mockResolvedValue(null)
    })
  }));
  vi.doMock('@lib/phantomchat/phantomchat-bridge', () => ({
    PhantomChatBridge: {
      getInstance: () => ({
        mapPubkeyToPeerId: vi.fn().mockResolvedValue(1234567890123456),
        mapEventIdToMid: vi.fn().mockResolvedValue(999000000001)
      })
    }
  }));

  const serverMod = await import('@lib/phantomchat/virtual-mtproto-server');
  PhantomChatMTProtoServer = serverMod.PhantomChatMTProtoServer;

  const storeMod = await import('@lib/phantomchat/message-store');
  getMessageStore = storeMod.getMessageStore;

  const peersMod = await import('@lib/phantomchat/virtual-peers-db');
  getPubkey = peersMod.getPubkey;
});

afterAll(() => {
  vi.unmock('@lib/phantomchat/peer-profile-cache');
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('PhantomChatMTProtoServer', () => {
  let server: any;

  beforeEach(() => {
    server = new PhantomChatMTProtoServer();
    server.setOwnPubkey(OWN_PUBKEY);
    vi.clearAllMocks();

    mockStore.getAllConversationIds.mockResolvedValue([CONVERSATION_ID]);
    mockStore.getMessages.mockResolvedValue([mockMessage]);
    mockStore.getReadCursor.mockResolvedValue(0);
    mockStore.countUnread.mockResolvedValue(0);
    mockStore.setReadCursor.mockResolvedValue(undefined);

    mockGetPubkey.mockResolvedValue(PEER_PUBKEY);
  });

  // ─── getDialogs ───────────────────────────────────────────────────

  describe('messages.getDialogs', () => {
    it('returns proper shape with dialogs/messages/users/chats/count', async () => {
      const result = await server.handleMethod('messages.getDialogs', {});

      expect(result._).toBe('messages.dialogs');
      expect(Array.isArray(result.dialogs)).toBe(true);
      expect(Array.isArray(result.messages)).toBe(true);
      expect(Array.isArray(result.users)).toBe(true);
      expect(Array.isArray(result.chats)).toBe(true);
      expect(typeof result.count).toBe('number');
    });

    it('includes one dialog per conversation', async () => {
      const result = await server.handleMethod('messages.getDialogs', {});

      expect(result.dialogs.length).toBe(1);
      expect(result.messages.length).toBe(1);
      expect(result.users.length).toBe(1);
    });

    it('dialog has correct shape', async () => {
      const result = await server.handleMethod('messages.getDialogs', {});
      const dialog = result.dialogs[0];

      expect(dialog._).toBe('dialog');
      expect(dialog.top_message).toBe(MID);
      expect(typeof dialog.unread_count).toBe('number');
    });

    it('routes messages.getPinnedDialogs to same handler', async () => {
      const result = await server.handleMethod('messages.getPinnedDialogs', {});

      expect(result._).toBe('messages.dialogs');
      expect(Array.isArray(result.dialogs)).toBe(true);
    });

    it('returns empty arrays when no conversations', async () => {
      mockStore.getAllConversationIds.mockResolvedValue([]);
      const result = await server.handleMethod('messages.getDialogs', {});

      expect(result.dialogs).toEqual([]);
      expect(result.messages).toEqual([]);
      expect(result.users).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('propagates unread_count from store.countUnread', async () => {
      mockStore.countUnread.mockResolvedValueOnce(3);
      const result = await server.handleMethod('messages.getDialogs', {});

      expect(mockStore.countUnread).toHaveBeenCalledWith(CONVERSATION_ID, OWN_PUBKEY);
      expect(result.dialogs[0].unread_count).toBe(3);
    });

    it('propagates the read cursor into read_inbox/outbox_max_id', async () => {
      mockStore.getReadCursor.mockResolvedValueOnce(7);
      const result = await server.handleMethod('messages.getDialogs', {});

      expect(mockStore.getReadCursor).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(result.dialogs[0].read_inbox_max_id).toBe(7);
      expect(result.dialogs[0].read_outbox_max_id).toBe(7);
    });
  });

  // ─── getHistory ───────────────────────────────────────────────────

  describe('messages.getHistory', () => {
    it('returns messages for user_id peer', async () => {
      const result = await server.handleMethod('messages.getHistory', {
        peer: {_: 'inputPeerUser', user_id: PEER_ID}
      });

      expect(result._).toBe('messages.messages');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(Array.isArray(result.users)).toBe(true);
      expect(Array.isArray(result.chats)).toBe(true);
    });

    it('includes message content from store', async () => {
      const result = await server.handleMethod('messages.getHistory', {
        peer: {user_id: PEER_ID}
      });

      expect(result.messages.length).toBeGreaterThan(0);
      const msg = result.messages[0];
      expect(msg._).toBe('message');
      expect(msg.message).toBe('hello world');
      expect(msg.date).toBe(1700000000);
    });

    it('returns empty when no pubkey for peerId', async () => {
      mockGetPubkey.mockResolvedValueOnce(null);

      const result = await server.handleMethod('messages.getHistory', {
        peer: {user_id: 999999}
      });

      expect(result._).toBe('messages.messages');
      expect(result.messages).toEqual([]);
    });

    it('returns empty when peer is missing', async () => {
      const result = await server.handleMethod('messages.getHistory', {});

      expect(result._).toBe('messages.messages');
      expect(result.messages).toEqual([]);
    });

    it('handles chat_id peer (negative peerId)', async () => {
      const result = await server.handleMethod('messages.getHistory', {
        peer: {_: 'inputPeerChat', chat_id: 100}
      });

      expect(result._).toBe('messages.messages');
      // Result shape should be correct regardless of found messages
      expect(Array.isArray(result.messages)).toBe(true);
    });
  });

  // ─── searchMessages ───────────────────────────────────────────────

  describe('messages.search', () => {
    it('returns matching messages for query', async () => {
      const result = await server.handleMethod('messages.search', {q: 'hello'});

      expect(result._).toBe('messages.messages');
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[0].message).toContain('hello');
    });

    it('is case-insensitive', async () => {
      const result = await server.handleMethod('messages.search', {q: 'HELLO'});

      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('returns no matches for unrelated query', async () => {
      const result = await server.handleMethod('messages.search', {q: 'zzznomatch'});

      expect(result._).toBe('messages.messages');
      expect(result.messages).toEqual([]);
    });

    it('returns proper shape with users array', async () => {
      const result = await server.handleMethod('messages.search', {q: 'hello'});

      expect(Array.isArray(result.users)).toBe(true);
      expect(result.users.length).toBeGreaterThan(0);
    });
  });

  // ─── contacts.getContacts ─────────────────────────────────────────

  describe('contacts.getContacts', () => {
    it('returns contacts shape with users', async () => {
      const result = await server.handleMethod('contacts.getContacts', {});

      expect(result._).toBe('contacts.contacts');
      expect(Array.isArray(result.contacts)).toBe(true);
      expect(Array.isArray(result.users)).toBe(true);
      expect(typeof result.saved_count).toBe('number');
    });

    it('has one contact per conversation', async () => {
      const result = await server.handleMethod('contacts.getContacts', {});

      expect(result.contacts.length).toBe(1);
      expect(result.contacts[0]._).toBe('contact');
      expect(result.contacts[0].user_id).toBe(PEER_ID);
    });
  });

  // ─── self:self skip (never surface the user as their own chat/contact) ───

  describe('self:self conversation is skipped everywhere', () => {
    const SELF_CONV_ID = [OWN_PUBKEY, OWN_PUBKEY].join(':');
    const selfMessage = {
      ...mockMessage,
      conversationId: SELF_CONV_ID,
      senderPubkey: OWN_PUBKEY,
      content: 'note to self hello',
      isOutgoing: true
    };

    it('getDialogs drops a self:self conversation', async () => {
      mockStore.getAllConversationIds.mockResolvedValue([SELF_CONV_ID]);
      mockStore.getMessages.mockResolvedValue([selfMessage]);

      const result = await server.handleMethod('messages.getDialogs', {});

      expect(result.dialogs).toEqual([]);
      expect(result.users).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('getDialogs keeps a real peer but drops the self:self one', async () => {
      mockStore.getAllConversationIds.mockResolvedValue([SELF_CONV_ID, CONVERSATION_ID]);
      mockStore.getMessages.mockImplementation(async (convId: string) =>
        convId === SELF_CONV_ID ? [selfMessage] : [mockMessage]
      );

      const result = await server.handleMethod('messages.getDialogs', {});

      expect(result.dialogs.length).toBe(1);
      expect(result.users.length).toBe(1);
    });

    it('searchMessages does not return self:self matches', async () => {
      mockStore.getAllConversationIds.mockResolvedValue([SELF_CONV_ID]);
      mockStore.getMessages.mockResolvedValue([selfMessage]);

      const result = await server.handleMethod('messages.search', {q: 'hello'});

      expect(result.messages).toEqual([]);
      expect(result.users).toEqual([]);
    });

    it('getContacts does not list the user as their own contact', async () => {
      mockStore.getAllConversationIds.mockResolvedValue([SELF_CONV_ID]);
      mockStore.getMessages.mockResolvedValue([selfMessage]);

      const result = await server.handleMethod('contacts.getContacts', {});

      expect(result.contacts).toEqual([]);
      expect(result.users).toEqual([]);
    });
  });

  // ─── users.getFullUser ────────────────────────────────────────────

  describe('users.getFullUser', () => {
    it('returns userFull shape', async () => {
      const result = await server.handleMethod('users.getFullUser', {
        id: {user_id: PEER_ID}
      });

      expect(result._).toBe('users.userFull');
      expect(Array.isArray(result.users)).toBe(true);
      expect(result.full_user._).toBe('userFull');
    });
  });

  // ─── Write path ───────────────────────────────────────────────────

  describe('messages.sendMessage', () => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue('differentPeer'),
      connect: vi.fn().mockResolvedValue(undefined),
      allocateMessageId: vi.fn().mockReturnValue('eventId123'),
      sendText: vi.fn().mockResolvedValue('eventId123')
    };

    beforeEach(() => {
      server.setChatAPI(mockChatAPI);
      mockChatAPI.getActivePeer.mockReturnValue('differentPeer');
      mockChatAPI.connect.mockResolvedValue(undefined);
      mockChatAPI.allocateMessageId.mockReturnValue('eventId123');
      mockChatAPI.sendText.mockResolvedValue('eventId123');

      mockStore.saveMessage = vi.fn().mockResolvedValue(undefined);
      mockStore.getConversationId = vi.fn((a: string, b: string) => [a, b].sort().join(':'));
    });

    it('calls chatAPI.sendText and returns updates shape', async () => {
      const result = await server.handleMethod('messages.sendMessage', {
        peer: {user_id: PEER_ID},
        message: 'hello there',
        random_id: BigInt(42)
      });

      expect(result._).toBe('updates');
      // VMT passes twebPeerId so the initial ChatAPI IDB row already carries
      // it — closes FIND-e49755c1 (mirror/IDB drift).
      expect(mockChatAPI.sendText).toHaveBeenCalledWith('hello there', expect.objectContaining({twebPeerId: expect.any(Number)}));
      // Source returns emptyUpdates — Worker's P2P shortcut in
      // appMessagesManager handles the pending-to-sent transition
      // instead of relying on updateNewMessage from the server.
      expect(Array.isArray(result.updates)).toBe(true);
    });

    // Persistence is now ChatAPI's responsibility — VMT delegates the row
    // save entirely (production: chat-api.ts:621-635 keys by `eventId =
    // publishedRumorId`). The previous "VMT writes a second row with
    // eventId = chat-XXX-N" path was the source of FIND-4e18d35d's recurrent
    // strfry rejection; removing it is the fix. This test now just asserts
    // the delegation contract: `chatAPI.sendText` receives the same content
    // and a `twebPeerId` so its save can land the full identity triple.
    it('delegates persistence to chatAPI.sendText (no direct store write from VMT)', async () => {
      await server.handleMethod('messages.sendMessage', {
        peer: {user_id: PEER_ID},
        message: 'persist me',
        random_id: BigInt(1)
      });

      expect(mockChatAPI.sendText).toHaveBeenCalledWith(
        'persist me',
        expect.objectContaining({twebPeerId: expect.any(Number), timestampSec: expect.any(Number)})
      );
      expect(mockStore.saveMessage).not.toHaveBeenCalled();
    });

    it('connects to peer if not already active', async () => {
      mockChatAPI.getActivePeer.mockReturnValue('someOtherPeer');
      await server.handleMethod('messages.sendMessage', {
        peer: {user_id: PEER_ID},
        message: 'test'
      });

      expect(mockChatAPI.connect).toHaveBeenCalledWith(PEER_PUBKEY);
    });

    it('skips connect if peer already active', async () => {
      mockChatAPI.getActivePeer.mockReturnValue(PEER_PUBKEY);
      await server.handleMethod('messages.sendMessage', {
        peer: {user_id: PEER_ID},
        message: 'test'
      });

      expect(mockChatAPI.connect).not.toHaveBeenCalled();
    });

    it('returns empty updates when chatAPI is not set', async () => {
      const bareServer = new PhantomChatMTProtoServer();
      bareServer.setOwnPubkey(OWN_PUBKEY);
      // no setChatAPI call

      const result = await bareServer.handleMethod('messages.sendMessage', {
        peer: {user_id: PEER_ID},
        message: 'test'
      });

      expect(result._).toBe('updates');
      expect(result.updates).toEqual([]);
    });

    it('returns empty updates when ownPubkey is not set', async () => {
      const bareServer = new PhantomChatMTProtoServer();
      bareServer.setChatAPI(mockChatAPI);
      // no setOwnPubkey call

      const result = await bareServer.handleMethod('messages.sendMessage', {
        peer: {user_id: PEER_ID},
        message: 'test'
      });

      expect(result._).toBe('updates');
      expect(result.updates).toEqual([]);
    });

    describe('reply_to plumbing', () => {
      it('extracts reply_to.reply_to_msg_id, resolves eventId via getByMid, and forwards as replyTo', async () => {
        mockStore.getByMid.mockResolvedValue({
          ...mockMessage,
          mid: 555,
          eventId: 'rumor-original-evt-hex'
        });

        await server.handleMethod('messages.sendMessage', {
          peer: {user_id: PEER_ID},
          message: 'this is a reply',
          reply_to: {_: 'inputReplyToMessage', reply_to_msg_id: 555}
        });

        expect(mockStore.getByMid).toHaveBeenCalledWith(555);
        expect(mockChatAPI.sendText).toHaveBeenCalledWith(
          'this is a reply',
          expect.objectContaining({
            replyTo: {eventId: 'rumor-original-evt-hex'}
          })
        );
      });

      it('does NOT pass replyTo when reply_to is absent on the request', async () => {
        await server.handleMethod('messages.sendMessage', {
          peer: {user_id: PEER_ID},
          message: 'plain message'
        });

        const opts = mockChatAPI.sendText.mock.calls[0][1];
        expect(opts.replyTo).toBeUndefined();
      });

      it('still sends the message when reply_to mid lookup fails', async () => {
        mockStore.getByMid.mockResolvedValue(null);

        await server.handleMethod('messages.sendMessage', {
          peer: {user_id: PEER_ID},
          message: 'reply with broken target',
          reply_to: {_: 'inputReplyToMessage', reply_to_msg_id: 999}
        });

        expect(mockChatAPI.sendText).toHaveBeenCalled();
        const opts = mockChatAPI.sendText.mock.calls[0][1];
        expect(opts.replyTo).toBeUndefined();
      });
    });
  });

  describe('messages.sendMedia', () => {
    it('returns updates shape (delegates to sendMessage with caption)', async () => {
      const mockChatAPI = {
        getActivePeer: vi.fn().mockReturnValue('differentPeer'),
        connect: vi.fn().mockResolvedValue(undefined),
        sendText: vi.fn().mockResolvedValue('mediaEventId')
      };
      server.setChatAPI(mockChatAPI);

      mockStore.saveMessage = vi.fn().mockResolvedValue(undefined);
      mockStore.getConversationId = vi.fn((a: string, b: string) => [a, b].sort().join(':'));

      const result = await server.handleMethod('messages.sendMedia', {
        peer: {user_id: PEER_ID},
        message: 'a caption'
      });

      expect(result._).toBe('updates');
      expect(Array.isArray(result.updates)).toBe(true);
    });
  });

  describe('messages.deleteMessages', () => {
    it('returns affectedMessages with correct pts_count', async () => {
      const result = await server.handleMethod('messages.deleteMessages', {
        id: [101, 102, 103]
      });

      expect(result._).toBe('messages.affectedMessages');
      // FIND-0ed3a22c: pts is now monotonic (allocatePts increments by
      // pts_count); hard-coding to 1 collided with apiUpdatesManager's
      // initial curState.pts=1 and dropped the update as duplicate.
      expect(result.pts).toBeGreaterThan(0);
      expect(result.pts_count).toBe(3);
    });

    it('returns pts_count 0 when id is missing', async () => {
      const result = await server.handleMethod('messages.deleteMessages', {});

      expect(result._).toBe('messages.affectedMessages');
      expect(result.pts_count).toBe(0);
    });

    it('returns monotonically increasing pts across calls (FIND-0ed3a22c)', async () => {
      const a = await server.handleMethod('messages.deleteMessages', {id: [1, 2]});
      const b = await server.handleMethod('messages.deleteMessages', {id: [3]});
      const c = await server.handleMethod('messages.deleteMessages', {id: [4, 5, 6]});
      expect(b.pts).toBeGreaterThan(a.pts);
      expect(c.pts).toBeGreaterThan(b.pts);
      // pts_count: 0 calls share the previous pts (no event delivered).
      const d = await server.handleMethod('messages.deleteMessages', {});
      expect(d.pts).toBe(c.pts);
    });

    it('seedPts lifts nextPts above persisted high-water-mark (FIND-0ed3a22c persistence regression)', async () => {
      // Simulate a returning user: apiUpdatesManager has restored
      // curState.pts = 100 from disk. A fresh VMT instance starts at
      // nextPts = 1; without the seed it would allocate pts <= 100 and
      // every update gets dropped as duplicate.
      const fresh = new PhantomChatMTProtoServer();
      fresh.seedPts(100);
      const r = await fresh.handleMethod('messages.deleteMessages', {id: [9, 8, 7]});
      expect(r.pts).toBeGreaterThan(100);
      expect(r.pts_count).toBe(3);
    });

    it('seedPts is monotonic-only (lower values do not regress the counter)', async () => {
      const fresh = new PhantomChatMTProtoServer();
      fresh.seedPts(50);
      const r1 = await fresh.handleMethod('messages.deleteMessages', {id: [1]});
      const ptsAfter = r1.pts; // 51
      // A late seed with a smaller value (e.g. stale state read) must NOT
      // pull nextPts back below the live counter.
      fresh.seedPts(10);
      const r2 = await fresh.handleMethod('messages.deleteMessages', {id: [2]});
      expect(r2.pts).toBeGreaterThan(ptsAfter);
    });

    it('seedPts ignores non-finite or undefined values', async () => {
      const fresh = new PhantomChatMTProtoServer();
      fresh.seedPts(undefined as unknown as number);
      fresh.seedPts(NaN);
      fresh.seedPts(-1);  // monotonic-only also rejects negatives
      const r = await fresh.handleMethod('messages.deleteMessages', {id: [1]});
      expect(r.pts).toBeGreaterThan(0);
      expect(r.pts).toBeLessThan(10); // proves we didn't accidentally jump
    });

    describe('revoke=true (delete-for-everyone)', () => {
      const publishMessageDeletions = vi.fn().mockResolvedValue(undefined);

      beforeEach(() => {
        publishMessageDeletions.mockClear();
        server.setChatAPI({
          getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
          connect: vi.fn().mockResolvedValue(undefined),
          sendText: vi.fn().mockResolvedValue('eventId'),
          publishMessageDeletions
        });
        mockStore.deleteByMid.mockResolvedValue(undefined);
        mockStore.getByMid.mockResolvedValue({
          ...mockMessage,
          eventId: 'rumor-evt-A'
        });
        mockGetPubkey.mockResolvedValue(PEER_PUBKEY);
      });

      it('publishes per-message deletions to peer when revoke=true', async () => {
        await server.handleMethod('messages.deleteMessages', {
          id: [MID],
          revoke: true
        });

        // Wait a microtask cycle for the fire-and-forget publish chain.
        await new Promise((r) => setTimeout(r, 0));

        expect(publishMessageDeletions).toHaveBeenCalledTimes(1);
        const [eventIds, peerPubkey] = publishMessageDeletions.mock.calls[0];
        expect(eventIds).toEqual(['rumor-evt-A']);
        expect(peerPubkey).toBe(PEER_PUBKEY);
      });

      it('does NOT publish when revoke is false (Local-only delete)', async () => {
        await server.handleMethod('messages.deleteMessages', {
          id: [MID],
          revoke: false
        });

        await new Promise((r) => setTimeout(r, 0));
        expect(publishMessageDeletions).not.toHaveBeenCalled();
      });

      it('still removes from local store even when publish path is unavailable', async () => {
        server.setChatAPI(null);
        await server.handleMethod('messages.deleteMessages', {
          id: [MID],
          revoke: true
        });

        expect(mockStore.deleteByMid).toHaveBeenCalledWith(MID);
        expect(publishMessageDeletions).not.toHaveBeenCalled();
      });

      it('skips eventIds for mids with missing rows', async () => {
        mockStore.getByMid
        .mockResolvedValueOnce({...mockMessage, eventId: 'rumor-evt-1'})
        .mockResolvedValueOnce(null);

        await server.handleMethod('messages.deleteMessages', {
          id: [MID, MID + 1],
          revoke: true
        });

        await new Promise((r) => setTimeout(r, 0));
        const [eventIds] = publishMessageDeletions.mock.calls[0];
        expect(eventIds).toEqual(['rumor-evt-1']);
      });
    });
  });

  describe('messages.deleteHistory', () => {
    beforeEach(() => {
      mockStore.deleteMessages.mockResolvedValue(undefined);
    });

    it('wipes the conversation in message-store for a 1:1 peer', async () => {
      const result = await server.handleMethod('messages.deleteHistory', {
        peer: {user_id: PEER_ID},
        max_id: 0
      });

      expect(result._).toBe('messages.affectedHistory');
      expect(result.offset).toBe(0);
      expect(mockStore.deleteMessages).toHaveBeenCalledWith(CONVERSATION_ID);
      // Deletion watermark recorded so relay replays can't boomerang the chat.
      expect(mockStore.setTombstone).toHaveBeenCalledWith(CONVERSATION_ID, expect.any(Number));
    });

    it('does not call deleteMessages when peer pubkey cannot be resolved', async () => {
      mockGetPubkey.mockResolvedValueOnce(null);

      const result = await server.handleMethod('messages.deleteHistory', {
        peer: {user_id: 999999},
        max_id: 0
      });

      expect(result._).toBe('messages.affectedHistory');
      expect(result.offset).toBe(0);
      expect(mockStore.deleteMessages).not.toHaveBeenCalled();
    });

    it('returns affectedHistory when peer is missing', async () => {
      const result = await server.handleMethod('messages.deleteHistory', {});

      expect(result._).toBe('messages.affectedHistory');
      expect(mockStore.deleteMessages).not.toHaveBeenCalled();
    });
  });

  describe('channels.deleteHistory', () => {
    it('returns truthy and is a no-op for unknown groups', async () => {
      mockStore.deleteMessages.mockResolvedValue(undefined);

      const result = await server.handleMethod('channels.deleteHistory', {
        channel: {channel_id: 42},
        max_id: 0
      });

      expect(result).toBe(true);
      expect(mockStore.deleteMessages).not.toHaveBeenCalled();
    });
  });

  describe('contacts.deleteContacts', () => {
    beforeEach(() => {
      mockStore.deleteMessages.mockResolvedValue(undefined);
      mockStore.setTombstone.mockResolvedValue(undefined);
      mockDispatchEvent.mockClear();
      mockRemoveMapping.mockClear();
      mockRemoveMapping.mockResolvedValue(undefined);
    });

    it('removes the peer from virtual-peers-db so it cannot re-appear in Contacts (delete-boomerang)', async () => {
      const result = await server.handleMethod('contacts.deleteContacts', {
        id: [{_: 'inputUser', user_id: PEER_ID, access_hash: 0}]
      });

      expect(result._).toBe('updates');
      // The tombstone alone is not enough — Contacts re-enumerates from
      // getAllMappings(), so the mapping itself must be dropped.
      expect(mockRemoveMapping).toHaveBeenCalledWith(PEER_PUBKEY);
    });

    it('wipes + tombstones the conversation for each deleted contact', async () => {
      const result = await server.handleMethod('contacts.deleteContacts', {
        id: [{_: 'inputUser', user_id: PEER_ID, access_hash: 0}]
      });

      // Returns an updates envelope (not the old silent fallback `true`).
      expect(result._).toBe('updates');
      expect(mockStore.deleteMessages).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(mockStore.setTombstone).toHaveBeenCalledWith(CONVERSATION_ID, expect.any(Number));
      // Dispatches the dialog-drop event so the chat list removes the dialog.
      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'phantomchat_conversation_deleted',
        expect.objectContaining({peerPubkey: PEER_PUBKEY, conversationId: CONVERSATION_ID})
      );
    });

    it('is a safe no-op when no ids are supplied', async () => {
      const result = await server.handleMethod('contacts.deleteContacts', {id: []});

      expect(result._).toBe('updates');
      expect(mockStore.deleteMessages).not.toHaveBeenCalled();
      expect(mockStore.setTombstone).not.toHaveBeenCalled();
    });

    it('skips a contact whose pubkey cannot be resolved', async () => {
      mockGetPubkey.mockResolvedValueOnce(null);

      const result = await server.handleMethod('contacts.deleteContacts', {
        id: [{_: 'inputUser', user_id: 999999, access_hash: 0}]
      });

      expect(result._).toBe('updates');
      expect(mockStore.deleteMessages).not.toHaveBeenCalled();
      expect(mockStore.setTombstone).not.toHaveBeenCalled();
    });
  });

  describe('messages.readHistory', () => {
    it('returns affectedMessages with pts_count 0', async () => {
      const result = await server.handleMethod('messages.readHistory', {
        peer: {user_id: PEER_ID},
        max_id: 9999
      });

      expect(result._).toBe('messages.affectedMessages');
      expect(result.pts).toBe(1);
      expect(result.pts_count).toBe(0);
    });

    it('advances the read cursor via setReadCursor', async () => {
      await server.handleMethod('messages.readHistory', {
        peer: {user_id: PEER_ID},
        max_id: 42
      });

      expect(mockStore.setReadCursor).toHaveBeenCalledWith(CONVERSATION_ID, 42);
    });

    it('is a no-op when max_id is 0', async () => {
      await server.handleMethod('messages.readHistory', {
        peer: {user_id: PEER_ID},
        max_id: 0
      });

      expect(mockStore.setReadCursor).not.toHaveBeenCalled();
    });

    it('is a no-op when peer cannot be resolved', async () => {
      mockGetPubkey.mockResolvedValueOnce(null);
      await server.handleMethod('messages.readHistory', {
        peer: {user_id: 999999},
        max_id: 42
      });

      expect(mockStore.setReadCursor).not.toHaveBeenCalled();
    });

    it('round-trip: getDialogs reports unread=3, then readHistory clears, getDialogs reports 1', async () => {
      mockStore.countUnread.mockResolvedValueOnce(3);
      const before = await server.handleMethod('messages.getDialogs', {});
      expect(before.dialogs[0].unread_count).toBe(3);

      await server.handleMethod('messages.readHistory', {
        peer: {user_id: PEER_ID},
        max_id: MID - 1
      });
      expect(mockStore.setReadCursor).toHaveBeenCalledWith(CONVERSATION_ID, MID - 1);

      mockStore.countUnread.mockResolvedValueOnce(1);
      const after = await server.handleMethod('messages.getDialogs', {});
      expect(after.dialogs[0].unread_count).toBe(1);
    });
  });

  // ─── Privacy ──────────────────────────────────────────────────────
  // WAVE 8 preventive fix: account.setPrivacy/getPrivacy now persist to
  // localStorage so the toggle round-trips across reload. Was a silent-
  // noop trap (the audit's #1 ranked candidate to surface as FIND-* HIGH
  // in the next explorer run).

  describe('account.setPrivacy + account.getPrivacy round-trip', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('getPrivacy returns allowAll fallback when no entry stored', async () => {
      const result = await server.handleMethod('account.getPrivacy', {
        key: {_: 'inputPrivacyKeyStatusTimestamp'}
      });

      expect(result._).toBe('account.privacyRules');
      expect(result.rules).toEqual([{_: 'privacyValueAllowAll'}]);
    });

    it('setPrivacy persists rules and returns the response shape tweb expects', async () => {
      const result = await server.handleMethod('account.setPrivacy', {
        key: {_: 'inputPrivacyKeyStatusTimestamp'},
        rules: [{_: 'inputPrivacyValueDisallowAll'}]
      });

      // Tweb's caller does .then(privacyRules => saveApiUsers(privacyRules.users))
      // so the response MUST have users + chats arrays.
      expect(result._).toBe('account.privacyRules');
      expect(Array.isArray(result.users)).toBe(true);
      expect(Array.isArray(result.chats)).toBe(true);
      // setPrivacy converts inputPrivacyValue* → privacyValue* in the response
      expect(result.rules[0]._).toBe('privacyValueDisallowAll');
    });

    it('round-trips: getPrivacy returns rules previously stored by setPrivacy', async () => {
      await server.handleMethod('account.setPrivacy', {
        key: {_: 'inputPrivacyKeyStatusTimestamp'},
        rules: [{_: 'inputPrivacyValueDisallowAll'}]
      });

      const get = await server.handleMethod('account.getPrivacy', {
        key: {_: 'inputPrivacyKeyStatusTimestamp'}
      });

      expect(get.rules[0]._).toBe('privacyValueDisallowAll');
    });

    it('keys are scoped — setting one privacy key does not affect another', async () => {
      await server.handleMethod('account.setPrivacy', {
        key: {_: 'inputPrivacyKeyStatusTimestamp'},
        rules: [{_: 'inputPrivacyValueDisallowAll'}]
      });

      const otherKey = await server.handleMethod('account.getPrivacy', {
        key: {_: 'inputPrivacyKeyPhoneNumber'}
      });

      expect(otherKey.rules).toEqual([{_: 'privacyValueAllowAll'}]);
    });
  });

  // ─── Notify settings ──────────────────────────────────────────────
  // WU-1 #4: account.updateNotifySettings/getNotifySettings now persist
  // per-peer to localStorage. Previously updateNotifySettings fell through
  // fallback() (matched '.set' → returned true, dropping the mute) and
  // getNotifySettings returned a hardcoded static, so per-peer mute did
  // not survive reload.

  describe('account.updateNotifySettings + getNotifySettings round-trip (WU-1)', () => {
    const peer = {_: 'inputNotifyPeer', peer: {_: 'inputPeerUser', user_id: 777}};

    beforeEach(() => {
      localStorage.clear();
    });

    it('getNotifySettings returns a peerNotifySettings shape when nothing stored', async () => {
      const r = await server.handleMethod('account.getNotifySettings', {peer});
      expect(r._).toBe('peerNotifySettings');
    });

    it('updateNotifySettings persists mute_until + silent and round-trips via getNotifySettings', async () => {
      await server.handleMethod('account.updateNotifySettings', {
        peer,
        settings: {_: 'inputPeerNotifySettings', mute_until: 2147483647, silent: true}
      });

      const r = await server.handleMethod('account.getNotifySettings', {peer});
      expect(r._).toBe('peerNotifySettings');
      expect(r.mute_until).toBe(2147483647);
      expect(r.silent).toBe(true);
    });

    it('is per-peer scoped — muting one peer does not mute another', async () => {
      await server.handleMethod('account.updateNotifySettings', {
        peer,
        settings: {_: 'inputPeerNotifySettings', mute_until: 2147483647}
      });

      const other = await server.handleMethod('account.getNotifySettings', {
        peer: {_: 'inputNotifyPeer', peer: {_: 'inputPeerUser', user_id: 888}}
      });
      expect(other.mute_until ?? 0).toBe(0);
    });
  });

  // ─── Fallback ─────────────────────────────────────────────────────

  describe('fallback', () => {
    it('unknown method returns {pFlags: {}}', async () => {
      const result = await server.handleMethod('unknown.method', {});

      expect(result).toEqual({pFlags: {}});
    });

    it('action methods return true — contains .set', async () => {
      // account.setPrivacy now has its own handler (WAVE 8 preventive fix
      // for the silent-noop trap). Use a different .set method to exercise
      // the fallback action-pattern path.
      const result = await server.handleMethod('account.setAccountTTL', {});

      expect(result).toBe(true);
    });

    it('action methods return true — contains .save', async () => {
      const result = await server.handleMethod('account.saveWallPaper', {});

      expect(result).toBe(true);
    });

    it('action methods return true — contains .delete', async () => {
      // contacts.deleteContacts now has a real handler (see deleteContacts
      // tests below); use another unhandled .delete method to exercise the
      // fallback pattern.
      const result = await server.handleMethod('messages.deleteScheduledMessages', {});

      expect(result).toBe(true);
    });

    it('action methods return true — contains .mark', async () => {
      const result = await server.handleMethod('messages.markDialogUnread', {});

      expect(result).toBe(true);
    });

    it('action methods return true — contains .toggle', async () => {
      const result = await server.handleMethod('channels.toggleForum', {});

      expect(result).toBe(true);
    });

    it('action methods return true — contains .block', async () => {
      const result = await server.handleMethod('contacts.block', {});

      expect(result).toBe(true);
    });

    it('action methods return true — contains .join', async () => {
      const result = await server.handleMethod('channels.joinChannel', {});

      expect(result).toBe(true);
    });

    // WU-1 #5: surface unhandled silent-noops in dev/explorer builds so a UI
    // action routed through an unimplemented action method doesn't disappear
    // unnoticed. Return value is unchanged (still true) — diagnostic only.
    it('warns (dev) on an unhandled action-pattern method while still returning true', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await server.handleMethod('channels.toggleForum', {});

      expect(result).toBe(true);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not warn for a known static method', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await server.handleMethod('updates.getState', {});

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns at most once per distinct unhandled method', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await server.handleMethod('channels.toggleSlowMode', {});
      await server.handleMethod('channels.toggleSlowMode', {});

      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('updates.getState returns state shape', async () => {
      const result = await server.handleMethod('updates.getState', {});

      expect(result._).toBe('updates.state');
      expect(typeof result.pts).toBe('number');
    });

    it('updates.getDifference returns differenceEmpty', async () => {
      const result = await server.handleMethod('updates.getDifference', {});

      expect(result._).toBe('updates.differenceEmpty');
    });

    it('help.getConfig returns config shape', async () => {
      const result = await server.handleMethod('help.getConfig', {});

      expect(result._).toBe('config');
      expect(Array.isArray(result.dc_options)).toBe(true);
    });

    it('account.getNotifySettings returns peerNotifySettings', async () => {
      const result = await server.handleMethod('account.getNotifySettings', {});

      expect(result._).toBe('peerNotifySettings');
    });

    it('langpack.getDifference returns langPackDifference', async () => {
      const result = await server.handleMethod('langpack.getDifference', {});

      expect(result._).toBe('langPackDifference');
      expect(Array.isArray(result.strings)).toBe(true);
    });
  });
});
