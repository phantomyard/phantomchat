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

  it('drops the OLDEST rows when the content budget binds, never the newest', () => {
    // 400 rows of ~1 KiB content offered against a 32 KiB budget: the slice must
    // be a contiguous window ENDING at the newest row (the conversation right
    // before the join is the whole point), not the oldest 32 rows.
    const many = Array.from({length: 400}, (_, i) => item(i, 1024));
    const carried = mod.buildBackfillControlPayloads(GROUP_ID, OUTSIDER_PUBKEY, many)
    .flatMap((p) => p.historyItems!);

    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThan(many.length);
    expect(carried[carried.length - 1].createdAt).toBe(many[many.length - 1].createdAt);

    const firstKept = many.findIndex((i) => i.rumorId === carried[0].rumorId);
    expect(carried.map((i) => i.rumorId)).toEqual(many.slice(firstKept).map((i) => i.rumorId));

    const contentBytes = carried.reduce((n, i) => n + mod.historyItemBytes(i), 0);
    expect(contentBytes).toBeLessThanOrEqual(mod.HISTORY_BACKFILL_TARGET_BYTES);
    // ...and the budget is actually spent, not abandoned a seventh of the way in.
    expect(contentBytes).toBeGreaterThan(mod.HISTORY_BACKFILL_TARGET_BYTES - 2048);
  });

  it('keeps the newest rows when the row cap binds', () => {
    const many = Array.from({length: 900}, (_, i) => item(i, 8));
    const carried = mod.buildBackfillControlPayloads(GROUP_ID, OUTSIDER_PUBKEY, many)
    .flatMap((p) => p.historyItems!);

    expect(carried.length).toBe(mod.HISTORY_BACKFILL_MAX_MESSAGES);
    expect(carried[carried.length - 1].createdAt).toBe(1_700_000_899);
    expect(carried[0].createdAt).toBe(1_700_000_500);
  });

  it('emits payloads oldest-first so receivers can append as they arrive', () => {
    const items = Array.from({length: 120}, (_, i) => item(i));
    const payloads = mod.buildBackfillControlPayloads(GROUP_ID, OUTSIDER_PUBKEY, items);
    const carried = payloads.flatMap((p) => p.historyItems!);

    expect(carried.map((i) => i.createdAt)).toEqual([...carried.map((i) => i.createdAt)].sort((a, b) => a - b));
    expect(payloads[payloads.length - 1].historyItems!.at(-1)!.createdAt).toBe(items[items.length - 1].createdAt);
  });
});

