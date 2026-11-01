/**
 * Group history backfill — GroupAPI wiring.
 *
 * The collection/chunking math and the silent-ingest pipeline are covered in
 * group-history-backfill.test.ts. This file pins the POLICY around them:
 *
 *  - `addMember` relays a `group_history_backfill` slice addressed to the new
 *    member only, and never at the cost of the membership event (fire-and-
 *    forget, and skipped entirely when the add did not land);
 *  - a received backfill is ingested only when it names THIS device, comes from
 *    the group's ADMIN, and lands against a record we hold — and a slice that
 *    arrives before the record is staged rather than dropped;
 *  - items authored by a non-member are dropped instead of being rendered under
 *    a stranger's name.
 */
import 'fake-indexeddb/auto';
import '../setup';
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';
import type {GroupRecord} from '@lib/phantomchat/group-types';

const OWN_PUBKEY = 'd'.repeat(64);
const MEMBER_A = 'a'.repeat(64);
const NEW_MEMBER = 'c'.repeat(64);
const OUTSIDER = 'e'.repeat(64);
const GROUP_ID = 'abcdef0123456789abcdef0123456789';

const mockStore = vi.hoisted(() => ({
  save: vi.fn(), get: vi.fn(), getByPeerId: vi.fn(), getAll: vi.fn(),
  delete: vi.fn(), updateMembers: vi.fn(), updateInfo: vi.fn(), destroy: vi.fn(),
  recordDeletedGroup: vi.fn(), listDeletedGroups: vi.fn(), clearDeletedGroup: vi.fn()
}));

const mockBroadcast = vi.hoisted(() => vi.fn());
const mockIngest = vi.hoisted(() => vi.fn(async(..._args: any[]): Promise<number> => 0));
const mockMsgStore = vi.hoisted(() => ({
  getTombstone: vi.fn(async() => 0),
  getMessages: vi.fn(async(): Promise<any[]> => []),
  getByMid: vi.fn(async(): Promise<any> => null),
  getByEventId: vi.fn(async(): Promise<any> => null),
  hasSeenEventId: vi.fn((): boolean => false),
  saveMessage: vi.fn(async() => {}),
  setReadCursor: vi.fn(async() => {})
}));

vi.mock('@lib/phantomchat/group-store', () => ({
  GroupStore: vi.fn(() => mockStore),
  getGroupStore: () => mockStore
}));

vi.mock('@lib/phantomchat/message-store', () => ({getMessageStore: () => mockMsgStore}));

vi.mock('@lib/phantomchat/nostr-crypto', () => ({
  wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
  createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
  createSeal: vi.fn(), createGiftWrap: vi.fn()
}));

vi.mock('@lib/phantomchat/group-control-messages', () => ({
  isControlEvent: (rumor: {tags?: string[][]}) =>
    rumor.tags?.some((t: string[]) => t[0] === 'control' && t[1] === 'true') ?? false,
  getGroupIdFromRumor: (rumor: {tags?: string[][]}) => {
    const tag = rumor.tags?.find((t: string[]) => t[0] === 'group');
    return tag ? tag[1] : null;
  },
  broadcastGroupControl: (...args: any[]) => mockBroadcast(...args),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));

vi.mock('@lib/phantomchat/phantomchat-groups-sync', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/phantomchat-groups-sync')>('@lib/phantomchat/phantomchat-groups-sync');
  return {...actual, ingestBackfilledGroupHistory: mockIngest};
});

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-2000000000000001)};
});

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn(), managers: {}}
}));

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

let GroupAPI: any;

beforeAll(async() => {
  const mod = await import('@lib/phantomchat/group-api');
  GroupAPI = mod.GroupAPI;
});

function groupRecord(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: GROUP_ID,
    name: 'Phantom Yard',
    adminPubkey: OWN_PUBKEY,
    members: [OWN_PUBKEY, MEMBER_A],
    peerId: -2000000000000001,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as GroupRecord;
}

function historyRow(index: number) {
  return {
    eventId: `${index.toString(16).padStart(4, '0')}${'5'.repeat(60)}`,
    conversationId: `group:${GROUP_ID}`,
    senderPubkey: MEMBER_A,
    content: `message ${index}`,
    type: 'text',
    timestamp: 1_700_000_000 + index,
    appMessageId: `grp-${index}`,
    deliveryState: 'delivered',
    mid: 100 + index,
    twebPeerId: 2000000000000001
  };
}

