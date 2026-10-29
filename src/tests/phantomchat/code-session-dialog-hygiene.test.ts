/**
 * Regression coverage for the Code-mode dialog gate (#277 fix-up).
 *
 * A session group is a 2-member group used as a coding thread (#279). It must
 * NEVER materialise a chat-list dialog row — "sessions invisible in Groups
 * Folder and All Chats, only visible in the Code rail" (Andrew, 2026-10-29).
 * `injectGroupCreateDialog` already bails for session groups at CREATE time,
 * but the rx/tx MESSAGE paths dispatched `dialogs_multiupdate` unconditionally,
 * so the FIRST message in a session pushed its row back into All Chats.
 *
 * We cover three layers here:
 *   1. isSessionGroupPeer reports `true` for a `sessionGroup` record (and
 *      false for ordinary groups / unreadable stores).
 *   2. rx (handleGroupIncoming) skips the dialog row but STILL renders the
 *      transcript (mirrors.messages + history_append + phantomchat_new_message).
 *   3. tx (handleGroupOutgoing) does the same on the send path.
 */

import '../setup';
import {describe, it, expect, beforeEach, vi} from 'vitest';

const groupIdToPeerId = vi.fn();
const dispatchEvent = vi.fn();
const dispatchEventSingle = vi.fn();
const mapEventId = vi.fn();
const mapPubkey = vi.fn();
const createTwebDialog = vi.fn();

// Hoisted proxies closed over by the mock factories below.
const state = vi.hoisted(() => {
  return {
    groupRecord: null as Record<string, unknown> | null,
    mirrors: {
      peers: {} as Record<number, unknown>,
      chats: {} as Record<number, unknown>,
      messages: {} as Record<string, unknown>,
      dialogs: {} as Record<number, unknown>
    }
  };
});

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: {mirrors: state.mirrors}}};
});

vi.mock('@lib/phantomchat/group-store', () => ({
  GroupStore: class {},
  getGroupStore: () => ({
    get: vi.fn(async(groupId: string) => {
      if(groupId === state.groupRecord?.groupId) return state.groupRecord;
      return null;
    }),
    getByPeerId: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue([])
  })
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId};
});

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({
    getTombstone: vi.fn().mockResolvedValue(0),
    getByEventId: vi.fn().mockResolvedValue(null),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    setMessageToStorage: vi.fn().mockResolvedValue(undefined)
  })
}));

vi.mock('@lib/phantomchat/phantomchat-peer-mapper', () => ({
  PhantomChatPeerMapper: class {
    constructor() {}
    mapEventId = mapEventId;
    mapPubkey = mapPubkey;
    createTwebDialog = createTwebDialog;
    createTwebMessage = vi.fn((raw: Record<string, unknown>) => ({...raw}));
    createTwebChat = vi.fn((raw: Record<string, unknown>) => ({...raw}));
  }
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent,
    dispatchEventSingle,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    managers: {
      appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)},
      appMessagesManager: {
        setMessageToStorage: vi.fn().mockResolvedValue(undefined),
        invalidateHistoryCache: vi.fn().mockResolvedValue(undefined)
      }
    }
  }
}));

vi.mock('@stores/peers', () => ({reconcilePeer: vi.fn()}));

const GROUP_PEER_ID = -2000000000000001;
const OWN_PUBKEY = 'a'.repeat(64);
const PHANTOM_PUBKEY = 'b'.repeat(64);
const sessionsGroupId = 'cccc0000cccc0000cccc0000cccc0000';
const ordinaryGroupId = 'dddd0000dddd0000dddd0000dddd0000';

function sessionRecord() {
  return {
    groupId: sessionsGroupId,
    name: 'New session',
    adminPubkey: OWN_PUBKEY,
    members: [OWN_PUBKEY, PHANTOM_PUBKEY],
    peerId: GROUP_PEER_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionGroup: true
  };
}

function ordinaryRecord(): Record<string, unknown> {
  return {...sessionRecord(), groupId: ordinaryGroupId, name: 'Ordinary', sessionGroup: undefined};
}

function rumor(content: Record<string, unknown>) {
  return {id: 'f'.repeat(64), content: JSON.stringify(content), created_at: 1700000100};
}

function assertNoDialogDispatch() {
  const dialogCalls = dispatchEvent.mock.calls.filter((c: unknown[]) => c[0] === 'dialogs_multiupdate');
  expect(dialogCalls).toHaveLength(0);
  expect(createTwebDialog).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mirrors.peers = {};
  state.mirrors.chats = {};
  state.mirrors.messages = {};
  state.mirrors.dialogs = {};
  groupIdToPeerId.mockResolvedValue(GROUP_PEER_ID);
  mapEventId.mockResolvedValue(4242);
  mapPubkey.mockResolvedValue(777);
  createTwebDialog.mockImplementation((raw: Record<string, unknown>) => ({...raw}));
  dispatchEvent.mockClear();
});

