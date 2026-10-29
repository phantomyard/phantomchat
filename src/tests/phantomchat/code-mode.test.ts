/**
 * Code Mode — rail entry + device-local mode state.
 *
 * Code Mode is a MODE inside PhantomChat, not a second app and not a coding
 * engine: the phantoms run their own harnesses, PhantomChat stays a thin
 * client with no filesystem access. See `lib/code-mode.ts`.
 *
 * Worth pinning here:
 *
 *  1. The mode owns NO dialogFilter. If a future change registers it as a
 *     folder it silently enters `filter_order` and the FoldersSync snapshot,
 *     which is exactly the cross-device leakage this design avoids — so the
 *     rail item must keep passing no `id`.
 *  2. Picking a real folder (rail or chat-list tab) must leave the mode, and
 *     picking a folder that fails to select must NOT — otherwise the rail
 *     shows Code highlighted while the chat list shows a folder.
 *  3. Folders are stripped (Andrew, 2026-10-29): no New Folder in the pencil
 *     menu, no Folders entry in the hamburger, no folders management button in
 *     the rail, and the rail is always on showing All Chats / Groups / Code.
 */
import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import {
  CODE_MODE_BODY_CLASS,
  CODE_MODE_LANG_KEY,
  CODE_MODE_RAIL_GLYPH,
  CODE_MODE_SETTING_KEY,
  applyCodeModeClass,
  isCodeModeEnabled
} from '@lib/code-mode';

const SRC = join(__dirname, '../..');
const railSrc = readFileSync(join(SRC, 'components/sidebarLeft/foldersSidebarContent/index.tsx'), 'utf8');
const sidebarSrc = readFileSync(join(SRC, 'components/sidebarLeft/index.ts'), 'utf8');
const stateSrc = readFileSync(join(SRC, 'config/state.ts'), 'utf8');
const langSrc = readFileSync(join(SRC, 'lang.ts'), 'utf8');
const inboxSrc = readFileSync(join(SRC, 'components/phantomchat/codeInbox.tsx'), 'utf8');
const indexSrc = readFileSync(join(SRC, 'index.ts'), 'utf8');

describe('code-mode module', () => {
  it('treats only a literal true as enabled', () => {
    expect(isCodeModeEnabled(true)).toBe(true);
    for(const off of [undefined, null, false, 0, 1, 'true', {}, []]) {
      expect(isCodeModeEnabled(off)).toBe(false);
    }
  });

  it('toggles the skin class on the given element', () => {
    const classList = {add: vi.fn(), remove: vi.fn()};

    expect(applyCodeModeClass({classList} as any, true)).toBe(true);
    expect(classList.add).toHaveBeenCalledWith(CODE_MODE_BODY_CLASS);
    expect(classList.remove).not.toHaveBeenCalled();

    expect(applyCodeModeClass({classList} as any, false)).toBe(false);
    expect(classList.remove).toHaveBeenCalledWith(CODE_MODE_BODY_CLASS);
  });

  it('is device-local in the settings store', () => {
    expect(CODE_MODE_SETTING_KEY).toBe('codeModeEnabled');
    expect(stateSrc).toContain('codeModeEnabled?: boolean');
  });

  it('has a lang key so the rail label is translatable', () => {
    expect(langSrc).toContain(`'${CODE_MODE_LANG_KEY}':`);
  });
});

