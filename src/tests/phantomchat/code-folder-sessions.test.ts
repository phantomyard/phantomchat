/**
 * Code folder + session groups (2026-10-30).
 *
 * The owner's ask: a new Code folder whose `+` creates a group tagged
 * `session`; that group is visible in Code and NOWHERE else; it is created as
 * "New session" and takes its name from the first prompt.
 *
 * The rules that have to hold:
 *   1. Code is a real, protected, locally-seeded system folder titled "Code".
 *   2. Folder membership is decided by the `session` TAG, and every other
 *      folder excludes it — Chats (0), Groups (3), Archive (1) and any custom
 *      folder. The tag is mirrored into a synchronous index, because the hot
 *      membership gates cannot await IndexedDB.
 *   3. The tag survives the wire (group_create / group_info_update) and the
 *      groups CRDT, where an older client that republishes the record without
 *      `tags` must not strip it.
 *   4. A session is named from its first prompt, once.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import DialogsStorage from '@lib/storages/dialogs';
import FiltersStorage from '@lib/storages/filters';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_CODE,
  FOLDER_ID_GROUPS,
  PROTECTED_FOLDERS,
  REAL_FOLDERS
} from '@appManagers/constants';
import {GROUP_PEER_BASE} from '@lib/phantomchat/group-types';
import {
  DEFAULT_SESSION_GROUP_NAME,
  SESSION_TAG,
  clearSessionPeers,
  forgetSessionPeer,
  hasSessionTag,
  isSessionPeer,
  mergeRecordTags,
  sanitizeGroupTags,
  sessionTitleFromPrompt,
  syncSessionPeer,
  syncSessionPeers
} from '@lib/phantomchat/group-tags';

const SESSION_PEER_ID = -Number(GROUP_PEER_BASE + BigInt(111));
const GROUP_PEER_ID = -Number(GROUP_PEER_BASE + BigInt(222));
const USER_PEER_ID = 1_000_000_777;

function mkDialog(peerId: number, overrides: Record<string, unknown> = {}) {
  return {_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0, ...overrides} as any;
}

function filterStorage() {
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
  clearSessionPeers();
});

describe('Code folder definition', () => {
  it('is a protected, locally-seeded system folder titled Code', () => {
    expect(REAL_FOLDERS.has(FOLDER_ID_CODE)).toBe(true);
    expect(PROTECTED_FOLDERS.has(FOLDER_ID_CODE)).toBe(true);

    const filter = buildLocalFilter(FOLDER_ID_CODE);
    const pFlags = (filter as any).pFlags;
    expect(filter.title.text).toBe('Code');
    // Membership is the tag, not a peer class — a `groups` pFlag here would
    // make Code a duplicate of Groups.
    expect(pFlags.groups).toBeUndefined();
    expect(pFlags.exclude_archived).toBe(true);
  });

  it('keeps the existing ids stable (persisted folder arrays key on them)', () => {
    expect(FOLDER_ID_ALL).toBe(0);
    expect(FOLDER_ID_ARCHIVE).toBe(1);
    expect(FOLDER_ID_GROUPS).toBe(3);
    expect(FOLDER_ID_CODE).toBe(4);
  });
});

describe('session tag helpers', () => {
  it('only understands the `session` tag on the wire', () => {
    expect(sanitizeGroupTags(['session'])).toEqual(['session']);
    expect(sanitizeGroupTags(['session', 'session'])).toEqual(['session']);
    expect(sanitizeGroupTags(['session', 'made-up'])).toEqual(['session']);
    expect(sanitizeGroupTags(['made-up'])).toBeUndefined();
    expect(sanitizeGroupTags('session')).toBeUndefined();
    expect(sanitizeGroupTags(undefined)).toBeUndefined();
  });

  it('hasSessionTag is the single predicate', () => {
    expect(hasSessionTag([SESSION_TAG])).toBe(true);
    expect(hasSessionTag([])).toBe(false);
    expect(hasSessionTag(undefined)).toBe(false);
  });

  it('names a session from the first 10 characters of the prompt', () => {
    expect(DEFAULT_SESSION_GROUP_NAME).toBe('New session');
    expect(sessionTitleFromPrompt('Fix the audio bug')).toBe('Fix the au…');
    expect(sessionTitleFromPrompt('  Fix\n\nthe   audio  ')).toBe('Fix the au…');
    expect(sessionTitleFromPrompt('Exactly 10')).toBe('Exactly 10');
    expect(sessionTitleFromPrompt('short')).toBe('short');
    expect(sessionTitleFromPrompt('   ')).toBe('');
  });

  it('the CRDT merge treats absent remote tags as unchanged', () => {
    // An older client renames the group and republishes WITHOUT `tags`.
    expect(mergeRecordTags(['session'], undefined)).toEqual(['session']);
    expect(mergeRecordTags(['session'], [])).toEqual(['session']);
    expect(mergeRecordTags(undefined, ['session'])).toEqual(['session']);
    expect(mergeRecordTags(undefined, undefined)).toBeUndefined();
  });

  it('the index shrinks only on a full rebuild', () => {
    syncSessionPeer(SESSION_PEER_ID, ['session']);
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(true);

    forgetSessionPeer(SESSION_PEER_ID);
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(false);

    syncSessionPeers([{peerId: SESSION_PEER_ID, tags: ['session']}, {peerId: GROUP_PEER_ID, tags: []}]);
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(true);
    expect(isSessionPeer(GROUP_PEER_ID)).toBe(false);

    // A record that lost its tag falls out on the next full read.
    const changed = syncSessionPeers([{peerId: SESSION_PEER_ID, tags: undefined}]);
    expect(changed).toBe(true);
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(false);
  });
});

describe('folder membership', () => {
  it('a session lives in Code and nowhere else', () => {
    syncSessionPeer(SESSION_PEER_ID, ['session']);
    syncSessionPeer(GROUP_PEER_ID, []);

    const fs = filterStorage();
    const session = mkDialog(SESSION_PEER_ID);
    const group = mkDialog(GROUP_PEER_ID);
    const user = mkDialog(USER_PEER_ID);

    expect(fs.testDialogForFilterId(session, FOLDER_ID_CODE)).toBe(true);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ALL)).toBe(false);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_GROUPS)).toBe(false);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ARCHIVE)).toBe(false);

    // A plain group still behaves exactly as before.
    expect(fs.testDialogForFilterId(group, FOLDER_ID_GROUPS)).toBe(true);
    expect(fs.testDialogForFilterId(group, FOLDER_ID_CODE)).toBe(false);
    expect(fs.testDialogForFilterId(group, FOLDER_ID_ALL)).toBe(false);

    // Code never lists a person.
    expect(fs.testDialogForFilterId(user, FOLDER_ID_CODE)).toBe(false);
    expect(fs.testDialogForFilterId(user, FOLDER_ID_ALL)).toBe(true);
  });

  it('Code excludes a session that is also excluded from every other folder', () => {
    syncSessionPeer(SESSION_PEER_ID, ['session']);
    const fs = filterStorage();
    const session = mkDialog(SESSION_PEER_ID, {folder_id: FOLDER_ID_ARCHIVE});

    // A session that ended up in the archive is still Code's, and Archive does
    // not list it either — "Code and nowhere else" holds for every folder.
    expect(fs.testDialogForFilterId(session, FOLDER_ID_CODE)).toBe(true);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ARCHIVE)).toBe(false);
  });

  it('DialogsStorage hides sessions from Chats and Archive', () => {
    syncSessionPeer(SESSION_PEER_ID, ['session']);
    const ds = new DialogsStorage();
    (ds as any).appPeersManager = {isBotforum: () => false, peerId: USER_PEER_ID};
    const session = mkDialog(SESSION_PEER_ID);
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
        unreadPeerIds: new Set(),
        unreadUnmutedPeerIds: new Set(),
        unreadMentionsPeerIds: new Set()
      }
    };

    expect(ds.getFolderDialogs(FOLDER_ID_ALL)).toEqual([user]);
    expect(ds.getFolderDialogs(FOLDER_ID_ARCHIVE)).toEqual([]);

    const counts = ds.getFolderUnreadCount(FOLDER_ID_ALL);
    expect(counts.unreadCount).toBe(1);
    expect(counts.unreadUnmutedCount).toBe(1);
  });
});

describe('group store keeps the index fresh', () => {
  it('save / getAll / delete drive the session index', async() => {
    const {GroupStore} = await import('@lib/phantomchat/group-store');

    const store = new GroupStore();
    const peerId = -Number(GROUP_PEER_BASE + BigInt(999));
    const record: any = {
      groupId: 'a'.repeat(64) + '0'.repeat(32),
      name: DEFAULT_SESSION_GROUP_NAME,
      adminPubkey: 'a'.repeat(64),
      members: ['a'.repeat(64)],
      peerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: ['session']
    };

    await store.save(record);
    expect(isSessionPeer(peerId)).toBe(true);

    // A fresh boot: the full read repopulates the index from IDB.
    clearSessionPeers();
    await store.getAll();
    expect(isSessionPeer(peerId)).toBe(true);

    // Renaming must not lose the tag (updateInfo leaves absent fields alone).
    await store.updateInfo(record.groupId, {name: 'Fix the au…'});
    expect((await store.get(record.groupId))?.tags).toEqual(['session']);

    await store.delete(record.groupId);
    expect(isSessionPeer(peerId)).toBe(false);
    await store.destroy();
  });
});
