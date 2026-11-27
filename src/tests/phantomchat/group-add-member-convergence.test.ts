import 'fake-indexeddb/auto';
import '../setup';
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord} from '@lib/phantomchat/group-types';

/**
 * Issue #503 — adding several members quickly lost most of them.
 *
 * Two defects on the same path:
 *  1. `handleAddMember` applied the event's `memberPubkeys` as a wholesale
 *     replace, and our own add echoes come back to us, so the echo of add #1
 *     (carrying the shorter snapshot) landed after add #2 and dropped it.
 *  2. `addMember` is a read-modify-write with no serialization, so two adds
 *     in flight read the same base and the second write dropped the first.
 *
 * The fix is a union on the add path plus a per-group mutation chain; these
 * tests are the regression guards for both, and for the removal path that
 * must still shrink.
 */

const mockStore = vi.hoisted(() => ({
  save: vi.fn(), get: vi.fn(), getByPeerId: vi.fn(), getAll: vi.fn(),
  delete: vi.fn(), updateMembers: vi.fn(), updateInfo: vi.fn(), destroy: vi.fn(),
  recordDeletedGroup: vi.fn(), listDeletedGroups: vi.fn(), clearDeletedGroup: vi.fn()
}));
const mockBroadcast = vi.hoisted(() => vi.fn().mockReturnValue([{id: 'c', kind: 1059}]));

vi.mock('@lib/phantomchat/group-store', () => ({
  GroupStore: vi.fn(() => mockStore), getGroupStore: () => mockStore
}));
vi.mock('@lib/phantomchat/nostr-crypto', () => ({
  wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
  createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
  createSeal: vi.fn(), createGiftWrap: vi.fn(),
  wrapNip17Message: vi.fn(), unwrapNip17Message: vi.fn(), wrapNip17Receipt: vi.fn()
}));
vi.mock('@lib/phantomchat/group-control-messages', () => ({
  isControlEvent: (r: any) => Array.isArray(r?.tags) && r.tags.some((t: string[]) => t[0] === 'control'),
  getGroupIdFromRumor: (r: any) => r?.tags?.find((t: string[]) => t[0] === 'group')?.[1] ?? null,
  broadcastGroupControl: (...a: any[]) => mockBroadcast(...a),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));
vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<any>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
});
vi.mock('@lib/rootScope', () => ({default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}}));
vi.mock('@lib/logger', () => ({Logger: class {}, logger: () => Object.assign(() => {}, {warn: vi.fn(), error: vi.fn()})}));

let GroupAPI: any;
beforeAll(async() => {
  vi.resetModules();
  GroupAPI = (await import('@lib/phantomchat/group-api')).GroupAPI;
});

const OWN = 'd'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'e'.repeat(64);
const E = 'f'.repeat(64);
const GROUP_ID = 'abc123def456abc123def456abc123de';

/** Build the control rumor the relay would deliver for one of our own adds. */
function controlRumor(id: string, payload: unknown) {
  return {
    id, kind: 14, content: JSON.stringify(payload), pubkey: OWN,
    created_at: Math.floor(Date.now() / 1000) - 1,
    tags: [['control', 'true'], ['group', GROUP_ID]]
  };
}

