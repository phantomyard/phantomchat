/*
 * Owner batch 9 (2026-10-30) — UI regression guards.
 *
 * Source/CSS assertions, same convention as ui-batch6/7/8: the app needs an
 * authenticated P2P session to render the chat list, so the invariants are
 * pinned at the source level. The geometry quoted here was measured in a real
 * browser (vite dev + playwright, fixture page built from the real SCSS)
 * against the compiled CSS.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('batch 9: the hamburger is centred in the collapsed 56px bar', () => {
  const scss = read('scss/partials/_leftSidebar.scss');

  it('positions the collapsed header button off the 56px column, not the old 80px one', () => {
    // Collapsed column 56px, .sidebar-header__btn-container 40px, so the
    // exact centre is (56 - 40) / 2 = 8px. The previous 20px was the 80px
    // column's centre and left the button 12px right of centre, overhanging
    // the narrow bar.
    const rule = scss.slice(scss.indexOf('.sidebar-header.main-search-sidebar-header .sidebar-header__btn-container:not(.force-static) {'));
    expect(rule).toContain('left: calc(max(0px, (100vw - #{$large-screen}) / 2) + 8px) !important;');
    expect(rule).not.toContain('+ 20px) !important;');
  });

  it('still pins the button to the top bar height so it lines up vertically', () => {
    const rule = scss.slice(scss.indexOf('.sidebar-header.main-search-sidebar-header .sidebar-header__btn-container:not(.force-static) {'));
    // (56 - 40) / 2 as well — same row height as the rail and the top bar.
    expect(rule).toContain('top: 8px;');
  });
});
