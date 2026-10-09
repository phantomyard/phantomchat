/**
 * Regression coverage for phantomchat#207 — honest group dialog dispatch.
 *
 * Before this fix the group receive path built every dialog with
 * `unreadCount: 1` / `read_inbox_max_id: mid - 1`, including for the user's
 * OWN message echo (`senderPubkey === ownPubkey`). A message you just sent (or
 * sent from another device) must never be unread: it dispatches `unreadCount:
 * 0` with the read marker at `mid`.
 */
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'b2'.repeat(32);
const GROUP_PEER_ID = -8100000000000001;
const OWN_PUBKEY = '33'.repeat(32);
const SENDER_PUBKEY = '44'.repeat(32);
const RUMOR_ID = 'ff'.repeat(32);

const mockDispatchEvent = vi.hoisted(() => vi.fn());

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({
    getTombstone: vi.fn().mockResolvedValue(0),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getByEventId: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([]),
    hasSeenEventId: vi.fn().mockReturnValue(false)
  })
}));

vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue({
      groupId: GROUP_ID,
      name: 'Phantom Yard',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY, SENDER_PUBKEY],
      peerId: GROUP_PEER_ID,
      createdAt: 1_699_000_000,
      updatedAt: 1_699_000_000
    }),
    getByPeerId: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    save: vi.fn()
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
  MOUNT_CLASS_TO: {
    apiManagerProxy: {
      mirrors: {messages: {}, chats: {}, dialogs: {}, peers: {}}
    }
  }
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

vi.mock('@lib/logger', () => ({
  Logger: class {},
  logger: () => Object.assign((..._args: any[]) => {}, {warn: vi.fn(), error: vi.fn()})
}));

let handleGroupIncoming: typeof import('@lib/phantomchat/phantomchat-groups-sync')['handleGroupIncoming'];

beforeAll(async() => {
  vi.resetModules();
  const mod = await import('@lib/phantomchat/phantomchat-groups-sync');
  handleGroupIncoming = mod.handleGroupIncoming;
});

function rumor() {
  return {
    id: RUMOR_ID,
    kind: 14,
    pubkey: OWN_PUBKEY,
    created_at: 1_699_000_100,
    content: JSON.stringify({id: 'grp-1', content: 'hi from me', type: 'text', timestamp: 1_699_000_100_000}),
    tags: [['group', GROUP_ID]]
  };
}

function dispatchedDialog(tag: string) {
  const call = mockDispatchEvent.mock.calls.find((c) => c[0] === tag);
  expect(call, `expected a ${tag} dispatch`).toBeDefined();
  return (call![1] as Map<any, any>).values().next().value?.dialog;
}

describe('#207 — handleGroupIncoming dialog honesty', () => {
  beforeEach(() => {
    mockDispatchEvent.mockClear();
  });

  it('own echo dispatches unreadCount 0 with the read marker at mid', async() => {
    const dispatch = vi.fn();
    // Own message: sender is us.
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, {...rumor(), pubkey: OWN_PUBKEY}, OWN_PUBKEY, dispatch);

    const dialog = dispatchedDialog('dialogs_multiupdate');
    expect(dialog.unread_count).toBe(0);
    expect(dialog.read_inbox_max_id).toBe(dialog.top_message);
    expect(dialog.read_outbox_max_id).toBe(dialog.top_message);
  });

  it('a genuinely new incoming message still bumps unread to 1 at mid - 1', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, {...rumor(), pubkey: SENDER_PUBKEY}, SENDER_PUBKEY, dispatch);

    const dialog = dispatchedDialog('dialogs_multiupdate');
    expect(dialog.unread_count).toBe(1);
    expect(dialog.read_inbox_max_id).toBe(dialog.top_message - 1);
  });
});
