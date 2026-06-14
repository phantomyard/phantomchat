/**
 * Regression coverage for the group "resurrection" bug.
 *
 * Symptom reported: deleted groups kept coming back as broken duplicates
 * ("not a member of group <id>"). Root cause: getGroupHistory's orphan-recovery
 * scan rebuilt a group record from leftover 'group:<id>' messages whenever the
 * store record was missing — including for groups the user had deliberately
 * deleted. The fix writes a deletion tombstone on leave (covered in
 * group-management.test.ts) AND makes getGroupHistory refuse to rebuild a
 * tombstoned conversation, purging its orphan messages instead.
 *
 * This file asserts the read-side guard: a tombstoned group is NOT resurrected.
 */

import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_PEER_ID = -6000000000000001;
const GROUP_ID = 'cafebabe'.repeat(8);
const CONV_ID = `group:${GROUP_ID}`;
const OWN_PUBKEY = '99'.repeat(32);

const mockGetByPeerId = vi.hoisted(() => vi.fn());
const mockGetAllConversationIds = vi.hoisted(() => vi.fn());
const mockGetTombstone = vi.hoisted(() => vi.fn());
const mockDeleteMessages = vi.hoisted(() => vi.fn());
const mockGetMessages = vi.hoisted(() => vi.fn());
const mockGroupSave = vi.hoisted(() => vi.fn());
const mockG2p = vi.hoisted(() => vi.fn());

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({
    getAllConversationIds: mockGetAllConversationIds,
    getTombstone: mockGetTombstone,
    deleteMessages: mockDeleteMessages,
    getMessages: mockGetMessages,
    getConversationId: (a: string, b: string) => [a, b].sort().join(':')
  })
}));

vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    getByPeerId: mockGetByPeerId,
    save: mockGroupSave,
    getAll: vi.fn().mockResolvedValue([])
  })
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: mockG2p};
});

describe('getGroupHistory — resurrection guard', () => {
  let VirtualMTProtoServer: any;

  beforeEach(async() => {
    vi.resetModules();
    [mockGetByPeerId, mockGetAllConversationIds, mockGetTombstone,
      mockDeleteMessages, mockGetMessages, mockGroupSave, mockG2p].forEach((m) => m.mockReset());

    vi.doMock('@lib/phantomchat/message-store', () => ({
      getMessageStore: () => ({
        getAllConversationIds: mockGetAllConversationIds,
        getTombstone: mockGetTombstone,
        deleteMessages: mockDeleteMessages,
        getMessages: mockGetMessages,
        getConversationId: (a: string, b: string) => [a, b].sort().join(':')
      })
    }));
    vi.doMock('@lib/phantomchat/group-store', () => ({
      getGroupStore: () => ({
        getByPeerId: mockGetByPeerId,
        save: mockGroupSave,
        getAll: vi.fn().mockResolvedValue([])
      })
    }));
    vi.doMock('@lib/phantomchat/group-types', async() => {
      const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
      return {...actual, groupIdToPeerId: mockG2p};
    });

    const mod = await import('@lib/phantomchat/virtual-mtproto-server');
    VirtualMTProtoServer = (mod as any).PhantomChatMTProtoServer;
  });

  function buildServer() {
    const server = new VirtualMTProtoServer();
    (server as any).ownPubkey = OWN_PUBKEY;
    return server;
  }

  it('does NOT rebuild a tombstoned group and purges its orphan messages', async() => {
    mockGetByPeerId.mockResolvedValue(null);            // store record gone
    mockGetAllConversationIds.mockResolvedValue([CONV_ID]);
    mockG2p.mockResolvedValue(GROUP_PEER_ID);           // convId maps to this peer
    mockGetTombstone.mockResolvedValue(1_700_000_000);  // deleted (watermark set)

    const server = buildServer();
    const result = await (server as any).getGroupHistory(GROUP_PEER_ID, {limit: 50});

    // Guard fired: orphan messages purged, group NOT resurrected, empty result.
    expect(mockDeleteMessages).toHaveBeenCalledWith(CONV_ID);
    expect(mockGroupSave).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();     // never scanned to rebuild
    expect(result._).toBe('messages.messages');
    expect(result.messages).toEqual([]);
  });

  it('DOES rebuild an orphan group when there is no tombstone (self-heal preserved)', async() => {
    mockGetByPeerId.mockResolvedValue(null);
    mockGetAllConversationIds.mockResolvedValue([CONV_ID]);
    mockG2p.mockResolvedValue(GROUP_PEER_ID);
    mockGetTombstone.mockResolvedValue(0);              // never deleted
    mockGetMessages.mockResolvedValue([
      {eventId: 'e1', conversationId: CONV_ID, senderPubkey: 'aa'.repeat(32), content: 'hi', timestamp: 1_699_000_000, mid: 1, type: 'text', deliveryState: 'delivered'}
    ]);
    mockGroupSave.mockResolvedValue(undefined);

    const server = buildServer();
    await (server as any).getGroupHistory(GROUP_PEER_ID, {limit: 50});

    // Self-heal path still works: group rebuilt + persisted, no purge.
    expect(mockGroupSave).toHaveBeenCalledTimes(1);
    expect(mockDeleteMessages).not.toHaveBeenCalled();
  });
});
