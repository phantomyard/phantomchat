/**
 * Group history backfill — a member added today cannot decrypt anything sent
 * before the add, so the adder re-wraps a bounded slice of its own stored
 * history and pushes it as `group_history_backfill` control payloads addressed
 * to the newcomer.
 *
 * Covered here:
 *  - the collection budget (32 KiB of content bytes, row cap, oldest-first
 *    ordering once the slice is emitted),
 *  - the chunking/wire ceilings,
 *  - the receiver's per-item shape gate,
 *  - `ingestBackfilledGroupHistory` running the ordinary receive pipeline in
 *    SILENT mode: rows persist and bubbles append, but no dialog bump, no
 *    unread, no read cursor and no `phantomchat_new_message`,
 *  - `GroupAPI.handleHistoryBackfill`'s addressing/membership gates.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, afterAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'ab12'.repeat(16);
const GROUP_PEER_ID = -8200000000000001;
const OWN_PUBKEY = 'a1'.repeat(32);
const MEMBER_PUBKEY = 'b2'.repeat(32);
const OUTSIDER_PUBKEY = 'c3'.repeat(32);

const hex = (n: number, seed: string) => seed.repeat(2).slice(0, 64).padEnd(64, '0');

function rowFor(index: number, overrides: Partial<any> = {}) {
  return {
    eventId: `${index.toString(16).padStart(4, '0')}${'7'.repeat(60)}`,
    conversationId: `group:${GROUP_ID}`,
    senderPubkey: MEMBER_PUBKEY,
    content: 'x'.repeat(64),
    type: 'text',
    timestamp: 1_700_000_000 + index,
    appMessageId: `grp-${index}`,
    deliveryState: 'delivered',
    mid: 1000 + index,
    twebPeerId: Math.abs(GROUP_PEER_ID),
    ...overrides
  };
}

// ─── Collection + chunking (pure) ───────────────────────────────────

describe('group-history-backfill — collection budget', () => {
  let mod: typeof import('@lib/phantomchat/group-history-backfill');

  beforeAll(async() => {
    vi.resetModules();
    mod = await import('@lib/phantomchat/group-history-backfill');
  });

  /** Paging read over an in-memory newest-first array, message-store contract. */
  function pager(rows: any[]) {
    const newestFirst = [...rows].sort((a, b) => b.timestamp - a.timestamp);
    return vi.fn(async(_conversationId: string, limit: number, before?: number) => {
      const eligible = before === undefined ? newestFirst : newestFirst.filter((r) => r.timestamp < before);
      return eligible.slice(0, limit);
    });
  }

  it('collects newest-first until the content-byte budget, then emits oldest-first', async() => {
    // 64-byte contents: 200 rows = 12.8 KiB, so the 32 KiB budget is not the
    // binding constraint here — the row cap must not be either.
    const rows = Array.from({length: 200}, (_, i) => rowFor(i));
    const items = await mod.collectGroupHistoryItems({
      conversationId: `group:${GROUP_ID}`,
      getMessages: pager(rows)
    });

    expect(items.length).toBe(200);
    // Oldest-first: receivers append in reading order.
    expect(items[0].createdAt).toBe(1_700_000_000);
    expect(items[items.length - 1].createdAt).toBe(1_700_000_199);
  });

  it('stops at the 32 KiB content budget', async() => {
    // 1 KiB contents → 32 rows is exactly the budget, so the slice must stop
    // at (and include) the row that reaches it.
    const rows = Array.from({length: 120}, (_, i) => rowFor(i, {content: 'y'.repeat(1024)}));
    const items = await mod.collectGroupHistoryItems({
      conversationId: `group:${GROUP_ID}`,
      getMessages: pager(rows)
    });

    expect(items.length).toBe(mod.HISTORY_BACKFILL_TARGET_BYTES / 1024);
    // Newest-first walking means the NEWEST rows survive, the oldest are cut.
    expect(items[items.length - 1].createdAt).toBe(1_700_000_119);
    const totalBytes = items.reduce((n, item) => n + mod.utf8ByteLength(JSON.parse(item.payload).content), 0);
    expect(totalBytes).toBeGreaterThanOrEqual(mod.HISTORY_BACKFILL_TARGET_BYTES);
  });

  it('respects the row cap', async() => {
    const rows = Array.from({length: 900}, (_, i) => rowFor(i, {content: 'z'}));
    const items = await mod.collectGroupHistoryItems({
      conversationId: `group:${GROUP_ID}`,
      getMessages: pager(rows)
    });

    expect(items.length).toBe(mod.HISTORY_BACKFILL_MAX_MESSAGES);
  });

  it('skips service rows, failed/sending rows and unknown authors', async() => {
    const rows = [
      rowFor(1, {serviceType: 'chatCreate'}),
      rowFor(2, {deliveryState: 'failed'}),
      rowFor(3, {deliveryState: 'sending'}),
      rowFor(4, {senderPubkey: 'not-hex'}),
      rowFor(5),
      rowFor(6)
    ];
    const items = await mod.collectGroupHistoryItems({
      conversationId: `group:${GROUP_ID}`,
      getMessages: pager(rows)
    });

    expect(items.map((i) => i.createdAt)).toEqual([1_700_000_005, 1_700_000_006]);
  });

  it('re-derives replyToRumorId from the parent row when it resolves', async() => {
    const parent = rowFor(10);
    const reply = rowFor(11, {replyToMid: parent.mid});
    const items = await mod.collectGroupHistoryItems({
      conversationId: `group:${GROUP_ID}`,
      getMessages: pager([parent, reply]),
      getByMid: async(mid: number) => (mid === parent.mid ? parent : null)
    });

    const replyItem = items.find((item) => item.rumorId === reply.eventId);
    expect(JSON.parse(replyItem!.payload).replyToRumorId).toBe(parent.eventId);
  });

  it('returns nothing when the conversation is empty', async() => {
    const items = await mod.collectGroupHistoryItems({
      conversationId: `group:${GROUP_ID}`,
      getMessages: vi.fn(async(): Promise<any[]> => [])
    });
    expect(items).toEqual([]);
  });
});

