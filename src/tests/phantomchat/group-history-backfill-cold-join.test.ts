/**
 * Group history backfill — the cold join.
 *
 * The slice is worthless on the device it exists for unless that device holds
 * a group RECORD to accept it against, and a group's record normally reaches a
 * member only through the groups CRDT — whose snapshot is SELF-ADDRESSED
 * (`getConversationKey(priv, ownPubkey)`), so it reaches the adder's own
 * devices and nobody else. A newcomer therefore arrived empty, its
 * `handleAddMember` threw `Group not found`, and every staged chunk expired.
 *
 * These cases drive the REAL group store (fake-indexeddb) through a genuine
 * `addMember`, capture what it published, wipe the device, and then have a
 * newcomer apply those events in the orders the relay can actually produce:
 *
 *  - create then add — the ordered case;
 *  - add then create — independent gift-wraps, no delivery-order guarantee;
 *  - slice before create — the history slice racing its own record.
 *
 * The published create is addressed to the newcomer ALONE: a create re-sent to
 * a device that had left would resurrect the group, because the tombstone gate
 * only rejects creates older than `deletedAt`.
 */
import 'fake-indexeddb/auto';
import '../setup';
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';

const ADMIN = 'd'.repeat(64);
const MEMBER = 'a'.repeat(64);
const NEWCOMER = 'c'.repeat(64);
const GROUP_ID = 'abcdef0123456789abcdef0123456789';
const GROUP_NAME = 'Phantom Yard';

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

vi.mock('@lib/phantomchat/message-store', () => ({getMessageStore: () => mockMsgStore}));

vi.mock('@lib/phantomchat/nostr-crypto', () => ({
  wrapGroupMessage: vi.fn().mockReturnValue([{id: 'w1', kind: 1059}]),
  createRumor: vi.fn().mockReturnValue({id: 'r', kind: 14, content: '', pubkey: '', created_at: 0, tags: []}),
  createSeal: vi.fn(), createGiftWrap: vi.fn()
}));

/**
 * Stand in for the real wrap: record the payload, and hand back one "event" per
 * addressed recipient so the publish order and addressing stay observable.
 */
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

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn(), managers: {}}
}));

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

// ─── Real modules under test ──────────────────────────────────────

let GroupAPI: any;
let getGroupStore: any;
let resetPendingBackfills: any;
let resetIngestBudgets: any;

beforeAll(async() => {
  ({GroupAPI} = await import('@lib/phantomchat/group-api'));
  ({getGroupStore} = await import('@lib/phantomchat/group-store'));
  ({resetPendingBackfills, resetIngestBudgets} = await import('@lib/phantomchat/group-history-backfill'));
});

/** Everything this device holds, discarded — the next phase is a fresh device. */
async function wipeDevice() {
  const store = getGroupStore();
  for(const record of await store.getAll()) {
    await store.delete(record.groupId);
  }
  resetPendingBackfills();
  resetIngestBudgets();
  localStorage.clear();
}

let giftSeq = 0;

/** The payloads a device published, in publish order, addressed as they were. */
type Sent = {recipient: string; payload: any};
let sent: Sent[];

function device(pubkey: string) {
  const api = new GroupAPI(pubkey, new Uint8Array(32).fill(1), async(events: any[]) => {
    for(const event of events) sent.push({recipient: event.recipient, payload: event.payload});
  }, vi.fn());
  return api;
}

/** A control rumor as the relay would deliver it: authored by the admin. */
function controlRumor(payload: any) {
  return {
    id: `${giftSeq++}`.padStart(64, 'f'),
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify(payload),
    tags: [['control', 'true'], ['group', payload.groupId]]
  };
}

async function deliver(api: any, senderPubkey: string, payloads: any[]) {
  for(const payload of payloads) {
    await api.handleControlMessage(controlRumor(payload), senderPubkey);
  }
}

