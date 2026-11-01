/*
 * Archived-tab chat rows must use the same compact geometry as the Chats tab.
 *
 * Owner report (2026-11-01): the avatars in the Archived folder were larger than
 * the avatars in the other folders. Cause: the owner batch 4/5 compact rules
 * were scoped to `#chatlist-container`, the hardcoded node index.html gives the
 * Chats tab. AppArchivedTab does not reuse that node — it builds its own
 * AutonomousDialogList and mounts it in `#chats-archived-container` — so those
 * rows kept the defaults (54px avatar inside a 72px row) while the virtual list
 * still placed them on the shared 56px itemSize.
 *
 * Per the batch 6-9 convention this asserts on the compiled cascade rather than
 * on rule text, and it derives the archived container id from the tab source so
 * a rename can never silently re-open the gap.
 */
import {describe, it, expect, beforeAll} from 'vitest';
import {JSDOM} from 'jsdom';
import * as sass from 'sass';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

let css: string;
/** The id AppArchivedTab gives its container, read from the tab itself. */
let archivedContainerId: string;

type FlatRule = {selector: string, style: CSSStyleDeclaration};

function flatten(sheetCss: string): FlatRule[] {
  const out: FlatRule[] = [];
  const walk = (rules: any) => {
    for(const rule of Array.from(rules) as any[]) {
      if(rule.cssRules) {
        walk(rule.cssRules);
        continue;
      }
      if(rule.selectorText && rule.style) out.push({selector: rule.selectorText, style: rule.style});
    }
  };
  const sheet = new JSDOM(`<!doctype html><html><head><style>${sheetCss}</style></head><body></body></html>`).window.document.styleSheets[0];
  walk(sheet.cssRules);
  return out;
}

/**
 * Declarations are read off `cssText`: the bundled cssstyle drops the value of a
 * declaration that carries `!important`, which is exactly how these rules are
 * written.
 */
function declares(rule: FlatRule, property: string, value: string) {
  return rule.style.cssText.split(';').some(declaration => {
    const [name, ...rest] = declaration.split(':');
    if(!rest.length || name.trim() !== property) return false;
    return rest.join(':').replace('!important', '').trim() === value;
  });
}

/** Every selector in the compiled sheet that sets `property: value`. */
function selectorsSetting(rules: FlatRule[], property: string, value: string) {
  return rules
  .filter(rule => declares(rule, property, value))
  .flatMap(rule => rule.selector.split(','))
  .map(selector => selector.replace(/\s+/g, ' ').trim())
  .join(', ');
}

beforeAll(() => {
  css = sass.compile(path.join(SRC, 'scss/style.scss'), {style: 'expanded'}).css;
  const match = read('components/sidebarLeft/tabs/archivedTab.ts').match(/container\.id = '([^']+)'/);
  archivedContainerId = match?.[1];
}, 120_000);

