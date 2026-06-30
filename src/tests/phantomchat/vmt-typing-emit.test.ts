/**
 * Tests for PhantomChatMTProtoServer.setTyping (messages.setTyping handler).
 *
 * Covers the emit side: a typing / recording action from the UI is translated
 * into a NIP-17 gift-wrapped (kind-1059) typing indicator and published over
 * the relay layer — gated, WhatsApp-style, on the read-receipts toggle.
 *
 * Regression guard: messages.setTyping used to fall through to the action-prefix
 * no-op (returned `true`, dropped on the floor), so typing was never sent.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

const PEER_PUBKEY = 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344';
const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const MEMBER_A = 'cafe000000000000cafe000000000000cafe000000000000cafe000000000000';
const MEMBER_B = 'beef111111111111beef111111111111beef111111111111beef111111111111';
const PEER_ID = 1234567890123456;
// Negative, in the GROUP_PEER_BASE range (2 * 10^15) → isGroupPeer === true.
const GROUP_PEER_ID = -(3 * 10 ** 15);
const READ_RECEIPTS_KEY = 'phantomchat:read-receipts-enabled';

const mockGetPubkey = vi.hoisted(() => vi.fn());
// Mutable group record so individual tests can drive the group branch.
const groupState = vi.hoisted(() => ({record: null as any}));

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({})
}));
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  getPubkey: mockGetPubkey,
  getMapping: vi.fn(),
  getDB: vi.fn(),
  storeMapping: vi.fn(),
  getAllMappings: vi.fn().mockResolvedValue([]),
  removeMapping: vi.fn(),
  updateMappingProfile: vi.fn()
}));
vi.mock('@lib/phantomchat/peer-profile-cache', () => ({
  loadCachedPeerProfile: vi.fn().mockReturnValue(null),
  refreshPeerProfileFromRelays: vi.fn().mockResolvedValue(undefined),
  saveCachedPeerProfile: vi.fn(),
  clearPeerProfileCache: vi.fn()
}));
vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    getAll: vi.fn().mockResolvedValue([]),
    getByPeerId: vi.fn().mockImplementation(async() => groupState.record)
  })
}));
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {
    getInstance: () => ({
      mapPubkeyToPeerId: vi.fn().mockResolvedValue(PEER_ID),
      mapEventIdToMid: vi.fn().mockResolvedValue(999000000001)
    })
  }
}));

import {PhantomChatMTProtoServer} from '@lib/phantomchat/virtual-mtproto-server';

describe('PhantomChatMTProtoServer.setTyping', () => {
  let server: any;
  let publishTypingGiftWrap: ReturnType<typeof vi.fn>;
  let publishGroupTypingGiftWrap: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    if(typeof localStorage !== 'undefined') localStorage.removeItem(READ_RECEIPTS_KEY);
    groupState.record = null;
    mockGetPubkey.mockResolvedValue(PEER_PUBKEY);

    publishTypingGiftWrap = vi.fn().mockResolvedValue(undefined);
    publishGroupTypingGiftWrap = vi.fn().mockResolvedValue(undefined);
    server = new PhantomChatMTProtoServer();
    server.setOwnPubkey(OWN_PUBKEY);
    server.setChatAPI({publishTypingGiftWrap, publishGroupTypingGiftWrap});
  });

  afterEach(() => {
    if(typeof localStorage !== 'undefined') localStorage.removeItem(READ_RECEIPTS_KEY);
  });

  it('publishes a gift-wrapped typing tick for a 1:1 typing action', async() => {
    const result = await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });

    expect(result).toBe(true);
    expect(publishTypingGiftWrap).toHaveBeenCalledTimes(1);
    const [recipientHex, content, conversationId] = publishTypingGiftWrap.mock.calls[0];
    expect(recipientHex).toBe(PEER_PUBKEY);
    expect(content).toBe('');
    expect(conversationId).toBe(PEER_PUBKEY);
  });

  it('maps record-audio action to the "recording" content marker', async() => {
    await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageRecordAudioAction'}
    });
    expect(publishTypingGiftWrap.mock.calls[0][1]).toBe('recording');
  });

  it('maps cancel action to the "stop" content marker', async() => {
    await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageCancelAction'}
    });
    expect(publishTypingGiftWrap.mock.calls[0][1]).toBe('stop');
  });

  it('does NOT publish for non-relayed actions (e.g. upload progress)', async() => {
    const result = await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageUploadDocumentAction', progress: 42}
    });
    expect(result).toBe(true);
    expect(publishTypingGiftWrap).not.toHaveBeenCalled();
  });

  it('suppresses emission when read receipts are OFF (WhatsApp coupling)', async() => {
    localStorage.setItem(READ_RECEIPTS_KEY, 'false');
    const result = await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(result).toBe(true);
    expect(publishTypingGiftWrap).not.toHaveBeenCalled();
  });

  it('still emits when read receipts are explicitly ON', async() => {
    localStorage.setItem(READ_RECEIPTS_KEY, 'true');
    await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(publishTypingGiftWrap).toHaveBeenCalledTimes(1);
  });

  it('returns true (never throws) when chatAPI is not wired', async() => {
    const bare = new PhantomChatMTProtoServer();
    bare.setOwnPubkey(OWN_PUBKEY);
    const result = await bare.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(result).toBe(true);
  });

  it('group tick gift-wraps for each member (excluding self)', async() => {
    groupState.record = {groupId: 'abc123groupid', members: [OWN_PUBKEY, MEMBER_A, MEMBER_B]};

    await server.handleMethod('messages.setTyping', {
      peer: {chat_id: Math.abs(GROUP_PEER_ID)},
      action: {_: 'sendMessageTypingAction'}
    });

    expect(publishGroupTypingGiftWrap).toHaveBeenCalledTimes(1);
    const [members, content, groupId] = publishGroupTypingGiftWrap.mock.calls[0];
    expect(members).toContainEqual(MEMBER_A);
    expect(members).toContainEqual(MEMBER_B);
    expect(members).not.toContainEqual(OWN_PUBKEY);
    expect(content).toBe('');
    expect(groupId).toBe('abc123groupid');
  });

  it('group tick with no other members publishes nothing', async() => {
    groupState.record = {groupId: 'solo', members: [OWN_PUBKEY]};
    const result = await server.handleMethod('messages.setTyping', {
      peer: {chat_id: Math.abs(GROUP_PEER_ID)},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(result).toBe(true);
    expect(publishGroupTypingGiftWrap).not.toHaveBeenCalled();
  });
});
