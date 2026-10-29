/**
 * Code Mode — rail entry + device-local mode state.
 *
 * Code Mode is a MODE inside PhantomChat, not a second app and not a coding
 * engine: the phantoms run their own harnesses, PhantomChat stays a thin
 * client with no filesystem access. See `lib/code-mode.ts`.
 *
 * Two things are worth pinning here:
 *
 *  1. The mode owns NO dialogFilter. If a future change registers it as a
 *     folder it silently enters `filter_order` and the FoldersSync snapshot,
 *     which is exactly the cross-device leakage this design avoids — so the
 *     rail item must keep passing no `id`.
 *  2. Picking a real folder (rail or chat-list tab) must leave the mode, and
 *     picking a folder that fails to select must NOT — otherwise the rail
 *     shows Code highlighted while the chat list shows a folder.
 */
import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import {
  CODE_MODE_BODY_CLASS,
  CODE_MODE_EMOJI_ICON,
  CODE_MODE_LANG_KEY,
  CODE_MODE_SETTING_KEY,
  applyCodeModeClass,
  isCodeModeEnabled
} from '@lib/code-mode';

const SRC = join(__dirname, '../..');
const railSrc = readFileSync(join(SRC, 'components/sidebarLeft/foldersSidebarContent/index.tsx'), 'utf8');
const stateSrc = readFileSync(join(SRC, 'config/state.ts'), 'utf8');
const langSrc = readFileSync(join(SRC, 'lang.ts'), 'utf8');

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
  it('renders a Code rail item between the folder list and the settings button', () => {
    expect(railSrc).toContain('folders-sidebar__code-button');
    expect(railSrc).toContain(`emojiIcon={CODE_MODE_EMOJI_ICON}`);
    expect(railSrc).toContain(`name={i18n(CODE_MODE_LANG_KEY)}`);

    const codeButton = railSrc.indexOf('folders-sidebar__code-button');
    const settingsButton = railSrc.lastIndexOf('icon="equalizer"');
    expect(codeButton).toBeGreaterThan(-1);
    expect(settingsButton).toBeGreaterThan(codeButton);
  });

  it('keeps the mode out of folder storage (no filter id on the rail item)', () => {
    const item = railSrc.slice(
      railSrc.indexOf('folders-sidebar__code-button'),
      railSrc.indexOf('icon="equalizer"')
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

  it('only leaves Code Mode on a USER folder choice, not on a boot-time one', () => {
    // `changing_folder_from_chatlist` also fires when the app restores its
    // initial filter at startup; treating that as a user choice silently
    // cancelled a Code Mode the user had left on across reloads.
    expect(railSrc).toContain('sawUserGesture');
    expect(railSrc).toMatch(/if\(sawUserGesture\) enterCodeMode\(false\);/);
    expect(railSrc).toContain("document.addEventListener('pointerdown', onUserGesture");
  });

  it('parks the chat list on All Chats when Code Mode is entered', () => {
    const enter = railSrc.slice(railSrc.indexOf('async function selectCodeMode'));
    expect(enter).toContain('await setSelectedFolder(FOLDER_ID_ALL)');
  });
});

describe('code mode skin hook', () => {
  it('uses a single body class, not inline styles', () => {
    expect(CODE_MODE_BODY_CLASS).toBe('code-mode');
    expect(CODE_MODE_EMOJI_ICON).toBeTruthy();
  });
});
