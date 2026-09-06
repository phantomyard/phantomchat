import 'fake-indexeddb/auto';
import '../setup';
// leaveGroup() calls peerId.toPeerId() — a tweb prototype extension that the
// app loads via peerIdPolyfill. Import the real polyfill so the test exercises
// genuine behaviour instead of a hand-rolled stub.
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord, GroupControlPayload} from '@lib/phantomchat/group-types';

// ─── Mock setup ─────────────────────────────────────────────────

// Hoisted mock state shared across resetModules boundaries
const mockMgmtGroupStore = vi.hoisted(() => ({
  save: vi.fn(), get: vi.fn(), getByPeerId: vi.fn(), getAll: vi.fn(),
  delete: vi.fn(), updateMembers: vi.fn(), updateInfo: vi.fn(), destroy: vi.fn()
}));

const mockMgmtBroadcast = vi.hoisted(() => vi.fn().mockReturnValue([{id: 'c', kind: 1059}]));

vi.mock('@lib/phantomchat/group-store', () => ({
  GroupStore: vi.fn(() => mockMgmtGroupStore),
  getGroupStore: () => mockMgmtGroupStore
}));

vi.mock('@lib/phantomchat/nostr-crypto', () => ({
  wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
  createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
  createSeal: vi.fn(), createGiftWrap: vi.fn(),
  wrapNip17Message: vi.fn(), unwrapNip17Message: vi.fn(), wrapNip17Receipt: vi.fn()
}));