/** `sendHistoryBackfill` is fire-and-forget; let its microtasks settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function backfillCalls() {
  return mockBroadcast.mock.calls
  .map((call) => ({memberPubkeys: call[1], payload: call[2]}))
  .filter((call) => call.payload?.type === 'group_history_backfill');
}

describe('GroupAPI.addMember — relays a bounded history slice', () => {
  let api: any;
  let published: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    published = [];
    mockStore.get.mockResolvedValue(groupRecord());
    mockStore.updateMembers.mockResolvedValue(undefined);
    mockBroadcast.mockReturnValue([{id: 'ctrl-1', kind: 1059}]);
    mockMsgStore.getMessages.mockResolvedValue([]);
    mockMsgStore.getByMid.mockResolvedValue(null);
    api = new GroupAPI(OWN_PUBKEY, new Uint8Array(32).fill(1), async(events: any[]) => {
      published.push(...events);
    }, vi.fn());
  });

  it('sends the slice to the new member alone, after the membership event', async() => {
    mockMsgStore.getMessages.mockResolvedValue([historyRow(2), historyRow(1), historyRow(0)]);

    await api.addMember(GROUP_ID, NEW_MEMBER);
    await flush();

    const calls = backfillCalls();
    expect(calls.length).toBeGreaterThan(0);
    for(const call of calls) {
      expect(call.memberPubkeys).toEqual([NEW_MEMBER]);
      expect(call.payload.historyTargetPubkey).toBe(NEW_MEMBER);
      expect(call.payload.groupId).toBe(GROUP_ID);
    }
    // Oldest-first inside each payload.
    const carried = calls.flatMap((c) => c.payload.historyItems);
    expect(carried.map((i: any) => i.createdAt)).toEqual([1_700_000_000, 1_700_000_001, 1_700_000_002]);
    expect(carried.every((i: any) => i.senderPubkey === MEMBER_A)).toBe(true);

    // The membership control is still the FIRST broadcastGroupControl call.
    expect(mockBroadcast.mock.calls[0][2]).toMatchObject({type: 'group_add_member', targetPubkey: NEW_MEMBER});
  });

  it('sends nothing when this device has no history for the group', async() => {
    mockMsgStore.getMessages.mockResolvedValue([]);

    await api.addMember(GROUP_ID, NEW_MEMBER);
    await flush();

    expect(backfillCalls()).toEqual([]);
  });

  it('does not backfill when the membership event never landed', async() => {
    mockMsgStore.getMessages.mockResolvedValue([historyRow(1)]);
    const publish = vi.fn(async() => { throw new Error('relay down'); });
    api = new GroupAPI(OWN_PUBKEY, new Uint8Array(32).fill(1), publish, vi.fn());

    await expect(api.addMember(GROUP_ID, NEW_MEMBER)).rejects.toThrow('relay down');
    expect(backfillCalls()).toEqual([]);
  });

  it('is bounded: never more than the row cap, never more than the wire ceiling', async() => {
    mockMsgStore.getMessages.mockResolvedValue(
      Array.from({length: 900}, (_, i) => historyRow(i)).sort((a, b) => b.timestamp - a.timestamp)
    );

    await api.addMember(GROUP_ID, NEW_MEMBER);
    await flush();

    const carried = backfillCalls().flatMap((c) => c.payload.historyItems);
    expect(carried.length).toBeLessThanOrEqual(400);
    expect(carried.length).toBeGreaterThan(0);
  });
});

describe('GroupAPI.handleHistoryBackfill — receiver gates', () => {
  let api: any;
  let backfill: typeof import('@lib/phantomchat/group-history-backfill');

  const rumorFor = (payload: any) => ({
    id: 'f'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify(payload),
    tags: [['control', 'true'], ['group', GROUP_ID]]
  });

  const validItem = (overrides: any = {}) => ({
    rumorId: '7'.repeat(64),
    senderPubkey: MEMBER_A,
    createdAt: 1_700_000_000,
    payload: JSON.stringify({content: 'old', type: 'text', id: 'grp-1', timestamp: 1_700_000_000_000}),
    ...overrides
  });

  beforeEach(async() => {
    vi.clearAllMocks();
    backfill = await import('@lib/phantomchat/group-history-backfill');
    backfill.resetPendingBackfills();
    backfill.resetIngestBudgets();
    // MEMBER_A is the group's ADMIN here: adding a member is admin-only, so the
    // only legitimate relayer is the admin.
    mockStore.get.mockResolvedValue(groupRecord({adminPubkey: MEMBER_A, members: [OWN_PUBKEY, MEMBER_A]}));
    mockIngest.mockResolvedValue(1);
    api = new GroupAPI(OWN_PUBKEY, new Uint8Array(32).fill(1), async() => {}, vi.fn());
  });

  it('ingests a slice addressed to this device from the group admin', async() => {
    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem()]
    }), MEMBER_A);

    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest.mock.calls[0][2]).toHaveLength(1);
  });

  it('ignores a slice addressed to somebody else', async() => {
    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: NEW_MEMBER,
      historyItems: [validItem()]
    }), MEMBER_A);

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('ignores a slice relayed by a non-member', async() => {
    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem()]
    }), OUTSIDER);

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('ignores a slice relayed by a member who is not the admin', async() => {
    // Adding a member is admin-only, so a plain member relaying history could
    // only be planting rows attributed to anyone, at any past timestamp.
    mockStore.get.mockResolvedValue(groupRecord({adminPubkey: OUTSIDER, members: [OWN_PUBKEY, MEMBER_A, OUTSIDER]}));

    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem()]
    }), MEMBER_A);

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('stages a slice that arrives before the record, then drains it once the record lands', async() => {
    // A newcomer's record arrives through the groups CRDT, AFTER the membership
    // control — so the backfill legitimately lands first and must not be lost.
    mockStore.get.mockResolvedValue(null);

    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem()]
    }), MEMBER_A);
    expect(mockIngest).not.toHaveBeenCalled();

    // The groups sync materialises the record and drains the stage.
    mockStore.get.mockResolvedValue(groupRecord({adminPubkey: MEMBER_A, members: [OWN_PUBKEY, MEMBER_A]}));
    await api.drainPendingHistoryBackfill(GROUP_ID);

    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest.mock.calls[0][2]).toHaveLength(1);

    // Take-once: a second drain cannot re-ingest the same slice.
    await api.drainPendingHistoryBackfill(GROUP_ID);
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });

  it('never materialises a group it has no record of', async() => {
    mockStore.get.mockResolvedValue(null);

    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem()]
    }), MEMBER_A);

    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockStore.save).not.toHaveBeenCalled();
  });

  it('drops a staged slice whose relayer turns out not to be the admin', async() => {
    mockStore.get.mockResolvedValue(null);
    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem()]
    }), MEMBER_A);

    mockStore.get.mockResolvedValue(groupRecord({adminPubkey: OUTSIDER, members: [OWN_PUBKEY, MEMBER_A, OUTSIDER]}));
    await api.drainPendingHistoryBackfill(GROUP_ID);

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('drops items attributed to a non-member and keeps the rest', async() => {
    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem(), validItem({rumorId: '8'.repeat(64), senderPubkey: OUTSIDER})]
    }), MEMBER_A);

    expect(mockIngest).toHaveBeenCalledTimes(1);
    const items = mockIngest.mock.calls[0][2];
    expect(items).toHaveLength(1);
    expect(items[0].senderPubkey).toBe(MEMBER_A);
  });

  it('drops the whole payload when nothing in it is well formed', async() => {
    await api.handleControlMessage(rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: [validItem({rumorId: 'nope'}), {garbage: true}]
    }), MEMBER_A);

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('enforces its own aggregate budget across repeated payloads', async() => {
    // The sender's caps are advisory; these bytes come from another device.
    const slice = Array.from({length: 64}, (_, i) => validItem({
      rumorId: i.toString(16).padStart(4, '0').repeat(16),
      createdAt: 1_700_000_000 + i,
      payload: JSON.stringify({content: 'p'.repeat(1024), type: 'text', id: `grp-${i}`, timestamp: 1_700_000_000_000})
    }));
    const payload = rumorFor({
      type: 'group_history_backfill',
      groupId: GROUP_ID,
      historyTargetPubkey: OWN_PUBKEY,
      historyItems: slice
    });

    let accepted = 0;
    for(let i = 0; i < 6; i++) {
      await api.handleControlMessage(payload, MEMBER_A);
      const call = mockIngest.mock.calls[mockIngest.mock.calls.length - 1];
      if(call) accepted += call[2].length;
    }

    expect(accepted).toBeLessThan(6 * slice.length);
    expect(accepted).toBeLessThanOrEqual(backfill.HISTORY_BACKFILL_INGEST_MAX_ROWS);
  });
});
