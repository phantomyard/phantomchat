/*
 * Owner batch 8 — cascade guards for the folders strip and the presence dot.
 *
 * The batch-6/7/8 tests are source-text assertions on the SCSS, which lock the
 * text of a rule rather than what it computes: one of them happily pinned a
 * selector that hid the folders strip in rail mode on narrow windows. These
 * compile the real `src/scss/style.scss` and ask for computed values instead.
 *
 * Media-query caveat: jsdom keeps `@media` rules in the CSSOM but never applies
 * them, so anything asserted through `getComputedStyle` here lives outside a
 * query. The presence dot's white-on-active rule *is* inside
 * `@media (min-width: 601px)`, so that one is checked by comparing selector
 * specificity across the flattened sheet (treated as satisfied, which it is on
 * every desktop window) rather than by computing a colour.
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

/** [ids, classes+attributes+pseudo-classes, elements+pseudo-elements] */
function specificity(selector: string): [number, number, number] {
  const s = selector
    .replace(/:not\(([^)]*)\)/g, ' $1 ')
    .replace(/::[a-z-]+/gi, ' ::pseudo-element ')
    .replace(/:([a-z-]+)(\([^)]*\))?/gi, (m, name) => name === 'pseudo-element' ? m : ' .pseudo ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]*\]/g) || []).length + (s.match(/\.pseudo/g) || []).length;
  const elements = s.split(/[\s>+~]+/).filter(part => part && !part.startsWith('#') && !part.startsWith('.') && !part.startsWith('[') && !part.startsWith(':')).length;
  return [ids, classes, elements];
}

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

describe('presence dot', () => {
  it('keeps the white-on-active rule authoritative', () => {
    const sheet = flatten();
    const fixture = new JSDOM(`<!doctype html><html><body>
      <div class="chatlist-chat active"><div class="row-title"><span class="dialog-online-dot is-online"></span></div></div>
    </body></html>`).window.document.querySelector('.dialog-online-dot')!;

    const background = (rule: {style: CSSStyleDeclaration}) =>
      rule.style.getPropertyValue('background-color') || rule.style.getPropertyValue('background');

    // Every rule that paints this element, with the best-matching selector of
    // each list and that selector's specificity.
    const painting = sheet
      .filter(rule => background(rule))
      .flatMap(rule => rule.selector.split(',').map(sel => {
        const selector = sel.trim();
        try { return fixture.matches(selector) ? {selector, background: background(rule)} : null; }
        catch { return null; }
      }))
      .filter((hit): hit is {selector: string; background: string} => !!hit);

    // The dot's default is the primary colour, which is the active row's own
    // background — so the active rule must win on specificity, not on order.
    const fallback = painting.filter(hit => hit.background.includes('--avatar-online-color'));
    const white = painting.filter(hit => /#fff|255, 255, 255/i.test(hit.background));
    expect(fallback.length).toBe(1);
    expect(white.length).toBe(1);

    // Same specificity would make it a file-order coin flip; higher is the point.
    expect(compare(specificity(white[0].selector), specificity(fallback[0].selector))).toBeGreaterThan(0);
  });

  it('does not reach for an id in the dot default', () => {
    // An id there outranks `.chatlist-chat.active .dialog-online-dot` and the
    // dot disappears on the selected row.
    const sheet = flatten();
    const dotRules = sheet.filter(rule => rule.selector.includes('.dialog-online-dot'));
    expect(dotRules.length).toBeGreaterThan(0);
    for(const rule of dotRules) {
      for(const sel of rule.selector.split(',')) {
        if(!sel.includes('.dialog-online-dot')) continue;
        expect(sel).not.toMatch(/#[\w-]+\s/);
      }
    }
  });
});

function compare(a: [number, number, number], b: [number, number, number]) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