describe('group membership convergence (#503)', () => {
  let api: any;
  let live: GroupRecord | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // #505 reset: the anti-resurrection ledger persists per group in
    // localStorage like the event watermarks; a remove stamped in an earlier
    // test must not block this test's adds, which are all dated "now-ish".
    localStorage.removeItem('phantomchat:group-member-removals:' + GROUP_ID);
    live = {
      groupId: GROUP_ID, name: 'G', adminPubkey: OWN, members: [A, B, OWN],
      peerId: -2000000000000001, createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord;
    mockStore.get.mockImplementation(async() => live);
    mockStore.save.mockImplementation(async(g: GroupRecord) => { live = g; });
    mockStore.updateMembers.mockImplementation(async(_id: string, members: string[]) => {
      live = {...live!, members: [...members]};
    });
    mockStore.recordDeletedGroup.mockResolvedValue(undefined);
    mockStore.listDeletedGroups.mockResolvedValue([]);
    mockBroadcast.mockReturnValue([{id: 'ctrl', kind: 1059}]);
    api = new GroupAPI(OWN, new Uint8Array(32).fill(1), async() => {});
  });

  it('an echoed add published before a later add does not drop the later member', async() => {
    await api.addMember(GROUP_ID, C);
    const addCPayload = mockBroadcast.mock.calls[1][2];
    await api.addMember(GROUP_ID, D);
    expect(live!.members).toEqual(expect.arrayContaining([C, D]));

    // Relay delivers our own earlier add echo AFTER the newer add applied.
    await api.handleControlMessage(controlRumor('echo-c', addCPayload), OWN);

    expect(live!.members).toEqual(expect.arrayContaining([A, B, C, D]));
  });

  it('two adds in flight at once both land (no read-modify-write loss)', async() => {
    await Promise.all([api.addMember(GROUP_ID, C), api.addMember(GROUP_ID, D)]);
    expect(live!.members).toEqual(expect.arrayContaining([C, D]));
  });

  it('five rapid adds followed by their echoes keep every member', async() => {
    const added = [C, D, E];
    for(const pk of added) await api.addMember(GROUP_ID, pk);
    for(const pk of added) {
      const payload = mockBroadcast.mock.calls.find(c => c[2]?.targetPubkey === pk)?.[2];
      await api.handleControlMessage(controlRumor('echo-' + pk, payload), OWN);
    }
    expect(live!.members).toEqual(expect.arrayContaining([A, B, OWN, ...added]));
  });

  it('an add event never shrinks the list, however stale it is', async() => {
    await api.addMember(GROUP_ID, C);
    await api.addMember(GROUP_ID, D);
    // A stale snapshot that predates D entirely.
    await api.handleControlMessage(controlRumor('stale', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    }), OWN);
    expect(live!.members).toEqual(expect.arrayContaining([C, D]));
  });

  it('a no-op add echo does not touch the record (no LWW stamp bump)', async() => {
    await api.addMember(GROUP_ID, C);
    const before = live!.updatedAt;
    mockStore.updateMembers.mockClear();
    await api.handleControlMessage(controlRumor('echo-c', mockBroadcast.mock.calls[1][2]), OWN);
    expect(mockStore.updateMembers).not.toHaveBeenCalled();
    expect(live!.updatedAt).toBe(before);
  });

  it('removal still shrinks — the union applies to adds only', async() => {
    await api.addMember(GROUP_ID, C);
    await api.removeMember(GROUP_ID, C);
    expect(live!.members).not.toContain(C);

    await api.addMember(GROUP_ID, D);
    await api.handleControlMessage(controlRumor('rm-d', {
      type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: D
    }), OWN);
    expect(live!.members).not.toContain(D);
  });

  it('an add that beats its group_create is retried once the record exists', async() => {
    const payload = {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    };
    live = undefined;
    mockStore.get.mockImplementation(async() => live);
    await api.handleControlMessage(controlRumor('early', payload), OWN);
    expect(mockStore.updateMembers).not.toHaveBeenCalled();

    // The create lands; the relay redelivers the add.
    live = {
      groupId: GROUP_ID, name: 'G', adminPubkey: OWN, members: [A, B, OWN],
      peerId: -2000000000000001, createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord;
    await api.handleControlMessage(controlRumor('early', payload), OWN);
    expect(live!.members).toContain(C);
  });

  it('malformed member entries are ignored rather than persisted', async() => {
    await api.handleControlMessage(controlRumor('junk', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C, '', null, undefined], groupName: 'G'
    }), OWN);
    expect(live!.members).toEqual(expect.arrayContaining([A, B, OWN, C]));
    expect(live!.members.every(pk => typeof pk === 'string' && pk.length > 0)).toBe(true);
  });
});
