/**
 * Session routing across threads + deferred chat backgrounds (2026-10-31).
 *
 * Two owner-reported bugs from the first Code-folder eyeball:
 *
 *   1. A session created from the Code folder's `+` landed in GROUPS, not in
 *      Code. Root cause: the folder-membership predicates (DialogsStorage,
 *      FiltersStorage, AutonomousDialogList) run inside the MTPROTO WORKER,
 *      while the synchronous session index (`group-tags.sessionPeerIds`) is
 *      populated by the group store on the MAIN thread. The worker's copy of
 *      the module was therefore always empty, `isSessionPeer` said "no", and
 *      `pFlags.groups` claimed the session for Groups. Fix: the dialog carries
 *      Code's own index key (`index_4`) stamped at creation, and every gate
 *      reads `isSessionDialog(dialog)` = index OR dialog.
 *
 *   2. The wallpaper never painted on the first chat/group opened from an
 *      empty list. Root cause: `Chat`'s deferred path dropped the callback
 *      that `handleBackgrounds` resolves to, so any chat element created AFTER
 *      the app-wide `setCurrentBackground` pass got no background layer.
 *
 * Bug 1 is tested behaviourally here. Bug 2 lives in a one-line change inside a
 * large Svelte component class with no mountable harness in this suite, so it
 * is guarded by a source assertion — the same pattern as ui-cleanup.test.ts.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, vi} from 'vitest';

// tweb runtime addition, not available in this test env
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

import * as fsSync from 'fs';
import * as path from 'path';
import DialogsStorage from '@lib/storages/dialogs';
import FiltersStorage from '@lib/storages/filters';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {PhantomChatPeerMapper} from '@lib/phantomchat/phantomchat-peer-mapper';
import getDialogIndexKey from '@appManagers/utils/dialogs/getDialogIndexKey';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_CODE,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';
import {GROUP_PEER_BASE} from '@lib/phantomchat/group-types';
import {
  SESSION_TAG,
  clearSessionPeers,
  isSessionDialog,
  isSessionPeer,
  syncSessionPeer
} from '@lib/phantomchat/group-tags';

const CODE_INDEX_KEY = getDialogIndexKey(FOLDER_ID_CODE as any);
const GROUPS_INDEX_KEY = getDialogIndexKey(FOLDER_ID_GROUPS as any);

const SESSION_PEER_ID = -Number(GROUP_PEER_BASE + BigInt(911));
const GROUP_PEER_ID = -Number(GROUP_PEER_BASE + BigInt(922));
const USER_PEER_ID = 1_000_000_991;

function mkDialog(peerId: number, overrides: Record<string, unknown> = {}) {
  return {_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0, ...overrides} as any;
}

/** A dialog exactly as the MTPROTO worker receives it for a session: the
 * worker's own session index is EMPTY (that is the bug), the dialog carries
 * Code's index key. */
function workerSessionDialog() {
  return mkDialog(SESSION_PEER_ID, {[CODE_INDEX_KEY]: 1_700_000_000});
}

function makeFilterStorage() {
  const fs = new FiltersStorage();
  (fs as any).filters = {
    [FOLDER_ID_ALL]: buildLocalFilter(FOLDER_ID_ALL),
    [FOLDER_ID_ARCHIVE]: buildLocalFilter(FOLDER_ID_ARCHIVE),
    [FOLDER_ID_GROUPS]: buildLocalFilter(FOLDER_ID_GROUPS),
    [FOLDER_ID_CODE]: buildLocalFilter(FOLDER_ID_CODE)
  };
  (fs as any).rootScope = {dispatchEvent: vi.fn()};
  (fs as any).dialogsStorage = {canSaveDialog: () => true};
  (fs as any).appMessagesManager = {getDialogOnly: (pid: number) => mkDialog(pid)};
  (fs as any).appPeersManager = {
    isAnyChat: (pid: number) => pid < 0,
    isAnyGroup: (pid: number) => pid < 0,
    isBroadcast: () => false
  };
  (fs as any).appUsersManager = {isBot: () => false, isContact: () => false};
  return fs;
}

beforeEach(() => {
  // The worker-thread condition: no session index at all.
  clearSessionPeers();
});

