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

/**
 * A source slice between two anchors. BOTH anchors are asserted: an `indexOf`
 * that quietly returns -1 would make `slice(start, -1)` the tail of the file,
 * and a negative assertion like `expect(flowSlice()).not.toContain('sendMessage')`
 * would then pass for entirely the wrong reason after a rename.
 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  expect(start, `missing start anchor: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `missing end anchor: ${endMarker}`).toBeGreaterThan(-1);
  expect(end, `end anchor precedes start anchor: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const ENTRY_START = "text: 'Chat.OpenNewSession'";
const ENTRY_END = "text: 'Message.Context.Selection.Copy'";
const FLOW_START = 'private async openNewSessionFlow';
const FLOW_END = 'private createNewChatsMenuOptions';

const entrySlice = () => sliceBetween(contextMenu, ENTRY_START, ENTRY_END);
const flowSlice = () => sliceBetween(sidebar, FLOW_START, FLOW_END);

describe('text selection menu: Open New Session', () => {
  it('sits right after Search Selected Text and uses the same selection gate', () => {
    const search = contextMenu.indexOf("text: 'Chat.SearchSelected'");
    const open = contextMenu.indexOf("text: 'Chat.OpenNewSession'");
    expect(search).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(search);
    expect(entrySlice()).toContain("verify: () => !!(this.message as Message.message).message && this.isTextSelected");
  });

  it('dispatches the selected text, not the whole message body', () => {
    expect(entrySlice()).toContain('document.getSelection()');
    expect(entrySlice()).toContain("rootScope.dispatchEvent('phantomchat_new_session_from_selection', {text: selection.toString()})");
    // the message text is what Copy/Search pin, so a regression to it would
    // silently open a session with the entire message in the composer
    expect(entrySlice()).not.toContain('this.message.message');
  });
});

describe('sidebar: the selection flow', () => {
  it('is reachable from the dispatched event', () => {
    expect(sidebar).toContain("rootScope.addEventListener('phantomchat_new_session_from_selection', ({text}) => {");
    expect(sidebar).toContain('void this.openNewSessionFlow(text)');
  });

  it('switches to the Sessions folder before opening the picker', () => {
    const flow = flowSlice();
    const folder = flow.indexOf('appDialogsManager.setFilterIdAndChangeTab(FOLDER_ID_SESSION)');
    const picker = flow.indexOf('this.createTab(AppContactsTab)');
    expect(folder).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(folder);
  });

  it('prefills the new session composer and does not send', () => {
    expect(flowSlice()).toContain('chat.input.setInputValue(prefill, true, true)');
    expect(flowSlice()).toContain('chat.input.saveDraft()');
    // composer-prefilled means the text is the user's to send — the flow must
    // not publish a message on their behalf
    expect(flowSlice()).not.toContain('sendMessage');
    // and the title therefore still comes from the first prompt they send
    expect(flowSlice()).toContain('DEFAULT_SESSION_GROUP_NAME');
  });

  it('leaves the plain Session + path untouched (no folder switch, no prefill)', () => {
    expect(flowSlice()).toContain('const prefill = prefillText ? composerDraftFromSelection(prefillText) : \'\';');
    expect(flowSlice()).toContain('if(!prefill) return;');
  });

  it('still opens the picker when the folder switch rejects', () => {
    const flow = flowSlice();
    const folder = flow.indexOf('appDialogsManager.setFilterIdAndChangeTab(FOLDER_ID_SESSION)');
    const picker = flow.indexOf('this.createTab(AppContactsTab)');
    // The listener fires this flow as `void …`, so an unguarded await here is
    // an unhandled rejection: no picker, no toast, nothing in the console. The
    // switch is context for the pick, not a gate on it.
    expect(flow.slice(0, folder)).toContain('try {');
    expect(flow.slice(folder, picker)).toContain('catch(');
  });
});

describe('the menu label exists in both language sources', () => {
  it('is a local pack key as well as an official string', () => {
    expect(lang).toContain("'Chat.OpenNewSession': 'Open New Session'");
    expect(strings).toContain('"Chat.OpenNewSession" = "Open New Session";');
  });
});

describe('the local lang-pack version is bumped for the new key', () => {
  it('is ahead of the version #390 shipped', () => {
    const version = readFile('langPackLocalVersion.example.ts');
    const match = version.match(/const langPackLocalVersion = (\d+);/);
    expect(match).toBeTruthy();
    // A new key only reaches a client that reloads its pack: boot compares
    // langPack.localVersion to App.langPackLocalVersion and does nothing else
    // (src/index.ts:559-566), and a cached pack renders the literal key for a
    // string it does not carry. So this number has to move with the key.
    expect(Number(match![1])).toBeGreaterThan(17);
  });
});
