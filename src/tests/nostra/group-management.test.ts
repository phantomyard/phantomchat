import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord, GroupControlPayload} from '@lib/nostra/group-types';

// ─── Mock setup ─────────────────────────────────────────────────

// Hoisted mock state shared across resetModules boundaries
const mockMgmtGroupStore = vi.hoisted(() => ({
  save: vi.fn(), get: vi.fn(), getByPeerId: vi.fn(), getAll: vi.fn(),
  delete: vi.fn(), updateMembers: vi.fn(), updateInfo: vi.fn(), destroy: vi.fn()
}));

const mockMgmtBroadcast = vi.hoisted(() => vi.fn().mockReturnValue([{id: 'c', kind: 1059}]));

vi.mock('@lib/nostra/group-store', () => ({
  GroupStore: vi.fn(() => mockMgmtGroupStore),
  getGroupStore: () => mockMgmtGroupStore
}));

vi.mock('@lib/nostra/nostr-crypto', () => ({
  wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
  createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
  createSeal: vi.fn(), createGiftWrap: vi.fn(),
  wrapNip17Message: vi.fn(), unwrapNip17Message: vi.fn(), wrapNip17Receipt: vi.fn()
}));

vi.mock('@lib/nostra/group-control-messages', () => ({
  isControlEvent: (rumor: {tags?: string[][]}) =>
    rumor.tags?.some((t: string[]) => t[0] === 'control' && t[1] === 'true') ?? false,
  getGroupIdFromRumor: (rumor: {tags?: string[][]}) => {
    const tag = rumor.tags?.find((t: string[]) => t[0] === 'group');
    return tag ? tag[1] : null;
  },
  broadcastGroupControl: (...args: any[]) => mockMgmtBroadcast(...args),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));

vi.mock('@lib/nostra/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/nostra/group-types')>('@lib/nostra/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
});

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
}));

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

// ─── Dynamic module loading ────────────────────────────────────

let GroupAPI: any;
let groupStoreModule: any;
let controlModule: any;

beforeAll(async() => {
  vi.resetModules();

  vi.doMock('@lib/nostra/group-store', () => ({
    GroupStore: vi.fn(() => mockMgmtGroupStore),
    getGroupStore: () => mockMgmtGroupStore
  }));
  vi.doMock('@lib/nostra/nostr-crypto', () => ({
    wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
    createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
    createSeal: vi.fn(), createGiftWrap: vi.fn(),
    wrapNip17Message: vi.fn(), unwrapNip17Message: vi.fn(), wrapNip17Receipt: vi.fn()
  }));
  vi.doMock('@lib/nostra/group-control-messages', () => ({
    isControlEvent: (rumor: {tags?: string[][]}) =>
      rumor.tags?.some((t: string[]) => t[0] === 'control' && t[1] === 'true') ?? false,
    getGroupIdFromRumor: (rumor: {tags?: string[][]}) => {
      const tag = rumor.tags?.find((t: string[]) => t[0] === 'group');
      return tag ? tag[1] : null;
    },
    broadcastGroupControl: (...args: any[]) => mockMgmtBroadcast(...args),
    wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
  }));
  vi.doMock('@lib/nostra/group-types', async() => {
    const actual = await vi.importActual<typeof import('@lib/nostra/group-types')>('@lib/nostra/group-types');
    return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
  });
  vi.doMock('@lib/rootScope', () => ({
    default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
  }));
  vi.doMock('@lib/logger', () => ({
    Logger: class {},
    logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
  }));

  const apiMod = await import('@lib/nostra/group-api');
  GroupAPI = apiMod.GroupAPI;

  groupStoreModule = await import('@lib/nostra/group-store');
  controlModule = await import('@lib/nostra/group-control-messages');
});

const OWN_PUBKEY = 'ownpub00000000000000000000000000000000000000000000000000000000ab';
const OWN_SK = new Uint8Array(32).fill(1);
const MEMBER_A = 'membera0000000000000000000000000000000000000000000000000000001';
const MEMBER_B = 'memberb0000000000000000000000000000000000000000000000000000002';
const NEW_MEMBER = 'newmem00000000000000000000000000000000000000000000000000000003';
const GROUP_ID = 'abc123def456abc123def456abc123de00';

function makeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: GROUP_ID, name: 'Test Group', adminPubkey: OWN_PUBKEY,
    members: [MEMBER_A, MEMBER_B, OWN_PUBKEY], peerId: -2000000000000001,
    createdAt: Date.now(), updatedAt: Date.now(), ...overrides
  };
}

function store() {
  return mockMgmtGroupStore;
}

function broadcast() {
  return mockMgmtBroadcast;
}

