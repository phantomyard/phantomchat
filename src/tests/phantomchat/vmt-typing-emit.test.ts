/**
 * Tests for PhantomChatMTProtoServer.setTyping (messages.setTyping handler).
 *
 * Covers the emit side of issue #43: a typing / recording action from the UI is
 * translated into a kind-20001 (NIP-16 ephemeral) event and published over the
 * relay layer — gated, WhatsApp-style, on the read-receipts toggle.
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
  let publishEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    if(typeof localStorage !== 'undefined') localStorage.removeItem(READ_RECEIPTS_KEY);
    groupState.record = null;
    mockGetPubkey.mockResolvedValue(PEER_PUBKEY);

    publishEvent = vi.fn().mockResolvedValue(undefined);
    server = new PhantomChatMTProtoServer();
    server.setOwnPubkey(OWN_PUBKEY);
    server.setChatAPI({publishEvent});
  });

  afterEach(() => {
    if(typeof localStorage !== 'undefined') localStorage.removeItem(READ_RECEIPTS_KEY);
  });

  it('publishes a kind-30001 with empty content (start) for a 1:1 typing action', async() => {
    const result = await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });

    expect(result).toBe(true);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    const ev = publishEvent.mock.calls[0][0];
    expect(ev.kind).toBe(30001);
    expect(ev.content).toBe('');
    expect(ev.tags).toContainEqual(['d', PEER_PUBKEY]);
    expect(ev.tags).toContainEqual(['p', PEER_PUBKEY]);
    // Must have an expiration tag (~30s TTL)
    const expTag = ev.tags.find((t: string[]) => t[0] === 'expiration');
    expect(expTag).toBeDefined();
    const expTs = Number(expTag[1]);
    expect(expTs).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(expTs).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 31);
  });

  it('maps record-audio action to the "recording" content marker', async() => {
    await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageRecordAudioAction'}
    });
    expect(publishEvent.mock.calls[0][0].content).toBe('recording');
  });

  it('maps cancel action to the "stop" content marker', async() => {
    await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageCancelAction'}
    });
    expect(publishEvent.mock.calls[0][0].content).toBe('stop');
  });

  it('does NOT publish for non-relayed actions (e.g. upload progress)', async() => {
    const result = await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageUploadDocumentAction', progress: 42}
    });
    expect(result).toBe(true);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('suppresses emission when read receipts are OFF (WhatsApp coupling)', async() => {
    localStorage.setItem(READ_RECEIPTS_KEY, 'false');
    const result = await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(result).toBe(true);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('still emits when read receipts are explicitly ON', async() => {
    localStorage.setItem(READ_RECEIPTS_KEY, 'true');
    await server.handleMethod('messages.setTyping', {
      peer: {user_id: PEER_ID},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(publishEvent).toHaveBeenCalledTimes(1);
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

  it('group tick carries the d tag, group tag and p-tags other members (excluding self)', async() => {
    groupState.record = {groupId: 'abc123groupid', members: [OWN_PUBKEY, MEMBER_A, MEMBER_B]};

    await server.handleMethod('messages.setTyping', {
      peer: {chat_id: Math.abs(GROUP_PEER_ID)},
      action: {_: 'sendMessageTypingAction'}
    });

    expect(publishEvent).toHaveBeenCalledTimes(1);
    const ev = publishEvent.mock.calls[0][0];
    expect(ev.kind).toBe(30001);
    expect(ev.tags).toContainEqual(['d', 'abc123groupid']);
    expect(ev.tags).toContainEqual(['group', 'abc123groupid']);
    expect(ev.tags).toContainEqual(['p', MEMBER_A]);
    expect(ev.tags).toContainEqual(['p', MEMBER_B]);
    // Must have an expiration tag
    expect(ev.tags.some((t: string[]) => t[0] === 'expiration')).toBe(true);
    // Own pubkey must NOT be p-tagged.
    expect(ev.tags).not.toContainEqual(['p', OWN_PUBKEY]);
  });

  it('group tick with no other members publishes nothing', async() => {
    groupState.record = {groupId: 'solo', members: [OWN_PUBKEY]};
    const result = await server.handleMethod('messages.setTyping', {
      peer: {chat_id: Math.abs(GROUP_PEER_ID)},
      action: {_: 'sendMessageTypingAction'}
    });
    expect(result).toBe(true);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
