/**
 * WU-2 — applyGroupReaction store effect.
 *
 * Mirrors applyGroupEdit: resolve the reacted-to message by its rumor id
 * (eventId), then persist a row to phantomchatReactionsStore keyed to the local
 * mid + the group peerId, and dispatch phantomchat_reactions_changed so the
 * bubble re-renders. Uses the real reactions store (fake-indexeddb) with a
 * mocked message-store + groupIdToPeerId.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';

const mockGetByEventId = vi.hoisted(() => vi.fn());
const mockDispatchSingle = vi.hoisted(() => vi.fn());

function messageStoreMock() {
  return {getMessageStore: () => ({getByEventId: mockGetByEventId})};
}
async function groupTypesMock() {
  const actual = await vi.importActual<any>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
}
function rootScopeMock() {
  return {default: {dispatchEventSingle: mockDispatchSingle, dispatchEvent: vi.fn(), addEventListener: vi.fn()}};
}

vi.mock('@lib/phantomchat/message-store', messageStoreMock);
vi.mock('@lib/phantomchat/group-types', groupTypesMock);
vi.mock('@lib/rootScope', rootScopeMock);

let applyGroupReaction: any;
let phantomchatReactionsStore: any;

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@lib/phantomchat/message-store', messageStoreMock);
  vi.doMock('@lib/phantomchat/group-types', groupTypesMock);
  vi.doMock('@lib/rootScope', rootScopeMock);
  applyGroupReaction = (await import('@lib/phantomchat/phantomchat-groups-sync')).applyGroupReaction;
  phantomchatReactionsStore = (await import('@lib/phantomchat/phantomchat-reactions-store')).phantomchatReactionsStore;
});

const GID = 'abc123def456abc123def456abc123de00';
const EVENT = 'ab'.repeat(32);
const PUB = 'cd'.repeat(32);
const GROUP_PEER = -2000000000000001;

describe('applyGroupReaction (WU-2)', () => {
  beforeEach(async() => {
    vi.clearAllMocks();
    await phantomchatReactionsStore.destroy().catch(() => {});
  });

  it('adds a reaction row + dispatches phantomchat_reactions_changed when the target exists', async() => {
    mockGetByEventId.mockResolvedValue({mid: 555, conversationId: `group:${GID}`, senderPubkey: 'someone', eventId: EVENT});

    await applyGroupReaction(GID, EVENT, '👍', PUB, 1700000100);

    const rows = await phantomchatReactionsStore.getByTarget(EVENT);
    expect(rows.length).toBe(1);
    expect(rows[0].emoji).toBe('👍');
    expect(rows[0].fromPubkey).toBe(PUB);
    expect(rows[0].targetMid).toBe(555);
    expect(rows[0].targetPeerId).toBe(GROUP_PEER);
    expect(mockDispatchSingle).toHaveBeenCalledWith('phantomchat_reactions_changed', {peerId: GROUP_PEER, mid: 555});
  });

  it('does nothing when the target event is not in the store', async() => {
    const missing = 'ee'.repeat(32);
    mockGetByEventId.mockResolvedValue(null);

    await applyGroupReaction(GID, missing, '👍', PUB, 1700000100);

    expect((await phantomchatReactionsStore.getByTarget(missing)).length).toBe(0);
    expect(mockDispatchSingle).not.toHaveBeenCalled();
  });

  it('rejects a target that belongs to a different conversation', async() => {
    const wrong = 'ff'.repeat(32);
    mockGetByEventId.mockResolvedValue({mid: 5, conversationId: 'group:OTHERGROUP', senderPubkey: 'x', eventId: wrong});

    await applyGroupReaction(GID, wrong, '👍', PUB, 1700000100);

    expect((await phantomchatReactionsStore.getByTarget(wrong)).length).toBe(0);
    expect(mockDispatchSingle).not.toHaveBeenCalled();
  });
});