describe('isSessionDialog — the verdict that survives the thread boundary', () => {
  it('is false for an empty or ordinary dialog', () => {
    expect(isSessionDialog(undefined)).toBe(false);
    expect(isSessionDialog(null)).toBe(false);
    expect(isSessionDialog(mkDialog(USER_PEER_ID))).toBe(false);
    expect(isSessionDialog(mkDialog(GROUP_PEER_ID))).toBe(false);
  });

  it('trusts the index when this thread has it', () => {
    syncSessionPeer(SESSION_PEER_ID, [SESSION_TAG]);
    expect(isSessionDialog(mkDialog(SESSION_PEER_ID))).toBe(true);
  });

  it('trusts Code\'s index key when this thread does NOT have it', () => {
    // Precondition: the index is empty, i.e. we are the worker thread.
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(false);
    expect(isSessionDialog(workerSessionDialog())).toBe(true);
  });

  it('a dialog without Code\'s key is not promoted by a foreign key', () => {
    expect(isSessionDialog(mkDialog(GROUP_PEER_ID, {[GROUPS_INDEX_KEY]: 1_700_000_000}))).toBe(false);
  });
});

describe('createTwebDialog stamps the folder that owns the row', () => {
  it('stamps Code (index_4) and never Groups (index_3) for a session group', () => {
    // Bogus peer id: the tag alone must decide, because on the create path the
    // worker's index is empty and can never answer.
    const mapper = new PhantomChatPeerMapper();
    const dialog = mapper.createTwebDialog({
      peerId: SESSION_PEER_ID,
      topMessage: 42,
      topMessageDate: 1_700_000_000,
      isGroup: true,
      tags: [SESSION_TAG]
    }) as any;

    expect(dialog[CODE_INDEX_KEY]).toBeTypeOf('number');
    expect(dialog[GROUPS_INDEX_KEY]).toBeUndefined();
    // The stamp has to look like a real session dialog to the gates.
    expect(isSessionDialog(dialog)).toBe(true);
  });

  it('stamps Groups (index_3) for an ordinary group', () => {
    const mapper = new PhantomChatPeerMapper();
    const dialog = mapper.createTwebDialog({
      peerId: GROUP_PEER_ID,
      topMessage: 42,
      topMessageDate: 1_700_000_000,
      isGroup: true,
      tags: []
    }) as any;

    expect(dialog[GROUPS_INDEX_KEY]).toBeTypeOf('number');
    expect(dialog[CODE_INDEX_KEY]).toBeUndefined();
    expect(isSessionDialog(dialog)).toBe(false);
  });

  it('falls back to this thread\'s index when the caller has no tags', () => {
    syncSessionPeer(SESSION_PEER_ID, [SESSION_TAG]);
    const mapper = new PhantomChatPeerMapper();
    const dialog = mapper.createTwebDialog({
      peerId: SESSION_PEER_ID,
      topMessage: 42,
      topMessageDate: 1_700_000_000,
      isGroup: true
    }) as any;

    expect(dialog[CODE_INDEX_KEY]).toBeTypeOf('number');
    expect(dialog[GROUPS_INDEX_KEY]).toBeUndefined();
  });

  it('teaches the creating thread the tag it was handed', () => {
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(false);
    new PhantomChatPeerMapper().createTwebDialog({
      peerId: SESSION_PEER_ID,
      topMessage: 42,
      topMessageDate: 1_700_000_000,
      isGroup: true,
      tags: [SESSION_TAG]
    });

    // Without this the worker's predicates answer "not a session" forever, even
    // for dialogs it built itself.
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(true);
  });
});

