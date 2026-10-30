/*
 * Owner batch 7 (2026-10-30) — collapsed sidebar geometry.
 *
 * Source/CSS assertions, not DOM tests: the collapsed column only renders with
 * an authenticated session, so the two numbers that broke are pinned here.
 * Both were measured in a real browser against the compiled CSS first:
 * column 56px, row 56px, badge 16x16 at (32,32) with 8px clearance on the row
 * and column edges.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('batch 7: collapsed chat list is as wide as the rail', () => {
  const scss = read('scss/partials/_leftSidebar.scss');
  const src = read('components/sidebarLeft/index.ts');

  it('--sidebar-collapsed-width matches --topbar-height (3.5rem)', () => {
    expect(scss).toContain('--sidebar-collapsed-width: 56px;');
    expect(scss).not.toContain('--sidebar-collapsed-width: 80px;');
  });

  // The collapse animation writes --sidebar-left-width-when-collapsed inline
  // and removes it when it ends, so a stale constant makes the column animate
  // to the old width and then snap to the CSS value.
  it('the collapse animation ends on the same width', () => {
    expect(src).toContain('const WIDTH_WHEN_COLLAPSED = 56;');
  });
});

describe('batch 7: avatar unread badge fits the narrower column', () => {
  const scss = read('scss/partials/_chatlist.scss');
  const rule = scss.slice(scss.indexOf('&.avatar-badge {'));

  it('is a 16px circle, not the 26px one sized for the 54px avatar', () => {
    expect(rule).toContain('--size: 1rem;');
    expect(rule).not.toContain('--size: 1.625rem;');
  });

  it('sits on the avatar corner instead of the old 65px/39px offsets', () => {
    expect(rule).toContain('right: calc(100% - 3rem);');
    expect(rule).toContain('top: 2rem;');
    expect(rule).not.toContain('right: calc(100% - 4.0625rem);');
    expect(rule).not.toContain('top: 2.4375rem;');
  });

  // 16px box minus the 2px border on each side, or the digit sits off-centre.
  it('keeps the line-height in step with the smaller box', () => {
    expect(rule).toContain('line-height: 12px !important;');
  });
});
