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

beforeAll(async() => {
  vi.resetModules();
  const gsMod = await import('@lib/phantomchat/group-api');
  GroupAPI = (gsMod as any).GroupAPI;
  const vmtMod = await import('@lib/phantomchat/virtual-mtproto-server');
  VirtualMTProtoServer = (vmtMod as any).PhantomChatMTProtoServer;
  const storeMod = await import('@lib/phantomchat/message-store');
  store = (storeMod as any).getMessageStore();
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
    await store.deleteMessages(CONV_ID);
    await store.setReadCursor(CONV_ID, 0);
  }

  it('finds canonical `group:`-prefixed rows and reports the real unread count', async() => {
    await clearStore();
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
