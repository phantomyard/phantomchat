/*
 * Owner batch 8 (2026-10-30) — UI regression guards.
 *
 * Source/CSS assertions, same convention as ui-batch6/ui-batch7: the app needs
 * an authenticated P2P session to render the chat list, so the invariants are
 * pinned at the source level. The geometry quoted here was measured in a real
 * browser (vite dev + playwright, synthetic host) against the compiled CSS:
 * the toggle button is 56x56 and sits flush at the head of the tabs row, with
 * the first tab starting 11px after it.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('batch 8: one glyph for the sidebar toggle everywhere', () => {
  const railSrc = read('components/sidebarLeft/foldersSidebarContent/index.tsx');
  const sidebarSrc = read('components/sidebarLeft/index.ts');

  it('the rail bottom button uses the hamburger menu glyph, not the sliders', () => {
    // the hamburger's "Disable Sidebar" entry
    expect(sidebarSrc).toContain("icon: 'rightpanel'");
    // the rail's bottom button — same toggle, same glyph
    expect(railSrc).toContain('icon="rightpanel"');
    expect(railSrc).not.toContain('icon="equalizer"');
  });
});

describe('batch 8: chat-list header carries the same toggle', () => {
  const managerSrc = read('lib/appDialogsManager.ts');
  const scss = read('scss/partials/_leftSidebar.scss');

  it('the toggle is built and inserted before the folders tabs strip', () => {
    const rowIdx = managerSrc.indexOf("foldersRow.classList.add('chatlist-folders-row');");
    const appendIdx = managerSrc.indexOf('foldersRow.append(foldersSidebarToggle, this.folders.menuScrollContainer);');
    const prependIdx = managerSrc.indexOf('bottomPart.prepend(foldersRow);');
    expect(rowIdx).toBeGreaterThan(-1);
    // button first, tabs second — the button is the head of the row
    expect(appendIdx).toBeGreaterThan(rowIdx);
    expect(prependIdx).toBeGreaterThan(appendIdx);
  });

  it('it drives the one shared layout writer', () => {
    expect(managerSrc).toContain("import('@lib/folders-sidebar-layout')");
    expect(managerSrc).toContain('toggleFoldersSidebar()');
  });

  it('it is gated on folders being horizontal, never on the rail preference', () => {
    expect(scss).toContain('.chatlist-folders-row {');
    // The row is the only parent of the strip: gating it on the rail
    // preference hid every folders surface at <= 925px with the rail on.
    expect(scss).toContain('body.has-horizontal-folders & {');
    expect(scss).not.toContain('body.has-horizontal-folders:not(.has-folders-sidebar) & {');
    // only the button is rail-mode specific
    expect(scss).toContain('body.has-folders-sidebar & .chatlist-sidebar-toggle {');
    expect(scss).toContain('.chatlist-sidebar-toggle {');
    // matches the rail/top bar width
    expect(scss).toContain('width: 3.5rem;');
  });

  it('the strip is allowed to fill and shrink inside the row', () => {
    // Computed behaviour is checked in ui-batch8-cascade; this pins where.
    expect(scss).toContain('flex: 1 1 auto;');
    expect(scss).toContain('min-width: 0;');
  });
});