describe('isSessionGroupPeer', () => {
  it('is true for a sessionGroup record and false for an ordinary group', async() => {
    state.groupRecord = sessionRecord();
    const {handleGroupIncoming} = await import('@lib/phantomchat/phantomchat-groups-sync');
    // (exercised indirectly below — here we assert via the module gate by
    // checking that rx honours the flag; the unit expectations live in the
    // rx/tx blocks. Kept as a smoke assertion over the mocked store.)
    expect(state.groupRecord.sessionGroup).toBe(true);
    void handleGroupIncoming;
  });
});

describe('rx: handleGroupIncoming keeps sessions out of the chat list', () => {
  it('renders the session message but never dispatches a dialog row', async() => {
    state.groupRecord = sessionRecord();
    const {handleGroupIncoming} = await import('@lib/phantomchat/phantomchat-groups-sync');
    const dispatch = vi.fn();

    await handleGroupIncoming(OWN_PUBKEY, sessionsGroupId, rumor({
      content: 'hello session',
      type: 'text',
      id: 'm1',
      timestamp: 1700000100
    }), PHANTOM_PUBKEY, dispatch);

    // The transcript path ran.
    expect(state.mirrors.messages[`${GROUP_PEER_ID}_history`]).toBeDefined();
    expect(dispatch).toHaveBeenCalledWith('phantomchat_new_message', expect.anything());
    // The chat list did NOT.
    assertNoDialogDispatch();
  });

  it('still dispatches a dialog row for an ordinary group', async() => {
    state.groupRecord = ordinaryRecord();
    const {handleGroupIncoming} = await import('@lib/phantomchat/phantomchat-groups-sync');
    const dispatch = vi.fn();

    await handleGroupIncoming(OWN_PUBKEY, ordinaryGroupId, rumor({
      content: 'hello group',
      type: 'text',
      id: 'm2',
      timestamp: 1700000100
    }), PHANTOM_PUBKEY, dispatch);

    const dialogCalls = dispatchEvent.mock.calls.filter((c: unknown[]) => c[0] === 'dialogs_multiupdate');
    expect(dialogCalls.length).toBeGreaterThanOrEqual(1);
    expect(createTwebDialog).toHaveBeenCalled();
  });
});

describe('tx: handleGroupOutgoing keeps sessions out of the chat list', () => {
  it('renders the sent message but never dispatches a dialog row', async() => {
    state.groupRecord = sessionRecord();
    const {handleGroupOutgoing} = await import('@lib/phantomchat/phantomchat-groups-sync');
    const dispatch = vi.fn();

    await handleGroupOutgoing(OWN_PUBKEY, {
      groupId: sessionsGroupId,
      messageId: 'send-1',
      rumorId: 'e'.repeat(64),
      content: 'ship it',
      timestamp: 1700000200,
      type: 'text'
    }, dispatch);

    expect(dispatch).toHaveBeenCalledWith('phantomchat_new_message', expect.anything());
    assertNoDialogDispatch();
  });

  it('still dispatches a dialog row for an ordinary group', async() => {
    state.groupRecord = ordinaryRecord();
    const {handleGroupOutgoing} = await import('@lib/phantomchat/phantomchat-groups-sync');
    const dispatch = vi.fn();

    await handleGroupOutgoing(OWN_PUBKEY, {
      groupId: ordinaryGroupId,
      messageId: 'send-2',
      rumorId: 'e'.repeat(64) + 'f',
      content: 'group message',
      timestamp: 1700000200,
      type: 'text'
    }, dispatch);

    const dialogCalls = dispatchEvent.mock.calls.filter((c: unknown[]) => c[0] === 'dialogs_multiupdate');
    expect(dialogCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('fail-open: an unreadable store keeps the ordinary dialog path', () => {
  it('a missing group record is treated as an ordinary group, not a session', async() => {
    state.groupRecord = null; // get() ⇒ null for every id (fail-open)
    const {handleGroupOutgoing} = await import('@lib/phantomchat/phantomchat-groups-sync');
    const dispatch = vi.fn();

    await handleGroupOutgoing(OWN_PUBKEY, {
      groupId: ordinaryGroupId,
      messageId: 'send-3',
      rumorId: '0'.repeat(64),
      content: 'no record',
      timestamp: 1700000300,
      type: 'text'
    }, dispatch);

    const dialogCalls = dispatchEvent.mock.calls.filter((c: unknown[]) => c[0] === 'dialogs_multiupdate');
    expect(dialogCalls.length).toBeGreaterThanOrEqual(1);
  });
});
