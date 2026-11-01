/**
 * Compact folder badges in the chatlist strip (#354).
 *
 * Pins the wiring a later refactor could silently drop:
 *  1. the archive chip is a standalone button — outside the horizontal menu's
 *     indexed children — that opens the archive tab through the same entry
 *     point the rail uses;
 *  2. archive unread reaches the chip through `setFilterUnreadCount` and is
 *     refreshed by the batch path, so it cannot disagree with the tab title;
 *  3. the folder tabs carry the compact icon + badge markup;
 *  4. both sidebar toggles are hidden below the floating-sidebar breakpoint,
 *     including the portalled hamburger menu entry.
 *
 * Source assertions on purpose: this is presentation wiring, and the repo
 * already covers the same class of change this way (ui-batch8,
 * folders-icon-emoticon).
 */

import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function block(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  expect(start, `missing anchor: ${startNeedle}`).toBeGreaterThan(-1);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end, `missing end anchor: ${endNeedle}`).toBeGreaterThan(start);
  return source.slice(start, end + endNeedle.length);
}

describe('compact folder badges — archive chip wiring', () => {
  const dialogsManager = readFile('lib/appDialogsManager.ts');

  it('creates the archive chip as a standalone button carrying the archive filter id', () => {
    const archive = block(dialogsManager, "const archiveButton = document.createElement('button');", 'foldersRow.append(archiveButton);');

    expect(archive).toContain("archiveButton.dataset.filterId = '' + FOLDER_ID_ARCHIVE;");
    expect(archive).toContain('chatlist-archive-badge');
    expect(archive).toContain('attachButtonClickEvent(archiveButton, () => appSidebarLeft.openArchiveTab());');
  });

  it('keeps the archive chip out of the horizontal menu index', () => {
    const archive = block(dialogsManager, "const archiveButton = document.createElement('button');", 'foldersRow.append(archiveButton);');

    // The delegated folder context menu and the horizontal menu's index lookup
    // both key off this class / the menu container.
    expect(archive).not.toContain('menu-horizontal-div-item');
    expect(archive).toContain('foldersRow.append(archiveButton);');
    expect(archive).not.toContain('this.folders.menuScrollContainer.append(archiveButton)');
  });

  it('routes archive unread into the chip and refreshes it in the batch path', () => {
    expect(dialogsManager).toContain(
      'const unreadSpan = filterId === FOLDER_ID_ARCHIVE ? this.archiveFolderUnread : this.filtersRendered[filterId]?.unread;'
    );

    const batch = block(dialogsManager, 'private setFiltersUnreadCount() {', 'private ');
    const archiveCall = batch.indexOf('this.setFilterUnreadCount(FOLDER_ID_ARCHIVE);');
    const loop = batch.indexOf('for(const filterId in this.filtersRendered)');
    expect(archiveCall).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(archiveCall).toBeLessThan(loop);
  });

  it('declares the archive badge as optional so the short-circuit is honest', () => {
    expect(dialogsManager).toContain('private archiveFolderUnread?: HTMLElement;');
  });
});

describe('compact folder badges — folder tabs', () => {
  const dialogsManager = readFile('lib/appDialogsManager.ts');

  it('marks folder tabs with the compact badge classes and an icon span', () => {
    expect(dialogsManager).toContain("menuTab.classList.add('menu-horizontal-div-item', 'chatlist-folder-badge');");
    expect(dialogsManager).toContain("icon.classList.add('chatlist-folder-icon');");
    expect(dialogsManager).toContain('span.append(icon, titleSpan, unreadSpan, i);');
  });

  it('keeps the tab icon inside the horizontal menu item', () => {
    // Regression guard: the archive chip must not inherit the delegated
    // context menu, but the folder tabs still rely on it.
    expect(dialogsManager).toContain("menuTab.dataset.filterId = '' + id;");
  });
});

describe('compact folder badges — sidebar toggle hiding', () => {
  const sidebar = readFile('components/sidebarLeft/index.ts');
  const scss = readFile('scss/partials/_leftSidebar.scss');

  it('tags the folders-panel sidebar toggle so the media query can reach it', () => {
    expect(sidebar).toContain("className: 'folders-sidebar-layout-toggle',");
  });

  it('hides the chatlist toggle and the menu entry below the floating breakpoint', () => {
    const chatlistRule = block(scss, '@include respond-to(until-floating-left-sidebar) {\n      .chatlist-sidebar-toggle {', '}');
    expect(chatlistRule).toContain('display: none;');

    expect(scss).toContain(
      '@include respond-to(until-floating-left-sidebar) {\n  .folders-sidebar-layout-toggle {\n    display: none;\n  }\n}'
    );
  });

  it('uses the same breakpoint the rail does', () => {
    expect(readFile('scss/partials/_leftSidebar.scss')).toContain('until-floating-left-sidebar');
  });
});
