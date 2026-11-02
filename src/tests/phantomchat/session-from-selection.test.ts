/**
 * "Open New Session" on a text selection (owner 2026-11-02).
 *
 * Selecting a message and right-clicking offers Open New Session next to
 * Search Selected Text: the app switches to the Sessions folder, opens the
 * single-contact picker, and the session card lands in that space with the
 * selected text in the COMPOSER — prefilled, never auto-sent, so the user
 * edits the prompt and presses send themselves.
 *
 * What these pins protect:
 *   - the entry carries the SELECTION text (not the whole message) and is only
 *     offered when text is actually selected;
 *   - the flow is one dispatch: the chat's context menu cannot open a sidebar
 *     tab, so the sidebar owns the picker;
 *   - the text is PREFILLED as a draft AND nothing sends on the user's behalf;
 *   - the folder switch happens before the picker so the session is created in
 *     the space the user is looking at.
 *
 * A DOM mount of the sidebar + picker tab is disproportionate here; this is a
 * wiring pin over the real source, the same approach as
 * archive-context-menu.test.ts.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

const contextMenu = readFile('components/chat/contextMenu.ts');
const sidebar = readFile('components/sidebarLeft/index.ts');
const lang = readFile('lang.ts');
const strings = readFile('scripts/out/langPack.strings');

const entry = contextMenu.slice(
  contextMenu.indexOf("text: 'Chat.OpenNewSession'"),
  contextMenu.indexOf("text: 'Message.Context.Selection.Copy'")
);

const flow = sidebar.slice(
  sidebar.indexOf('private async openNewSessionFlow'),
  sidebar.indexOf('private createNewChatsMenuOptions')
);

describe('text selection menu: Open New Session', () => {
  it('sits right after Search Selected Text and uses the same selection gate', () => {
    const search = contextMenu.indexOf("text: 'Chat.SearchSelected'");
    const open = contextMenu.indexOf("text: 'Chat.OpenNewSession'");
    expect(search).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(search);
    expect(entry).toContain("verify: () => !!(this.message as Message.message).message && this.isTextSelected");
  });

  it('dispatches the selected text, not the whole message body', () => {
    expect(entry).toContain('document.getSelection()');
    expect(entry).toContain("rootScope.dispatchEvent('phantomchat_new_session_from_selection', {text: selection.toString()})");
    // the message text is what Copy/Search pin, so a regression to it would
    // silently open a session with the entire message in the composer
    expect(entry).not.toContain('this.message.message');
  });
});

describe('sidebar: the selection flow', () => {
  it('is reachable from the dispatched event', () => {
    expect(sidebar).toContain("rootScope.addEventListener('phantomchat_new_session_from_selection', ({text}) => {");
    expect(sidebar).toContain('void this.openNewSessionFlow(text)');
  });

  it('switches to the Sessions folder before opening the picker', () => {
    const folder = flow.indexOf('appDialogsManager.setFilterIdAndChangeTab(FOLDER_ID_SESSION)');
    const picker = flow.indexOf('this.createTab(AppContactsTab)');
    expect(folder).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(folder);
  });

  it('prefills the new session composer and does not send', () => {
    expect(flow).toContain('chat.input.setInputValue(prefill, true, true)');
    expect(flow).toContain('chat.input.saveDraft()');
    // composer-prefilled means the text is the user's to send — the flow must
    // not publish a message on their behalf
    expect(flow).not.toContain('sendMessage');
    // and the title therefore still comes from the first prompt they send
    expect(flow).toContain('DEFAULT_SESSION_GROUP_NAME');
  });

  it('leaves the plain Session + path untouched (no folder switch, no prefill)', () => {
    expect(flow).toContain('const prefill = prefillText ? composerDraftFromSelection(prefillText) : \'\';');
    expect(flow).toContain('if(!prefill) return;');
  });
});

describe('the menu label exists in both language sources', () => {
  it('is a local pack key as well as an official string', () => {
    expect(lang).toContain("'Chat.OpenNewSession': 'Open New Session'");
    expect(strings).toContain('"Chat.OpenNewSession" = "Open New Session";');
  });
});