describe('archived chat rows match the compact chat-list geometry', () => {
  it('is the container the archived tab actually mounts its list in', () => {
    expect(archivedContainerId).toBe('chats-archived-container');
  });

  it('sizes the dialog avatar to the 32px top-bar box in both lists', () => {
    const scopes = selectorsSetting(flatten(css), 'width', '2rem');
    // The compact avatar box: 2rem (32px), matching the top-bar avatar.
    const avatarScopes = scopes.split(', ').filter(selector => selector.includes('.dialog-avatar.row-media-bigger'));
    expect(avatarScopes.some(selector => selector.startsWith('#chatlist-container '))).toBe(true);
    expect(avatarScopes.some(selector => selector.startsWith(`#${archivedContainerId} `))).toBe(true);
  });

  it('pins the compact 56px row height in both lists', () => {
    const scopes = selectorsSetting(flatten(css), 'height', '3.5rem');
    const rowScopes = scopes.split(', ').filter(selector => selector.endsWith('.chatlist-chat.row-big'));
    expect(rowScopes.some(selector => selector.startsWith('#chatlist-container '))).toBe(true);
    expect(rowScopes.some(selector => selector.startsWith(`#${archivedContainerId} `))).toBe(true);
  });

  /**
   * #326: the stylesheet half above is only half the contract. `row-big` and
   * `dialog-avatar.row-media-bigger` are emitted by `appDialogsManager`'s
   * `avatarSize === 'bigger'` branch, not by the archived tab — so a future
   * change to that branch would leave these assertions green while the rows
   * quietly went back to a 54px avatar inside a 72px row, which is the bug
   * this file exists to prevent.
   *
   * The honest shape would be mounting an `AppArchivedTab` row, but importing
   * `appDialogsManager` pulls the whole app (IDB, popups, IntersectionObserver)
   * into the test, so instead each link of the chain is pinned: the branch
   * emits the classes, the archived list reaches that branch, and the CSS keys
   * off exactly those classes.
   */
  it('the classes the archived scopes target are emitted only by the bigger-avatar branch', () => {
    const src = read('lib/appDialogsManager.ts');

    // `row-big` exists for one reason: this branch.
    expect(src).toContain("if(avatarSize === 'bigger') {");
    expect(src).toContain("this.container.classList.add('row-big')");

    // The avatar class is derived from the same variable that gates `row-big`,
    // so `row-media-bigger` cannot drift from the container class.
    const ctor = src.slice(src.indexOf('constructor({'), src.indexOf("if(avatarSize === 'bigger') {"));
    expect(ctor).toContain('this.applyMediaElement(avatarEl, avatarSize)');
    // …and applyMediaElement is what turns 'bigger' into the class name.
    expect(read('components/row.ts')).toContain("media.classList.add('row-media-' + size)");
  });

  it('the archived list reaches that branch, and the shared row options do not override the size', () => {
    // AppArchivedTab mounts the manager's own AutonomousDialogList for
    // FOLDER_ID_ARCHIVE → SortedDialogList.createElementForKey →
    // appDialogsManager.addListDialog → addDialogNew({avatarSize: 'bigger'}).
    const archived = read('components/sidebarLeft/tabs/archivedTab.ts');
    expect(archived).toContain('localId: FOLDER_ID_ARCHIVE');
    expect(archived).toContain('appDialogsManager.xds[AppArchivedTab.filterId]');

    // That list class is the one the manager builds rows with.
    const managerForList = read('lib/appDialogsManager.ts');
    expect(managerForList).toContain('new AutonomousDialogList({filterId: filter.id, appDialogsManager: this})');

    const sorted = read('components/sortedDialogList.ts');
    expect(sorted).toContain('this.appDialogsManager.addListDialog(options)');

    // getDialogOptions is shared by every list, Chats included. The moment it
    // sets avatarSize itself, the archived rows stop going through the bigger
    // branch and the archived-scoped rules above stop matching — which is
    // exactly how this would regress without a single assertion failing.
    const opts = sorted.slice(sorted.indexOf('private getDialogOptions'), sorted.indexOf('private getAsAllChats'));
    expect(opts).not.toContain('avatarSize');

    // The default it inherits.
    const addDialogNew = managerForList.slice(managerForList.indexOf('public addDialogNew'));
    expect(addDialogNew).toContain("avatarSize: 'bigger',");
  });

  it('leaves no archived rule at the old 54px avatar size', () => {
    const rules = flatten(css).filter(rule => rule.selector.includes(`#${archivedContainerId}`));
    // 3.375rem = 54px, the size the bug left behind.
    const wrong = rules.filter(rule => declares(rule, 'width', '3.375rem'));
    expect(wrong.map(rule => rule.selector)).toEqual([]);
  });

  it('keeps the matching inline padding in both lists so text does not start under the smaller avatar', () => {
    const scopes = selectorsSetting(flatten(css), 'padding-inline-start', '3.125rem');
    expect(scopes.split(', ').some(selector => selector.startsWith('#chatlist-container '))).toBe(true);
    expect(scopes.split(', ').some(selector => selector.startsWith(`#${archivedContainerId} `))).toBe(true);
  });
});
