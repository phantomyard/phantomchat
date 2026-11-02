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

  it('switches folder through the rail\'s own path, not by setting filterId', () => {
    const flow = flowSlice();
    // The rail dispatches `changing_folder_from_sidebar`, whose handler selects
    // the folder tab, and the menu's onClick then dispatches
    // `changing_folder_from_chatlist` (the rail highlight) before switching the
    // filter. Calling appDialogsManager.setFilterIdAndChangeTab directly moves
    // `filterId` while leaving the folder menu on the old tab — and the menu's
    // `wasFilterId === id` early return then turns the NEXT click on Sessions
    // into a scroll with no switch.
    expect(flow).toContain("rootScope.dispatchEventSingle('changing_folder_from_sidebar', {id: FOLDER_ID_SESSION})");
    expect(flow).not.toContain('appDialogsManager.setFilterIdAndChangeTab(');
  });

  it('brings the left column forward before the picker', () => {
    const flow = flowSlice();
    // The selection menu lives in the chat pane: at phone width the left column
    // is off screen, so without this the picker opens behind the chat and a
    // hidden tab is left open. `selectTab(CHATLIST)` is how the app reveals it.
    const column = flow.indexOf('appImManager.selectTab(APP_TABS.CHATLIST)');
    const picker = flow.indexOf('this.createTab(AppContactsTab)');
    expect(column).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(column);
  });

  it('only moves the column when it is actually away', () => {
    const flow = flowSlice();
    const guard = flow.indexOf('document.body.classList.contains(LEFT_COLUMN_ACTIVE_CLASSNAME)');
    const call = flow.indexOf('appImManager.selectTab(APP_TABS.CHATLIST)');
    // `selectTab` also rewrites the hash — `overrideHash(undefined)` for
    // CHATLIST — so an unconditional call with a DM open at desktop width
    // clears the hash of a chat that is still on screen, and a reload then
    // loses it. The class is toggled by `selectTab` itself, so it is the app's
    // own "left column is the active tab" flag; the call is a no-op when the
    // column is already there.
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
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

  it('still opens the picker when the setup rejects', () => {
    const flow = flowSlice();
    const setup = flow.indexOf('appImManager.selectTab(APP_TABS.CHATLIST)');
    const picker = flow.indexOf('this.createTab(AppContactsTab)');
    // The listener fires this flow as `void …`, so an unguarded await here is
    // an unhandled rejection: no picker, no toast, nothing in the console. The
    // switch is context for the pick, not a gate on it.
    expect(flow.slice(0, setup)).toContain('try {');
    expect(flow.slice(setup, picker)).toContain('catch(');
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
