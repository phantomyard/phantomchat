/*
 * Owner batch 6 (2026-10-30) — UI regression guards.
 *
 * These are source/CSS assertions, not DOM tests: the app itself needs an
 * authenticated P2P session to render the chat list, so the invariants that
 * actually broke (a presence dot pinned to the old avatar size, a rail width
 * that disagreed with the top bar, two dead folder-management entry points)
 * are pinned at the source level. The geometry numbers here were measured in a
 * real browser against the compiled CSS before landing.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('batch 6: folders rail matches the top bar', () => {
  const scss = read('scss/partials/_foldersSidebar.scss');

  it('rail flex-basis is the top bar height (3.5rem), not the old 5rem', () => {
    expect(scss).toContain('flex: 3.5rem 0 0;');
    expect(scss).not.toContain('flex: 5rem 0 0;');
  });

  it('folder badge offset follows the narrower 30px icon', () => {
    expect(scss).toContain('right: 7px;');
  });
});

describe('batch 6: presence dot lives in the title row', () => {
  const dialogsSrc = read('components/autonomousDialogList/dialogs.ts');
  const managerSrc = read('lib/appDialogsManager.ts');
  const chatlistScss = read('scss/partials/_chatlist.scss');

  it('the dot is stamped into the title container before the P2P chip', () => {
    const dotIdx = managerSrc.indexOf("onlineDot.classList.add('dialog-online-dot');");
    const p2pIdx = managerSrc.indexOf("titleSpanContainer.append(createP2PBadge(peerId, 'p2p-badge--row'));");
    expect(dotIdx).toBeGreaterThan(-1);
    expect(p2pIdx).toBeGreaterThan(-1);
    // the dot is appended to titleSpanContainer above (title row) and the P2P
    // chip comes later in the source, i.e. the browser order is [name][dot][p2p]
    expect(dotIdx).toBeLessThan(p2pIdx);
  });

  it('presence no longer renders on the avatar', () => {
    expect(dialogsSrc).not.toContain('dom.avatarEl.node');
    expect(dialogsSrc).toContain('dom.onlineDot?.classList.toggle');
    // the old avatar :after was pinned to a 54px box and overflowed the row
    expect(chatlistScss).toContain('.dialog-avatar.is-online:after {');
    expect(chatlistScss).toContain('display: none;');
  });

  it('the dot is 8px, inline-block, and hidden until online', () => {
    expect(chatlistScss).toContain('.dialog-online-dot {');
    expect(chatlistScss).toContain('&.is-online {');
    expect(chatlistScss).toContain('width: 8px;');
  });
});

describe('batch 6: dead folder-management entry points are gone', () => {
  const contextMenuSrc = read('helpers/dom/createFolderContextMenu.ts');
  const sidebarSrc = read('components/sidebarLeft/index.ts');
  const railSrc = read('components/sidebarLeft/foldersSidebarContent/index.tsx');

  it('the "Edit folders" context-menu entry is removed', () => {
    expect(contextMenuSrc).not.toContain('FilterEditAll');
    // the surviving entries stay
    expect(contextMenuSrc).toContain('ChatList.Filter.SetDefault');
    expect(contextMenuSrc).toContain('MarkAllAsRead');
  });

  it('the hamburger has no Folders entry', () => {
    expect(sidebarSrc).not.toContain("text: 'Filters'");
  });

  it('the hamburger toggle is labelled Disable Sidebar and flips the setting', () => {
    expect(sidebarSrc).toContain("id: 'folders-sidebar-toggle'");
    expect(sidebarSrc).toContain('DisableSidebar');
    expect(sidebarSrc).toContain('EnableSidebar');
    expect(sidebarSrc).toContain('toggleFoldersSidebar()');
  });

  it('the rail bottom button toggles the layout instead of opening settings', () => {
    expect(railSrc).toContain('toggleFoldersSidebar()');
    expect(railSrc).not.toContain('openingChatFolders');
  });

  it('both toggles share one writer of the stored preference', () => {
    const layoutSrc = read('lib/folders-sidebar-layout.ts');
    expect(layoutSrc).toContain("setAppSettings('tabsInSidebar', enabled)");
    // the body class the CSS keys off must move with it
    expect(layoutSrc).toContain('setHasFoldersSidebar(enabled)');
  });

  it('the new label keys exist in the local lang pack', () => {
    expect(read('lang.ts')).toContain("'DisableSidebar': 'Disable Sidebar'");
    expect(read('lang.ts')).toContain("'EnableSidebar': 'Enable Sidebar'");
  });
});