function historyRow(index: number) {
  return {
    eventId: `${index.toString(16).padStart(4, '0')}${'5'.repeat(60)}`,
    conversationId: `group:${GROUP_ID}`,
    senderPubkey: MEMBER,
    content: `message ${index}`,
    type: 'text',
    timestamp: 1_700_000_000 + index,
    appMessageId: `grp-${index}`,
    deliveryState: 'delivered',
    mid: 100 + index,
    twebPeerId: 2000000000000001
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async() => {
  vi.clearAllMocks();
  sent = [];
  giftSeq = 0;
  await wipeDevice();
  mockMsgStore.getTombstone.mockResolvedValue(0);
  mockMsgStore.getMessages.mockResolvedValue([]);
  mockMsgStore.getByMid.mockResolvedValue(null);
  mockBroadcast.mockImplementation((_sk: any, recipients: string[], payload: any) =>
    recipients.map((recipient) => ({id: `ev${giftSeq++}`, kind: 1059, recipient, payload})));
});

/** An admin holding a live group with one other member. */
async function adminWithGroup() {
  const store = getGroupStore();
  await store.save({
    groupId: GROUP_ID,
    name: GROUP_NAME,
    description: 'Yard business',
    adminPubkey: ADMIN,
    members: [ADMIN, MEMBER],
    peerId: -2000000000000001,
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as any);
  return device(ADMIN);
}

// ─── What addMember publishes for a cold newcomer ─────────────────

describe('GroupAPI.addMember — hands the newcomer its own group record', () => {
  it('publishes a group_create addressed to the newcomer, before the membership event', async() => {
    const admin = await adminWithGroup();
    await admin.addMember(GROUP_ID, NEWCOMER);
    await flush();

    const create = sent.filter((s) => s.payload.type === 'group_create');
    expect(create.length).toBe(1);
    // The newcomer ALONE: a create re-sent to a device that left would
    // resurrect the group (the tombstone gate only rejects stale creates).
    expect(create.map((s) => s.recipient)).toEqual([NEWCOMER]);
    expect(create[0].payload).toMatchObject({
      groupId: GROUP_ID,
      groupName: GROUP_NAME,
      groupDescription: 'Yard business',
      adminPubkey: ADMIN
    });
    // Post-add member list, so the newcomer is a member the moment it exists.
    expect(create[0].payload.memberPubkeys).toEqual([ADMIN, MEMBER, NEWCOMER]);

    // The create is published first, so a device that honours publish order
    // already holds the record when the membership event arrives.
    const types = sent.map((s) => s.payload.type);
    expect(types.indexOf('group_create')).toBeLessThan(types.indexOf('group_add_member'));
    expect(sent.filter((s) => s.payload.type === 'group_add_member').map((s) => s.recipient).sort())
    .toEqual([ADMIN, MEMBER, NEWCOMER].sort());
  });

  it('carries the session class so the newcomer derives the same peerId', async() => {
    const store = getGroupStore();
    await store.save({
      groupId: GROUP_ID,
      name: GROUP_NAME,
      adminPubkey: ADMIN,
      members: [ADMIN],
      peerId: -2000000000000001,
      kind: 'session',
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as any);
    const admin = device(ADMIN);

    await admin.addMember(GROUP_ID, NEWCOMER);
    await flush();

    const create = sent.find((s) => s.payload.type === 'group_create')!;
    expect(create.payload.groupKind).toBe('session');
  });
});

// ─── What the newcomer does with them ─────────────────────────────

describe('the cold newcomer — applying what the adder published', () => {
  /** Publish the add on an admin device, then discard everything it holds. */
  async function addedFromAColdStart() {
    mockMsgStore.getMessages.mockResolvedValue([historyRow(1), historyRow(0)]);
    const admin = await adminWithGroup();
    await admin.addMember(GROUP_ID, NEWCOMER);
    // The slice is fire-and-forget: let its paging settle before we snapshot.
    for(let i = 0; i < 50 && !sent.some((s) => s.payload.type === 'group_history_backfill'); i++) {
      await flush();
    }
    const published = sent.slice();
    await wipeDevice();
    return published;
  }

  it('create-then-add: ends up holding the record, as a member', async() => {
    const published = await addedFromAColdStart();
    const newcomer = device(NEWCOMER);

    await deliver(newcomer, ADMIN, published.map((s) => s.payload));

    const record = await getGroupStore().get(GROUP_ID);
    expect(record).not.toBeNull();
    expect(record.name).toBe(GROUP_NAME);
    expect(record.adminPubkey).toBe(ADMIN);
    expect(record.members).toContain(NEWCOMER);
    expect(mockIngest).toHaveBeenCalled();
    expect(mockIngest.mock.calls[0][0]).toBe(NEWCOMER);
    expect(mockIngest.mock.calls[0][1]).toBe(GROUP_ID);
    expect(mockIngest.mock.calls[0][2].length).toBe(2);
  });

  it('add-then-create: the membership event does not throw, and the record still lands', async() => {
    const published = await addedFromAColdStart();
    const newcomer = device(NEWCOMER);
    const add = published.filter((s) => s.payload.type === 'group_add_member').map((s) => s.payload);
    const create = published.filter((s) => s.payload.type === 'group_create').map((s) => s.payload);

    // Independent gift-wraps: no delivery-order guarantee. Before the fix this
    // escaped as an unhandled rejection from a caller that does not await.
    await expect(deliver(newcomer, ADMIN, add)).resolves.toBeUndefined();
    expect(await getGroupStore().get(GROUP_ID)).toBeNull();
    // Un-applied, so the members watermark must not advance — a relay
    // redelivery has to be able to land it once the record exists.
    expect(localStorage.getItem(`phantomchat:group-wm:${GROUP_ID}:members`)).toBeNull();

    await deliver(newcomer, ADMIN, create);

    const record = await getGroupStore().get(GROUP_ID);
    expect(record.members).toContain(NEWCOMER);
    // And the redelivered membership event now applies cleanly.
    await expect(deliver(newcomer, ADMIN, add)).resolves.toBeUndefined();
    expect(await getGroupStore().get(GROUP_ID)).not.toBeNull();
  });

  it('slice-before-create: the slice is staged, then ingested when the record lands', async() => {
    const published = await addedFromAColdStart();
    const newcomer = device(NEWCOMER);
    const slices = published.filter((s) => s.payload.type === 'group_history_backfill').map((s) => s.payload);
    const create = published.filter((s) => s.payload.type === 'group_create').map((s) => s.payload);
    expect(slices.length).toBeGreaterThan(0);

    await deliver(newcomer, ADMIN, slices);
    // Nothing to accept rows against yet — staged, not dropped, and not ingested.
    expect(mockIngest).not.toHaveBeenCalled();

    await deliver(newcomer, ADMIN, create);
    await flush();

    expect(await getGroupStore().get(GROUP_ID)).not.toBeNull();
    const carried = mockIngest.mock.calls.flatMap((call) => call[2]);
    expect(carried.map((item: any) => JSON.parse(item.payload).content)).toEqual(['message 0', 'message 1']);
    expect(carried.map((item: any) => item.senderPubkey)).toEqual([MEMBER, MEMBER]);
  });
});
