/**
 * Session names reverting to "New session" after a second device logs in.
 *
 * A fresh device replays the session's group_create from the relay backlog.
 * Three things combined to lose the rename everywhere:
 *   1. the rebuilt record was stamped with the RECEIVE time, so it looked
 *      like the newest copy of the group;
 *   2. a rename that reached the device before its create was dropped as
 *      "unknown group";
 *   3. groups sync is whole-record last-writer-wins on updatedAt, so that
 *      "newest" copy carried "New session" back over the rename on the other
 *      device too.
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
  broadcastGroupControl: vi.fn((): any[] => []),
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
  type: 'group_create', groupId: GROUP_ID, groupName: 'New session', groupKind: 'session',
  adminPubkey: ADMIN, memberPubkeys: [ADMIN, NEWCOMER]
});
const rename = (name: string) => ({type: 'group_info_update', groupId: GROUP_ID, groupName: name});
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

describe('session name survives a fresh device replaying the backlog', () => {
  it('a rename delivered BEFORE its create is applied once the create lands', async() => {
    const record = await deliverInOrder([[rename('Fix the login bug'), -100], [create(), -900]]);
    expect(record?.name).toBe('Fix the login bug');
  });

  it('a staged rename still loses to a newer rename that already applied', async() => {
    const record = await deliverInOrder([
      [rename('Older'), -200], [create(), -900], [rename('Newest'), -50], [rename('Older'), -200]
    ]);
    expect(record?.name).toBe('Newest');
  });

  it('a staged rename from a non-admin is discarded on drain', async() => {
    const device = new GroupAPI(NEWCOMER, new Uint8Array(32).fill(1), async() => {}, vi.fn());
    await device.handleControlMessage(rumor(rename('Spoof'), -100), NEWCOMER);
    await device.handleControlMessage(rumor(create(), -900), ADMIN);
    expect((await getGroupStore().get(GROUP_ID))?.name).toBe('New session');
  });

  it('a replayed create is stamped with the create event time, not the receive time', async() => {
    const record = await deliverInOrder([[create(), -900]]);
    const nowMs = Date.now();
    expect(record.updatedAt).toBeLessThanOrEqual(nowMs - 890_000);
    expect(record.createdAt).toBeLessThanOrEqual(nowMs - 890_000);
  });

  it('a future-dated create is capped at the local clock', async() => {
    const record = await deliverInOrder([[create(), 30]]);
    expect(record.updatedAt).toBeLessThanOrEqual(Date.now());
  });
});
