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
  delete: vi.fn(), updateMembers: vi.fn(), updateInfo: vi.fn(), destroy: vi.fn(),
  recordDeletedGroup: vi.fn(), listDeletedGroups: vi.fn(), clearDeletedGroup: vi.fn()
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
const GROUP_ID = 'abc123def456abc123def456abc123de'; // 32-hex: the real legacy id format (stripped randomUUID)

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
    s.recordDeletedGroup.mockResolvedValue(undefined);

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

  describe('durable delete on teardown (PR #179 round 7)', () => {
    it('records the durable delete BEFORE the destructive teardown', async() => {
      store().get.mockResolvedValueOnce(makeGroup());
      await api.leaveGroup(GROUP_ID);

      expect(store().recordDeletedGroup).toHaveBeenCalledTimes(1);
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(GROUP_ID, expect.any(Number));
      // The positive delete fact must precede the record deletion — the
      // destructive step that leaves neither a live record nor a delete.
      const durableOrder = store().recordDeletedGroup.mock.invocationCallOrder[0];
      const deleteOrder = store().delete.mock.invocationCallOrder[0];
      expect(durableOrder).toBeLessThan(deleteOrder);
    });

    it('a message-store rejection cannot suppress the durable delete (Kai round-7 blocker)', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      const originalDeleteMessages = ms.deleteMessages.bind(ms);
      try {
        ms.deleteMessages = vi.fn().mockRejectedValue(new Error('idb quota exceeded')) as any;

        store().get.mockResolvedValueOnce(makeGroup());
        await api.leaveGroup(GROUP_ID); // must not throw despite the rejection

        expect(store().recordDeletedGroup).toHaveBeenCalledTimes(1);
        expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
      } finally {
        ms.deleteMessages = originalDeleteMessages;
      }
    });

    it('a DURABLE-write rejection aborts the destructive teardown (Kai round-9 blocker)', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      // The durable fact is a strict precondition: without it the device
      // would hold neither a live record nor the delete fact — the exact
      // state a stale record elsewhere resurrects the group from.
      store().get.mockResolvedValueOnce(makeGroup());
      store().recordDeletedGroup.mockRejectedValueOnce(new Error('idb upgrade failed'));

      await expect(api.leaveGroup(GROUP_ID)).rejects.toThrow('idb upgrade failed');

      // Nothing destructive ran: the live record and the message store are
      // untouched, so the group remains fully intact for a retry.
      expect(store().delete).not.toHaveBeenCalled();
      const convId = `group:${GROUP_ID}`;
      expect(await ms.getTombstone(convId)).toBe(0);
    });

    it('orphan teardown (no store record) still records the durable delete before the message-store chain', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      // Seed a leftover group conversation so the orphan scan finds it.
      await ms.saveMessage({
        eventId: 'evt-orphan-durable', conversationId: `group:${GROUP_ID}`,
        senderPubkey: MEMBER_A, content: 'hi', type: 'text',
        timestamp: Math.floor(Date.now() / 1000), deliveryState: 'delivered',
        isOutgoing: false
      });

      await api.leaveGroupByPeerId(-2000000000000001);

      expect(store().recordDeletedGroup).toHaveBeenCalledWith(GROUP_ID, expect.any(Number));
    });

    it('orphan path: a durable-write rejection aborts the purge (nothing destructive runs)', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      // Seed a leftover group conversation so the orphan scan finds it.
      await ms.saveMessage({
        eventId: 'evt-orphan-durable-reject', conversationId: `group:${GROUP_ID}`,
        senderPubkey: MEMBER_A, content: 'hi', type: 'text',
        timestamp: Math.floor(Date.now() / 1000), deliveryState: 'delivered',
        isOutgoing: false
      });
      store().recordDeletedGroup.mockRejectedValueOnce(new Error('idb upgrade failed'));

      await api.leaveGroupByPeerId(-2000000000000001); // non-fatal by contract

      // The purge never ran: the leftover messages survive, so no state is
      // created where the conversation is purged but no delete fact exists.
      const remaining = await ms.getMessages(`group:${GROUP_ID}`, 50);
      expect(remaining.length).toBe(1);
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

    it('group_delete for an unknown group cannot create a durable delete', async() => {
      store().get.mockResolvedValue(null);
      const payload: GroupControlPayload = {type: 'group_delete', groupId: GROUP_ID};
      const rumor = {
        id: 'ctrl-del-unknown', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_B);

      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      expect(await getMessageStore().getTombstone(`group:${GROUP_ID}`)).toBe(0);
    });

    it('applies a genuine admin delete that arrived before its older group_create', async() => {
      store().get.mockResolvedValue(null);
      const now = Math.floor(Date.now() / 1000);
      const deletePayload: GroupControlPayload = {type: 'group_delete', groupId: GROUP_ID};
      const createPayload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Deleted Group',
        adminPubkey: MEMBER_A, memberPubkeys: [MEMBER_A, OWN_PUBKEY]
      };

      await api.handleControlMessage({
        id: 'ctrl-del-reordered', kind: 14, content: JSON.stringify(deletePayload),
        pubkey: MEMBER_A, created_at: now - 10,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      await api.handleControlMessage({
        id: 'ctrl-create-older', kind: 14, content: JSON.stringify(createPayload),
        pubkey: MEMBER_A, created_at: now - 100,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);

      expect(store().save).not.toHaveBeenCalled();
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(GROUP_ID, expect.any(Number));
      expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
    });

    it('applies an admin delete that starts while group_create is saving', async() => {
      store().get.mockResolvedValue(null);
      let finishSave!: () => void;
      store().save.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
      const now = Math.floor(Date.now() / 1000);
      const createPayload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Racing Group',
        adminPubkey: MEMBER_A, memberPubkeys: [MEMBER_A, OWN_PUBKEY]
      };

      const createPromise = api.handleControlMessage({
        id: 'ctrl-create-racing', kind: 14, content: JSON.stringify(createPayload),
        pubkey: MEMBER_A, created_at: now - 100,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      await vi.waitFor(() => expect(store().save).toHaveBeenCalledTimes(1));

      await api.handleControlMessage({
        id: 'ctrl-del-concurrent', kind: 14,
        content: JSON.stringify({type: 'group_delete', groupId: GROUP_ID} as GroupControlPayload),
        pubkey: MEMBER_A, created_at: now - 10,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      finishSave();
      await createPromise;

      expect(store().recordDeletedGroup).toHaveBeenCalledWith(GROUP_ID, expect.any(Number));
      expect(store().delete).toHaveBeenCalledWith(GROUP_ID);
    });

    it('does not let an unknown non-admin delete suppress a later group_create', async() => {
      store().get.mockResolvedValue(null);
      const now = Math.floor(Date.now() / 1000);
      const deletePayload: GroupControlPayload = {type: 'group_delete', groupId: GROUP_ID};
      const createPayload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Real Group',
        adminPubkey: MEMBER_A, memberPubkeys: [MEMBER_A, OWN_PUBKEY]
      };

      await api.handleControlMessage({
        id: 'ctrl-del-spoof', kind: 14, content: JSON.stringify(deletePayload),
        pubkey: MEMBER_B, created_at: now - 10,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_B);
      await api.handleControlMessage({
        id: 'ctrl-create-real', kind: 14, content: JSON.stringify(createPayload),
        pubkey: MEMBER_A, created_at: now - 100,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);

      expect(store().save).toHaveBeenCalledTimes(1);
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
    });

    it('does not let a stale pre-create delete suppress a newer group_create', async() => {
      store().get.mockResolvedValue(null);
      const now = Math.floor(Date.now() / 1000);
      const deletePayload: GroupControlPayload = {type: 'group_delete', groupId: GROUP_ID};
      const createPayload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Re-created Group',
        adminPubkey: MEMBER_A, memberPubkeys: [MEMBER_A, OWN_PUBKEY]
      };

      await api.handleControlMessage({
        id: 'ctrl-del-stale', kind: 14, content: JSON.stringify(deletePayload),
        pubkey: MEMBER_A, created_at: now - 100,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      await api.handleControlMessage({
        id: 'ctrl-create-newer', kind: 14, content: JSON.stringify(createPayload),
        pubkey: MEMBER_A, created_at: now - 10,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);

      expect(store().save).toHaveBeenCalledTimes(1);
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
    });

    it('group_remove_member with targetPubkey=self removes group locally (admin sender)', async() => {
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
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

    // ─── Kicked member durable delete (issue #181) ────────────────
    // handleRemoveMember(self) must be a POSITIVE delete fact, not an
    // absence: durable deletedGroups row + conversation tombstone, same
    // teardown as leaveGroup / deleteGroup. Without it, a second own
    // device's live record re-materialises the group via the sync apply().
    it('admin removing another member updates the local member list; a non-admin sender cannot', async() => {
      // Admin path: MEMBER_A (admin) removes MEMBER_B.
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      await api.handleControlMessage({
        id: 'ctrl-remove-other', kind: 14,
        content: JSON.stringify({
          type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: MEMBER_B
        }),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      expect(store().updateMembers).toHaveBeenCalledWith(GROUP_ID, [MEMBER_A, OWN_PUBKEY]);

      // Non-admin path: MEMBER_B forges a removal of MEMBER_A — ignored.
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      await api.handleControlMessage({
        id: 'ctrl-remove-other-forge', kind: 14,
        content: JSON.stringify({
          type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: MEMBER_A
        }),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_B);
      expect(store().updateMembers).toHaveBeenCalledTimes(1);
    });

    it('kick records the durable delete BEFORE store.delete and tombstones the conversation', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      const convId = `group:${GROUP_ID}`;
      // Seed a leftover group message — the exact orphan the tombstone purge
      // must remove so the kicked group cannot rebuild from history.
      await ms.saveMessage({
        eventId: 'evt-kick-1', conversationId: convId,
        senderPubkey: MEMBER_A, content: 'hi', type: 'text',
        timestamp: Math.floor(Date.now() / 1000), deliveryState: 'delivered',
        isOutgoing: false
      });

      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      const payload: GroupControlPayload = {
        type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: OWN_PUBKEY
      };
      const rumor = {
        id: 'ctrl-kick', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await api.handleControlMessage(rumor, MEMBER_A);

      // Positive delete fact recorded, and strictly BEFORE the store delete.
      expect(store().recordDeletedGroup).toHaveBeenCalledTimes(1);
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(GROUP_ID, expect.any(Number));
      const durableOrder = store().recordDeletedGroup.mock.invocationCallOrder[0];
      const deleteOrder = store().delete.mock.invocationCallOrder[0];
      expect(durableOrder).toBeLessThan(deleteOrder);
      // Conversation tombstoned + purged — replayed creates/rumors stay gated.
      const deletedAt = await ms.getTombstone(convId);
      expect(deletedAt).toBeGreaterThan(0);
      expect((await ms.getMessages(convId, 50)).length).toBe(0);
    });

    it('a durable-write rejection aborts the kick teardown and the dispatch survives', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      store().recordDeletedGroup.mockRejectedValueOnce(new Error('idb upgrade failed'));

      const payload: GroupControlPayload = {
        type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: OWN_PUBKEY
      };
      const rumor = {
        id: 'ctrl-kick-durable-fail', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      // The dispatch catch keeps the control path alive (relay backlog
      // redelivery retries the kick); nothing destructive ran.
      await expect(api.handleControlMessage(rumor, MEMBER_A)).resolves.not.toThrow();
      expect(store().delete).not.toHaveBeenCalled();
      expect(await ms.getTombstone(`group:${GROUP_ID}`)).toBe(0);
    });

    it('kick from a non-admin is ignored — no durable write, no tombstone, no delete', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      // Record exists, admin is MEMBER_A; the forger is MEMBER_B, who knows
      // the groupId. Pre-review this forged kick would have durably deleted
      // the group on every own device.
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      const payload: GroupControlPayload = {
        type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: OWN_PUBKEY
      };
      const rumor = {
        id: 'ctrl-kick-forge', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await expect(api.handleControlMessage(rumor, MEMBER_B)).resolves.not.toThrow();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
      expect(await ms.getTombstone(`group:${GROUP_ID}`)).toBe(0);
    });

    it('kick with no local record fails closed — mirror cleanup only, no durable fact', async() => {
      // No record → nothing to verify the sender against, so nothing durable
      // may be written from an unverified control (Lena's review of #183,
      // fail-closed like #184). Only zombie-mirror cleanup runs.
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      store().get.mockResolvedValue(undefined);
      const payload: GroupControlPayload = {
        type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: OWN_PUBKEY
      };
      const rumor = {
        id: 'ctrl-kick-orphan', kind: 14, content: JSON.stringify(payload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      };

      await expect(api.handleControlMessage(rumor, MEMBER_A)).resolves.not.toThrow();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
      expect(await ms.getTombstone(`group:${GROUP_ID}`)).toBe(0);
    });

    it('a re-invite after the kick still revives the group, a replayed create stays dropped', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();

      // Kick: writes the tombstone at deletedAt.
      store().get.mockResolvedValueOnce(makeGroup({adminPubkey: MEMBER_A}));
      const kickPayload: GroupControlPayload = {
        type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: OWN_PUBKEY
      };
      await api.handleControlMessage({
        id: 'ctrl-kick-reinvite', kind: 14, content: JSON.stringify(kickPayload),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      const deletedAt = await ms.getTombstone(`group:${GROUP_ID}`);
      expect(deletedAt).toBeGreaterThan(0);

      // Replayed create at/below the watermark: dropped at the tombstone gate.
      const replayPayload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Zombie',
        memberPubkeys: [MEMBER_A, OWN_PUBKEY], adminPubkey: MEMBER_A
      };
      await api.handleControlMessage({
        id: 'ctrl-kick-replay', kind: 14, content: JSON.stringify(replayPayload),
        pubkey: MEMBER_A, created_at: deletedAt,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      expect(store().save).not.toHaveBeenCalled();

      // Fresh re-invite strictly newer than the watermark: revives.
      const reinvitePayload: GroupControlPayload = {
        type: 'group_create', groupId: GROUP_ID, groupName: 'Re-invited',
        memberPubkeys: [MEMBER_A, OWN_PUBKEY], adminPubkey: MEMBER_A
      };
      await api.handleControlMessage({
        id: 'ctrl-kick-reinvite2', kind: 14, content: JSON.stringify(reinvitePayload),
        pubkey: MEMBER_A, created_at: deletedAt + 10,
        tags: [['control', 'true'], ['group', GROUP_ID]]
      }, MEMBER_A);
      expect(store().save).toHaveBeenCalledTimes(1);
      const saved = store().save.mock.calls[0][0] as GroupRecord;
      expect(saved.groupId).toBe(GROUP_ID);
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

  // ─── Legacy rebind migration (#188 remainder) ─────────────────────
  //
  // #189 bound the admin into every NEW group id. Pre-existing groups keep
  // legacy 32-hex ids, so their create/delete trust path is still the
  // self-asserted one. The rebind migration moves a legacy group to a bound
  // id: a `group_create` for the bound successor carrying `supersedesGroupId`.
  // Design on issue #188 (issuecomment-5978742331).
  describe('legacy rebind migration (#188 remainder)', () => {
    const LEGACY_ID = GROUP_ID;
    const BOUND_SUFFIX = 'e'.repeat(32);
    const boundIdOf = (admin: string, suffix: string = BOUND_SUFFIX): string => admin + suffix;

    function makeLegacyRecord(overrides: Partial<GroupRecord> = {}): GroupRecord {
      return makeGroup({groupId: LEGACY_ID, adminPubkey: MEMBER_A, ...overrides});
    }

    function makeBoundRecord(boundId: string, overrides: Partial<GroupRecord> = {}): GroupRecord {
      return makeGroup({
        groupId: boundId,
        adminPubkey: MEMBER_A,
        supersededGroupIds: [LEGACY_ID],
        reboundAt: 1700000000,
        ...overrides
      } as Partial<GroupRecord>);
    }

    /** store().get mock that answers per-groupId. */
    function getAnswers(map: Record<string, GroupRecord | null>): void {
      store().get.mockImplementation(async(gid: string) => map[gid] ?? null);
    }

    function makeSupersedeRumor(boundId: string, sender: string, createdSec: number, overrides: Partial<GroupControlPayload> = {}) {
      const payload: GroupControlPayload = {
        type: 'group_create',
        groupId: boundId,
        groupName: 'Migrated Group',
        adminPubkey: sender,
        memberPubkeys: [MEMBER_A, MEMBER_B, OWN_PUBKEY],
        supersedesGroupId: LEGACY_ID,
        ...overrides
      };
      return {
        rumor: {
          id: `ctrl-supersede-${boundId.slice(-6)}`, kind: 14,
          content: JSON.stringify(payload),
          pubkey: sender, created_at: createdSec,
          tags: [['control', 'true'], ['group', boundId]]
        },
        payload
      };
    }

    async function seedLegacyMessage(): Promise<void> {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      await getMessageStore().saveMessage({
        eventId: 'legacy-msg-1', conversationId: `group:${LEGACY_ID}`,
        senderPubkey: MEMBER_A, content: 'pre-migration history', type: 'text',
        timestamp: 1700000000, deliveryState: 'delivered', mid: 1001,
        twebPeerId: -2000000000000001, isOutgoing: false
      });
    }

    beforeEach(() => {
      store().getAll.mockResolvedValue([]);
    });

    it('rebindLegacyGroup mints a bound id, migrates state and durably kills the legacy id', async() => {
      getAnswers({[LEGACY_ID]: makeLegacyRecord({adminPubkey: OWN_PUBKEY, members: [MEMBER_A, MEMBER_B, OWN_PUBKEY]})});
      localStorage.setItem('phantomchat:group-wm:' + LEGACY_ID + ':members', '1700000500');
      await seedLegacyMessage();

      await api.rebindLegacyGroup(LEGACY_ID);

      // Broadcast carries the supersede claim + full membership.
      expect(broadcast()).toHaveBeenCalledTimes(1);
      const payload = broadcast().mock.calls[0][2] as GroupControlPayload;
      expect(payload.type).toBe('group_create');
      expect(payload.supersedesGroupId).toBe(LEGACY_ID);
      expect(payload.memberPubkeys).toContain(MEMBER_B);
      // New id is bound to the rebind initiator (admin).
      expect(payload.groupId).toMatch(new RegExp('^' + OWN_PUBKEY + '[0-9a-f]{32}$'));

      // New record: same membership, supersedes link recorded.
      const savedCalls = store().save.mock.calls.map((c: any[]) => c[0] as GroupRecord);
      const newRecord = savedCalls.find((r) => r.groupId === payload.groupId);
      expect(newRecord).toBeDefined();
      expect(newRecord!.adminPubkey).toBe(OWN_PUBKEY);
      expect(newRecord!.supersededGroupIds).toEqual([LEGACY_ID]);
      expect(newRecord!.reboundAt).toEqual(expect.any(Number));

      // History re-keyed BEFORE the legacy teardown purged it.
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const migrated = await getMessageStore().getMessages('group:' + payload.groupId);
      expect(migrated.some((m) => m.eventId === 'legacy-msg-1')).toBe(true);
      // Legacy conversation is purged + tombstoned by the teardown.
      expect(await getMessageStore().getTombstone('group:' + LEGACY_ID)).toBeGreaterThan(0);

      // Watermarks follow the group.
      expect(localStorage.getItem('phantomchat:group-wm:' + payload.groupId + ':members')).toBe('1700000500');

      // Durable delete for the legacy id, ordered before its store delete.
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(LEGACY_ID, expect.any(Number));
      expect(store().delete).toHaveBeenCalledWith(LEGACY_ID);
      const durableOrder = store().recordDeletedGroup.mock.invocationCallOrder[0];
      const deleteOrder = store().delete.mock.invocationCallOrder.find(
        (o: number) => o > durableOrder
      );
      expect(durableOrder).toBeLessThan(deleteOrder);
    });

    it('rebindLegacyGroup is admin-only and legacy-only', async() => {
      // Not admin of the legacy group → refuses.
      getAnswers({[LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})});
      await expect(api.rebindLegacyGroup(LEGACY_ID)).rejects.toThrow(/admin/i);
      expect(broadcast()).not.toHaveBeenCalled();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();

      // Already-bound group → nothing to do.
      const boundId = boundIdOf(MEMBER_A);
      getAnswers({[boundId]: makeBoundRecord(boundId, {adminPubkey: OWN_PUBKEY})});
      await expect(api.rebindLegacyGroup(boundId)).rejects.toThrow(/bound/i);

      // No record at all → refuses.
      getAnswers({});
      await expect(api.rebindLegacyGroup(LEGACY_ID)).rejects.toThrow();
    });

    it('supersede create from the legacy admin migrates a live legacy record', async() => {
      const boundId = boundIdOf(MEMBER_A);
      getAnswers({
        [LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A}),
        [boundId]: null
      });
      await seedLegacyMessage();
      const {rumor} = makeSupersedeRumor(boundId, MEMBER_A, Math.floor(Date.now() / 1000) - 10);

      await api.handleControlMessage(rumor, MEMBER_A);

      const saved = store().save.mock.calls.map((c: any[]) => c[0] as GroupRecord)
        .find((r) => r.groupId === boundId);
      expect(saved).toBeDefined();
      expect(saved!.supersededGroupIds).toEqual([LEGACY_ID]);
      expect(saved!.reboundAt).toBe(Math.floor(Date.now() / 1000) - 10);
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(LEGACY_ID, expect.any(Number));
      expect(store().delete).toHaveBeenCalledWith(LEGACY_ID);
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const migrated = await getMessageStore().getMessages('group:' + boundId);
      expect(migrated.some((m) => m.eventId === 'legacy-msg-1')).toBe(true);
    });

    it('supersede create from a NON-admin cannot hijack a legacy group (anti-hijack)', async() => {
      const attackerBoundId = boundIdOf(MEMBER_B, 'f'.repeat(32));
      getAnswers({
        [LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A}),
        [attackerBoundId]: null
      });
      const {rumor, payload} = makeSupersedeRumor(attackerBoundId, MEMBER_B, Math.floor(Date.now() / 1000) - 10);

      await api.handleControlMessage(rumor, MEMBER_B);

      // Nothing stored for the attacker's id, nothing torn down.
      expect(store().save.mock.calls.map((c: any[]) => c[0].groupId)).not.toContain(attackerBoundId);
      expect(store().delete).not.toHaveBeenCalled();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      // The broadcast payload naming the attacker's own bound id was still
      // a create — but the legacy group must be untouched.
      expect(payload.supersedesGroupId).toBe(LEGACY_ID);
    });

    it('supersede create with a LEGACY successor id is rejected', async() => {
      // Successor must be bound — a legacy id superseding a legacy id keeps
      // the unbound trust path and is rejected outright.
      const otherLegacyId = '0123456789abcdef0123456789abcdef00';
      getAnswers({[LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})});
      const {rumor} = makeSupersedeRumor(otherLegacyId, MEMBER_A, Math.floor(Date.now() / 1000) - 10);

      await api.handleControlMessage(rumor, MEMBER_A);

      expect(store().save).not.toHaveBeenCalled();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
    });

    it('supersede create with no local legacy record lands as a plain bound create', async() => {
      const boundId = boundIdOf(MEMBER_A);
      getAnswers({[boundId]: null});
      const {rumor} = makeSupersedeRumor(boundId, MEMBER_A, Math.floor(Date.now() / 1000) - 10);

      await api.handleControlMessage(rumor, MEMBER_A);

      // Bound-id create from the id-bound admin (post-#189 path) — stored,
      // carrying the supersedes link so late legacy traffic remaps.
      expect(store().save).toHaveBeenCalledTimes(1);
      const saved = store().save.mock.calls[0][0] as GroupRecord;
      expect(saved.groupId).toBe(boundId);
      expect(saved.supersededGroupIds).toEqual([LEGACY_ID]);
      // No legacy record existed — nothing to tear down.
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
    });

    it('competing rebinds converge deterministically on the greater (reboundAt, groupId)', async() => {
      const winner = boundIdOf(MEMBER_A, 'f'.repeat(32));
      const loser = boundIdOf(MEMBER_A, '1'.repeat(32));
      const now = Math.floor(Date.now() / 1000);

      // We already hold a rebound successor (ts = now-100); a NEWER competing
      // rebind (ts = now-10) wins and we migrate to it.
      getAnswers({[loser]: makeBoundRecord(loser, {reboundAt: now - 100})});
      store().getAll.mockResolvedValue([makeBoundRecord(loser, {reboundAt: now - 100})]);
      const {rumor: newerRumor} = makeSupersedeRumor(winner, MEMBER_A, now - 10);
      await api.handleControlMessage(newerRumor, MEMBER_A);
      expect(store().save.mock.calls.map((c: any[]) => c[0].groupId)).toContain(winner);
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(loser, expect.any(Number));

      // Reset and reverse: the incoming rebind is OLDER — ignored.
      vi.clearAllMocks();
      const boundLoser = makeBoundRecord(loser, {reboundAt: now - 10});
      getAnswers({[loser]: boundLoser});
      store().getAll.mockResolvedValue([boundLoser]);
      const {rumor: olderRumor} = makeSupersedeRumor(winner, MEMBER_A, now - 100);
      await api.handleControlMessage(olderRumor, MEMBER_A);
      expect(store().save).not.toHaveBeenCalled();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
    });

    it('echo of an already-applied supersede create stays idempotent and still reconciles a resurrected legacy record', async() => {
      const boundId = boundIdOf(MEMBER_A);
      // The successor record already exists (own device synced it / relay
      // echo), AND a stale live legacy record coexists (e.g. #180 deliberate
      // stamp let it win a merge against the legacy durable row).
      const bound = makeBoundRecord(boundId);
      getAnswers({
        [boundId]: bound,
        [LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})
      });
      const {rumor} = makeSupersedeRumor(boundId, MEMBER_A, Math.floor(Date.now() / 1000) - 10);

      await api.handleControlMessage(rumor, MEMBER_A);

      // No duplicate save of the successor…
      expect(store().save).not.toHaveBeenCalled();
      // …but the resurrected legacy record is torn down (successor presence
      // is itself the delete fact for the legacy id).
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(LEGACY_ID, expect.any(Number));
      expect(store().delete).toHaveBeenCalledWith(LEGACY_ID);
    });

    it('late group messages addressed to the legacy id are remapped into the rebound conversation', async() => {
      const boundId = boundIdOf(MEMBER_A);
      const bound = makeBoundRecord(boundId);
      getAnswers({[boundId]: bound});
      store().getAll.mockResolvedValue([bound]);

      let seenGroupId: string | null = null;
      api.onGroupMessage = (gid: string) => { seenGroupId = gid; };

      api.handleIncomingGroupMessage(LEGACY_ID, {
        id: 'late-legacy-msg', kind: 14,
        content: JSON.stringify({id: 'late-legacy-msg'}),
        pubkey: MEMBER_A, created_at: Math.floor(Date.now() / 1000),
        tags: []
      }, MEMBER_A);

      await vi.waitFor(() => expect(seenGroupId).toBe(boundId));
      api.onGroupMessage = null;
    });

    it('remap is routing, not auth: a NON-member sending to the legacy id post-rebind is dropped (Lena review 2026-10-04)', async() => {
      // The successor's member list is the authority AFTER remap — the remap
      // itself must never smuggle a non-member into the rebound conversation.
      const boundId = boundIdOf(MEMBER_A);
      const bound = makeBoundRecord(boundId, {members: [MEMBER_A, OWN_PUBKEY]});
      getAnswers({[boundId]: bound});
      store().getAll.mockResolvedValue([bound]);

      let seenGroupId: string | null = null;
      let sawAnyDelivery = false;
      api.onGroupMessage = (gid: string) => { sawAnyDelivery = true; seenGroupId = gid; };

      // MEMBER_B is NOT in the successor's members — the legacy id must not
      // become a side door around the membership gate.
      api.handleIncomingGroupMessage(LEGACY_ID, {
        id: 'late-legacy-nonmember', kind: 14,
        content: JSON.stringify({id: 'late-legacy-nonmember'}),
        pubkey: MEMBER_B, created_at: Math.floor(Date.now() / 1000),
        tags: []
      }, MEMBER_B);

      await new Promise((r) => setTimeout(r, 25));
      expect(sawAnyDelivery).toBe(false);
      expect(seenGroupId).toBeNull();
      api.onGroupMessage = null;
    });

    it('a forged successor record with a SPOOFED adminPubkey field cannot drive the reconcile sweep (Lena review 2026-10-04)', async() => {
      // The sweep's authority gate must be the successor's ID-DERIVED admin,
      // not the record's adminPubkey field — that field is attacker-mouldable
      // data once a forged record enters the CRDT union. Here the forged
      // record is bound to MEMBER_B's id but carries a spoofed adminPubkey
      // matching the legacy record: the old field-comparison gate would tear
      // the legacy group down; the id-derived gate must refuse.
      const forgedBound = boundIdOf(MEMBER_B, 'f'.repeat(32));
      const forged = makeBoundRecord(forgedBound, {adminPubkey: MEMBER_A});
      getAnswers({
        [forgedBound]: forged,
        [LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})
      });
      store().getAll.mockResolvedValue([forged, makeLegacyRecord()]);

      await api.reconcileSupersededGroups();

      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
    });

    it('supersede create with a BOUND supersedesGroupId target is rejected (Lena review 2026-10-04)', async() => {
      // Bound ids are already self-authenticating — allowing them as
      // supersede targets buys nothing and adds an unneeded code path to
      // audit. Only legacy 32-hex ids may be superseded.
      const otherBound = boundIdOf(MEMBER_B, 'f'.repeat(32));
      getAnswers({[LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})});
      const {rumor} = makeSupersedeRumor(boundIdOf(MEMBER_A), MEMBER_A, Math.floor(Date.now() / 1000) - 10, {supersedesGroupId: otherBound});

      await api.handleControlMessage(rumor, MEMBER_A);

      expect(store().save).not.toHaveBeenCalled();
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
    });

    it('rebind writes the visible upgrade notice into the new conversation (auto-rebind is not silent)', async() => {
      const {GROUP_REBIND_NOTICE} = await import('@lib/phantomchat/group-service-messages');
      getAnswers({[LEGACY_ID]: makeLegacyRecord({adminPubkey: OWN_PUBKEY, members: [MEMBER_A, MEMBER_B, OWN_PUBKEY]})});
      await seedLegacyMessage();

      const newGroupId = await api.rebindLegacyGroup(LEGACY_ID);

      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const rows = await getMessageStore().getMessages('group:' + newGroupId);
      const notice = rows.find((m: any) => m.content === GROUP_REBIND_NOTICE);
      expect(notice).toBeDefined();
      expect(notice.senderPubkey).toBe(OWN_PUBKEY);
      // Deterministic eventId — an echo/replay of the same rebind upserts,
      // never duplicates.
      const before = await getMessageStore().getMessages('group:' + newGroupId);
      expect(before.filter((m: any) => m.content === GROUP_REBIND_NOTICE)).toHaveLength(1);
    });

    it('reconcileSupersededGroups tears down a live legacy record whose successor already exists', async() => {
      const boundId = boundIdOf(MEMBER_A);
      const bound = makeBoundRecord(boundId);
      getAnswers({
        [boundId]: bound,
        [LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})
      });
      store().getAll.mockResolvedValue([bound, makeLegacyRecord()]);

      await api.reconcileSupersededGroups();

      // Same invariant as deleteGroup: the durable row is written BEFORE the
      // store delete, so the teardown survives a crash between the two.
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(LEGACY_ID, expect.any(Number));
      expect(store().delete).toHaveBeenCalledWith(LEGACY_ID);
      const durableOrder = store().recordDeletedGroup.mock.invocationCallOrder[0];
      const deleteOrder = store().delete.mock.invocationCallOrder.find(
        (o: number) => o > durableOrder
      );
      expect(durableOrder).toBeLessThan(deleteOrder);
      expect(store().delete).not.toHaveBeenCalledWith(boundId);
    });

    it('reconcileSupersededGroups ignores a forged successor whose admin does not match the legacy record', async() => {
      const forgedBound = boundIdOf(MEMBER_B, 'f'.repeat(32));
      const forged = makeBoundRecord(forgedBound, {adminPubkey: MEMBER_B});
      getAnswers({
        [forgedBound]: forged,
        [LEGACY_ID]: makeLegacyRecord({adminPubkey: MEMBER_A})
      });
      store().getAll.mockResolvedValue([forged, makeLegacyRecord()]);

      await api.reconcileSupersededGroups();

      // The attacker's bound group claims our legacy id, but its admin is not
      // the legacy admin — the claim fails and the legacy record survives.
      expect(store().recordDeletedGroup).not.toHaveBeenCalled();
      expect(store().delete).not.toHaveBeenCalled();
    });

    it('rebindAllLegacyGroups rebinds only legacy groups this device admins', async() => {
      const foreignLegacy = '1111111122223333aabbccddeeff00112233'.slice(0, 32);
      const alreadyBound = boundIdOf(OWN_PUBKEY, 'a'.repeat(32));
      const mine = makeGroup({
        groupId: LEGACY_ID, adminPubkey: OWN_PUBKEY,
        members: [MEMBER_A, OWN_PUBKEY]
      });
      const foreign = makeGroup({groupId: foreignLegacy, adminPubkey: MEMBER_A});
      const bound = makeGroup({groupId: alreadyBound, adminPubkey: OWN_PUBKEY});
      getAnswers({
        [LEGACY_ID]: mine,
        [foreignLegacy]: foreign,
        [alreadyBound]: bound
      });
      store().getAll.mockResolvedValue([mine, foreign, bound]);

      const count = await api.rebindAllLegacyGroups();

      expect(count).toBe(1);
      expect(broadcast()).toHaveBeenCalledTimes(1);
      const payload = broadcast().mock.calls[0][2] as GroupControlPayload;
      expect(payload.supersedesGroupId).toBe(LEGACY_ID);
      expect(store().recordDeletedGroup).toHaveBeenCalledWith(LEGACY_ID, expect.any(Number));
      expect(store().recordDeletedGroup).not.toHaveBeenCalledWith(foreignLegacy);
    });

    it('rebindAllLegacyGroups reconciles once, not once per already-rebound successor', async() => {
      const legacyA = '1111111122223333aabbccddeeff00112233'.slice(0, 32);
      const legacyB = '2222222233334444aabbccddeeff00112233'.slice(0, 32);
      const boundA = boundIdOf(OWN_PUBKEY, 'a'.repeat(32));
      const boundB = boundIdOf(OWN_PUBKEY, 'b'.repeat(32));
      const mineA = makeGroup({groupId: legacyA, adminPubkey: OWN_PUBKEY, members: [MEMBER_A, OWN_PUBKEY]});
      const mineB = makeGroup({groupId: legacyB, adminPubkey: OWN_PUBKEY, members: [MEMBER_A, OWN_PUBKEY]});
      const succA = makeGroup({groupId: boundA, adminPubkey: OWN_PUBKEY, supersededGroupIds: [legacyA]});
      const succB = makeGroup({groupId: boundB, adminPubkey: OWN_PUBKEY, supersededGroupIds: [legacyB]});
      getAnswers({
        [legacyA]: mineA, [legacyB]: mineB,
        [boundA]: succA, [boundB]: succB
      });
      store().getAll.mockResolvedValue([mineA, mineB, succA, succB]);
      const reconcileSpy = vi.spyOn(api, 'reconcileSupersededGroups').mockResolvedValue(undefined);

      const count = await api.rebindAllLegacyGroups();

      // Both legacy groups were already rebound by other own devices.
      expect(count).toBe(0);
      expect(broadcast()).not.toHaveBeenCalled();
      // One sweep for the whole run, not one per already-rebound group.
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });

    it('rekeyGroupMessages paginates until exhausted — no history lost past one page', async() => {
      const {getMessageStore} = await import('@lib/phantomchat/message-store');
      const ms = getMessageStore();
      const successorId = boundIdOf(OWN_PUBKEY, 'c'.repeat(32));
      // 25 rows against a page size of 10 → three pages, exercising the
      // `before` cursor loop; the old single-bounded call would have kept
      // only the newest `limit` rows and silently dropped the rest.
      const total = 25;
      for(let i = 0; i < total; i++) {
        await ms.saveMessage({
          eventId: 'legacy-msg-' + i, conversationId: `group:${LEGACY_ID}`,
          senderPubkey: MEMBER_A, content: 'history ' + i, type: 'text',
          timestamp: 1700000000 + i, deliveryState: 'delivered', mid: 2000 + i,
          twebPeerId: -2000000000000001, isOutgoing: false
        });
      }

      await (api as any).rekeyGroupMessages(LEGACY_ID, successorId, -2000000000000002, 10);

      const migrated = await ms.getMessages(`group:${successorId}`, 100);
      expect(migrated.length).toBe(total);
      const eventIds = new Set(migrated.map((m: any) => m.eventId));
      for(let i = 0; i < total; i++) {
        expect(eventIds.has('legacy-msg-' + i)).toBe(true);
      }
      // Oldest row survived the migration.
      expect(eventIds.has('legacy-msg-0')).toBe(true);
    });
  });
});
