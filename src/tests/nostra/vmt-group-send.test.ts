/**
 * Regression coverage for the VMT group-send branch.
 *
 * Before this fix, `VirtualMTProtoServer.sendMessage` short-circuited on
 * `getPubkey(Math.abs(peerId)) === null` for group peerIds (no user-side
 * mapping), returning `emptyUpdates`. Result: messages typed in a group
 * chat were silently dropped — both on the wire and in the UI — matching
 * the symptom reported ("non risulta possibile scriverci dentro").
 *
 * With `isGroupPeer(peerId)` routing, VMT now delegates to
 * `GroupAPI.sendMessage` (which publishes + renders optimistically) and
 * returns an `updates`-shaped response carrying `nostraMid` +
 * `nostraEventId` so the Worker's post-send shortcut renames the temp
 * mid to the real mapped mid and dispatches `message_sent` for ⏳→✓.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_PEER_ID = -5000000000000001;
const GROUP_ID = 'abcdef12'.repeat(8);
const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const RUMOR_ID = 'feedface'.repeat(8);
const MID = 1700000000000001;

const mockGroupSendMessage = vi.hoisted(() => vi.fn());
const mockGetByPeerId = vi.hoisted(() => vi.fn());
const mockMapEventId = vi.hoisted(() => vi.fn());

vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => ({
    getAllConversationIds: vi.fn(),
    getMessages: vi.fn(),
    getConversationId: (a: string, b: string) => [a, b].sort().join(':'),
    saveMessage: vi.fn()
  })
}));

vi.mock('@lib/nostra/virtual-peers-db', () => ({
  getPubkey: vi.fn().mockResolvedValue(null),
  getMapping: vi.fn()
}));

vi.mock('@lib/nostra/peer-profile-cache', () => ({
  loadCachedPeerProfile: vi.fn().mockReturnValue(null),
  refreshPeerProfileFromRelays: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@lib/nostra/group-store', () => ({
  getGroupStore: () => ({
    getByPeerId: mockGetByPeerId,
    getAll: vi.fn().mockResolvedValue([])
  })
}));

vi.mock('@lib/nostra/group-api', () => ({
  getGroupAPI: () => ({
    sendMessage: mockGroupSendMessage
  })
}));

vi.mock('@lib/nostra/nostra-peer-mapper', () => ({
  NostraPeerMapper: class {
    mapEventId = mockMapEventId;
    mapPubkey = vi.fn();
    createTwebMessage = vi.fn();
    createTwebDialog = vi.fn();
    createTwebChat = vi.fn();
  }
}));

describe('VirtualMTProtoServer.sendMessage — group branch', () => {
  let VirtualMTProtoServer: any;

  beforeEach(async() => {
    vi.resetModules();
    mockGroupSendMessage.mockReset();
    mockGetByPeerId.mockReset();
    mockMapEventId.mockReset();

    vi.doMock('@lib/nostra/group-store', () => ({
      getGroupStore: () => ({
        getByPeerId: mockGetByPeerId,
        getAll: vi.fn().mockResolvedValue([])
      })
    }));
    vi.doMock('@lib/nostra/group-api', () => ({
      getGroupAPI: () => ({sendMessage: mockGroupSendMessage})
    }));
    vi.doMock('@lib/nostra/nostra-peer-mapper', () => ({
      NostraPeerMapper: class {
        mapEventId = mockMapEventId;
        mapPubkey = vi.fn();
        createTwebMessage = vi.fn();
        createTwebDialog = vi.fn();
        createTwebChat = vi.fn();
      }
    }));

    const mod = await import('@lib/nostra/virtual-mtproto-server');
    VirtualMTProtoServer = (mod as any).NostraMTProtoServer;
  });

  function buildServer() {
    const server = new VirtualMTProtoServer();
    // setChatAPI / setOwnPubkey in prod init the server; tests set the
    // fields directly via a minimal reflection gate.
    (server as any).chatAPI = {getActivePeer: (): null => null, connect: vi.fn()};
    (server as any).ownPubkey = OWN_PUBKEY;
    return server;
  }

  it('delegates to GroupAPI.sendMessage and returns nostraMid/nostraEventId', async() => {
    mockGetByPeerId.mockResolvedValue({
      groupId: GROUP_ID,
      peerId: GROUP_PEER_ID,
      name: 'Team',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY, 'a'.repeat(64)],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    mockGroupSendMessage.mockResolvedValue({
      messageId: 'grp-123-abc',
      rumorId: RUMOR_ID,
      timestampMs: 1700000000000
    });
    mockMapEventId.mockResolvedValue(MID);

    const server = buildServer();
    const params = {
      peer: {_: 'peerChat', chat_id: Math.abs(GROUP_PEER_ID)},
      message: 'Ciao gruppo!'
    };

    const result = await (server as any).sendMessage(params);

    expect(mockGetByPeerId).toHaveBeenCalledWith(GROUP_PEER_ID);
    expect(mockGroupSendMessage).toHaveBeenCalledWith(GROUP_ID, 'Ciao gruppo!', {replyToRumorId: undefined});
    expect(result._).toBe('updates');
    expect(result.nostraMid).toBe(MID);
    expect(result.nostraEventId).toBe(RUMOR_ID);
  });

  it('returns emptyUpdates when no group record matches the peerId', async() => {
    mockGetByPeerId.mockResolvedValue(null);

    const server = buildServer();
    const params = {
      peer: {_: 'peerChat', chat_id: Math.abs(GROUP_PEER_ID)},
      message: 'orphan'
    };

    const result = await (server as any).sendMessage(params);

    expect(mockGroupSendMessage).not.toHaveBeenCalled();
    expect(result._).toBe('updates');
    expect(result.nostraMid).toBeUndefined();
    expect(result.nostraEventId).toBeUndefined();
    expect(result.updates).toEqual([]);
  });

  it('returns emptyUpdates when GroupAPI.sendMessage throws', async() => {
    mockGetByPeerId.mockResolvedValue({
      groupId: GROUP_ID,
      peerId: GROUP_PEER_ID,
      name: 'Team',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    mockGroupSendMessage.mockRejectedValue(new Error('relay down'));

    const server = buildServer();
    const params = {
      peer: {_: 'peerChat', chat_id: Math.abs(GROUP_PEER_ID)},
      message: 'will fail'
    };

    const result = await (server as any).sendMessage(params);

    expect(result._).toBe('updates');
    expect(result.nostraMid).toBeUndefined();
  });
});
