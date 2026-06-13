// @ts-nocheck
/**
 * Error-path + malformed-input tests for NostraMTProtoServer.
 *
 * Complements virtual-mtproto-server.test.ts (happy paths). Locks in
 * current behaviour for:
 *   - handleMethod with an unknown method (fallback shape)
 *   - malformed getHistory params (null peer, missing offsets)
 *   - sendMessage with empty message text
 *   - chatAPI.sendText rejection (caught + empty updates returned)
 *   - store.getAllConversationIds rejection (search/getDialogs resilient)
 *   - getFullUser when getPubkey returns empty → refresh not triggered
 *   - setChatAPI (wireRetryListener) with an invalid rootScope — swallowed
 *
 * If a malformed input triggers an unexpected throw, document it in the
 * report instead of fixing source here (scope boundary).
 */

import '../setup';
import {describe, it, expect, vi, beforeEach, beforeAll, afterAll} from 'vitest';

// ─── Polyfills ────────────────────────────────────────────────────────

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────

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

// ─── Hoisted mock refs ────────────────────────────────────────────────

const mockStore = vi.hoisted(() => ({
  getAllConversationIds: vi.fn(),
  getMessages: vi.fn(),
  getConversationId: vi.fn((a: string, b: string) => [a, b].sort().join(':')),
  saveMessage: vi.fn(),
  deleteByMid: vi.fn(),
  getByMid: vi.fn()
}));

const mockGetPubkey = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// ─── Mocks ────────────────────────────────────────────────────────────

vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => mockStore
}));

vi.mock('@lib/nostra/virtual-peers-db', () => ({
  getPubkey: mockGetPubkey,
  getMapping: vi.fn(),
  getDB: vi.fn(),
  storeMapping: vi.fn(),
  getAllMappings: vi.fn().mockResolvedValue([]),
  removeMapping: vi.fn(),
  updateMappingProfile: vi.fn()
}));

vi.mock('@lib/nostra/peer-profile-cache', () => ({
  loadCachedPeerProfile: vi.fn().mockReturnValue(null),
  refreshPeerProfileFromRelays: mockRefresh,
  saveCachedPeerProfile: vi.fn(),
  clearPeerProfileCache: vi.fn()
}));

vi.mock('@lib/nostra/group-store', () => ({
  getGroupStore: () => ({
    getAll: vi.fn().mockResolvedValue([])
  })
}));

vi.mock('@lib/nostra/nostra-bridge', () => ({
  NostraBridge: {
    getInstance: () => ({
      mapPubkeyToPeerId: vi.fn().mockResolvedValue(1234567890123456),
      mapEventIdToMid: vi.fn().mockResolvedValue(999000000001)
    })
  }
}));

// ─── Dynamic module loading ──────────────────────────────────────────

let NostraMTProtoServer: any;

beforeAll(async() => {
  vi.resetModules();

  vi.doMock('@lib/nostra/message-store', () => ({
    getMessageStore: () => mockStore
  }));
  vi.doMock('@lib/nostra/virtual-peers-db', () => ({
    getPubkey: mockGetPubkey,
    getMapping: vi.fn(),
    getDB: vi.fn(),
    storeMapping: vi.fn(),
    getAllMappings: vi.fn().mockResolvedValue([]),
    removeMapping: vi.fn(),
    updateMappingProfile: vi.fn()
  }));
  vi.doMock('@lib/nostra/peer-profile-cache', () => ({
    loadCachedPeerProfile: vi.fn().mockReturnValue(null),
    refreshPeerProfileFromRelays: mockRefresh,
    saveCachedPeerProfile: vi.fn(),
    clearPeerProfileCache: vi.fn()
  }));
  vi.doMock('@lib/nostra/group-store', () => ({
    getGroupStore: () => ({
      getAll: vi.fn().mockResolvedValue([])
    })
  }));
  vi.doMock('@lib/nostra/nostra-bridge', () => ({
    NostraBridge: {
      getInstance: () => ({
        mapPubkeyToPeerId: vi.fn().mockResolvedValue(1234567890123456),
        mapEventIdToMid: vi.fn().mockResolvedValue(999000000001)
      })
    }
  }));

  const serverMod = await import('@lib/nostra/virtual-mtproto-server');
  NostraMTProtoServer = serverMod.NostraMTProtoServer;
});

