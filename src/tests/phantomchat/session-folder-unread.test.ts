/**
 * The Sessions rail icon showed no badge while a session row showed unread.
 * Live messages update the row on the main thread, but folder badges read the
 * Worker's unread sets. These tests run the real DialogsStorage accounting behind
 * the real receive and clear paths, so they fail if either side stops reaching it.
 */
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import {FOLDER_ID_ALL, FOLDER_ID_GROUPS, FOLDER_ID_SESSION} from '@appManagers/constants';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'b2'.repeat(32);
const SESSION_PEER_ID = -12000000000000001;
const OWN_PUBKEY = '33'.repeat(32);
const SENDER_PUBKEY = '44'.repeat(32);

const mocks = vi.hoisted(() => ({
  dispatchEvent: vi.fn(),
  im: {chat: {peerId: 0}, isChatVisible: true},
  managers: {} as any
}));

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({
    getTombstone: vi.fn().mockResolvedValue(0),
    setReadCursor: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getByEventId: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([]),
    hasSeenEventId: vi.fn().mockReturnValue(false),
    countUnread: vi.fn().mockResolvedValue(0),
    getConversationId: vi.fn().mockReturnValue('conv'),
    peekReadCursor: vi.fn().mockReturnValue(0)
  })
}));

vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue({
      groupId: GROUP_ID,
      name: 'A session',
      kind: 'session',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY, SENDER_PUBKEY],
      peerId: -12000000000000001,
      createdAt: 1_699_000_000,
      updatedAt: 1_699_000_000
    }),
    getByPeerId: vi.fn().mockResolvedValue({groupId: 'b2'.repeat(32)}),
    getAll: vi.fn().mockResolvedValue([]),
    save: vi.fn()
  })
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(-12000000000000001)};
});

vi.mock('@lib/phantomchat/ensure-sender-user-injected', () => ({
  ensureSenderUserInjected: vi.fn().mockResolvedValue({isNewPeer: false})
}));

vi.mock('@stores/peers', () => ({reconcilePeer: vi.fn()}));

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<any>('@config/debug');
  return {
    ...actual,
    MOUNT_CLASS_TO: {
      appImManager: mocks.im,
      apiManagerProxy: {mirrors: {messages: {}, chats: {}, dialogs: {}, peers: {}}}
    }
  };
});

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: mocks.dispatchEvent,
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: mocks.managers
  }
}));

let handleGroupIncoming: typeof import('@lib/phantomchat/phantomchat-groups-sync')['handleGroupIncoming'];
let handler: typeof import('@lib/phantomchat/phantomchat-message-handler');
let DialogsStorage: typeof import('@lib/storages/dialogs')['default'];
let worker: any;
let row: any;
const USER_PEER_ID = 2e15;
let userRow: any;

function makeWorker() {
  const instance: any = new DialogsStorage();
  const rows: Record<number, any> = {[SESSION_PEER_ID]: row, [USER_PEER_ID]: userRow};
  Object.assign(instance, {
    folders: {},
    rootScope: {dispatchEvent: mocks.dispatchEvent},
    getDialogOnly: (peerId: number) => rows[peerId],
    filtersStorage: {
      getFilters: () => ({
        [FOLDER_ID_GROUPS]: {id: FOLDER_ID_GROUPS},
        [FOLDER_ID_SESSION]: {id: FOLDER_ID_SESSION}
      }),
      testDialogForFilter: (dialog: any, filter: any) =>
        filter.id === FOLDER_ID_SESSION && dialog.peerId === SESSION_PEER_ID
    },
    appMessagesManager: {getDialogUnreadCount: (d: any) => d.unread_count || +!!d.pFlags.unread_mark},
    appPeersManager: {isForum: () => false},
    appNotificationsManager: {isPeerLocalMuted: () => false}
  });
  return instance;
}

function rumor(id: string, pubkey: string) {
  return {
    id,
    kind: 14,
    pubkey,
    created_at: 1_699_000_100,
    content: JSON.stringify({id: 'grp-1', content: 'hi', type: 'text', timestamp: 1_699_000_100_000}),
    tags: [['group', GROUP_ID]]
  };
}

const sessionsBadge = () => worker.getFolderUnreadCount(FOLDER_ID_SESSION).unreadCount;

