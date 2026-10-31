/**
 * Session context menu (owner batch 11, 2026-10-31).
 *
 * The owner's report: the session row showed the generic dialog menu, so a
 * one-member session offered Mark as unread / Pin / Mute / Add to folder, and
 * its rename entry still said "Edit". The rule now is:
 *
 *   live session     -> Rename / Archive / Delete
 *   archived session -> Unarchive / Delete
 *
 * and nothing else, with the delete entry always labelled "Delete" (a session
 * is never "left", so never "Leave Group").
 *
 * DialogsContextMenu builds one button list at attach() time and resolves each
 * entry's `verify` per open, because the peer id is only known when the menu
 * opens. That makes a DOM mount disproportionate, so these are wiring pins over
 * the real source — the same approach as folders-icon-emoticon.test.ts. They
 * fail if a generic entry stops being gated, if the delete button moves out of
 * last place (onOpenBefore rewrites the last button's label), or if the labels
 * drift back to "Edit".
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

const menu = readFile('components/dialogsContextMenu.ts');
const folderMenu = readFile('helpers/dom/createFolderContextMenu.ts');
const renamePopup = readFile('components/popups/renameSession.ts');

describe('session context menu: entries', () => {
  it('offers exactly Rename / Archive / Delete on a live session', () => {
    const session = menu.slice(menu.indexOf('private getSessionButtons'), menu.indexOf('private hideForSessions'));
    expect(session).toMatch(/text: 'SessionRename'/);
    expect(session).toMatch(/text: 'Archive'/);
    expect(session).toMatch(/text: 'Unarchive'/);
    // Rename and Archive gate on the live predicate, Unarchive on the archived one.
    const live = session.match(/verify: isLiveSession/g) ?? [];
    expect(live.length).toBe(2);
    expect(session.match(/verify: isArchivedSession/g)?.length).toBe(1);
    // No Edit dialog: the session menu never opens the peer edit popup.
    expect(session).not.toContain('peerEditMenuButton');
  });

  it('gates every generic entry off for a session', () => {
    expect(menu).toContain('private hideForSessions');
    expect(menu).toMatch(/if\(isSessionPeer\(\+this\.peerId\)\) return false;/);
    // Every non-delete generic entry is built, then wrapped.
    expect(menu).toMatch(/generic\.filter\(Boolean\)\.map\(button => this\.hideForSessions\(button\)\)/);
  });

  it('keeps Delete visible on a session and always last', () => {
    // onOpenBefore rewrites the label of buttons[length - 1], so the delete
    // entry is held outside the generic list and appended last, unwrapped.
    expect(menu).toContain('const deleteButton: ButtonMenuItemOptionsVerifiable');
    expect(menu).toMatch(/\.\.\.generic\.filter\(Boolean\)\.map\(button => this\.hideForSessions\(button\)\),\s*deleteButton\s*\]/);
    const generic = menu.slice(menu.indexOf('const generic: ButtonMenuItemOptionsVerifiable[]'), menu.indexOf('return this.buttons ='));
    expect(generic).not.toMatch(/text: 'Delete'/);
  });

  it('labels the session delete entry Delete, never a group verdict', () => {
    expect(menu).toMatch(/this\.threadId \|\| isSessionPeer\(\+this\.peerId\) \? 'Delete'/);
  });

  it('renames the session popup title from Edit to Rename', () => {
    expect(renamePopup).toContain("title: 'SessionRename'");
    expect(renamePopup).not.toMatch(/title: 'Edit'/);
  });

  it('defines the Rename string alongside the other session keys', () => {
    const lang = readFile('lang.ts');
    expect(lang).toMatch(/'SessionRename': 'Rename'/);
    expect(lang).toContain("'SessionName': 'Session name'");
    expect(lang).toContain("'SessionActionFailed':");
  });
});

describe('folder context menu: archive views', () => {
  it('never offers Set/Remove default on an archive folder', () => {
    expect(folderMenu).toContain('isArchiveFolder');
    expect(folderMenu).toMatch(
      /filterId === FOLDER_ID_ARCHIVE \|\| filterId === FOLDER_ID_SESSION_ARCHIVE/
    );
    // Both default entries short-circuit on it.
    expect(folderMenu.match(/!isArchiveFolder\(clickFilterId\)/g)?.length).toBe(2);
  });

  it('still offers Mark all as read there', () => {
    expect(folderMenu).toContain("text: 'MarkAllAsRead'");
  });
});
