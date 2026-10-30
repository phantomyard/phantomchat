/**
 * Regression: the Chats folder (0) must never list a group chat.
 *
 * Groups carry `dialog.folder_id === 0` because that is what the server sends,
 * so folder_id alone puts a group in BOTH Chats and the built-in Groups folder.
 * They have to be excluded by rule, and at every entry point — the first load
 * (getFolderDialogs), the unread badge, the storage-level filter membership
 * test, and the incremental row gate in AutonomousDialogList.updateDialog,
 * which re-adds a row the first time a group emits dialog_flush /
 * dialogs_multiupdate after the list was loaded.
 */
import {describe, it, expect, vi} from 'vitest';
import DialogsStorage from '@lib/storages/dialogs';
import FiltersStorage from '@lib/storages/filters';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {FOLDER_ID_ALL, FOLDER_ID_GROUPS} from '@appManagers/constants';
import {GROUP_PEER_BASE, isGroupPeer} from '@lib/phantomchat/group-types';

/** A group peer id, shaped exactly like groupIdToPeerId() produces. */
const GROUP_PEER_ID = -Number(GROUP_PEER_BASE + BigInt(12345));
const USER_PEER_ID = 1_000_000_001;

function mkDialog(peerId: number, overrides: Record<string, unknown> = {}) {
  return {_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0, ...overrides} as any;
}

describe('Chats folder excludes groups', () => {
  it('the fixture peer ids are shaped as real group / user peers', () => {
    expect(isGroupPeer(GROUP_PEER_ID)).toBe(true);
    expect(isGroupPeer(USER_PEER_ID)).toBe(false);
  });

  it('getFolderDialogs(0) drops group dialogs and keeps users', () => {
    const ds = new DialogsStorage();
    const group = mkDialog(GROUP_PEER_ID);
    const user = mkDialog(USER_PEER_ID);
    (ds as any).appPeersManager = {isBotforum: () => false, peerId: USER_PEER_ID};
    (ds as any).folders = {
      [FOLDER_ID_ALL]: {
        id: FOLDER_ID_ALL,
        dialogs: [group, user],
        count: 2,
        unreadMessagesCount: 0,
        unreadPeerIds: new Set(),
        unreadUnmutedPeerIds: new Set(),
        unreadMentionsPeerIds: new Set()
      }
    };

    const dialogs = ds.getFolderDialogs(FOLDER_ID_ALL);

    expect(dialogs).toEqual([user]);
    expect(dialogs.some((d) => d.peerId === GROUP_PEER_ID)).toBe(false);
    // The Groups folder still owns the group — it is excluded from Chats, not
    // removed from storage.
    expect((ds as any).folders[FOLDER_ID_ALL].dialogs).toContain(group);
  });

  it('getFolderUnreadCount(0) does not count a group’s unread state', () => {
    const ds = new DialogsStorage();
    (ds as any).appPeersManager = {isBotforum: () => false, peerId: USER_PEER_ID};
    (ds as any).folders = {
      [FOLDER_ID_ALL]: {
        id: FOLDER_ID_ALL,
        dialogs: [mkDialog(GROUP_PEER_ID), mkDialog(USER_PEER_ID)],
        count: 2,
        unreadMessagesCount: 0,
        unreadPeerIds: new Set([GROUP_PEER_ID, USER_PEER_ID]),
        unreadUnmutedPeerIds: new Set([GROUP_PEER_ID, USER_PEER_ID]),
        unreadMentionsPeerIds: new Set([GROUP_PEER_ID])
      }
    };

    const counts = ds.getFolderUnreadCount(FOLDER_ID_ALL);

    expect(counts.unreadCount).toBe(1);
    expect(counts.unreadUnmutedCount).toBe(1);
    expect(counts.unreadMentionsCount).toBe(0);
  });

  it('filter membership: a group is not a member of Chats, but is of Groups', () => {
    const fs = new FiltersStorage();
    (fs as any).filters = {
      [FOLDER_ID_ALL]: buildLocalFilter(FOLDER_ID_ALL),
      [FOLDER_ID_GROUPS]: buildLocalFilter(FOLDER_ID_GROUPS)
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

    const group = mkDialog(GROUP_PEER_ID);
    const user = mkDialog(USER_PEER_ID);

    expect(fs.testDialogForFilterId(group, FOLDER_ID_ALL)).toBe(false);
    expect(fs.testDialogForFilterId(user, FOLDER_ID_ALL)).toBe(true);
    expect(fs.testDialogForFilterId(group, FOLDER_ID_GROUPS)).toBe(true);
  });
});
