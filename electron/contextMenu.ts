/*
 * Native right-click menu for editable fields (issue: spellchecker suggests
 * no corrections on right-click).
 *
 * Electron renders no default context menu — the `context-menu` event is the
 * app's cue to build one ("needs to be handled"). Web K supplies its own DOM
 * menus for bubbles, the send button and search results, but text fields had
 * none: Blink's spelling underline worked, yet right-clicking a misspelled
 * word never offered corrections. The suggestions ride the event params, so
 * the fix is a menu built from them: dictionary suggestions via
 * replaceMisspelling(), Add to dictionary, then the standard edit commands
 * gated by params.editFlags.
 */
import {Menu, MenuItem, BrowserWindow, type WebContents, type MenuItemConstructorOptions} from 'electron';

/** The subset of Electron's ContextMenuParams this builder needs. */
export type EditableContextParams = {
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
};

/** The subset of WebContents the menu actions drive (stub-friendly). */
export type SpellcheckTarget = {
  replaceMisspelling: (word: string) => void;
  session: {addWordToSpellCheckerDictionary: (word: string) => boolean};
};

const MAX_SUGGESTIONS = 5;

/**
 * Build the menu template for an editable field. Pure — no Electron Menu is
 * constructed here, so this is unit-testable without a display.
 *
 * Blink resolves spelling suggestions asynchronously, so a right-click
 * within a few ms of typing can carry an empty suggestion list; the follow-up
 * right-click on the same word has them cached. The disabled "No spelling
 * suggestions" row keeps the menu honest in that window instead of showing
 * a bare Add to dictionary.
 */
export function buildEditableMenuItems(
  params: EditableContextParams,
  target: SpellcheckTarget
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  const word = params.misspelledWord;
  if(word) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if(suggestions.length) {
      for(const suggestion of suggestions) {
        items.push({label: suggestion, click: () => target.replaceMisspelling(suggestion)});
      }
    } else {
      items.push({label: 'No spelling suggestions', enabled: false});
    }
    items.push({type: 'separator'});
    items.push({
      label: 'Add to dictionary',
      click: () => {
        target.session.addWordToSpellCheckerDictionary(word);
      }
    });
    items.push({type: 'separator'});
  }

  const flags = params.editFlags;
  if(flags.canUndo) items.push({label: 'Undo', role: 'undo'});
  if(flags.canRedo) items.push({label: 'Redo', role: 'redo'});
  if(flags.canUndo || flags.canRedo) items.push({type: 'separator'});
  if(flags.canCut) items.push({label: 'Cut', role: 'cut'});
  if(flags.canCopy) items.push({label: 'Copy', role: 'copy'});
  if(flags.canPaste) items.push({label: 'Paste', role: 'paste'});
  if(flags.canSelectAll) items.push({label: 'Select All', role: 'selectAll'});

  while(items.length && items[items.length - 1].type === 'separator') {
    items.pop();
  }
  return items;
}

/**
 * Wire the native editable-field menu onto a webContents. Non-editable
 * targets are left to the app's own DOM menus (bubbles, send, search).
 */
export function attachEditableContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    if(!params.isEditable) {
      return;
    }
    const template = buildEditableMenuItems(params, wc);
    if(!template.length) {
      return;
    }
    const menu = new Menu();
    for(const item of template) {
      menu.append(new MenuItem(item));
    }
    menu.popup({window: BrowserWindow.fromWebContents(wc) ?? undefined});
  });
}
