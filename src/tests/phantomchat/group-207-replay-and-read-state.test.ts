/**
 * Regression coverage for phantomchat#207 — "Group dialog always shows unread
 * after restart":
 *
 *  - Bug 1: the group RECEIVE path had no persistent replay dedup. Relays
 *    re-deliver kind-1059 gift-wraps (24h TTL) on every reconnect and the only
 *    guard was the in-memory `sentMessageIds` set (empty on a fresh boot), so
 *    already-read group messages re-rendered and bumped unread.
 *  - Bug 3: group conversation rows / read cursors were keyed inconsistently
 *    (`group:<id>` vs bare `<id>`), so the boot getDialogs branch and
 *    resetUnreadForPeer missed the real rows.
 *
 * The own-echo "honest dialog dispatch" half is covered in
 * group-207-honest-dialog.test.ts.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'a1'.repeat(32);
const CONV_ID = `group:${GROUP_ID}`;
const GROUP_PEER_ID = -8000000000000001;
const OWN_PUBKEY = '11'.repeat(32);
const SENDER_PUBKEY = '22'.repeat(32);
const RUMOR_ID = 'ee'.repeat(32);

const groupRecord = () => ({
  groupId: GROUP_ID,
  name: 'Phantom Yard',
  adminPubkey: OWN_PUBKEY,
  members: [OWN_PUBKEY, SENDER_PUBKEY],
  peerId: GROUP_PEER_ID,
  createdAt: 1_699_000_000,
  updatedAt: 1_699_000_000
});

const mockHandleGroupIncoming = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@lib/phantomchat/group-store', () => ({
  GroupStore: vi.fn(),
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue(groupRecord()),
    getByPeerId: vi.fn().mockResolvedValue(groupRecord()),
    getAll: vi.fn().mockResolvedValue([groupRecord()]),
    save: vi.fn(),
    delete: vi.fn(),
    updateMembers: vi.fn(),
    updateInfo: vi.fn()
  })
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
});

vi.mock('@lib/phantomchat/phantomchat-groups-sync', () => ({
  handleGroupIncoming: (...args: any[]) => mockHandleGroupIncoming(...args),
  handleGroupOutgoing: vi.fn().mockResolvedValue(undefined),
  injectGroupCreateDialog: vi.fn().mockResolvedValue(undefined),
  cleanupGroupChatInjection: vi.fn().mockResolvedValue(undefined),
  ensureGroupChatInjected: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@lib/phantomchat/nostr-crypto', () => ({
  wrapGroupMessage: vi.fn(),
  createRumor: vi.fn(),
  createSeal: vi.fn(),
  createGiftWrap: vi.fn(),
  wrapNip17Message: vi.fn(),
  unwrapNip17Message: vi.fn(),
  wrapNip17Receipt: vi.fn()
}));

vi.mock('@lib/phantomchat/group-control-messages', () => ({
  isControlEvent: (): boolean => false,
  getGroupIdFromRumor: (): string | null => null,
  broadcastGroupControl: vi.fn(),
  wrapGroupControl: vi.fn(),
  unwrapGroupControl: vi.fn()
}));

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), dispatchEventSingle: vi.fn(), addEventListener: vi.fn(), managers: {}}
}));

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

let GroupAPI: any;
let VirtualMTProtoServer: any;
let store: any;
let GROUP_KEY_MIGRATION: string;
let GROUP_KEY_MIGRATION_COHORT: string;
let GROUP_KEY_MIGRATION_DONE: string;
let GROUP_KEY_MIGRATION_CEILING: string;

beforeAll(async() => {
  vi.resetModules();
  const gsMod = await import('@lib/phantomchat/group-api');
  GroupAPI = (gsMod as any).GroupAPI;
  const vmtMod = await import('@lib/phantomchat/virtual-mtproto-server');
  VirtualMTProtoServer = (vmtMod as any).PhantomChatMTProtoServer;
  const storeMod = await import('@lib/phantomchat/message-store');
  store = (storeMod as any).getMessageStore();
  GROUP_KEY_MIGRATION = (storeMod as any).GROUP_KEY_MIGRATION;
  GROUP_KEY_MIGRATION_COHORT = (storeMod as any).GROUP_KEY_MIGRATION_COHORT;
  GROUP_KEY_MIGRATION_DONE = (storeMod as any).GROUP_KEY_MIGRATION_DONE;
  GROUP_KEY_MIGRATION_CEILING = (storeMod as any).GROUP_KEY_MIGRATION_CEILING;
});

function seedMessage(overrides: Record<string, unknown> = {}) {
  return store.saveMessage({
    eventId: RUMOR_ID,
    appMessageId: 'app-1',
    conversationId: CONV_ID,
    senderPubkey: SENDER_PUBKEY,
    content: 'hello group',
    type: 'text',
    timestamp: 1_699_000_100,
    mid: 101,
    twebPeerId: GROUP_PEER_ID,
    isOutgoing: false,
    deliveryState: 'delivered',
    ...overrides
  });
}

function incomingRumor(id = RUMOR_ID) {
  return {
    id,
    kind: 14,
    pubkey: SENDER_PUBKEY,
    created_at: 1_699_000_100,
    content: JSON.stringify({id: 'grp-1', content: 'hello group', type: 'text', timestamp: 1_699_000_100_000}),
    tags: [['group', GROUP_ID]]
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('#207 — persistent replay dedup on the group receive path', () => {
  let api: any;

  beforeEach(() => {
    mockHandleGroupIncoming.mockClear();
    api = new GroupAPI(OWN_PUBKEY, new Uint8Array(32), vi.fn().mockResolvedValue(undefined));
  });

  it('drops a replayed already-persisted group rumor before any render/dispatch', async() => {
    await seedMessage();
    // Fresh boot: in-memory sentMessageIds is empty — only the persistent
    // store row stands between the relay replay and a re-render.
    await flush();

    api.handleIncomingGroupMessage(GROUP_ID, incomingRumor(), SENDER_PUBKEY);
    await flush();

    expect(mockHandleGroupIncoming).not.toHaveBeenCalled();
  });

  it('still renders a genuinely new (unseen) group rumor', async() => {
    const freshId = 'dd'.repeat(32);
    api.handleIncomingGroupMessage(GROUP_ID, incomingRumor(freshId), SENDER_PUBKEY);
    await flush();

    expect(mockHandleGroupIncoming).toHaveBeenCalledTimes(1);
  });
});

describe('#207 — getDialogs group branch restores top message + read state', () => {
  function server() {
    const s = new VirtualMTProtoServer();
    (s as any).ownPubkey = OWN_PUBKEY;
    return s;
  }

  function groupDialog(result: any) {
    return result.dialogs.find((d: any) => d.peerId === GROUP_PEER_ID);
  }

  async function clearStore() {
    // Real deletes, not setReadCursor(…, 0) — the cursor write is monotonic so
    // a 0 write is a no-op and would leak one case's cursor into the next
    // (review #208 non-blocking). Also reset the one-shot migration marker so
    // each case exercises the migration independently of test order.
    await store.deleteMessages(CONV_ID);
    await store.deleteMessages(GROUP_ID);
    await store.deleteReadCursor(CONV_ID);
    await store.deleteReadCursor(GROUP_ID);
    await store.clearMigration(GROUP_KEY_MIGRATION);
    // #209: the sweep cohort/done records must also be reset, or a case that
    // runs the migration would leave the group marked done for the next case.
    await store.clearMigration(GROUP_KEY_MIGRATION_COHORT);
    await store.clearMigration(GROUP_KEY_MIGRATION_DONE);
    // #211: the per-group seed-ceiling record must be reset too.
    await store.clearMigration(GROUP_KEY_MIGRATION_CEILING);
  }

  it('finds canonical `group:`-prefixed rows and reports the real unread count', async() => {
    await clearStore();
    // Steady state (post-migration): a genuinely new inbound message with no
    // cursor yet must count as unread. Set the marker so the one-shot seed does
    // not mark this fresh case read.
    await store.setMigration(GROUP_KEY_MIGRATION);
    await seedMessage({mid: 201, timestamp: 1_699_000_200});

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);

    expect(dialog).toBeDefined();
    expect(dialog.top_message).toBe(201);
    expect(dialog.unread_count).toBe(1);
  });

  it('reports unread 0 once the read cursor has advanced (restart-no-badge)', async() => {
    await clearStore();
    await seedMessage({mid: 201, timestamp: 1_699_000_200});
    // What resetUnreadForPeer does when the user opens the chat.
    await store.setReadCursor(CONV_ID, 201);

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);

    expect(dialog.unread_count).toBe(0);
    expect(dialog.read_inbox_max_id).toBe(201);
    expect(dialog.read_outbox_max_id).toBe(201);
  });

  it('migrates a legacy bare read cursor onto the canonical key (mixed state)', async() => {
    // The normal pre-#207 upgrade state: inbound rows are already canonical,
    // but the read cursor was written under the BARE id. Canonical rows being
    // non-empty must NOT skip the cursor migration (review #208 blocker).
    await clearStore();
    await seedMessage({mid: 301, timestamp: 1_699_000_300});
    await store.setReadCursor(GROUP_ID, 301);

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);

    expect(dialog.unread_count).toBe(0);
    expect(dialog.read_inbox_max_id).toBe(301);
    expect(dialog.read_outbox_max_id).toBe(301);
    // And the canonical cursor is now the source of truth.
    expect(await store.getReadCursor(CONV_ID)).toBe(301);
  });

  it('upgrades a released legacy group: bare chatCreate cursor + canonical inbound rows', async() => {
    // The exact shipped pre-#207 state (review #208 blocker). The only bare row
    // is the chatCreate service row (mid 77), so main's resetUnreadForPeer
    // derived the bare cursor from that OLDEST mid, not from anything read.
    // Five inbound rows already live under the canonical key. The upgrade must
    // report unread 0 and advance the canonical cursor to the top (105), not
    // stop at the bare creation mid — the bug both reviewers reproduced.
    await clearStore();
    await seedMessage({
      eventId: 'legacy-create',
      conversationId: GROUP_ID,
      mid: 77,
      timestamp: 1_699_000_050,
      serviceType: 'chatCreate',
      servicePayload: {title: 'Legacy Group'}
    });
    for(let i = 101; i <= 105; i++) {
      await seedMessage({
        eventId: `inbound-${i}`,
        mid: i,
        timestamp: 1_699_000_000 + i
      });
    }
    // Build the bare cursor the way released resetUnreadForPeer did: from the
    // only bare row, i.e. the chatCreate mid — NOT hand-set to a canonical mid.
    const bareTop = (await store.getMessages(GROUP_ID, 1))[0].mid;
    expect(bareTop).toBe(77);
    await store.setReadCursor(GROUP_ID, bareTop);

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);

    expect(dialog.unread_count).toBe(0);
    expect(dialog.read_inbox_max_id).toBe(105);
    expect(await store.getReadCursor(CONV_ID)).toBe(105);
  });

  it('seeds the canonical cursor to the top when no cursor exists anywhere', async() => {
    // A group read pre-#207 through the UI-only localStorage path left no
    // stored cursor; main forced unread 0 at boot. The one-shot migration must
    // reproduce that instead of repainting the whole history as unread.
    await clearStore();
    await seedMessage({mid: 401, timestamp: 1_699_000_400});

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);

    expect(dialog.unread_count).toBe(0);
    expect(dialog.read_inbox_max_id).toBe(401);
    expect(await store.getReadCursor(CONV_ID)).toBe(401);
  });

  it('does not force-read a group created after the migration marker is set', async() => {
    // Once migrated, a brand-new group with no cursor and genuinely-unread
    // messages must keep its unread badge — the seed step is one-shot only.
    await clearStore();
    await store.setMigration(GROUP_KEY_MIGRATION);
    await seedMessage({mid: 501, timestamp: 1_699_000_500});

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);

    expect(dialog.unread_count).toBe(1);
    expect(dialog.read_inbox_max_id).toBe(0);
  });

  it('rekeys orphaned bare rows forward even when canonical rows exist', async() => {
    await clearStore();
    // Canonical inbound row plus a legacy bare service row — the mixed state
    // that used to leave the bare row orphaned (review #208 non-blocking 1).
    await seedMessage({eventId: 'canonical-1', mid: 601, timestamp: 1_699_000_600});
    await seedMessage({
      eventId: 'legacy-service-2',
      conversationId: GROUP_ID,
      mid: 77,
      timestamp: 1_699_000_050,
      serviceType: 'chatCreate',
      servicePayload: {title: 'Legacy Group'}
    });
    await store.setReadCursor(GROUP_ID, 601);

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);
    expect(dialog.top_message).toBe(601);
    expect(dialog.unread_count).toBe(0);

    // Both rows now live under the canonical key; nothing is left bare.
    expect((await store.getByEventId('legacy-service-2'))?.conversationId).toBe(CONV_ID);
    expect((await store.getByEventId('canonical-1'))?.conversationId).toBe(CONV_ID);
    expect((await store.getMessages(GROUP_ID, 10)).length).toBe(0);
  });

  it('tolerates legacy bare-key rows and migrates them onto the canonical key', async() => {
    await clearStore();
    await store.deleteMessages(GROUP_ID);
    // Legacy build wrote the chatCreate service row under the BARE group id.
    await seedMessage({
      eventId: 'legacy-service-1',
      conversationId: GROUP_ID,
      mid: 77,
      timestamp: 1_699_000_050,
      serviceType: 'chatCreate',
      servicePayload: {title: 'Legacy Group'}
    });

    const result = await (server() as any).getDialogs({}, new Set([GROUP_PEER_ID]));
    const dialog = groupDialog(result);
    expect(dialog).toBeDefined();
    expect(dialog.top_message).toBe(77);

    // The migration is fire-and-forget; let it settle, then assert the row now
    // lives under the canonical key (a bare-key read is empty).
    await flush();
    await new Promise((r) => setTimeout(r, 10));
    const canonical = await store.getByEventId('legacy-service-1');
    expect(canonical?.conversationId).toBe(CONV_ID);
  });
});
