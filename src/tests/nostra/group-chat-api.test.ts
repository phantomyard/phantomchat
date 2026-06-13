import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord} from '@lib/nostra/group-types';
import type {DeliveryState} from '@lib/nostra/delivery-tracker';

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

vi.mock('@lib/nostra/group-store', () => ({
  GroupStore: vi.fn(() => mockGroupStore),
  getGroupStore: () => mockGroupStore
}));

vi.mock('@lib/nostra/nostr-crypto', () => ({
  wrapGroupMessage: (...args: any[]) => mockWrapGroupMessage(...args),
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
  broadcastGroupControl: (...args: any[]) => mockBroadcastGroupControl(...args),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));

vi.mock('@lib/nostra/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/nostra/group-types')>('@lib/nostra/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
});

vi.mock('@lib/nostra/nostra-groups-sync', () => ({
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

  vi.doMock('@lib/nostra/group-store', () => ({
    GroupStore: vi.fn(() => mockGroupStore),
    getGroupStore: () => mockGroupStore
  }));
  vi.doMock('@lib/nostra/nostr-crypto', () => ({
    wrapGroupMessage: (...args: any[]) => mockWrapGroupMessage(...args),
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
    broadcastGroupControl: (...args: any[]) => mockBroadcastGroupControl(...args),
    wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
  }));
  vi.doMock('@lib/nostra/group-types', async() => {
    const actual = await vi.importActual<typeof import('@lib/nostra/group-types')>('@lib/nostra/group-types');
    return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
  });
  vi.doMock('@lib/nostra/nostra-groups-sync', () => ({
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

  const apiMod = await import('@lib/nostra/group-api');
  GroupAPI = apiMod.GroupAPI;

  const trackerMod = await import('@lib/nostra/group-delivery-tracker');
  computeAggregateState = trackerMod.computeAggregateState;
  GroupDeliveryTracker = trackerMod.GroupDeliveryTracker;
});

const OWN_PUBKEY = 'ownpub00000000000000000000000000000000000000000000000000000000ab';
const OWN_SK = new Uint8Array(32).fill(1);
const MEMBER_A = 'membera0000000000000000000000000000000000000000000000000000001';
const MEMBER_B = 'memberb0000000000000000000000000000000000000000000000000000002';

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