describe('Sessions folder badge follows live unread state', () => {
  beforeAll(async() => {
    vi.resetModules();
    handleGroupIncoming = (await import('@lib/phantomchat/phantomchat-groups-sync')).handleGroupIncoming;
    handler = await import('@lib/phantomchat/phantomchat-message-handler');
    DialogsStorage = (await import('@lib/storages/dialogs')).default;
  });

  beforeEach(() => {
    mocks.dispatchEvent.mockClear();
    mocks.im.chat.peerId = 0;
    row = {_: 'dialog', peerId: SESSION_PEER_ID, folder_id: 0, top_message: 1, unread_count: 0, pFlags: {}};
    userRow = {_: 'dialog', peerId: USER_PEER_ID, folder_id: 0, top_message: 1, unread_count: 0, pFlags: {}};
    worker = makeWorker();
    Object.assign(mocks.managers, {
      appMessagesManager: {
        setMessageToStorage: vi.fn().mockResolvedValue(undefined),
        invalidateHistoryCache: vi.fn().mockResolvedValue(undefined),
        setDialogTopMessage: vi.fn().mockResolvedValue(undefined)
      },
      appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)},
      dialogsStorage: worker
    });
  });

  it('an incoming session message lights the Sessions badge and notifies the rail', async() => {
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('aa'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, vi.fn());

    expect(sessionsBadge()).toBe(1);
    await vi.waitFor(() => expect(mocks.dispatchEvent).toHaveBeenCalledWith(
      'folder_unread',
      expect.objectContaining({id: FOLDER_ID_SESSION})
    ));
  });

  it('counts unread sessions, not messages, so a burst stays at one', async() => {
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('a1'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, vi.fn());
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('a2'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, vi.fn());

    expect(sessionsBadge()).toBe(1);
  });

  it('an own echo does not light the badge', async() => {
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('bb'.repeat(32), OWN_PUBKEY), OWN_PUBKEY, vi.fn());

    expect(sessionsBadge()).toBe(0);
  });

  it('an own echo keeps a manual unread mark', async() => {
    row.pFlags.unread_mark = true;
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('bc'.repeat(32), OWN_PUBKEY), OWN_PUBKEY, vi.fn());

    expect(sessionsBadge()).toBe(1);
  });

  it('a message into the open session does not light the badge', async() => {
    mocks.im.chat.peerId = SESSION_PEER_ID;
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('cc'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, vi.fn());

    expect(sessionsBadge()).toBe(0);
  });

  it('silent history backfill does not light the badge', async() => {
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('dd'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, vi.fn(), {silent: true});

    expect(sessionsBadge()).toBe(0);
  });

  it('marking the session read clears the badge and the manual mark', async() => {
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('ee'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, vi.fn());
    row.pFlags.unread_mark = true;
    expect(sessionsBadge()).toBe(1);

    await handler.applyRemoteReadState(SESSION_PEER_ID);

    expect(sessionsBadge()).toBe(0);
    expect(row.pFlags.unread_mark).toBeUndefined();
  });

  it('a live direct message reaches the Worker count too', async() => {
    await handler.handleIncomingMessage({
      peerId: USER_PEER_ID,
      mid: 2,
      senderPubkey: SENDER_PUBKEY,
      timestamp: 1_699_000_100,
      message: {id: 'dm-1', content: 'hi', type: 'text', from: SENDER_PUBKEY, timestamp: 1_699_000_100}
    } as any, OWN_PUBKEY);

    expect(worker.getFolderUnreadCount(FOLDER_ID_ALL).unreadCount).toBe(1);
  });

  it('a read landing during a slow Worker sync leaves the row and the badge at zero', async() => {
    // Hold the receive's positive-count sync, as a slow Worker round trip would.
    let releaseSync: () => void;
    const held = new Promise<void>((resolve) => releaseSync = resolve);
    const setLocal = worker.setLocalDialogUnreadCount.bind(worker);
    const setLocalDialogUnreadCount = vi.fn((peerId: number, unread: number, clearMark?: boolean) => {
      setLocal(peerId, unread, clearMark);
      return unread > 0 ? held : Promise.resolve();
    });
    mocks.managers.dialogsStorage = {setLocalDialogUnreadCount};

    const receiving = handler.handleIncomingMessage({
      peerId: USER_PEER_ID,
      mid: 3,
      senderPubkey: SENDER_PUBKEY,
      timestamp: 1_699_000_200,
      message: {id: 'dm-race', content: 'hi', type: 'text', from: SENDER_PUBKEY, timestamp: 1_699_000_200}
    } as any, OWN_PUBKEY);
    await vi.waitFor(() => expect(setLocalDialogUnreadCount).toHaveBeenCalledWith(USER_PEER_ID, expect.any(Number), false));

    await handler.applyRemoteReadState(USER_PEER_ID);
    releaseSync();
    await receiving;
    await new Promise((resolve) => setTimeout(resolve, 600)); // past the delayed mount repaint

    const painted = mocks.dispatchEvent.mock.calls
    .filter(([name]) => name === 'dialogs_multiupdate')
    .map(([, updates]) => updates.get(USER_PEER_ID)?.dialog)
    .filter(Boolean);
    expect(painted.length).toBeGreaterThan(0);
    expect(painted[painted.length - 1].unread_count).toBe(0);
    expect(userRow.unread_count).toBe(0);
  });

  it('a slow Worker does not hold up group receive', async() => {
    mocks.managers.dialogsStorage = {setLocalDialogUnreadCount: vi.fn(() => new Promise(() => {}))};
    const dispatch = vi.fn();
    void handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('ab'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, dispatch);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith('phantomchat_new_message', expect.anything()));
  });

  it('a Worker with no row for the peer is left alone', () => {
    expect(() => worker.setLocalDialogUnreadCount(-12000000000000999, 1)).not.toThrow();
    expect(sessionsBadge()).toBe(0);
  });

  it('a failing Worker call does not break the receive path', async() => {
    mocks.managers.dialogsStorage = {setLocalDialogUnreadCount: vi.fn().mockRejectedValue(new Error('port closed'))};
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('ff'.repeat(32), SENDER_PUBKEY), SENDER_PUBKEY, dispatch);

    expect(dispatch).toHaveBeenCalledWith('phantomchat_new_message', expect.anything());
  });
});
