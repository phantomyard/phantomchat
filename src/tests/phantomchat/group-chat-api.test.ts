import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord} from '@lib/phantomchat/group-types';
import type {DeliveryState} from '@lib/phantomchat/delivery-tracker';

// ─── Hoisted mock state ─────────────────────────────────────────

const mockGroupStore = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  getByPeerId: vi.fn(),
  getAll: vi.fn(),
  delete: vi.fn(),
  updateMembers: vi.fn(),
  updateInfo: vi.fn(),
  destroy: vi.fn()
}));

const mockWrapGroupMessage = vi.hoisted(() => vi.fn());
const mockBroadcastGroupControl = vi.hoisted(() => vi.fn());

// ─── Module-level vi.mock (hoisted) ─────────────────────────────

vi.mock('@lib/phantomchat/group-store', () => ({
  GroupStore: vi.fn(() => mockGroupStore),
  getGroupStore: () => mockGroupStore
}));

vi.mock('@lib/phantomchat/nostr-crypto', () => ({
  wrapGroupMessage: (...args: any[]) => mockWrapGroupMessage(...args),
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
  broadcastGroupControl: (...args: any[]) => mockBroadcastGroupControl(...args),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
});

vi.mock('@lib/phantomchat/phantomchat-groups-sync', () => ({
  handleGroupIncoming: vi.fn().mockResolvedValue(undefined),
  handleGroupOutgoing: vi.fn().mockResolvedValue(undefined),
  injectGroupCreateDialog: vi.fn().mockResolvedValue(undefined),
  cleanupGroupChatInjection: vi.fn().mockResolvedValue(undefined),
  ensureGroupChatInjected: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
}));

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

// ─── Dynamic module loading ────────────────────────────────────

let GroupAPI: any;
let computeAggregateState: any;
let GroupDeliveryTracker: any;

beforeAll(async() => {
  // Re-register mocks via doMock to override contamination from other
  // files (e.g. group-management.test.ts registers a different
  // group-store mock factory; whichever runs first wins).
  vi.resetModules();

  vi.doMock('@lib/phantomchat/group-store', () => ({
    GroupStore: vi.fn(() => mockGroupStore),
    getGroupStore: () => mockGroupStore
  }));
  vi.doMock('@lib/phantomchat/nostr-crypto', () => ({
    wrapGroupMessage: (...args: any[]) => mockWrapGroupMessage(...args),
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
    broadcastGroupControl: (...args: any[]) => mockBroadcastGroupControl(...args),
    wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
  }));
  vi.doMock('@lib/phantomchat/group-types', async() => {
    const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
    return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
  });
  vi.doMock('@lib/phantomchat/phantomchat-groups-sync', () => ({
    handleGroupIncoming: vi.fn().mockResolvedValue(undefined),
    handleGroupOutgoing: vi.fn().mockResolvedValue(undefined),
    injectGroupCreateDialog: vi.fn().mockResolvedValue(undefined),
    cleanupGroupChatInjection: vi.fn().mockResolvedValue(undefined),
    ensureGroupChatInjected: vi.fn().mockResolvedValue(undefined)
  }));
  vi.doMock('@lib/rootScope', () => ({
    default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
  }));
  vi.doMock('@lib/logger', () => ({
    Logger: class {},
    logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
  }));

  const apiMod = await import('@lib/phantomchat/group-api');
  GroupAPI = apiMod.GroupAPI;

  const trackerMod = await import('@lib/phantomchat/group-delivery-tracker');
  computeAggregateState = trackerMod.computeAggregateState;
  GroupDeliveryTracker = trackerMod.GroupDeliveryTracker;
});

// Pubkeys must be canonical NIP-01 form: 64-char lowercase hex (validated by
// group-api SECP_PUBKEY_HEX_RE). Mnemonic placeholders like 'membera…' contain
// non-hex chars (m, r, …) and are correctly rejected — use valid hex fixtures.
const OWN_PUBKEY = 'd'.repeat(64);
const OWN_SK = new Uint8Array(32).fill(1);
const MEMBER_A = 'a'.repeat(64);
const MEMBER_B = 'b'.repeat(64);

describe('GroupAPI', () => {
  let api: any;
  let publishedEvents: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    publishedEvents = [];

    mockGroupStore.save.mockResolvedValue(undefined);
    mockGroupStore.get.mockResolvedValue(null);
    mockGroupStore.delete.mockResolvedValue(undefined);
    mockGroupStore.updateMembers.mockResolvedValue(undefined);

    mockBroadcastGroupControl.mockReturnValue([
      {id: 'ctrl-1', kind: 1059, content: 'ctrl', pubkey: 'eph', created_at: 1000, tags: [], sig: 'sig'}
    ]);
    mockWrapGroupMessage.mockReturnValue({
      wraps: [
        {id: 'wrap-1', kind: 1059}, {id: 'wrap-2', kind: 1059}, {id: 'wrap-3', kind: 1059}
      ],
      rumorId: 'rumor-default'
    });

    const publishFn = async(events: any[]) => { publishedEvents.push(...events); };
    api = new GroupAPI(OWN_PUBKEY, OWN_SK, publishFn);
  });

  it('Test 1: createGroup stores GroupRecord and returns groupId', async() => {
    const groupId = await api.createGroup('Test Group', [MEMBER_A, MEMBER_B]);
    expect(groupId).toBeTruthy();
    expect(typeof groupId).toBe('string');
    expect(mockGroupStore.save).toHaveBeenCalledTimes(1);
    const saved = mockGroupStore.save.mock.calls[0][0] as GroupRecord;
    expect(saved.name).toBe('Test Group');
    expect(saved.adminPubkey).toBe(OWN_PUBKEY);
    expect(saved.members).toContain(MEMBER_A);
    expect(saved.members).toContain(MEMBER_B);
  });

  it('#180: createGroup stamps the deliberate-add proof on the created record', async() => {
    // Only the creator's own gesture may mint this stamp — it is what lets
    // the group clear a durable delete in the groups CRDT merge. The receive
    // path (handleGroupCreate) deliberately does not stamp.
    await api.createGroup('Test Group', [MEMBER_A, MEMBER_B]);
    const saved = mockGroupStore.save.mock.calls[0][0] as GroupRecord;
    expect(typeof saved.deliberateAddAt).toBe('number');
    expect(saved.deliberateAddAt! > 0).toBe(true);
  });

  it('Test 2: createGroup broadcasts group_create control message', async() => {
    await api.createGroup('Test Group', [MEMBER_A, MEMBER_B]);
    expect(mockBroadcastGroupControl).toHaveBeenCalledTimes(1);
    const [sk, members, payload] = mockBroadcastGroupControl.mock.calls[0];
    expect(sk).toBe(OWN_SK);
    expect(members).toContain(MEMBER_A);
    expect(members).toContain(MEMBER_B);
    expect(payload.type).toBe('group_create');
    expect(payload.groupName).toBe('Test Group');
    expect(publishedEvents.length).toBeGreaterThan(0);
  });

  it('Test 3: sendMessage calls wrapGroupMessage with members', async() => {
    const groupId = 'abc123def456abc123def456abc123de00';
    mockGroupStore.get.mockResolvedValueOnce({
      groupId, name: 'G', adminPubkey: OWN_PUBKEY,
      members: [MEMBER_A, MEMBER_B, OWN_PUBKEY], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord);

    await api.sendMessage(groupId, 'Hello group!');
    expect(mockWrapGroupMessage).toHaveBeenCalledTimes(1);
    const [sk, members, content, gId] = mockWrapGroupMessage.mock.calls[0];
    expect(sk).toBe(OWN_SK);
    expect(members).toContain(MEMBER_A);
    expect(members).toContain(MEMBER_B);
    expect(content).toContain('Hello group!');
    expect(gId).toBe(groupId);
  });

  it('Test 4: sendMessage publishes N+1 events', async() => {
    const groupId = 'abc123def456abc123def456abc123de00';
    mockGroupStore.get.mockResolvedValueOnce({
      groupId, name: 'G', adminPubkey: OWN_PUBKEY,
      members: [MEMBER_A, MEMBER_B, OWN_PUBKEY], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord);
    mockWrapGroupMessage.mockReturnValueOnce({
      wraps: [{id: 'w1'}, {id: 'w2'}, {id: 'w3'}],
      rumorId: 'rumor-test4'
    });

    await api.sendMessage(groupId, 'Test');
    expect(publishedEvents.length).toBe(3);
  });

  it('Test 5: incoming rumor with group tag routes to group handler', () => {
    const handleSpy = vi.spyOn(api, 'handleIncomingGroupMessage');
    const rumor = {id: 'r1', kind: 14, content: '{}', pubkey: MEMBER_A,
      created_at: 0, tags: [['group', 'g1'], ['p', OWN_PUBKEY]]};
    api.handleIncomingGroupMessage('g1', rumor, MEMBER_A);
    expect(handleSpy).toHaveBeenCalledWith('g1', rumor, MEMBER_A);
  });

  it('Test 6: control message handled without delivery receipt', async() => {
    const rumor = {id: 'c1', kind: 14,
      content: JSON.stringify({type: 'group_create', groupId: 'g1'}),
      pubkey: MEMBER_A, created_at: 0,
      tags: [['control', 'true'], ['group', 'g1']]};
    publishedEvents = [];
    await api.handleControlMessage(rumor, MEMBER_A);
    expect(true).toBe(true); // No crash = success
  });

  it('Test 7: self-send dedup prevents duplicate display', async() => {
    const groupId = 'abc123def456abc123def456abc123de00';
    mockGroupStore.get.mockResolvedValue({
      groupId, name: 'G', adminPubkey: OWN_PUBKEY,
      members: [MEMBER_A, MEMBER_B, OWN_PUBKEY], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord);
    mockWrapGroupMessage.mockReturnValueOnce({
      wraps: [{id: 'w1'}, {id: 'w2'}, {id: 'w3'}],
      rumorId: 'rumor-test7'
    });

    const {messageId} = await api.sendMessage(groupId, 'Hello!');

    let handlerCalls = 0;
    api.onGroupMessage = () => { handlerCalls++; };

    // Simulate self-send gift-wrap arriving back
    api.handleIncomingGroupMessage(groupId, {
      id: messageId, kind: 14,
      content: JSON.stringify({content: 'Hello!', type: 'text', id: messageId}),
      pubkey: OWN_PUBKEY, created_at: 0,
      tags: [['group', groupId]]
    }, OWN_PUBKEY);

    expect(handlerCalls).toBe(0); // Deduped
  });
  // ─── #188: group ids bound to the admin (two-message forgery closed) ────
  //
  // A group_create carries adminPubkey in its own payload — self-asserted.
  // On a device with no local record, an attacker who knows a group id could
  // forge create(admin=self) + delete(self) and manufacture a DURABLE
  // cross-device delete for a group this device never held. New ids bind the
  // admin: `<64-hex adminPubkey><32-hex random>`; receivers verify against the
  // id, not the payload.

  const BOUND_ADMIN = MEMBER_A; // the admin baked into the id
  const ATTACKER = MEMBER_B;
  const boundId = BOUND_ADMIN + '0123456789abcdef0123456789abcdef';

  const controlRumor = (payload: Record<string, unknown>, sender: string) => ({
    id: 'c-' + Math.random().toString(36).slice(2),
    kind: 14,
    content: JSON.stringify(payload),
    pubkey: sender,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['control', 'true'], ['group', String(payload.groupId)]]
  });

  it('createGroup mints an id that binds the creator as admin', async() => {
    const groupId = await api.createGroup('G', [MEMBER_A]);
    expect(groupId).toMatch(new RegExp('^' + OWN_PUBKEY + '[0-9a-f]{32}$'));
  });

  it('a forged create (sender ≠ id-bound admin) is rejected — nothing stored', async() => {
    const rumor = controlRumor({type: 'group_create', groupId: boundId, adminPubkey: ATTACKER}, ATTACKER);
    await api.handleControlMessage(rumor, ATTACKER);
    expect(mockGroupStore.save).not.toHaveBeenCalled();
  });

  it('the two-message forgery (create + delete) writes no durable delete', async() => {
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    // Message 1: forged create naming the attacker admin.
    const create = controlRumor({type: 'group_create', groupId: boundId, adminPubkey: ATTACKER}, ATTACKER);
    await api.handleControlMessage(create, ATTACKER);
    // Message 2: the attacker's own delete.
    const del = controlRumor({type: 'group_delete', groupId: boundId}, ATTACKER);
    await api.handleControlMessage(del, ATTACKER);
    expect(mockGroupStore.save).not.toHaveBeenCalled();
    expect(teardownSpy).not.toHaveBeenCalled();
    teardownSpy.mockRestore();
  });

  it('a legit create from the id-bound admin stores the id-bound admin, not the payload claim', async() => {
    const rumor = controlRumor({type: 'group_create', groupId: boundId, adminPubkey: ATTACKER}, BOUND_ADMIN);
    await api.handleControlMessage(rumor, BOUND_ADMIN);
    expect(mockGroupStore.save).toHaveBeenCalledTimes(1);
    const saved = mockGroupStore.save.mock.calls[0][0] as GroupRecord;
    // The id is the authority — a lying payload cannot register a foreign admin.
    expect(saved.adminPubkey).toBe(BOUND_ADMIN);
  });

  it('a legit delete from the id-bound admin still tears down', async() => {
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    mockGroupStore.get.mockResolvedValueOnce({
      groupId: boundId, name: 'G', adminPubkey: BOUND_ADMIN,
      members: [BOUND_ADMIN, OWN_PUBKEY], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord);
    const del = controlRumor({type: 'group_delete', groupId: boundId}, BOUND_ADMIN);
    await api.handleControlMessage(del, BOUND_ADMIN);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    teardownSpy.mockRestore();
  });

  // ─── Kai's round-3 review blocker: the id binding must authenticate
  // CREATE, never freeze DELETE authority. transferAdmin() and
  // handleMemberLeave() legitimately move adminPubkey off the id-bound
  // creator; a bound-key check on the delete path made every bound group
  // undeletable after any admin change (new admin fails the bound key,
  // original creator passes it only to fail the stored-admin check).

  it('after group_admin_transfer the NEW admin can delete (bound id, live record)', async() => {
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    const NEW_ADMIN = MEMBER_B;
    const live = {
      groupId: boundId, name: 'G', adminPubkey: BOUND_ADMIN,
      members: [BOUND_ADMIN, NEW_ADMIN], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord;
    // The transfer handler mutates the record and saves it — the store
    // mock then serves the updated record to the delete handler.
    mockGroupStore.get.mockResolvedValueOnce(live);
    const transfer = controlRumor({type: 'group_admin_transfer', groupId: boundId, adminPubkey: NEW_ADMIN}, BOUND_ADMIN);
    await api.handleControlMessage(transfer, BOUND_ADMIN);
    expect(mockGroupStore.save).toHaveBeenCalledTimes(1);
    expect((mockGroupStore.save.mock.calls[0][0] as GroupRecord).adminPubkey).toBe(NEW_ADMIN);

    const del = controlRumor({type: 'group_delete', groupId: boundId}, NEW_ADMIN);
    // handleAdminTransfer mutated `live` in place (adminPubkey = NEW_ADMIN)
    // — serve that updated record to the delete handler.
    mockGroupStore.get.mockResolvedValueOnce(live);
    await api.handleControlMessage(del, NEW_ADMIN);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    teardownSpy.mockRestore();
  });

  it('after admin transfer the ORIGINAL id-bound creator can no longer delete', async() => {
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    // Record reflects the completed transfer: current admin = MEMBER_B.
    mockGroupStore.get.mockResolvedValueOnce({
      groupId: boundId, name: 'G', adminPubkey: MEMBER_B,
      members: [BOUND_ADMIN, MEMBER_B], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord);
    const del = controlRumor({type: 'group_delete', groupId: boundId}, BOUND_ADMIN);
    await api.handleControlMessage(del, BOUND_ADMIN);
    expect(teardownSpy).not.toHaveBeenCalled();
    teardownSpy.mockRestore();
  });

  it('after admin-leave auto-promotion the promoted member can delete (bound id)', async() => {
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    // Members sorted lex-asc: the admin leaves, MEMBER_B is auto-promoted
    // (handleMemberLeave), then the promoted admin deletes the group.
    const live = {
      groupId: boundId, name: 'G', adminPubkey: BOUND_ADMIN,
      members: [BOUND_ADMIN, MEMBER_B, OWN_PUBKEY], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord;
    mockGroupStore.get.mockResolvedValueOnce(live);
    const leave = controlRumor({type: 'group_leave', groupId: boundId}, BOUND_ADMIN);
    await api.handleControlMessage(leave, BOUND_ADMIN);
    expect(mockGroupStore.save).toHaveBeenCalledTimes(1);
    const promoted = mockGroupStore.save.mock.calls[0][0] as GroupRecord;
    expect(promoted.adminPubkey).toBe(MEMBER_B);

    const del = controlRumor({type: 'group_delete', groupId: boundId}, MEMBER_B);
    // handleMemberLeave saved a NEW record object — serve its shape.
    mockGroupStore.get.mockResolvedValueOnce({
      groupId: boundId, name: 'G', adminPubkey: MEMBER_B,
      members: [MEMBER_B, OWN_PUBKEY], peerId: -2e15,
      createdAt: Date.now(), updatedAt: Date.now()
    } as GroupRecord);
    await api.handleControlMessage(del, MEMBER_B);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    teardownSpy.mockRestore();
  });

  it('no-record bound id: a forged delete stages nothing — direct quarantine pin', async() => {
    // DIRECT PIN (Kai, #190): the earlier version passed via the create-side
    // rejection only (the forged create replay never verified the quarantined
    // delete), so it would NOT fail if the delete-side no-record bound check
    // in handleGroupDelete were dropped. The check is quarantine hygiene
    // (defense-in-depth, not the authentication gate) — but a dropped check
    // must fail here, so the quarantine map is asserted on directly.
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    mockGroupStore.get.mockResolvedValue(null); // no record, ever
    const del = controlRumor({type: 'group_delete', groupId: boundId}, ATTACKER);
    await api.handleControlMessage(del, ATTACKER);
    const stagedForGroup = [...(api as any)['pendingGroupDeletes'].values()]
      .filter(p => p.groupId === boundId);
    expect(stagedForGroup).toHaveLength(0);
    // Robert's stronger shape (#190): the BOUND admin's own create replay is
    // legitimate — it saves a live record while the quarantine still holds
    // nothing to promote for this group.
    const create = controlRumor({type: 'group_create', groupId: boundId}, BOUND_ADMIN);
    await api.handleControlMessage(create, BOUND_ADMIN);
    expect(mockGroupStore.save).toHaveBeenCalledTimes(1);
    const saved = mockGroupStore.save.mock.calls[0][0] as GroupRecord;
    expect(saved.adminPubkey).toBe(BOUND_ADMIN);
    const stagedAfterCreate = [...(api as any)['pendingGroupDeletes'].values()]
      .filter(p => p.groupId === boundId);
    expect(stagedAfterCreate).toHaveLength(0);
    expect(teardownSpy).not.toHaveBeenCalled();
    teardownSpy.mockRestore();
  });

  it('reordered backlog after transfer: the new admin\'s delete on a no-record device is dropped, not re-applied (#190 divergence pin)', async() => {
    // Backlog replay in the worst order (Robert, #190): the new admin's
    // delete, then the create, then the transfer. The new admin's delete
    // cannot be authenticated against the id (sender ≠ bound key, no
    // record) and is rejected + unstaged — nothing re-sends it, so after
    // the create + transfer replay this device keeps a LIVE record for a
    // group the fleet has since deleted. Fail-closed is the accepted cost
    // (see the ACCEPTED DIVERGENCE note in handleGroupDelete); pinning it
    // here so nobody "fixes" the drop by loosening the fail-closed check.
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    const NEW_ADMIN = MEMBER_B;
    mockGroupStore.get.mockResolvedValue(null); // no record before the create
    const newAdminDel = controlRumor({type: 'group_delete', groupId: boundId}, NEW_ADMIN);
    await api.handleControlMessage(newAdminDel, NEW_ADMIN);
    const create = controlRumor({type: 'group_create', groupId: boundId}, BOUND_ADMIN);
    await api.handleControlMessage(create, BOUND_ADMIN);
    // Serve the just-saved record to the transfer handler (it mutates + saves).
    mockGroupStore.get.mockResolvedValueOnce(mockGroupStore.save.mock.calls[0][0] as GroupRecord);
    const transfer = controlRumor({type: 'group_admin_transfer', groupId: boundId, adminPubkey: NEW_ADMIN}, BOUND_ADMIN);
    await api.handleControlMessage(transfer, BOUND_ADMIN);
    // The delete was never re-applied and never will be: no teardown, and
    // the record stays live with the transferred admin.
    expect(teardownSpy).not.toHaveBeenCalled();
    expect(mockGroupStore.save).toHaveBeenCalledTimes(2);
    expect((mockGroupStore.save.mock.calls[1][0] as GroupRecord).adminPubkey).toBe(NEW_ADMIN);
    const stagedForGroup = [...(api as any)['pendingGroupDeletes'].values()]
      .filter(p => p.groupId === boundId);
    expect(stagedForGroup).toHaveLength(0);
    teardownSpy.mockRestore();
  });

  it('#182 close-out: a concurrent forged-delete flood cannot evict the pending admin delete the quarantine holds', async() => {
    // For a bound id, a delete from a sender ≠ the id-bound key is
    // permanently unpromotable (the only create that can verify a
    // quarantined delete mints admin = the bound key), so it must never be
    // staged. Staging it gave an attacker the eviction lever: 512+
    // concurrent forged deletes transiently occupied the bounded map and
    // its oldest-received eviction dropped the admin's own pending delete,
    // which a reordered create could then no longer promote — the group
    // resurrected on this device instead of being torn down.
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    mockGroupStore.get.mockResolvedValue(null); // no record, ever
    const ts = Math.floor(Date.now() / 1000);

    // 1) The id-bound admin's delete arrives during backlog replay, before
    //    this device holds any record → quarantined, awaiting its create.
    const legitDel = controlRumor({type: 'group_delete', groupId: boundId}, BOUND_ADMIN);
    legitDel.created_at = ts;
    await api.handleControlMessage(legitDel, BOUND_ADMIN);

    // 2) 520 concurrent forged deletes from distinct senders — none can
    //    ever authenticate. Gate the store lookup so the whole flood is
    //    in flight at once: the production concurrency shape, since
    //    control handlers interleave during backlog replay.
    let release!: (v: null) => void;
    const gate = new Promise<null>((r) => release = r);
    mockGroupStore.get.mockImplementation(() => gate);
    const flood = Array.from({length: 520},(_, i) => {
      const sender = (i + 1).toString(16).padStart(64, '0');
      return api.handleControlMessage(controlRumor({type: 'group_delete', groupId: boundId}, sender), sender);
    });
    // Let every flood handler run to its (gated) store lookup.
    await new Promise((r) => setTimeout(r, 50));

    // 3) Release. Pre-fix, the 520 transiently staged entries had already
    //    evicted the oldest-received legit fact; the fix never stages them.
    release(null);
    await Promise.all(flood);

    // 4) The admin's create finally arrives (relay reorder) and must still
    //    find its pending delete → teardown, not resurrection.
    mockGroupStore.get.mockResolvedValue(null);
    const create = controlRumor({type: 'group_create', groupId: boundId}, BOUND_ADMIN);
    create.created_at = ts;
    await api.handleControlMessage(create, BOUND_ADMIN);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    expect(mockGroupStore.save).not.toHaveBeenCalled();
    teardownSpy.mockRestore();
  });

  it('#193: a self-bound-id flood can evict only that sender\'s pending deletes', async() => {
    const teardownSpy = vi.spyOn(api as any, 'teardownGroupLocally').mockResolvedValue(undefined);
    mockGroupStore.get.mockResolvedValue(null);
    const ts = Math.floor(Date.now() / 1000);

    // A legitimate admin delete races ahead of its create and waits in the
    // quarantine for that create to authenticate it.
    const legitDel = controlRumor({type: 'group_delete', groupId: boundId}, BOUND_ADMIN);
    legitDel.created_at = ts;
    await api.handleControlMessage(legitDel, BOUND_ADMIN);

    // One attacker can mint unlimited ids bound to its own key, so every one
    // of these deletes is promotable in principle and passes the stage gate.
    // Before #193, the global oldest-first cap let this sequential flood
    // evict the unrelated legitimate fact above.
    for(let i = 0; i < 520; i++) {
      const attackerGroupId = ATTACKER + i.toString(16).padStart(32, '0');
      const del = controlRumor({type: 'group_delete', groupId: attackerGroupId}, ATTACKER);
      del.created_at = ts;
      await api.handleControlMessage(del, ATTACKER);
    }

    const pending = [...(api as any)['pendingGroupDeletes'].values()];
    expect(pending.some(p => p.groupId === boundId && p.senderPubkey === BOUND_ADMIN)).toBe(true);
    expect(pending.filter(p => p.senderPubkey === ATTACKER)).toHaveLength(32);

    // The reordered create still consumes the legitimate delete and tears the
    // group down instead of resurrecting it.
    const create = controlRumor({type: 'group_create', groupId: boundId}, BOUND_ADMIN);
    create.created_at = ts;
    await api.handleControlMessage(create, BOUND_ADMIN);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    expect(mockGroupStore.save).not.toHaveBeenCalled();
    teardownSpy.mockRestore();
  });

  it('#193: the global quarantine bound rejects newcomers without cross-sender eviction', () => {
    const remember = (groupId: string, sender: string) =>
      (api as any)['rememberPendingGroupDelete'](groupId, sender, 1);

    // Sixteen full sender slices fill the 512-entry global budget.
    for(let senderIndex = 1; senderIndex <= 16; senderIndex++) {
      const sender = senderIndex.toString(16).padStart(64, '0');
      for(let groupIndex = 0; groupIndex < 32; groupIndex++) {
        remember(`${senderIndex}:${groupIndex}`, sender);
      }
    }

    const pending = (api as any)['pendingGroupDeletes'] as Map<string, unknown>;
    const protectedKey = `1:0:${'1'.padStart(64, '0')}`;
    expect(pending.size).toBe(512);
    expect(pending.has(protectedKey)).toBe(true);

    // A seventeenth sender cannot displace an existing sender's fact.
    const newcomer = '11'.padStart(64, '0');
    remember('newcomer', newcomer);
    expect(pending.size).toBe(512);
    expect(pending.has(protectedKey)).toBe(true);
    expect(pending.has(`newcomer:${newcomer}`)).toBe(false);

    // An existing sender may still rotate its own oldest fact at capacity.
    const rotatingSender = '10'.padStart(64, '0');
    remember('rotated', rotatingSender);
    expect(pending.size).toBe(512);
    expect(pending.has(protectedKey)).toBe(true);
    expect(pending.has(`16:0:${rotatingSender}`)).toBe(false);
    expect(pending.has(`rotated:${rotatingSender}`)).toBe(true);
  });

  it('legacy 32-hex ids keep pre-#188 behavior (payload admin accepted)', async() => {
    const legacyId = 'abc123def456abc123def456abc123de';
    const rumor = controlRumor({type: 'group_create', groupId: legacyId, adminPubkey: ATTACKER}, ATTACKER);
    await api.handleControlMessage(rumor, ATTACKER);
    expect(mockGroupStore.save).toHaveBeenCalledTimes(1);
    const saved = mockGroupStore.save.mock.calls[0][0] as GroupRecord;
    expect(saved.adminPubkey).toBe(ATTACKER);
  });
});

describe('GroupDeliveryTracker', () => {
  it('Test 8: read only when ALL read', () => {
    expect(computeAggregateState({a: 'read', b: 'read'})).toBe('read');
  });

  it('Test 9: delivered when all delivered or read', () => {
    expect(computeAggregateState({a: 'delivered', b: 'read'})).toBe('delivered');
  });

  it('Test 10: sent when at least one sent', () => {
    expect(computeAggregateState({a: 'sent', b: 'delivered'})).toBe('sent');
  });

  it('sending when empty', () => {
    expect(computeAggregateState({})).toBe('sending');
  });

  it('tracker tracks per-member states', () => {
    const tracker = new GroupDeliveryTracker();
    tracker.initMessage('m1', 'g1', ['a', 'b']);
    expect(tracker.getInfo('m1')!.memberStates['a']).toBe('sending');
    expect(tracker.updateMemberState('m1', 'a', 'delivered')).toBe('sent');
    expect(tracker.updateMemberState('m1', 'b', 'delivered')).toBe('delivered');
  });
});