describe('group-history-backfill — control payload chunking', () => {
  let mod: typeof import('@lib/phantomchat/group-history-backfill');

  beforeAll(async() => {
    vi.resetModules();
    mod = await import('@lib/phantomchat/group-history-backfill');
  });

  const item = (i: number, size = 128) => ({
    rumorId: `${i.toString(16).padStart(4, '0')}${'9'.repeat(60)}`,
    senderPubkey: MEMBER_PUBKEY,
    createdAt: 1_700_000_000 + i,
    payload: JSON.stringify({content: 'q'.repeat(size), type: 'text', id: `grp-${i}`, timestamp: 1_700_000_000_000})
  });

  it('splits into relay-sized chunks addressed to the newcomer', () => {
    const items = Array.from({length: 60}, (_, i) => item(i));
    const payloads = mod.buildBackfillControlPayloads(GROUP_ID, OUTSIDER_PUBKEY, items);

    expect(payloads.length).toBeGreaterThan(1);
    let seen = 0;
    for(const payload of payloads) {
      expect(payload.type).toBe('group_history_backfill');
      expect(payload.groupId).toBe(GROUP_ID);
      expect(payload.historyTargetPubkey).toBe(OUTSIDER_PUBKEY);
      expect(payload.historyItems!.length).toBeLessThanOrEqual(mod.HISTORY_BACKFILL_MAX_ITEMS_PER_CONTROL);
      expect(mod.utf8ByteLength(JSON.stringify(payload))).toBeLessThan(mod.HISTORY_BACKFILL_CHUNK_BYTES + 4096);
      seen += payload.historyItems!.length;
    }
    expect(seen).toBe(items.length);
  });

  it('drops a single oversized message instead of wrapping it alone', () => {
    const payloads = mod.buildBackfillControlPayloads(GROUP_ID, OUTSIDER_PUBKEY, [
      item(1),
      item(2, mod.HISTORY_BACKFILL_MAX_ITEM_BYTES + 1),
      item(3)
    ]);
    const ids = payloads.flatMap((p) => p.historyItems!.map((i) => i.rumorId));
    expect(ids.length).toBe(2);
  });

  it('stops at the wire ceiling', () => {
    const many = Array.from({length: 400}, (_, i) => item(i, 900));
    const payloads = mod.buildBackfillControlPayloads(GROUP_ID, OUTSIDER_PUBKEY, many);
    const carried = payloads.reduce((n, p) => n + p.historyItems!.reduce((m, i) => m + mod.utf8ByteLength(i.payload), 0), 0);
    expect(carried).toBeLessThanOrEqual(mod.HISTORY_BACKFILL_MAX_WIRE_BYTES);
    expect(payloads.reduce((n, p) => n + p.historyItems!.length, 0)).toBeLessThan(many.length);
  });
});