describe('code mode rail wiring', () => {
  it('renders the Code rail item under the chat lists', () => {
    expect(railSrc).toContain('folders-sidebar__code-button');
    expect(railSrc).toContain('iconText={CODE_MODE_RAIL_GLYPH}');
    expect(railSrc).toContain('name={i18n(CODE_MODE_LANG_KEY)}');

    const codeButton = railSrc.indexOf('folders-sidebar__code-button');
    const chatsList = railSrc.indexOf('<For each={folderItems}>');
    expect(codeButton).toBeGreaterThan(chatsList);
  });

  it('keeps the mode out of folder storage (no filter id on the rail item)', () => {
    const item = railSrc.slice(
      railSrc.indexOf('folders-sidebar__code-button'),
      railSrc.indexOf('</Scrollable>')
    );

    expect(item).not.toMatch(/\bid[=:]/);
    expect(item).not.toMatch(/FOLDER_ID_/);
  });

  it('persists the selection and drives the body class', () => {
    expect(railSrc).toContain('setAppSettings(CODE_MODE_SETTING_KEY, enabled)');
    expect(railSrc).toContain('applyCodeModeClass(document.body, codeMode())');
  });

  it('never highlights a folder while Code Mode is on', () => {
    expect(railSrc).toContain('selected={isSelected(id) && !codeMode()}');
  });

  it('leaves Code Mode when a real folder is picked from the rail', () => {
    const railClick = railSrc.slice(
      railSrc.indexOf('async function selectFolderFromRail'),
      railSrc.indexOf('async function selectCodeMode')
    );
    // Folder switch must SUCCEED before the mode is dropped.
    expect(railClick).toMatch(/if\(await setSelectedFolder\(folderId\)\)\s*\{\s*enterCodeMode\(false\);/);
  });

  it('leaves Code Mode when the chat-list tabs pick a folder', () => {
    const listener = railSrc.slice(
      railSrc.indexOf("'changing_folder_from_chatlist'"),
      railSrc.indexOf("createEffect(() => {\n    if(!props.isFiltersInited)")
    );
    expect(listener).toContain('enterCodeMode(false)');
  });

  it('only leaves Code Mode on a RECENT user folder choice', () => {
    // `changing_folder_from_chatlist` also fires when the app restores its
    // initial filter at startup (which must not cancel a Code Mode left on
    // across a reload) and when a folder syncs in from another device (which
    // must not either). A recency window gets both: a click is a choice, a
    // background update is not — and unlike a once-only latch it re-arms.
    expect(railSrc).toContain('lastGestureAt');
    expect(railSrc).toMatch(/if\(Date\.now\(\) - lastGestureAt < GESTURE_WINDOW_MS\) enterCodeMode\(false\);/);
    expect(railSrc).toContain("document.addEventListener('pointerdown', onUserGesture");
    expect(railSrc).not.toContain('{once: true}');
  });

  it('parks the chat list on All Chats when Code Mode is entered — and only then', () => {
    const enter = railSrc.slice(
      railSrc.indexOf('async function selectCodeMode'),
      railSrc.indexOf('createEffect(() => {\n    const _menuTarget')
    );
    // A failed park (folder limit popup) must not leave the rail claiming Code.
    expect(enter).toMatch(/if\(await setSelectedFolder\(FOLDER_ID_ALL\)\) enterCodeMode\(true\);/);
  });
});

describe('folders are stripped from the UI (#279)', () => {
  it('shows only All Chats and Groups in the rail', () => {
    expect(railSrc).toMatch(/props\.filters\.filter\(\(filter\) => REAL_FOLDERS\.has\(filter\.id\) && filter\.id !== FOLDER_ID_ARCHIVE\)/);
  });

  it('has no New Folder entry in the pencil menu', () => {
    expect(sidebarSrc).not.toContain("text: 'FilterNew'");
    expect(sidebarSrc).not.toContain('onNewFolderClick');
  });

  it('has no Filters entry in the hamburger menu', () => {
    const hamburger = sidebarSrc.slice(sidebarSrc.indexOf('const menuButtons'), sidebarSrc.indexOf("id: 'settings'"));
    expect(hamburger).not.toContain("text: 'Filters'");
  });

  it('has no folders-management button and no add-folders pill in the rail', () => {
    expect(railSrc).not.toContain('icon="equalizer"');
    expect(railSrc).not.toContain('folders-sidebar__add-folders-button');
  });

  it('forces the folders sidebar on (no user toggle)', () => {
    // Andrew: "default to folders on left".
    expect(indexSrc).toMatch(/setHasFoldersSidebar\(true\);/);
  });
});

describe('code mode inbox lifecycle', () => {
  it('re-reads the session list on the session-changed event and a backstop timer', () => {
    expect(inboxSrc).toContain('CODE_SESSIONS_CHANGED_EVENT');
    expect(inboxSrc).toContain('REFRESH_INTERVAL_MS');
    expect(inboxSrc).toMatch(/if\(isActive\(\)\) void refresh\(\);/);
  });

  it('tears every listener and timer down on cleanup', () => {
    const cleanup = inboxSrc.slice(inboxSrc.indexOf('onCleanup(() => {'));
    expect(cleanup).toContain('detach()');
    expect(cleanup).toContain('clearInterval(clock)');
    expect(cleanup).toContain('clearInterval(backstop)');

    const runtimeSrc = readFileSync(join(SRC, 'lib/phantomchat/code-session-runtime.ts'), 'utf8');
    expect(runtimeSrc).toContain("removeEventListener('peer_typings'");
    expect(runtimeSrc).toContain('clearInterval(timer)');
  });
});

describe('session context menu works (Andrew 2026-10-30)', () => {
  it('the outside-click closer must not fire for pointerdowns inside the menu', () => {
    // The old closer (`setMenu(null)` on any pointerdown) unmounted the menu
    // before its first click could land — the delegated Solid handler and the
    // document closer both sit on `document`, so `stopPropagation` on the
    // menu cannot keep the closer from firing. The fix is a containment
    // check: menu ref + `menuEl.contains(target)`.
    expect(inboxSrc).toMatch(/const closeMenu = \(event: PointerEvent\) => \{/);
    expect(inboxSrc).toContain('if(menuEl && target && menuEl.contains(target)) return;');
    expect(inboxSrc).toMatch(/ref=\{\(el\) => menuEl = el\}/);
  });

  it('archiving or deleting the open session clears the right pane', () => {
    expect(inboxSrc).toMatch(/openGroupId\(\) === groupId\) \{\s*setOpenGroupId\(null\);\s*clearRightPane\(\);/);
  });

  it('on activation an open NON-session chat is parked, a session chat is not', () => {
    expect(inboxSrc).toMatch(/hydrate\(\)\.then\(refresh\)\.then\(assertEmptyRightPane\)/);
    expect(inboxSrc).toMatch(/if\(codeSessionRuntime\.groupIdForPeer\(peerId\)\) return;/);
  });
});

describe('pencil lives in the rail in Code Mode (Andrew 2026-10-30)', () => {
  it('sidebarLeft re-parents #new-menu on mode + breakpoint change', () => {
    expect(sidebarSrc).toContain('placeNewMenuButton');
    expect(sidebarSrc).toContain("document.getElementById('folders-sidebar')");
    expect(sidebarSrc).toMatch(/new MutationObserver\(placeNewMenuButton\)/);
    expect(sidebarSrc).toMatch(/matchMedia\('\(max-width: 925px\)'\)/);
  });

  it('the skin shows the pencil inside the rail', () => {
    const scss = readFileSync(join(SRC, 'scss/phantomchat/_code-mode.scss'), 'utf8');
    expect(scss).toMatch(/body\.code-mode \.folders-sidebar \.btn-new-menu \{/);
    expect(scss).toContain('display: flex;');
    expect(scss).toContain('inset-inline-start: 50% !important;');
  });
});

describe('empty rail looks like an empty folder (Andrew 2026-10-30)', () => {
  it('uses the folder 📂 sticker, not the chat-list EmptyChats.svg', () => {
    expect(inboxSrc).toContain("wrapStickerEmoji({div: el, emoji: '📂', width: 128, height: 128})");
    expect(inboxSrc).not.toMatch(/src=\"?\.?\/?assets\/img\/EmptyChats\.svg/);
    expect(inboxSrc).toContain('empty-placeholder-folder');
  });

  it('keeps the folder-empty shape: header + subtitle', () => {
    expect(inboxSrc).toContain('CodeModeEmptySessionsTitle');
    expect(inboxSrc).toContain('CodeModeEmptySessionsHint');
  });
});

describe('code mode skin hook', () => {
  it('uses a single body class, not inline styles', () => {
    expect(CODE_MODE_BODY_CLASS).toBe('code-mode');
  });

  it('draws the rail glyph as a `#` in the icon style, not an emoji', () => {
    // Andrew (2026-10-29): a `#` badge in the same style as the other rail
    // icons. An emoji renders as a colour sticker and breaks the monochrome
    // rail, so the glyph rides the text-icon slot instead.
    expect(CODE_MODE_RAIL_GLYPH).toBe('#');
    expect(railSrc).not.toContain('emojiIcon={CODE_MODE');

    const folderItemSrc = readFileSync(
      join(SRC, 'components/sidebarLeft/foldersSidebarContent/folderItem.tsx'),
      'utf8'
    );
    expect(folderItemSrc).toContain('folders-sidebar__folder-item-icon--text');
    expect(folderItemSrc).toContain('props.iconText');
  });
});
