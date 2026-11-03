/**
 * #369: a re-invite to a device that processes the kick late (offline, cold
 * backlog) must still land. Orderings from the issue, offsets in seconds
 * before now, delivered in order:
 *   create -900, kick -600, create -300  -> lands (was lost: teardown stamped now)
 *   kick -600, create -900, create -300  -> lands (was lost: reordered teardown stamped now)
 *   create -300, kick -600               -> lands (was lost: the live branch never aged the kick)
 *   kick 0, create 0                     -> kick wins the tie (unchanged)
 * The message store's tombstone is stateful here, so the tombstone gate that
 * produced the loss is the real one.
 */
import 'fake-indexeddb/auto';
import '../setup';
import '@helpers/peerIdPolyfill';
import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';

const ADMIN = 'd'.repeat(64);
const NEWCOMER = 'c'.repeat(64);
const GROUP_ID = 'abcdef0123456789abcdef0123456789';

const tombstones = vi.hoisted(() => new Map<string, number>());
const mockMsgStore = vi.hoisted(() => ({
  getTombstone: vi.fn(async(convId: string) => tombstones.get(convId) ?? 0),
  setTombstone: vi.fn(async(convId: string, at: number) => { tombstones.set(convId, at); }),
  clearTombstone: vi.fn(async(convId: string) => { tombstones.delete(convId); }),
  deleteMessages: vi.fn(async() => {}),
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
vi.mock('@lib/phantomchat/group-control-messages', () => ({
  isControlEvent: (rumor: {tags?: string[][]}) =>
    rumor.tags?.some((t: string[]) => t[0] === 'control' && t[1] === 'true') ?? false,
  getGroupIdFromRumor: (rumor: {tags?: string[][]}) => rumor.tags?.find((t: string[]) => t[0] === 'group')?.[1] ?? null,
  broadcastGroupControl: vi.fn(() => []),
  wrapGroupControl: vi.fn(), unwrapGroupControl: vi.fn()
}));
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn(), managers: {dialogsStorage: {dropDialogOnDeletion: vi.fn()}}}
}));
vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

let GroupAPI: any;
let getGroupStore: any;

beforeAll(async() => {
  ({GroupAPI} = await import('@lib/phantomchat/group-api'));
  ({getGroupStore} = await import('@lib/phantomchat/group-store'));
});

let seq = 0;
const create = () => ({
  type: 'group_create', groupId: GROUP_ID, groupName: 'Yard', adminPubkey: ADMIN,
  memberPubkeys: [ADMIN, NEWCOMER]
});
const kick = () => ({type: 'group_remove_member', groupId: GROUP_ID, targetPubkey: NEWCOMER, memberPubkeys: [ADMIN]});
const rumor = (payload: any, offsetSec: number) => ({
  id: `${seq++}`.padStart(64, 'e'),
  created_at: Math.floor(Date.now() / 1000) + offsetSec,
  content: JSON.stringify(payload),
  tags: [['control', 'true'], ['group', GROUP_ID]]
});

async function deliverInOrder(events: Array<[any, number]>) {
  const device = new GroupAPI(NEWCOMER, new Uint8Array(32).fill(1), async() => {}, vi.fn());
  for(const [payload, offset] of events) {
    await device.handleControlMessage(rumor(payload, offset), ADMIN);
  }
  return getGroupStore().get(GROUP_ID);
}

beforeEach(async() => {
  tombstones.clear();
  localStorage.clear();
  const store = getGroupStore();
  for(const record of await store.getAll()) await store.delete(record.groupId);
  for(const row of await store.listDeletedGroups()) await store.clearDeletedGroup(row.groupId);
});

describe('a re-invite survives a kick processed late (#369)', () => {
  it('create -900, kick -600, create -300: the re-invite lands', async() => {
    const record = await deliverInOrder([[create(), -900], [kick(), -600], [create(), -300]]);
    expect(record).not.toBeNull();
    expect(record.members).toContain(NEWCOMER);
  });

  it('kick -600, create -900, create -300: the re-invite lands', async() => {
    const record = await deliverInOrder([[kick(), -600], [create(), -900], [create(), -300]]);
    expect(record).not.toBeNull();
  });

  it('create -300, kick -600 with no add applied: the older kick does not tear down', async() => {
    const record = await deliverInOrder([[create(), -300], [kick(), -600]]);
    expect(record).not.toBeNull();
  });

  it('the kick teardown is stamped with the kick time, not now', async() => {
    await deliverInOrder([[create(), -900], [kick(), -600]]);
    const stamped = tombstones.get(`group:${GROUP_ID}`);
    expect(stamped).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 590);
  });

  it('kick 0 then create 0: the kick still wins the tie', async() => {
    const record = await deliverInOrder([[create(), -900], [kick(), 0], [create(), 0]]);
    expect(record).toBeNull();
  });
});