describe('group-history-backfill — receiver-side aggregate budget', () => {
  let mod: typeof import('@lib/phantomchat/group-history-backfill');

  beforeAll(async() => {
    vi.resetModules();
    mod = await import('@lib/phantomchat/group-history-backfill');
  });

  beforeEach(() => mod.resetIngestBudgets());

  const item = (i: number, size = 128) => ({
    rumorId: `${i.toString(16).padStart(4, '0')}${'9'.repeat(60)}`,
    senderPubkey: MEMBER_PUBKEY,
    createdAt: 1_700_000_000 + i,
    payload: JSON.stringify({content: 'q'.repeat(size), type: 'text', id: `grp-${i}`, timestamp: 1_700_000_000_000})
  });

  it('trims a slice that exceeds the per-window content cap', () => {
    const many = Array.from({length: 400}, (_, i) => item(i, 1024));
    const accepted = mod.applyIngestBudget(GROUP_ID, many);

    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(many.length);
    const bytes = accepted.reduce((n, i) => n + mod.historyItemBytes(i), 0);
    expect(bytes).toBeLessThanOrEqual(mod.HISTORY_BACKFILL_INGEST_MAX_CONTENT_BYTES);
  });

  it('trims from the OLD end, keeping the newest rows', () => {
    // The slice exists to convey the conversation right before the join, so a
    // cap must never cut the newest rows (the original bug, one layer down).
    const many = Array.from({length: 400}, (_, i) => item(i, 1024));
    const accepted = mod.applyIngestBudget(GROUP_ID, many);

    expect(accepted.length).toBeLessThan(many.length);
    expect(accepted[accepted.length - 1].rumorId).toBe(many[many.length - 1].rumorId);
    expect(accepted.map((i) => i.rumorId)).not.toContain(many[0].rumorId);
    // Still oldest-first reading order.
    const times = accepted.map((i) => i.createdAt);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('accumulates across payloads instead of resetting per payload', () => {
    // A member repeating a 32 KiB payload must not get a fresh budget each time.
    const payloads = Array.from({length: 8}, () => Array.from({length: 32}, (_, i) => item(i, 1024)));
    let total = 0;
    for(const slice of payloads) total += mod.applyIngestBudget(GROUP_ID, slice).length;

    expect(total).toBeLessThanOrEqual(mod.HISTORY_BACKFILL_INGEST_MAX_ROWS);
    // A slice from an exhausted window is refused whole (the leftover slack is
    // smaller than one full-size row).
    expect(mod.applyIngestBudget(GROUP_ID, [item(999, 4096)])).toEqual([]);
  });

  it('opens a fresh window once the previous one expires', () => {
    const start = 1_700_000_000_000;
    const many = Array.from({length: 400}, (_, i) => item(i, 1024));
    const first = mod.applyIngestBudget(GROUP_ID, many, start);
    expect(mod.applyIngestBudget(GROUP_ID, [item(999, 4096)], start + 1000)).toEqual([]);

    const later = start + mod.HISTORY_BACKFILL_INGEST_WINDOW_MS + 1;
    expect(mod.applyIngestBudget(GROUP_ID, [item(998, 4096)], later).length).toBe(1);
    expect(first.length).toBeGreaterThan(0);
  });

  it('bounds the number of groups holding a window', () => {
    for(let g = 0; g < mod.HISTORY_BACKFILL_INGEST_MAX_GROUPS + 8; g++) {
      mod.applyIngestBudget(`group-${g}`, [item(1)]);
    }
    // The evicted (oldest) group starts clean rather than staying wedged.
    expect(mod.applyIngestBudget('group-0', [item(2)]).length).toBe(1);
  });
});

describe('group-history-backfill — pending stage (order tolerance)', () => {
  let mod: typeof import('@lib/phantomchat/group-history-backfill');

  beforeAll(async() => {
    vi.resetModules();
    mod = await import('@lib/phantomchat/group-history-backfill');
  });

  beforeEach(() => mod.resetPendingBackfills());

  const item = (i: number) => ({
    rumorId: `${i.toString(16).padStart(4, '0')}${'9'.repeat(60)}`,
    senderPubkey: MEMBER_PUBKEY,
    createdAt: 1_700_000_000 + i,
    payload: JSON.stringify({content: `m${i}`, type: 'text', id: `grp-${i}`, timestamp: 1_700_000_000_000})
  });

  it('round-trips a slice staged before its group record exists', () => {
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(1), item(2)]});

    const pending = mod.takePendingBackfill(GROUP_ID);
    expect(pending?.relayerPubkey).toBe(MEMBER_PUBKEY);
    expect(pending?.items.map((i) => i.rumorId)).toEqual([item(1).rumorId, item(2).rumorId]);
    // Take clears: a second drain cannot re-ingest.
    expect(mod.takePendingBackfill(GROUP_ID)).toBeNull();
  });

  it('accumulates consecutive chunks of one slice instead of replacing them', () => {
    // Each control payload is a small chunk, so a cold newcomer would otherwise
    // end up holding only the last ~4 KiB of its history.
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(1), item(2)]});
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(3), item(4)]});

    const pending = mod.takePendingBackfill(GROUP_ID);
    expect(pending?.items.map((i) => i.rumorId)).toEqual([1, 2, 3, 4].map((i) => item(i).rumorId));
  });

  it('dedupes overlapping chunks and keeps the newest window', () => {
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(1), item(2), item(3)]});
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(3), item(4)]});

    const pending = mod.takePendingBackfill(GROUP_ID);
    expect(pending?.items.map((i) => i.rumorId)).toEqual([1, 2, 3, 4].map((i) => item(i).rumorId));
  });

  it('starts a fresh stage when the relayer changes', () => {
    const other = 'b'.repeat(64);
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(1)]});
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: other, items: [item(2)]});

    const pending = mod.takePendingBackfill(GROUP_ID);
    expect(pending?.relayerPubkey).toBe(other);
    expect(pending?.items.map((i) => i.rumorId)).toEqual([item(2).rumorId]);
  });

  it('expires a staged slice that never finds a record', () => {
    const start = 1_700_000_000_000;
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: [item(1)]}, start);

    expect(mod.takePendingBackfill(GROUP_ID, start + mod.HISTORY_BACKFILL_PENDING_TTL_MS + 1)).toBeNull();
  });

  it('rejects a malformed relayer and keeps the row/byte caps', () => {
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: 'not-hex', items: [item(1)]});
    expect(mod.takePendingBackfill(GROUP_ID)).toBeNull();

    const many = Array.from({length: 900}, (_, i) => item(i));
    mod.stagePendingBackfill({groupId: GROUP_ID, relayerPubkey: MEMBER_PUBKEY, items: many});
    expect(mod.takePendingBackfill(GROUP_ID)?.items.length).toBe(mod.HISTORY_BACKFILL_MAX_MESSAGES);
  });

  it('evicts the oldest group when the stage is full', () => {
    for(let g = 0; g < mod.HISTORY_BACKFILL_MAX_PENDING_GROUPS + 4; g++) {
      mod.stagePendingBackfill({groupId: `group-${g}`, relayerPubkey: MEMBER_PUBKEY, items: [item(1)]});
    }
    expect(mod.takePendingBackfill('group-0')).toBeNull();
    expect(mod.takePendingBackfill(`group-${mod.HISTORY_BACKFILL_MAX_PENDING_GROUPS + 3}`)).not.toBeNull();
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

  it('rejects a future-dated item (it would win LWW against real rows)', () => {
    const nowSec = 1_700_000_000;
    const future = {...good(), createdAt: nowSec + mod.HISTORY_BACKFILL_MAX_CLOCK_SKEW_SEC + 60};
    expect(mod.isWellFormedHistoryItem(future, members, {nowSec})).toBe(false);
    expect(mod.isWellFormedHistoryItem({...good(), createdAt: nowSec + 5}, members, {nowSec})).toBe(true);
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
  getReadCursor: vi.fn(async(): Promise<number> => 0),
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
    storeMock.getReadCursor.mockReset().mockResolvedValue(0);
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
    // The three things backfill must never do: badge the user, announce old
    // messages as new, or leave the slice counted as unread.
    expect(events).not.toContain('dialogs_multiupdate');
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockDispatchEvent.mock.calls.map((c) => c[0])).not.toContain('phantomchat_new_message');
  });

  it('advances the read cursor to the newest backfilled row (no unread badge after reload)', async() => {
    // `countUnread` is `mid > cursor`, and a newcomer's cursor is 0 — without
    // this the whole slice comes back as an unread badge on the next reload.
    storeMock.getByEventId.mockImplementation(async(eventId: string) => (eventId === 'e6'.repeat(32) ? {mid: 5000} : null));

    await ingest(OWN_PUBKEY, GROUP_ID, items(), vi.fn());

    expect(storeMock.setReadCursor).toHaveBeenCalledTimes(1);
    expect(storeMock.setReadCursor).toHaveBeenCalledWith(`group:${GROUP_ID}`, 5000);
  });

  it('never drags an already-advanced cursor backwards', async() => {
    storeMock.getByEventId.mockImplementation(async(eventId: string) => (eventId === 'e6'.repeat(32) ? {mid: 5000} : null));
    storeMock.getReadCursor.mockResolvedValue(6000);

    await ingest(OWN_PUBKEY, GROUP_ID, items(), vi.fn());

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