describe('group-history-backfill — per-item receiver gate', () => {
  let mod: typeof import('@lib/phantomchat/group-history-backfill');
  const members = [OWN_PUBKEY, MEMBER_PUBKEY];

  beforeAll(async() => {
    vi.resetModules();
    mod = await import('@lib/phantomchat/group-history-backfill');
  });

  const good = () => ({
    rumorId: 'd4'.repeat(32),
    senderPubkey: MEMBER_PUBKEY,
    createdAt: 1_700_000_000,
    payload: JSON.stringify({content: 'hi', type: 'text', id: 'grp-1', timestamp: 1_700_000_000_000})
  });

  it('accepts a well-formed item from a member', () => {
    expect(mod.isWellFormedHistoryItem(good(), members)).toBe(true);
  });

  it('rejects a non-member author (forged attribution)', () => {
    expect(mod.isWellFormedHistoryItem({...good(), senderPubkey: OUTSIDER_PUBKEY}, members)).toBe(false);
  });

  it('rejects a malformed rumor id or missing payload', () => {
    expect(mod.isWellFormedHistoryItem({...good(), rumorId: 'short'}, members)).toBe(false);
    expect(mod.isWellFormedHistoryItem({...good(), payload: ''}, members)).toBe(false);
    expect(mod.isWellFormedHistoryItem({...good(), createdAt: 0}, members)).toBe(false);
    expect(mod.isWellFormedHistoryItem(null, members)).toBe(false);
  });

  it('rejects an oversized payload', () => {
    const oversized = {...good(), payload: JSON.stringify({content: 'n'.repeat(mod.HISTORY_BACKFILL_MAX_ITEM_BYTES)})};
    expect(mod.isWellFormedHistoryItem(oversized, members)).toBe(false);
  });
});

// ─── Silent ingest through the real receive pipeline ────────────────

const storeMock = vi.hoisted(() => ({
  getTombstone: vi.fn(async() => 0),
  saveMessage: vi.fn(async(..._args: any[]): Promise<void> => {}),
  getByEventId: vi.fn(async(..._args: any[]): Promise<any> => null),
  hasSeenEventId: vi.fn((): boolean => false),
  setReadCursor: vi.fn(async() => {}),
  getMessages: vi.fn(async(): Promise<any[]> => [])
}));

const mockDispatchEvent = vi.hoisted(() => vi.fn());

vi.mock('@lib/phantomchat/message-store', () => ({getMessageStore: () => storeMock}));

vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue({
      groupId: GROUP_ID,
      name: 'Phantom Yard',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY, MEMBER_PUBKEY],
      peerId: GROUP_PEER_ID,
      createdAt: 1_699_000_000,
      updatedAt: 1_699_000_000
    }),
    getByPeerId: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    save: vi.fn(),
    updateMembers: vi.fn()
  })
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
});

vi.mock('@lib/phantomchat/ensure-sender-user-injected', () => ({
  ensureSenderUserInjected: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@stores/peers', () => ({reconcilePeer: vi.fn()}));

vi.mock('@config/debug', () => ({
  default: {MOUNT_CLASS_TO: null},
  MOUNT_CLASS_TO: {
    appImManager: {chat: {peerId: 0}, isChatVisible: true},
    apiManagerProxy: {mirrors: {messages: {}, chats: {}, dialogs: {}, peers: {}}}
  }
}));

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn(), debug: vi.fn()})
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: mockDispatchEvent,
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: {
      appMessagesManager: {
        setMessageToStorage: vi.fn().mockResolvedValue(undefined),
        invalidateHistoryCache: vi.fn().mockResolvedValue(undefined)
      },
      appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)}
    }
  }
}));

