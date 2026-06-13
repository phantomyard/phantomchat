/**
 * WU-2 — applyGroupReaction store effect.
 *
 * Mirrors applyGroupEdit: resolve the reacted-to message by its rumor id
 * (eventId), then persist a row to nostraReactionsStore keyed to the local
 * mid + the group peerId, and dispatch nostra_reactions_changed so the
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
  const actual = await vi.importActual<any>('@lib/nostra/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
}
function rootScopeMock() {
  return {default: {dispatchEventSingle: mockDispatchSingle, dispatchEvent: vi.fn(), addEventListener: vi.fn()}};
}

vi.mock('@lib/nostra/message-store', messageStoreMock);
vi.mock('@lib/nostra/group-types', groupTypesMock);
vi.mock('@lib/rootScope', rootScopeMock);

let applyGroupReaction: any;
let nostraReactionsStore: any;

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@lib/nostra/message-store', messageStoreMock);
  vi.doMock('@lib/nostra/group-types', groupTypesMock);
  vi.doMock('@lib/rootScope', rootScopeMock);
  applyGroupReaction = (await import('@lib/nostra/nostra-groups-sync')).applyGroupReaction;
  nostraReactionsStore = (await import('@lib/nostra/nostra-reactions-store')).nostraReactionsStore;
});

const GID = 'abc123def456abc123def456abc123de00';
const EVENT = 'ab'.repeat(32);
const PUB = 'cd'.repeat(32);
const GROUP_PEER = -2000000000000001;

describe('applyGroupReaction (WU-2)', () => {
  beforeEach(async() => {
    vi.clearAllMocks();
    await nostraReactionsStore.destroy().catch(() => {});
  });

  it('adds a reaction row + dispatches nostra_reactions_changed when the target exists', async() => {
    mockGetByEventId.mockResolvedValue({mid: 555, conversationId: `group:${GID}`, senderPubkey: 'someone', eventId: EVENT});

    await applyGroupReaction(GID, EVENT, '👍', PUB, 1700000100);

    const rows = await nostraReactionsStore.getByTarget(EVENT);
    expect(rows.length).toBe(1);
    expect(rows[0].emoji).toBe('👍');
    expect(rows[0].fromPubkey).toBe(PUB);
    expect(rows[0].targetMid).toBe(555);
    expect(rows[0].targetPeerId).toBe(GROUP_PEER);
    expect(mockDispatchSingle).toHaveBeenCalledWith('nostra_reactions_changed', {peerId: GROUP_PEER, mid: 555});
  });

  it('does nothing when the target event is not in the store', async() => {
    const missing = 'ee'.repeat(32);
    mockGetByEventId.mockResolvedValue(null);

    await applyGroupReaction(GID, missing, '👍', PUB, 1700000100);

    expect((await nostraReactionsStore.getByTarget(missing)).length).toBe(0);
    expect(mockDispatchSingle).not.toHaveBeenCalled();
  });

  it('rejects a target that belongs to a different conversation', async() => {
    const wrong = 'ff'.repeat(32);
    mockGetByEventId.mockResolvedValue({mid: 5, conversationId: 'group:OTHERGROUP', senderPubkey: 'x', eventId: wrong});

    await applyGroupReaction(GID, wrong, '👍', PUB, 1700000100);

    expect((await nostraReactionsStore.getByTarget(wrong)).length).toBe(0);
    expect(mockDispatchSingle).not.toHaveBeenCalled();
  });
});
