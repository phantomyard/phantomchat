import 'fake-indexeddb/auto';
import '../setup';
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord} from '@lib/phantomchat/group-types';

/**
 * Issue #505 — two membership holes left open after #503/#504:
 *  1. `handleAddMember` never checked who sent the event, so ANY member
 *     could push a member list and every client applied it.
 *  2. The add union made adds monotone, but a stale add landing inside the
 *     60 s watermark grace after a removal put the removed member back.
 *
 * Expected: only the group's admin may add; an add dated at or before a
 * member's latest removal cannot re-add them, while a genuine newer re-add
 * still lands. Removals and leaves still shrink; existing suites unchanged.
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
const GROUP_ID = 'a505a505a505a505a505a505a505a505';

/** Control rumor as the relay would deliver it, dated `tsSec`. */
function controlRumor(id: string, payload: unknown, tsSec: number, sender: string) {
  return {
    id, kind: 14, content: JSON.stringify(payload), pubkey: sender,
    created_at: tsSec,
    tags: [['control', 'true'], ['group', GROUP_ID]]
  };
}

describe('group membership authority and anti-resurrection (#505)', () => {
  let api: any;
  let live: GroupRecord | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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

  // ── 1. Authorisation: only the admin may push a member list ──────────

  it('an add from a plain member is ignored, not applied', async() => {
    mockStore.updateMembers.mockClear();
    await api.handleControlMessage(controlRumor('rogue', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    }, Math.floor(Date.now() / 1000), A), A);
    expect(mockStore.updateMembers).not.toHaveBeenCalled();
    expect(live!.members).not.toContain(C);
  });

  it('an add from the admin (another device) still applies', async() => {
    live = {...live!, adminPubkey: A, members: [A, B]} as GroupRecord;
    await api.handleControlMessage(controlRumor('legit', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, C], groupName: 'G'
    }, Math.floor(Date.now() / 1000), A), A);
    expect(live!.members).toEqual(expect.arrayContaining([A, B, C]));
  });

  // ── 2. A late add cannot resurrect a member removed moments ago ──────

  it('a stale add inside the grace window cannot re-add a removed member', async() => {
    const now = Math.floor(Date.now() / 1000);
    live = {...live!, members: [A, B, C, OWN]} as GroupRecord;
    // Admin removes C; the event applies and the removal is remembered.
    await api.handleControlMessage(controlRumor('rm', {
      type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: C
    }, now, OWN), OWN);
    expect(live!.members).not.toContain(C);

    // An add echo dated BEFORE the removal, delivered after it — inside
    // WATERMARK_GRACE_SEC so the event watermark gate lets it through.
    await api.handleControlMessage(controlRumor('stale-add', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    }, now - 5, OWN), OWN);

    expect(live!.members).not.toContain(C);
  });

  it('an add carrying the removed member in its list snapshot cannot resurrect them either', async() => {
    const now = Math.floor(Date.now() / 1000);
    live = {...live!, members: [A, B, C, OWN]} as GroupRecord;
    await api.handleControlMessage(controlRumor('rm', {
      type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: C
    }, now, OWN), OWN);
    // Stale snapshot from BEFORE the removal, adding D but carrying C.
    await api.handleControlMessage(controlRumor('snap', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: 'e'.repeat(64),
      memberPubkeys: [A, B, OWN, C, 'e'.repeat(64)], groupName: 'G'
    }, now - 10, OWN), OWN);
    expect(live!.members).not.toContain(C);
    expect(live!.members).toContain('e'.repeat(64));
  });

  it('an add dated exactly at the removal time is blocked (the removal wins ties)', async() => {
    const now = Math.floor(Date.now() / 1000);
    live = {...live!, members: [A, B, C, OWN]} as GroupRecord;
    await api.handleControlMessage(controlRumor('rm', {
      type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: C
    }, now, OWN), OWN);
    await api.handleControlMessage(controlRumor('tie', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    }, now, OWN), OWN);
    expect(live!.members).not.toContain(C);
  });

  it('a genuine re-add dated AFTER the removal still lands', async() => {
    const now = Math.floor(Date.now() / 1000);
    live = {...live!, members: [A, B, C, OWN]} as GroupRecord;
    await api.handleControlMessage(controlRumor('rm', {
      type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: C
    }, now - 30, OWN), OWN);
    expect(live!.members).not.toContain(C);

    await api.handleControlMessage(controlRumor('re-add', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    }, now, OWN), OWN);
    expect(live!.members).toContain(C);
  });

  it('a member who left cannot be resurrected by an add older than their leave', async() => {
    const now = Math.floor(Date.now() / 1000);
    await api.handleControlMessage(controlRumor('leave', {
      type: 'group_leave', groupId: GROUP_ID
    }, now - 2, B), B);
    expect(live!.members).not.toContain(B);

    await api.handleControlMessage(controlRumor('stale-add-b', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: B,
      memberPubkeys: [A, B, OWN], groupName: 'G'
    }, now - 10, OWN), OWN);
    expect(live!.members).not.toContain(B);
  });

  it('a locally removed member is protected before the echo lands', async() => {
    // Admin removes C on THIS device; the remove echo has not returned yet.
    live = {...live!, members: [A, B, C, OWN]} as GroupRecord;
    await api.removeMember(GROUP_ID, C);
    expect(live!.members).not.toContain(C);

    const now = Math.floor(Date.now() / 1000);
    await api.handleControlMessage(controlRumor('stale-add-2', {
      type: 'group_add_member', groupId: GROUP_ID, targetPubkey: C,
      memberPubkeys: [A, B, OWN, C], groupName: 'G'
    }, now - 5, OWN), OWN);
    expect(live!.members).not.toContain(C);
  });
});