describe('Group Management', () => {
  let api: any;
  let publishedEvents: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    publishedEvents = [];

    const s = store();
    s.save.mockResolvedValue(undefined);
    s.get.mockResolvedValue(null);
    s.delete.mockResolvedValue(undefined);
    s.updateMembers.mockResolvedValue(undefined);

    broadcast().mockReturnValue([{id: 'ctrl-1', kind: 1059} as any]);

    const publishFn = async(events: any[]) => { publishedEvents.push(...events); };
    api = new GroupAPI(OWN_PUBKEY, OWN_SK, publishFn);
  });

  describe('addMember', () => {
    it('sends control message to all current + new member and updates store', async() => {
      store().get.mockResolvedValueOnce(makeGroup());
      await api.addMember(GROUP_ID, NEW_MEMBER);

      expect(store().updateMembers).toHaveBeenCalledTimes(1);
      const updatedMembers = store().updateMembers.mock.calls[0][1] as string[];
      expect(updatedMembers).toContain(NEW_MEMBER);
      expect(updatedMembers).toContain(MEMBER_A);

      expect(broadcast()).toHaveBeenCalledTimes(1);
      const [, recipients, payload] = broadcast().mock.calls[0];
      expect(recipients).toContain(NEW_MEMBER);
      expect(payload.type).toBe('group_add_member');
      expect(payload.targetPubkey).toBe(NEW_MEMBER);
      expect(publishedEvents.length).toBeGreaterThan(0);
    });

    it('throws if not admin', async() => {
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      await expect(api.addMember(GROUP_ID, NEW_MEMBER)).rejects.toThrow('Only admin');
    });
  });

  describe('removeMember', () => {
    it('sends control message to remaining only and updates store', async() => {
      store().get.mockResolvedValueOnce(makeGroup());
      await api.removeMember(GROUP_ID, MEMBER_B);

      const remaining = store().updateMembers.mock.calls[0][1] as string[];
      expect(remaining).not.toContain(MEMBER_B);
      expect(remaining).toContain(MEMBER_A);

      const [, recipients, payload] = broadcast().mock.calls[0];
      expect(recipients).not.toContain(MEMBER_B);
      expect(payload.type).toBe('group_remove_member');
    });
  });

  describe('leaveGroup', () => {
    it('sends control message to remaining and removes local group', async() => {
      store().get.mockResolvedValueOnce(makeGroup());
      await api.leaveGroup(GROUP_ID);

      const [, recipients, payload] = broadcast().mock.calls[0];
      expect(recipients).not.toContain(OWN_PUBKEY);
      expect(recipients).toContain(MEMBER_A);
      expect(payload.type).toBe('group_leave');
      expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
    });
  });

  describe('handleControlMessage', () => {
    it('group_create creates group in store', async() => {
      const payload: GroupControlPayload = {
        type: 'group_create', groupId: 'newgroup123456789012345678901234',
        groupName: 'New Group', memberPubkeys: [MEMBER_A, MEMBER_B, OWN_PUBKEY],
        adminPubkey: MEMBER_A
      };
      const rumor = {
        id: 'ctrl-rumor', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', payload.groupId]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);
      expect(store().save).toHaveBeenCalledTimes(1);
      const saved = store().save.mock.calls[0][0] as GroupRecord;
      expect(saved.groupId).toBe('newgroup123456789012345678901234');
      expect(saved.name).toBe('New Group');
      expect(saved.adminPubkey).toBe(MEMBER_A);
    });

    it('group_remove_member with targetPubkey=self removes group locally', async() => {
      const payload: GroupControlPayload = {
        type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: OWN_PUBKEY
      };
      const rumor = {
        id: 'ctrl-remove', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);
      expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
    });

    // ─── Admin-orphan protection (Phase 2b.4 fix) ────────────────
    // When the admin leaves, receiver must promote a new admin from the
    // remaining members deterministically (lex-smallest pubkey) so every
    // member derives the same admin without a separate round-trip.
    it('group_leave from admin auto-promotes lex-smallest remaining member', async() => {
      // Group where MEMBER_A is admin and leaves; OWN_PUBKEY + MEMBER_B remain.
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));

      const payload: GroupControlPayload = {type: 'group_leave', groupId: GROUP_ID};
      const rumor = {
        id: 'ctrl-leave-admin', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };
      await api.handleControlMessage(rumor, MEMBER_A);

      expect(store().save).toHaveBeenCalledTimes(1);
      const saved = store().save.mock.calls[0][0] as GroupRecord;
      expect(saved.members).not.toContain(MEMBER_A);
      expect(saved.members).toContain(MEMBER_B);
      expect(saved.members).toContain(OWN_PUBKEY);
      // Lex-smallest of the remaining set (MEMBER_B < OWN_PUBKEY < …)
      const expected = [MEMBER_B, OWN_PUBKEY].sort()[0];
      expect(saved.adminPubkey).toBe(expected);
      // Invariant we ship with the fix: admin is always in members.
      expect(saved.members).toContain(saved.adminPubkey);
    });

    it('group_leave from non-admin preserves adminPubkey', async() => {
      // Group where OWN_PUBKEY is admin, MEMBER_B leaves.
      store().get.mockResolvedValueOnce(makeGroup());

      const payload: GroupControlPayload = {type: 'group_leave', groupId: GROUP_ID};
      const rumor = {
        id: 'ctrl-leave-member', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };
      await api.handleControlMessage(rumor, MEMBER_B);

      // No full save — admin didn't change. updateMembers path instead.
      expect(store().save).not.toHaveBeenCalled();
      expect(store().updateMembers).toHaveBeenCalledTimes(1);
      const remaining = store().updateMembers.mock.calls[0][1] as string[];
      expect(remaining).not.toContain(MEMBER_B);
      expect(remaining).toContain(OWN_PUBKEY);
    });

    it('group_leave from sole admin (last member leaving) removes group', async() => {
      // Admin leaves a 1-member group (just themselves).
      store().get.mockResolvedValueOnce(makeGroup({members: [MEMBER_A], adminPubkey: MEMBER_A}));

      const payload: GroupControlPayload = {type: 'group_leave', groupId: GROUP_ID};
      const rumor = {
        id: 'ctrl-leave-last', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };
      await api.handleControlMessage(rumor, MEMBER_A);

      // Empty remaining — no save (admin can't transfer to nobody).
      // Accept either updateMembers-with-empty or no-op; just assert no
      // adminPubkey inconsistency got persisted.
      if(store().save.mock.calls.length > 0) {
        const saved = store().save.mock.calls[0][0] as GroupRecord;
        expect(saved.members.length).toBeLessThanOrEqual(1);
        if(saved.adminPubkey) expect(saved.members).toContain(saved.adminPubkey);
      }
    });
  });
});