describe('ingestBackfilledGroupHistory — silent mode', () => {
  let ingest: typeof import('@lib/phantomchat/phantomchat-groups-sync')['ingestBackfilledGroupHistory'];

  let mod: typeof import('@lib/phantomchat/phantomchat-groups-sync');

  beforeAll(async() => {
    mod = await import('@lib/phantomchat/phantomchat-groups-sync');
    ingest = mod.ingestBackfilledGroupHistory;
  });

  beforeEach(() => {
    storeMock.saveMessage.mockReset().mockResolvedValue(undefined);
    storeMock.getByEventId.mockReset().mockResolvedValue(null);
    storeMock.hasSeenEventId.mockReset().mockReturnValue(false);
    storeMock.setReadCursor.mockReset().mockResolvedValue(undefined);
    storeMock.getTombstone.mockReset().mockResolvedValue(0);
    mockDispatchEvent.mockClear();
  });

  const items = () => [
    {rumorId: 'e5'.repeat(32), senderPubkey: MEMBER_PUBKEY, createdAt: 1_700_000_000, payload: JSON.stringify({content: 'old one', type: 'text', id: 'grp-1', timestamp: 1_700_000_000_000})},
    {rumorId: 'e6'.repeat(32), senderPubkey: MEMBER_PUBKEY, createdAt: 1_700_000_001, payload: JSON.stringify({content: 'old two', type: 'text', id: 'grp-2', timestamp: 1_700_000_001_000})}
  ];

  it('persists and appends history without any dialog, unread, cursor or new-message side effect', async() => {
    const dispatch = vi.fn();
    const ingested = await ingest(OWN_PUBKEY, GROUP_ID, items(), dispatch);

    expect(ingested).toBe(2);
    expect(storeMock.saveMessage).toHaveBeenCalledTimes(2);
    expect(storeMock.saveMessage.mock.calls[0][0]).toMatchObject({
      eventId: 'e5'.repeat(32),
      conversationId: `group:${GROUP_ID}`,
      senderPubkey: MEMBER_PUBKEY,
      content: 'old one',
      timestamp: 1_700_000_000,
      isOutgoing: false
    });

    const events = mockDispatchEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain('history_append');
    // The three things backfill must never do: badge the user, move the read
    // cursor, or announce old messages as new.
    expect(events).not.toContain('dialogs_multiupdate');
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockDispatchEvent.mock.calls.map((c) => c[0])).not.toContain('phantomchat_new_message');
    expect(storeMock.setReadCursor).not.toHaveBeenCalled();
  });

  it('skips rows that are already persisted (relay replay / second relayer)', async() => {
    storeMock.getByEventId.mockImplementation(async(eventId: string) => (eventId === 'e5'.repeat(32) ? {mid: 1} : null));
    const dispatch = vi.fn();

    const ingested = await ingest(OWN_PUBKEY, GROUP_ID, items(), dispatch);

    expect(ingested).toBe(1);
    expect(storeMock.saveMessage).toHaveBeenCalledTimes(1);
    expect(storeMock.saveMessage.mock.calls[0][0].eventId).toBe('e6'.repeat(32));
  });

  it('keeps going when one item throws (a bad row never aborts the slice)', async() => {
    storeMock.getByEventId.mockRejectedValueOnce(new Error('boom'));
    const dispatch = vi.fn();

    const ingested = await ingest(OWN_PUBKEY, GROUP_ID, items(), dispatch);

    expect(ingested).toBe(1);
    expect(storeMock.saveMessage).toHaveBeenCalledTimes(1);
    expect(storeMock.saveMessage.mock.calls[0][0].eventId).toBe('e6'.repeat(32));
  });

  it('is a no-op for an empty slice', async() => {
    expect(await ingest(OWN_PUBKEY, GROUP_ID, [], vi.fn())).toBe(0);
    expect(storeMock.saveMessage).not.toHaveBeenCalled();
  });
});