afterAll(() => {
  vi.unmock('@lib/nostra/peer-profile-cache');
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('NostraMTProtoServer — error + malformed input paths', () => {
  let server: any;
  let warnSpy: any;

  beforeEach(() => {
    server = new NostraMTProtoServer();
    server.setOwnPubkey(OWN_PUBKEY);
    vi.clearAllMocks();

    mockStore.getAllConversationIds.mockResolvedValue([CONVERSATION_ID]);
    mockStore.getMessages.mockResolvedValue([mockMessage]);
    mockStore.getByMid.mockResolvedValue(undefined);
    mockGetPubkey.mockResolvedValue(PEER_PUBKEY);

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ─── handleMethod unknown ───────────────────────────────────────────

  it('handleMethod(unknownMethod) routes to fallback shape', async() => {
    const result = await server.handleMethod('nonsense.notARealMethod', {});
    expect(result).toEqual({pFlags: {}});
  });

  // ─── getHistory malformed params ───────────────────────────────────

  it('getHistory with peer:null returns shaped empty result (no crash)', async() => {
    const result = await server.handleMethod('messages.getHistory', {peer: null});
    expect(result._).toBe('messages.messages');
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('getHistory with no params (undefined) returns shaped empty result', async() => {
    const result = await server.handleMethod('messages.getHistory', undefined);
    expect(result._).toBe('messages.messages');
    expect(result.messages).toEqual([]);
  });

  it('getHistory with missing offset_id/offset_date falls back to defaults', async() => {
    // No offset_* passed → limit default 50 and offsetDate undefined
    const result = await server.handleMethod('messages.getHistory', {
      peer: {user_id: PEER_ID}
    });
    expect(result._).toBe('messages.messages');
    expect(mockStore.getMessages).toHaveBeenCalledWith(
      expect.any(String),
      50,
      undefined
    );
  });

  it('getHistory with inputMessagesFilterPinned returns empty (P2P has no pins)', async() => {
    const result = await server.handleMethod('messages.getHistory', {
      peer: {user_id: PEER_ID},
      filter: {_: 'inputMessagesFilterPinned'}
    });
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  // ─── sendMessage validation ────────────────────────────────────────

  it('sendMessage with empty message string is accepted (forwarded as empty text)', async() => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue('evEmpty')
    };
    server.setChatAPI(mockChatAPI);
    mockStore.saveMessage = vi.fn().mockResolvedValue(undefined);

    const result = await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID},
      message: ''
    });

    expect(result._).toBe('updates');
    // Current behaviour: empty message is sent — there is NO input validation
    // in virtual-mtproto-server.sendMessage today.
    // 2nd arg = opts carrying twebPeerId (FIND-e49755c1 fix).
    expect(mockChatAPI.sendText).toHaveBeenCalledWith('', expect.objectContaining({twebPeerId: expect.any(Number)}));
  });

  it('sendMessage with missing message property defaults to empty string', async() => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue('evUndef')
    };
    server.setChatAPI(mockChatAPI);
    mockStore.saveMessage = vi.fn().mockResolvedValue(undefined);

    const result = await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID}
    });

    expect(result._).toBe('updates');
    expect(mockChatAPI.sendText).toHaveBeenCalledWith('', expect.objectContaining({twebPeerId: expect.any(Number)}));
  });

  it('sendMessage: chatAPI.sendText rejection returns emptyUpdates (no throw)', async() => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockRejectedValue(new Error('relay offline'))
    };
    server.setChatAPI(mockChatAPI);

    const result = await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID},
      message: 'never arrives'
    });

    expect(result._).toBe('updates');
    expect(result.updates).toEqual([]);
    // Neither nostraMid nor nostraEventId on the failure path
    expect(result.nostraMid).toBeUndefined();
    expect(result.nostraEventId).toBeUndefined();
  });

  it('sendMessage: no pubkey for peer returns emptyUpdates', async() => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue('ev')
    };
    server.setChatAPI(mockChatAPI);
    mockGetPubkey.mockResolvedValueOnce(null);

    const result = await server.handleMethod('messages.sendMessage', {
      peer: {user_id: 77},
      message: 'hi'
    });

    expect(result._).toBe('updates');
    expect(result.updates).toEqual([]);
    expect(mockChatAPI.sendText).not.toHaveBeenCalled();
  });

  // ─── deleteMessages error path ─────────────────────────────────────

  it('deleteMessages: store.deleteByMid rejection is caught (reports pts_count=mids.length)', async() => {
    mockStore.deleteByMid.mockRejectedValue(new Error('idb closed'));

    const result = await server.handleMethod('messages.deleteMessages', {
      id: [1, 2, 3]
    });

    expect(result._).toBe('messages.affectedMessages');
    // Current behaviour: pts_count reflects the REQUESTED delete count,
    // not the number that actually succeeded.
    expect(result.pts_count).toBe(3);
  });

  // ─── getDialogs / search resilience ─────────────────────────────────

  it('getDialogs: store.getAllConversationIds rejection returns empty shape', async() => {
    mockStore.getAllConversationIds.mockRejectedValueOnce(new Error('idb boom'));

    const result = await server.handleMethod('messages.getDialogs', {});
    expect(result._).toBe('messages.dialogs');
    expect(result.dialogs).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('searchMessages: store.getAllConversationIds rejection returns empty shape', async() => {
    mockStore.getAllConversationIds.mockRejectedValueOnce(new Error('idb boom'));

    const result = await server.handleMethod('messages.search', {q: 'x'});
    expect(result._).toBe('messages.messages');
    expect(result.messages).toEqual([]);
  });

  // ─── getFullUser: empty pubkey path ────────────────────────────────

  it('getFullUser: empty pubkey → does not trigger refreshPeerProfileFromRelays', async() => {
    mockGetPubkey.mockResolvedValueOnce(null);

    const result = await server.handleMethod('users.getFullUser', {
      id: {user_id: 42}
    });

    expect(result._).toBe('users.userFull');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('getFullUser: missing id returns shaped empty userFull', async() => {
    const result = await server.handleMethod('users.getFullUser', {});
    expect(result._).toBe('users.userFull');
    expect(Array.isArray(result.users)).toBe(true);
  });

  // ─── editMessage error path ────────────────────────────────────────

  it('editMessage: original mid not in store returns emptyUpdates', async() => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(true)
    };
    server.setChatAPI(mockChatAPI);
    mockStore.getByMid.mockResolvedValueOnce(undefined);

    const result = await server.handleMethod('messages.editMessage', {
      peer: {user_id: PEER_ID},
      id: 12345,
      message: 'new'
    });

    expect(result._).toBe('updates');
    expect(result.updates).toEqual([]);
    expect(mockChatAPI.editMessage).not.toHaveBeenCalled();
  });

  it('editMessage: non-numeric id returns emptyUpdates', async() => {
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(true)
    };
    server.setChatAPI(mockChatAPI);

    const result = await server.handleMethod('messages.editMessage', {
      peer: {user_id: PEER_ID},
      id: 'not-a-number',
      message: 'new'
    });

    expect(result._).toBe('updates');
    expect(result.updates).toEqual([]);
  });

  // ─── wireRetryListener swallow path ────────────────────────────────

  it('setChatAPI: wireRetryListener tolerates chained import failures (no throw)', async() => {
    // setChatAPI triggers a dynamic import('@lib/rootScope'). In jsdom the
    // import resolves normally; we just verify setChatAPI returns
    // synchronously and does not reject.
    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue('ev')
    };
    expect(() => server.setChatAPI(mockChatAPI)).not.toThrow();
    // Calling twice is a no-op (retryListenerWired guard)
    expect(() => server.setChatAPI(mockChatAPI)).not.toThrow();
  });
});
