/**
 * Regression coverage for the group "resurrection" bug — LIVE RECEIVE path.
 *
 * The read-side guard (getGroupHistory) is covered in
 * group-resurrection-guard.test.ts. But relays re-deliver group rumors
 * (kind-1059 gift-wraps, 24h TTL) on every reconnect, and those flow through
 * `handleGroupIncoming` — which rendered them unconditionally, re-creating a
 * group the user had just deleted (the "zombie HQ" reported from the field).
 *
 * This file asserts the live-path tombstone gate: a re-delivered rumor whose
 * timestamp predates the deletion watermark is dropped before any saveMessage /
 * inject / dispatch, while a genuinely newer rumor is allowed through.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, afterAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'feedface'.repeat(8);
const GROUP_PEER_ID = -7000000000000001;
const OWN_PUBKEY = 'aa'.repeat(32);
const SENDER_PUBKEY = 'bb'.repeat(32);
const DELETE_WATERMARK = 1_700_000_000;

const getTombstone = vi.hoisted(() => vi.fn());
const saveMessage = vi.hoisted(() => vi.fn());

function buildStoreMock() {
  return {
    getMessageStore: () => ({
      getTombstone,
      saveMessage,
      getByEventId: vi.fn().mockResolvedValue(undefined),
      getAllConversationIds: vi.fn().mockResolvedValue([]),
      deleteMessages: vi.fn()
    })
  };
}

vi.mock('@lib/phantomchat/message-store', buildStoreMock);
vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
});

let handleGroupIncoming: typeof import('@lib/phantomchat/phantomchat-groups-sync')['handleGroupIncoming'];

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@lib/phantomchat/message-store', buildStoreMock);
  vi.doMock('@lib/phantomchat/group-types', async() => {
    const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
    return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
  });
  const mod = await import('@lib/phantomchat/phantomchat-groups-sync');
  handleGroupIncoming = mod.handleGroupIncoming;
});

afterAll(() => {
  vi.doUnmock('@lib/phantomchat/message-store');
  vi.doUnmock('@lib/phantomchat/group-types');
  vi.resetModules();
});

function rumor(createdAt: number) {
  return {
    id: 'cc'.repeat(32),
    created_at: createdAt,
    content: JSON.stringify({id: 'grp-msg-1', content: 'zombie', type: 'text', timestamp: createdAt * 1000})
  };
}

describe('handleGroupIncoming — live-path resurrection guard', () => {
  beforeEach(() => {
    getTombstone.mockReset();
    saveMessage.mockReset();
  });

  it('drops a re-delivered rumor older than the deletion watermark', async() => {
    getTombstone.mockResolvedValue(DELETE_WATERMARK);
    const dispatch = vi.fn();

    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor(DELETE_WATERMARK - 100), SENDER_PUBKEY, dispatch);

    expect(getTombstone).toHaveBeenCalledWith(`group:${GROUP_ID}`);
    expect(saveMessage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