describe('folder gates route a worker-built session to Code only', () => {
  it('FiltersStorage: Code claims it, Groups/Chats/Archive do not', () => {
    const session = workerSessionDialog();
    const fs = makeFilterStorage();

    expect(fs.testDialogForFilterId(session, FOLDER_ID_CODE)).toBe(true);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_GROUPS)).toBe(false);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ALL)).toBe(false);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ARCHIVE)).toBe(false);

    // A plain group is unaffected.
    const group = mkDialog(GROUP_PEER_ID, {[GROUPS_INDEX_KEY]: 1_700_000_000});
    expect(fs.testDialogForFilterId(group, FOLDER_ID_GROUPS)).toBe(true);
    expect(fs.testDialogForFilterId(group, FOLDER_ID_CODE)).toBe(false);
  });

  it('DialogsStorage hides a worker-built session from Chats and Archive', () => {
    const ds = new DialogsStorage();
    (ds as any).appPeersManager = {isBotforum: () => false, peerId: USER_PEER_ID};
    const session = workerSessionDialog();
    const user = mkDialog(USER_PEER_ID);
    (ds as any).folders = {
      [FOLDER_ID_ALL]: {
        id: FOLDER_ID_ALL,
        dialogs: [session, user],
        count: 2,
        unreadMessagesCount: 0,
        unreadPeerIds: new Set([SESSION_PEER_ID, USER_PEER_ID]),
        unreadUnmutedPeerIds: new Set([SESSION_PEER_ID, USER_PEER_ID]),
        unreadMentionsPeerIds: new Set()
      },
      [FOLDER_ID_ARCHIVE]: {
        id: FOLDER_ID_ARCHIVE,
        dialogs: [session],
        count: 1,
        unreadMessagesCount: 0,
        unreadPeerIds: new Set([SESSION_PEER_ID]),
        unreadUnmutedPeerIds: new Set([SESSION_PEER_ID]),
        unreadMentionsPeerIds: new Set()
      }
    };

    expect(ds.getFolderDialogs(FOLDER_ID_ALL)).toEqual([user]);
    expect(ds.getFolderDialogs(FOLDER_ID_ARCHIVE)).toEqual([]);
  });

  it('DialogsStorage unread badges do not count a session in Chats/Archive', () => {
    const ds = new DialogsStorage();
    const session = workerSessionDialog();
    (ds as any).dialogs = {[SESSION_PEER_ID]: session};
    (ds as any).folders = {
      [FOLDER_ID_ALL]: {
        id: FOLDER_ID_ALL,
        dialogs: [session],
        count: 1,
        unreadMessagesCount: 3,
        unreadPeerIds: new Set([SESSION_PEER_ID]),
        unreadUnmutedPeerIds: new Set([SESSION_PEER_ID]),
        unreadMentionsPeerIds: new Set()
      },
      [FOLDER_ID_ARCHIVE]: {
        id: FOLDER_ID_ARCHIVE,
        dialogs: [session],
        count: 1,
        unreadMessagesCount: 3,
        unreadPeerIds: new Set([SESSION_PEER_ID]),
        unreadUnmutedPeerIds: new Set([SESSION_PEER_ID]),
        unreadMentionsPeerIds: new Set()
      }
    };

    expect(ds.getFolderUnreadCount(FOLDER_ID_ALL).unreadCount).toBe(0);
    expect(ds.getFolderUnreadCount(FOLDER_ID_ARCHIVE).unreadCount).toBe(0);
  });
});

describe('AutonomousDialogList row gate keeps a session out of Groups', () => {
  const SRC = path.resolve(__dirname, '../..');

  it('excludes a session dialog from every list except Code', () => {
    const src = fsSync.readFileSync(path.join(SRC, 'components/autonomousDialogList/dialogs.ts'), 'utf-8');
    // Single gate, so a dialog_flush cannot re-add the row to another tab.
    expect(src).toMatch(/this\.filterId !== FOLDER_ID_CODE && isSessionDialog\(/);
    // The old peer-only check must be gone from the group exclusion.
    expect(src).not.toMatch(/isGroupPeer\(dialog\.peerId\) \|\| isSessionPeer/);
  });
});

describe('deferred chat backgrounds paint when the chat element is created late', () => {
  const SRC = path.resolve(__dirname, '../..');

  it('invokes the callback handleBackgrounds resolves to', () => {
    const src = fsSync.readFileSync(path.join(SRC, 'components/chat/chat.ts'), 'utf-8');
    const start = src.indexOf('Promise.all([');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1600);

    // It must be destructured AND called. Dropping either is the 2026-10-31 bug
    // (first chat or group opened from an empty list had no wallpaper).
    expect(block).toMatch(/\[sharedMediaCallback, backgroundCallback\]/);
    expect(block).toMatch(/backgroundCallback\?\.\(\);/);
  });
});
