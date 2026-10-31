/**
 * Archive menu for group-class dialogs (owner batch 12, 2026-10-31).
 *
 * Not a "session menu" test: batch 12 DELETED the session-specific menu, and
 * what is pinned here is the one generic entry every group-class peer gets.
 * (Renamed from session-context-menu.test.ts, which promised a session path
 * that no longer exists.)
 *
 * Batch 11 gave sessions their own menu (Rename / Archive / Delete) and their
 * own badge. Batch 12 drops that whole idea: a session is an ordinary group
 * with all the group capabilities, so it uses THE SAME menu, and the only new
 * thing is an Archive/Unarchive entry that every group-class peer gets — so any
 * group can be archived, not just a session.
 *
 * What these pins protect:
 *   - no session-specific menu path comes back (the divergence that made the
 *     session row and the group row behave differently);
 *   - Archive/Unarchive are gated on the peer class + the archive flag, and call
 *     the GroupAPI, which is also the read-only enforcement point;
 *   - Delete stays LAST, because onOpenBefore rewrites the last button's label;
 *   - an archive VIEW still refuses Set/Remove default.
 *
 * DialogsContextMenu resolves each entry's `verify` per open (the peer id is
 * only known then), so a DOM mount is disproportionate; these are wiring pins
 * over the real source, the same approach as folders-icon-emoticon.test.ts.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {GROUP_PEER_BASE, SESSION_PEER_BASE, isGroupPeer, isSessionPeer} from '@lib/phantomchat/group-types';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

const menu = readFile('components/dialogsContextMenu.ts');
const folderMenu = readFile('helpers/dom/createFolderContextMenu.ts');
const groupApi = readFile('lib/phantomchat/group-api.ts');

describe('dialog context menu: archive entries', () => {
  it('offers Archive on a live group or session and Unarchive once archived', () => {
    expect(menu).toMatch(/text: 'Archive',\s+onClick: \(\) => this\.onArchiveClick\(true\),\s+verify: \(\) => this\.isArchivable\(\) && !this\.isArchived\(\)/);
    expect(menu).toMatch(/text: 'Unarchive',\s+onClick: \(\) => this\.onArchiveClick\(false\),\s+verify: \(\) => this\.isArchivable\(\) && this\.isArchived\(\)/);
  });

  it('gates on the group CLASS, so every group gets it — not sessions only', () => {
    const archivable = menu.slice(menu.indexOf('private isArchivable'), menu.indexOf('private isArchived'));
    expect(archivable).toContain('isGroupPeer(+this.peerId)');
    // Pinned as behaviour, not as an absent substring: the gate is correct
    // precisely because a session IS a group-class peer, so one predicate
    // covers both and a future reader may legitimately name it here.
    expect(isSessionPeer(-Number(SESSION_PEER_BASE) - 1)).toBe(true);
    expect(isGroupPeer(-Number(SESSION_PEER_BASE) - 1)).toBe(true);
    expect(isGroupPeer(-Number(GROUP_PEER_BASE) - 1)).toBe(true);
    // The archived verdict is the one dialog flag every type shares.
    expect(menu).toContain('(this.dialog as Dialog).folder_id === FOLDER_ID_ARCHIVE');
  });

  it('routes the toggle through GroupAPI, which also refuses sends when archived', () => {
    expect(menu).toContain('getGroupAPI().archiveGroup(record.groupId)');
    expect(menu).toContain('getGroupAPI().unarchiveGroup(record.groupId)');
    expect(groupApi).toContain('async archiveGroup(groupId: string)');
    expect(groupApi).toContain('async unarchiveGroup(groupId: string)');
    expect(groupApi).toMatch(/if\(group\.archivedAt\) \{\s*throw new Error\('sendMessage: group is archived \(read-only\)'\)/);
  });

  it('has no session-specific menu path left', () => {
    expect(menu).not.toContain('getSessionButtons');
    expect(menu).not.toContain('hideForSessions');
    expect(menu).not.toContain('isSessionPeer');
    expect(menu).not.toContain('peerEditMenuButton(() => this.peerId, ');
  });

  it('keeps Delete visible and last', () => {
    // onOpenBefore rewrites the label of buttons[length - 1], so the delete
    // entry must be the final one in the array.
    const list = menu.slice(menu.indexOf('private getButtons()'), menu.indexOf('private isArchivable'));
    expect(list.lastIndexOf("text: 'Delete'")).toBeGreaterThan(list.lastIndexOf("text: 'Unarchive'"));
    expect(list.lastIndexOf("text: 'Delete'")).toBeGreaterThan(list.lastIndexOf("text: 'Archive'"));
  });
});

describe('folder context menu: archive views', () => {
  it('never offers Set/Remove default on the archive folder', () => {
    expect(folderMenu).toContain('isArchiveFolder');
    expect(folderMenu).toMatch(/filterId === FOLDER_ID_ARCHIVE;/);
    // Both default entries short-circuit on it.
    expect(folderMenu.match(/!isArchiveFolder\(clickFilterId\)/g)?.length).toBe(2);
  });

  it('still offers Mark all as read there', () => {
    expect(folderMenu).toContain("text: 'MarkAllAsRead'");
  });
});

describe('strings', () => {
  it('files the archive failure toast and drops the session-only keys', () => {
    const lang = readFile('lang.ts');
    expect(lang).toContain("'ArchiveActionFailed':");
    expect(lang).not.toContain("'SessionRename'");
    expect(lang).not.toContain("'SessionName'");
  });
});
