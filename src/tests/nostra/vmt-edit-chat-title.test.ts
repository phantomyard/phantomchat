/**
 * WU-1 #3 — Regression coverage for the VMT messages.editChatTitle branch.
 *
 * Before this fix, renaming a nostra group via the Edit-Chat tab called
 * `messages.editChatTitle`, which had no handler and fell through to
 * fallback() → matched '.set'? no — it matched no action pattern and
 * returned {pFlags:{}} (success-shaped). Net effect: the dialog closed as
 * if the rename succeeded, but the new name was silently discarded and
 * never reached the other members. The producer GroupAPI.renameGroup
 * already existed; this wires the live UI method to it.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_PEER_ID = -5000000000000001; // isGroupPeer: |id| >= 2e15
const GROUP_ID = 'abcdef12'.repeat(8);
const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const CHAT_ID = Math.abs(GROUP_PEER_ID); // what messages.editChatTitle receives

const mockRenameGroup = vi.hoisted(() => vi.fn());
const mockGetByPeerId = vi.hoisted(() => vi.fn());

vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => ({
    getAllConversationIds: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
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
  getGroupStore: () => ({getByPeerId: mockGetByPeerId, getAll: vi.fn().mockResolvedValue([])})
}));

vi.mock('@lib/nostra/group-api', () => ({
  getGroupAPI: () => ({renameGroup: mockRenameGroup})
}));

vi.mock('@lib/nostra/nostra-peer-mapper', () => ({
  NostraPeerMapper: class {
    mapEventId = vi.fn();
    mapPubkey = vi.fn();
    createTwebMessage = vi.fn();
    createTwebDialog = vi.fn();
    createTwebChat = vi.fn();
  }
}));

describe('VirtualMTProtoServer — messages.editChatTitle (group rename)', () => {
  let VirtualMTProtoServer: any;

  beforeEach(async() => {
    vi.resetModules();
    mockRenameGroup.mockReset();
    mockGetByPeerId.mockReset();

    vi.doMock('@lib/nostra/group-store', () => ({
      getGroupStore: () => ({getByPeerId: mockGetByPeerId, getAll: vi.fn().mockResolvedValue([])})
    }));
    vi.doMock('@lib/nostra/group-api', () => ({
      getGroupAPI: () => ({renameGroup: mockRenameGroup})
    }));
    vi.doMock('@lib/nostra/nostra-peer-mapper', () => ({
      NostraPeerMapper: class {
        mapEventId = vi.fn();
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
    (server as any).chatAPI = {getActivePeer: (): null => null, connect: vi.fn()};
    (server as any).ownPubkey = OWN_PUBKEY;
    return server;
  }

  it('routes editChatTitle on a group peer to GroupAPI.renameGroup', async() => {
    mockGetByPeerId.mockResolvedValue({
      groupId: GROUP_ID, peerId: GROUP_PEER_ID, name: 'Old Name',
      adminPubkey: OWN_PUBKEY, members: [OWN_PUBKEY], createdAt: 0, updatedAt: 0
    });

    const server = buildServer();
    const result = await server.handleMethod('messages.editChatTitle', {chat_id: CHAT_ID, title: 'New Name'});

    expect(mockGetByPeerId).toHaveBeenCalledWith(GROUP_PEER_ID);
    expect(mockRenameGroup).toHaveBeenCalledWith(GROUP_ID, 'New Name');
    expect(result._).toBe('updates');
  });

  it('trims the title before renaming', async() => {
    mockGetByPeerId.mockResolvedValue({groupId: GROUP_ID, peerId: GROUP_PEER_ID, name: 'x', adminPubkey: OWN_PUBKEY, members: [], createdAt: 0, updatedAt: 0});

    const server = buildServer();
    await server.handleMethod('messages.editChatTitle', {chat_id: CHAT_ID, title: '  Trimmed  '});

    expect(mockRenameGroup).toHaveBeenCalledWith(GROUP_ID, 'Trimmed');
  });

  it('does not rename when no group record matches the peerId', async() => {
    mockGetByPeerId.mockResolvedValue(null);

    const server = buildServer();
    await server.handleMethod('messages.editChatTitle', {chat_id: CHAT_ID, title: 'New Name'});

    expect(mockRenameGroup).not.toHaveBeenCalled();
  });

  it('ignores an empty/whitespace title', async() => {
    mockGetByPeerId.mockResolvedValue({groupId: GROUP_ID, peerId: GROUP_PEER_ID, name: 'x', adminPubkey: OWN_PUBKEY, members: [], createdAt: 0, updatedAt: 0});

    const server = buildServer();
    await server.handleMethod('messages.editChatTitle', {chat_id: CHAT_ID, title: '   '});

    expect(mockRenameGroup).not.toHaveBeenCalled();
  });

  it('does not touch the group store for a non-group chat id', async() => {
    const server = buildServer();
    await server.handleMethod('messages.editChatTitle', {chat_id: 123, title: 'Whatever'});

    expect(mockGetByPeerId).not.toHaveBeenCalled();
    expect(mockRenameGroup).not.toHaveBeenCalled();
  });
});
