/*
 * Cascade guards for the folders strip and selected-chat unread counters.
 *
 * The batch-6/7/8 tests are source-text assertions on the SCSS, which lock the
 * text of a rule rather than what it computes: one of them happily pinned a
 * selector that hid the folders strip in rail mode on narrow windows. These
 * compile the real `src/scss/style.scss` and ask for computed values instead.
 *
 * Media-query caveat: jsdom keeps `@media` rules in the CSSOM but never applies
 * them, so anything asserted through `getComputedStyle` here lives outside a
 * query. The selected-row badge rules deliberately apply at every width.
 */
import {describe, it, expect, beforeAll} from 'vitest';
import {JSDOM} from 'jsdom';
import * as sass from 'sass';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

let css: string;
// jsdom is untyped here (src/tests/jsdom.d.ts); the fixtures need its DOM.
let win: any;

const ROW_MARKUP = (bodyClasses: string) => `<!doctype html><html><head><style>${css.replace(/<\/style>/g, '')}</style></head><body class="${bodyClasses}">
<div id="column-left"><div id="chatlist-container"><div class="connection-status-bottom">
  <div class="chatlist-folders-row">
    <button class="chatlist-sidebar-toggle"></button>
    <div class="folders-tabs-scrollable menu-horizontal-scrollable">
      <div class="scrollable scrollable-x"><div id="folders-tabs"></div></div>
    </div>
  </div>
</div></div></div></body></html>`;

const mount = (bodyClasses: string) => {
  win = new JSDOM(ROW_MARKUP(bodyClasses), {pretendToBeVisual: true}).window;
  const q = (sel: string) => win.document.querySelector(sel)!;
  const cs = (sel: string) => win.getComputedStyle(q(sel));
  return {
    row: cs('.chatlist-folders-row'),
    strip: cs('.folders-tabs-scrollable'),
    toggle: cs('.chatlist-sidebar-toggle'),
    scrollable: cs('.folders-tabs-scrollable .scrollable-x')
  };
};

/** Every declaration block in the compiled sheet, media-query ancestry noted. */
function flatten(): {selector: string; style: CSSStyleDeclaration; media: string}[] {
  const out: {selector: string; style: CSSStyleDeclaration; media: string}[] = [];
  const walk = (rules: any, media: string) => {
    for(const rule of Array.from(rules) as any[]) {
      if(rule.cssRules) {
        walk(rule.cssRules, rule.conditionText ? `${media} ${rule.conditionText}`.trim() : media);
        continue;
      }
      if(rule.selectorText && rule.style) out.push({selector: rule.selectorText, style: rule.style, media});
    }
  };
  const sheet = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`).window.document.styleSheets[0];
  walk(sheet.cssRules, '');
  return out;
}

beforeAll(() => {
  css = sass.compile(path.join(SRC, 'scss/style.scss'), {style: 'expanded'}).css;
}, 120_000);

describe('folders strip visibility', () => {
  it('is reachable with the rail preference on (the default) on a narrow window', () => {
    // body.has-horizontal-folders is also true when the rail is merely unable
    // to fit, i.e. rail preference ON below the floating-sidebar breakpoint.
    // The row must not be gated on the preference, only on usability.
    const {row, strip, toggle} = mount('has-horizontal-folders has-folders-sidebar');
    expect(row.display).toBe('flex');
    expect(strip.display).toBe('block');
    expect(toggle.display).toBe('none');
  });

  it('is reachable with the rail off, and the toggle comes back', () => {
    const {row, strip, toggle} = mount('has-horizontal-folders');
    expect(row.display).toBe('flex');
    expect(strip.display).toBe('block');
    expect(toggle.display).toBe('flex');
  });

  it('stays hidden when the rail is on screen', () => {
    // No .has-horizontal-folders: the rail is the folders surface.
    const {row, strip} = mount('');
    expect(row.display).toBe('none');
    expect(strip.display).toBe('none');
  });
});

describe('folders strip geometry', () => {
  it('takes the row width so the inner scroller can actually overflow', () => {
    // `.item-main .menu-horizontal-scrollable` sets flex: 0 0 auto, which as a
    // flex item sizes the strip to its content: no overflow, so no horizontal
    // scroll, and the row spills past the column. Measured 427px starting at
    // x=56 in a 420px column before the fix.
    const {strip, row} = mount('has-horizontal-folders');
    expect(strip.flexGrow).toBe('1');
    expect(strip.flexShrink).toBe('1');
    expect(strip.flexBasis).toBe('auto');
    expect(strip.minWidth).toBe('0');
    // and the row itself must be allowed to shrink
    expect(row.minWidth).toBe('0');
  });
});

describe('chat-list presence and selected unread badges', () => {
  it('has no inline presence-dot paint rules', () => {
    expect(flatten().filter(rule => rule.selector.includes('.dialog-online-dot'))).toEqual([]);
  });

  it('hides normal and collapsed unread counters only on the selected row', () => {
    const document = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="chatlist-chat active" id="selected">
        <span class="badge dialog-subtitle-badge-unread">7</span><span class="badge avatar-badge">7</span>
      </div>
      <div class="chatlist-chat" id="closed">
        <span class="badge dialog-subtitle-badge-unread">7</span><span class="badge avatar-badge">7</span>
      </div>
    </body></html>`).window;
    for(const selector of ['.dialog-subtitle-badge-unread', '.avatar-badge']) {
      expect(document.getComputedStyle(document.document.querySelector(`#selected ${selector}`)!).display).toBe('none');
      expect(document.getComputedStyle(document.document.querySelector(`#closed ${selector}`)!).display).not.toBe('none');
    }
    document.close();
  });
});