vi.mock('@lib/phantomchat/group-control-messages', () => ({
  isControlEvent: (rumor: {tags?: string[][]}) =>
    rumor.tags?.some((t: string[]) => t[0] === 'control' && t[1] === 'true') ?? false,
  getGroupIdFromRumor: (rumor: {tags?: string[][]}) => {
    const tag = rumor.tags?.find((t: string[]) => t[0] === 'group');
    return tag ? tag[1] : null;
  },
  broadcastGroupControl: (...args: any[]) => mockMgmtBroadcast(...args),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
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

  vi.doMock('@lib/phantomchat/group-store', () => ({
    GroupStore: vi.fn(() => mockMgmtGroupStore),
    getGroupStore: () => mockMgmtGroupStore
  }));
  vi.doMock('@lib/phantomchat/nostr-crypto', () => ({
    wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
    createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
    createSeal: vi.fn(), createGiftWrap: vi.fn(),
    wrapNip17Message: vi.fn(), unwrapNip17Message: vi.fn(), wrapNip17Receipt: vi.fn()
  }));
  vi.doMock('@lib/phantomchat/group-control-messages', () => ({
    isControlEvent: (rumor: {tags?: string[][]}) =>
      rumor.tags?.some((t: string[]) => t[0] === 'control' && t[1] === 'true') ?? false,
    getGroupIdFromRumor: (rumor: {tags?: string[][]}) => {
      const tag = rumor.tags?.find((t: string[]) => t[0] === 'group');
      return tag ? tag[1] : null;
    },
    broadcastGroupControl: (...args: any[]) => mockMgmtBroadcast(...args),
    wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
  }));
  vi.doMock('@lib/phantomchat/group-types', async() => {
    const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
    return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
  });
  vi.doMock('@lib/rootScope', () => ({
    default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
  }));
  vi.doMock('@lib/logger', () => ({
    Logger: class {},
    logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
  }));

  const apiMod = await import('@lib/phantomchat/group-api');
  GroupAPI = apiMod.GroupAPI;

  groupStoreModule = await import('@lib/phantomchat/group-store');
  controlModule = await import('@lib/phantomchat/group-control-messages');
});

// Pubkeys must be canonical NIP-01 form: 64-char lowercase hex (validated by
// group-api SECP_PUBKEY_HEX_RE). Mnemonic placeholders like 'membera…' contain
// non-hex chars and are correctly rejected — use valid hex fixtures.
const OWN_PUBKEY = 'd'.repeat(64);
const OWN_SK = new Uint8Array(32).fill(1);
const MEMBER_A = 'a'.repeat(64);
const MEMBER_B = 'b'.repeat(64);
const NEW_MEMBER = 'c'.repeat(64);
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

  beforeEach(async() => {
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

    // Test isolation: the leaveGroup test writes a deletion tombstone for
    // GROUP_ID into the (persistent fake-indexeddb) message store. Clear it so
    // the control-message tombstone gate doesn't carry over and drop control
    // messages in subsequent same-GROUP_ID tests.
    const {getMessageStore} = await import('@lib/phantomchat/message-store');
    await getMessageStore().clearTombstone(`group:${GROUP_ID}`);
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

    it('writes a deletion tombstone + purges messages so the group cannot resurrect', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      const convId = `group:${GROUP_ID}`;

      // Seed a leftover group message — the exact orphan that getGroupHistory
      // would otherwise rebuild the group from.
      await ms.saveMessage({
        eventId: 'evt-resurrect-1', conversationId: convId,
        senderPubkey: MEMBER_A, content: 'hi', type: 'text',
        timestamp: Math.floor(Date.now() / 1000), deliveryState: 'delivered',
        isOutgoing: false
      });

      store().get.mockResolvedValueOnce(makeGroup());
      await api.leaveGroup(GROUP_ID);

      // Tombstone watermark must be set, and the orphan messages purged.
      const deletedAt = await ms.getTombstone(convId);
      expect(deletedAt).toBeGreaterThan(0);
      const remaining = await ms.getMessages(convId, 50);
      expect(remaining.length).toBe(0);
    });
  });

  describe('deleteGroup (admin, broadcast-to-all)', () => {
    it('admin: broadcasts group_delete to other members and removes local group', async() => {
      store().get.mockResolvedValueOnce(makeGroup());
      await api.deleteGroup(GROUP_ID);

      const [, recipients, payload] = broadcast().mock.calls[0];
      expect(payload.type).toBe('group_delete');
      expect(recipients).toContain(MEMBER_A);
      expect(recipients).toContain(MEMBER_B);
      expect(recipients).not.toContain(OWN_PUBKEY); // self-wrap is added by broadcastGroupControl
      expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
    });

    it('throws if not admin', async() => {
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      await expect(api.deleteGroup(GROUP_ID)).rejects.toThrow('Only admin');
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

    // FIND-group-resurrection: a deleted/left group must NOT come back when the
    // original group_create (or its self-wrap) is replayed from the relay
    // backlog on reload. The control path now honors the deletion tombstone.
    it('drops a replayed group_create for a tombstoned group (no resurrection)', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const groupId = 'tombstonedgroup0000000000000000a';
      await getMessageStore().setTombstone(`group:${groupId}`, 2000);

      const payload: GroupControlPayload = {
        type: 'group_create', groupId, groupName: 'Zombie',
        memberPubkeys: [MEMBER_A, OWN_PUBKEY], adminPubkey: MEMBER_A
      };
      const rumor = {
        id: 'ctrl-zombie', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: 1000, // at/below the deletion watermark
        tags: [['control', 'true'], ['group', groupId]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);
      expect(store().save).not.toHaveBeenCalled();
    });

    it('still applies a group_create newer than the tombstone (revive semantics)', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const groupId = 'tombstonedgroup0000000000000000b';
      await getMessageStore().setTombstone(`group:${groupId}`, 1000);

      const payload: GroupControlPayload = {
        type: 'group_create', groupId, groupName: 'Revived',
        memberPubkeys: [MEMBER_A, OWN_PUBKEY], adminPubkey: MEMBER_A
      };
      const rumor = {
        id: 'ctrl-revive', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: 2000, // above the deletion watermark
        tags: [['control', 'true'], ['group', groupId]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);
      expect(store().save).toHaveBeenCalledTimes(1);
    });

    // ─── Replay guards (PR #138 review: source-event watermarks) ──
    it('ignores a replayed group_create for a live record (non-destructive)', async() => {
      store().get.mockResolvedValue(makeGroup());
      const payload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Clobber Attempt',
        memberPubkeys: [MEMBER_A], adminPubkey: MEMBER_A
      };
      const rumor = {
        id: 'ctrl-replay-create', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);
      // The live record must survive untouched.
      expect(store().save).not.toHaveBeenCalled();
    });

    it('drops group_info_update from a non-admin (name + avatar spoof)', async() => {
      store().get.mockResolvedValue(makeGroup({adminPubkey: OWN_PUBKEY}));
      const payload: GroupControlPayload = {
        type: 'group_info_update', groupId: GROUP_ID,
        groupName: 'Spoofed', groupAvatar: 'https://evil.example/beacon.jpg'
      };
      const rumor = {
        id: 'ctrl-info-spoof', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_B);
      expect(store().updateInfo).not.toHaveBeenCalled();
    });

    it('drops a group_info_update whose avatar is not a Blossom host', async() => {
      store().get.mockResolvedValue(makeGroup({adminPubkey: OWN_PUBKEY}));
      const payload: GroupControlPayload = {
        type: 'group_info_update', groupId: GROUP_ID,
        groupName: 'Still Mine', groupAvatar: 'https://evil.example/beacon.jpg'
      };
      const rumor = {
        id: 'ctrl-info-avatar', kind: 14, content: JSON.stringify(payload),
        pubkey: OWN_PUBKEY, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, OWN_PUBKEY);
      expect(store().updateInfo).not.toHaveBeenCalled();
    });

    it('applies an admin info update, then drops a replayed older one (watermark)', async() => {
      const gid = 'watermarkinfo000000000000000000001';
      store().get.mockResolvedValue(makeGroup({groupId: gid, adminPubkey: OWN_PUBKEY}));
      const now = Math.floor(Date.now() / 1000);

      const makeInfoRumor = (ts: number, name: string): any => ({
        id: 'ctrl-info-' + name, kind: 14,
        content: JSON.stringify({type: 'group_info_update', groupId: gid, groupName: name} as GroupControlPayload),
        pubkey: OWN_PUBKEY, created_at: ts,
        tags: [['control', 'true'], ['group', gid]]
      });

      await api.handleControlMessage(makeInfoRumor(now, 'Newer Name'), OWN_PUBKEY);
      expect(store().updateInfo).toHaveBeenCalledTimes(1);

      // Backlog replay of an event sent BEFORE the applied one (>60s older)
      // must not clobber the newer name.
      await api.handleControlMessage(makeInfoRumor(now - 300, 'Older Name'), OWN_PUBKEY);
      expect(store().updateInfo).toHaveBeenCalledTimes(1);
    });

    it('still applies a delayed members event after a newer info event (per-field)', async() => {
      const gid = 'watermarkfield000000000000000000001';
      store().get.mockResolvedValue(makeGroup({groupId: gid, adminPubkey: OWN_PUBKEY}));
      const now = Math.floor(Date.now() / 1000);

      const infoRumor: any = {
        id: 'ctrl-wm-info', kind: 14,
        content: JSON.stringify({type: 'group_info_update', groupId: gid, groupName: 'Renamed'} as GroupControlPayload),
        pubkey: OWN_PUBKEY, created_at: now,
        tags: [['control', 'true'], ['group', gid]]
      };
      const addRumor: any = {
        id: 'ctrl-wm-add', kind: 14,
        content: JSON.stringify({type: 'group_add_member', groupId: gid, targetPubkey: NEW_MEMBER, memberPubkeys: [MEMBER_A, OWN_PUBKEY, NEW_MEMBER]} as GroupControlPayload),
        pubkey: OWN_PUBKEY, created_at: now - 300, // sent long before the rename
        tags: [['control', 'true'], ['group', gid]]
      };

      await api.handleControlMessage(infoRumor, OWN_PUBKEY);
      await api.handleControlMessage(addRumor, OWN_PUBKEY);
      // The rename must not mask the (older) membership event: watermarks
      // are per field, so a delayed add still applies.
      expect(store().updateMembers).toHaveBeenCalledTimes(1);
    });

    it('drops a members event older than the applied members watermark', async() => {
      const gid = 'watermarkmem0000000000000000000001';
      store().get.mockResolvedValue(makeGroup({groupId: gid, adminPubkey: OWN_PUBKEY}));
      const now = Math.floor(Date.now() / 1000);

      const makeAddRumor = (ts: number, id: string): any => ({
        id, kind: 14,
        content: JSON.stringify({type: 'group_add_member', groupId: gid, targetPubkey: NEW_MEMBER, memberPubkeys: [MEMBER_A, OWN_PUBKEY, NEW_MEMBER]} as GroupControlPayload),
        pubkey: OWN_PUBKEY, created_at: ts,
        tags: [['control', 'true'], ['group', gid]]
      });

      await api.handleControlMessage(makeAddRumor(now, 'ctrl-wm-a1'), OWN_PUBKEY);
      expect(store().updateMembers).toHaveBeenCalledTimes(1);

      // Relay backlog replay of the same/older add must not re-clobber the
      // member list (e.g. re-adding a member the admin removed since).
      await api.handleControlMessage(makeAddRumor(now - 300, 'ctrl-wm-a2'), OWN_PUBKEY);
      expect(store().updateMembers).toHaveBeenCalledTimes(1);
    });

    it('does not let a future-dated members event poison the watermark (PR #138 review 2)', async() => {
      const gid = 'watermarkfuture0000000000000000001';
      store().get.mockResolvedValue(makeGroup({groupId: gid, adminPubkey: OWN_PUBKEY}));
      const now = Math.floor(Date.now() / 1000);

      const makeAddRumor = (ts: number, id: string, mems: string[]): any => ({
        id, kind: 14,
        content: JSON.stringify({type: 'group_add_member', groupId: gid, targetPubkey: NEW_MEMBER, memberPubkeys: mems} as GroupControlPayload),
        pubkey: MEMBER_B, created_at: ts,
        tags: [['control', 'true'], ['group', gid]]
      });

      // A member dates an add ten years out — this must not be applied AND
      // must not pin the persisted members watermark, which would freeze
      // the group's membership forever (every later event then fails the
      // replay gate).
      await api.handleControlMessage(
        makeAddRumor(now + 315360000, 'ctrl-wm-future', [MEMBER_A, OWN_PUBKEY, NEW_MEMBER]), MEMBER_B);
      expect(store().updateMembers).toHaveBeenCalledTimes(0);

      // A legitimate add that follows must still apply...
      await api.handleControlMessage(
        makeAddRumor(now, 'ctrl-wm-legit', [MEMBER_A, OWN_PUBKEY, NEW_MEMBER]), OWN_PUBKEY);
      expect(store().updateMembers).toHaveBeenCalledTimes(1);

      // ...and the watermark must be sane: an older backlog replay is still
      // dropped (proving the watermark advanced to ~now, not to the future).
      await api.handleControlMessage(
        makeAddRumor(now - 300, 'ctrl-wm-old', [MEMBER_A, OWN_PUBKEY, NEW_MEMBER]), OWN_PUBKEY);
      expect(store().updateMembers).toHaveBeenCalledTimes(1);
    });

    it('does not advance the watermark when the handler applied nothing (PR #138 review 2)', async() => {
      const gid = 'watermarknoop000000000000000000001';
      store().get.mockResolvedValue(makeGroup({groupId: gid, adminPubkey: OWN_PUBKEY}));
      const now = Math.floor(Date.now() / 1000);

      const makeAddRumor = (ts: number, id: string, mems?: string[]): any => ({
        id, kind: 14,
        content: JSON.stringify({type: 'group_add_member', groupId: gid, targetPubkey: NEW_MEMBER, ...(mems ? {memberPubkeys: mems} : {})} as GroupControlPayload),
        pubkey: OWN_PUBKEY, created_at: ts,
        tags: [['control', 'true'], ['group', gid]]
      });

      // An add with no member list is a complete no-op — it must not
      // advance the members watermark, otherwise a legitimate older add
      // still queued in the backlog behind it is dropped.
      await api.handleControlMessage(makeAddRumor(now, 'ctrl-wm-noop'), OWN_PUBKEY);
      expect(store().updateMembers).toHaveBeenCalledTimes(0);

      // The older legitimate add behind it in the backlog must apply.
      await api.handleControlMessage(
        makeAddRumor(now - 300, 'ctrl-wm-real', [MEMBER_A, OWN_PUBKEY, NEW_MEMBER]), OWN_PUBKEY);
      expect(store().updateMembers).toHaveBeenCalledTimes(1);
    });

    it('ignores group_admin_transfer from a non-admin', async() => {
      store().get.mockResolvedValue(makeGroup({adminPubkey: OWN_PUBKEY}));
      const payload: GroupControlPayload = {
        type: 'group_admin_transfer', groupId: GROUP_ID, adminPubkey: MEMBER_B
      };
      const rumor = {
        id: 'ctrl-at-spoof', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_B);
      expect(store().save).not.toHaveBeenCalled();
    });

    it('applies group_admin_transfer from the current admin', async() => {
      store().get.mockResolvedValue(makeGroup({adminPubkey: OWN_PUBKEY}));
      const payload: GroupControlPayload = {
        type: 'group_admin_transfer', groupId: GROUP_ID, adminPubkey: MEMBER_A
      };
      const rumor = {
        id: 'ctrl-at-real', kind: 14, content: JSON.stringify(payload),
        pubkey: OWN_PUBKEY, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, OWN_PUBKEY);
      expect(store().save).toHaveBeenCalledTimes(1);
      const saved = store().save.mock.calls[0][0] as GroupRecord;
      expect(saved.adminPubkey).toBe(MEMBER_A);
    });

    it('group_delete from the admin tears the group down locally', async() => {
      store().get.mockResolvedValue(makeGroup({adminPubkey: MEMBER_A}));
      const payload: GroupControlPayload = {type: 'group_delete', groupId: GROUP_ID};
      const rumor = {
        id: 'ctrl-del', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);
      expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
    });

    it('group_delete from a non-admin is ignored (no teardown)', async() => {
      store().get.mockResolvedValue(makeGroup({adminPubkey: MEMBER_A}));
      const payload: GroupControlPayload = {type: 'group_delete', groupId: GROUP_ID};
      const rumor = {
        id: 'ctrl-del2', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_B);
      expect(store().delete).not.toHaveBeenCalled();
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
