/**
 * WU-2 — Group reactions multi-member: control-channel wiring.
 *
 * Before this fix, group reactions went through the 1:1 kind-7 path
 * (nostra-reactions-publish), which p-tags only the reacted-to author.
 * getPubkey(groupPeerId) is null (group peerId is a hash, not a mapped
 * user), so other members never received the reaction. This routes group
 * reactions through broadcastGroupControl (N gift-wraps to all members),
 * mirroring the proven group_edit_message path.
 *
 * This file covers the WIRING: the producer broadcasts a group_reaction
 * payload + applies locally, and the receiver routes group_reaction control
 * messages to applyGroupReaction. The store mutation itself is covered in
 * group-reactions-apply.test.ts.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord} from '@lib/nostra/group-types';

const mockApplyGroupReaction = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGroupStore = vi.hoisted(() => ({
  save: vi.fn(), get: vi.fn(), getByPeerId: vi.fn(), getAll: vi.fn(),
  delete: vi.fn(), updateMembers: vi.fn(), updateInfo: vi.fn(), destroy: vi.fn()
}));
const mockBroadcast = vi.hoisted(() => vi.fn().mockReturnValue([{id: 'c', kind: 1059}]));

function syncMock() {
  return {
    handleGroupIncoming: vi.fn(), handleGroupOutgoing: vi.fn(), applyGroupEdit: vi.fn(),
    applyGroupReaction: mockApplyGroupReaction, cleanupGroupChatInjection: vi.fn(),
    ensureGroupChatInjected: vi.fn(), injectGroupCreateDialog: vi.fn()
  };
}
function storeMock() {
  return {GroupStore: vi.fn(() => mockGroupStore), getGroupStore: () => mockGroupStore};
}
function cryptoMock() {
  return {
    wrapGroupMessage: vi.fn(), createRumor: vi.fn(), createSeal: vi.fn(), createGiftWrap: vi.fn(),
    wrapNip17Message: vi.fn(), unwrapNip17Message: vi.fn(), wrapNip17Receipt: vi.fn()
  };
}
function controlMock() {
  return {
    isControlEvent: () => false, getGroupIdFromRumor: (): string | null => null,
    broadcastGroupControl: (...args: any[]): any => mockBroadcast(...args),
    wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
  };
}
function loggerMock() {
  return {Logger: class {}, logger: () => Object.assign((..._a: any[]) => {}, {warn: vi.fn(), error: vi.fn()})};
}

vi.mock('@lib/nostra/group-store', storeMock);
vi.mock('@lib/nostra/nostr-crypto', cryptoMock);
vi.mock('@lib/nostra/group-control-messages', controlMock);
vi.mock('@lib/nostra/nostra-groups-sync', syncMock);
vi.mock('@lib/rootScope', () => ({default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}}));
vi.mock('@lib/logger', loggerMock);

let GroupAPI: any;
beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@lib/nostra/group-store', storeMock);
  vi.doMock('@lib/nostra/nostr-crypto', cryptoMock);
  vi.doMock('@lib/nostra/group-control-messages', controlMock);
  vi.doMock('@lib/nostra/nostra-groups-sync', syncMock);
  vi.doMock('@lib/rootScope', () => ({default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}}));
  vi.doMock('@lib/logger', loggerMock);
  GroupAPI = (await import('@lib/nostra/group-api')).GroupAPI;
});

const OWN_PUBKEY = 'ownpub00000000000000000000000000000000000000000000000000000000ab';
const OWN_SK = new Uint8Array(32).fill(1);
const MEMBER_A = 'membera0000000000000000000000000000000000000000000000000000001';
const MEMBER_B = 'memberb0000000000000000000000000000000000000000000000000000002';
const GROUP_ID = 'abc123def456abc123def456abc123de00';
const RUMOR_ID = 'ab'.repeat(32);

function makeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: GROUP_ID, name: 'Test Group', adminPubkey: OWN_PUBKEY,
    members: [MEMBER_A, MEMBER_B, OWN_PUBKEY], peerId: -2000000000000001,
    createdAt: 1, updatedAt: 1, ...overrides
  };
}

describe('Group reactions — control wiring (WU-2)', () => {
  let api: any;
  let published: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    published = [];
    mockGroupStore.get.mockResolvedValue(makeGroup());
    mockBroadcast.mockReturnValue([{id: 'ctrl', kind: 1059}]);
    mockApplyGroupReaction.mockResolvedValue(undefined);
    api = new GroupAPI(OWN_PUBKEY, OWN_SK, async(e: any[]) => { published.push(...e); });
  });

  it('reactToMessage applies locally and broadcasts a group_reaction payload to other members', async() => {
    await api.reactToMessage(GROUP_ID, RUMOR_ID, '👍');

    expect(mockApplyGroupReaction).toHaveBeenCalledWith(GROUP_ID, RUMOR_ID, '👍', OWN_PUBKEY, expect.any(Number));
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const [, recipients, payload] = mockBroadcast.mock.calls[0];
    expect(payload.type).toBe('group_reaction');
    expect(payload.targetEventId).toBe(RUMOR_ID);
    expect(payload.emoji).toBe('👍');
    expect(recipients).toContain(MEMBER_A);
    expect(recipients).toContain(MEMBER_B);
    expect(recipients).not.toContain(OWN_PUBKEY);
    expect(published.length).toBeGreaterThan(0);
  });

  it('handleControlMessage routes group_reaction to applyGroupReaction with the sender pubkey', async() => {
    const rumor = {content: JSON.stringify({
      type: 'group_reaction', groupId: GROUP_ID, targetEventId: RUMOR_ID, emoji: '❤️', createdAt: 1700000123
    })};
    await api.handleControlMessage(rumor, MEMBER_A);

    expect(mockApplyGroupReaction).toHaveBeenCalledWith(GROUP_ID, RUMOR_ID, '❤️', MEMBER_A, 1700000123);
  });

  it('ignores a group_reaction control with a missing emoji', async() => {
    const rumor = {content: JSON.stringify({type: 'group_reaction', groupId: GROUP_ID, targetEventId: RUMOR_ID})};
    await api.handleControlMessage(rumor, MEMBER_A);

    expect(mockApplyGroupReaction).not.toHaveBeenCalled();
  });
});
