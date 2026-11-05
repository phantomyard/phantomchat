import {describe, expect, it} from 'vitest';
import fs from 'fs';
import {planPeerEditorToggle} from '@lib/phantomchat/peer-editor-toggle';

const GROUP_PEER = -2000000000000007;
const OTHER_GROUP_PEER = -2000000000000009;

class FakeEditorTab {
  constructor(public peerId: number) {}
}
class FakeOtherTab {}

/** Mirrors `openPeerEditor`'s wiring: instanceof the editor class + numeric peer compare. */
function plan(history: unknown[], isSidebarOpen: boolean, peerId = GROUP_PEER) {
  return planPeerEditorToggle({
    history,
    isSidebarOpen,
    isEditorTab: (tab): tab is FakeEditorTab => tab instanceof FakeEditorTab,
    isSamePeer: (tab) => tab.peerId === peerId
  });
}

describe('peer editor pane toggle', () => {
  it('opens the editor when nothing is showing', () => {
    expect(plan([], false)).toEqual({action: 'open', staleTabs: []});
    expect(plan([new FakeOtherTab()], false)).toEqual({action: 'open', staleTabs: []});
  });

  it('closes the editor on a second click on the same peer', () => {
    const tab = new FakeEditorTab(GROUP_PEER);
    expect(plan([tab], true)).toEqual({action: 'close', tab});
  });

  it('closes the editor even with ordinary tabs below it in the history', () => {
    const other = new FakeOtherTab();
    const tab = new FakeEditorTab(GROUP_PEER);
    expect(plan([other, tab], true)).toEqual({action: 'close', tab});
  });

  it('judges the toggle against the LAST editor tab, not the first', () => {
    // Regression: `getTab` returned the first editor tab, so once a stale tab
    // was left in history the peer never matched and every click stacked
    // another tab — the pane appeared to reopen instead of closing.
    const stale = new FakeEditorTab(OTHER_GROUP_PEER);
    const current = new FakeEditorTab(GROUP_PEER);
    expect(plan([stale, current], true)).toEqual({action: 'close', tab: current});
  });

  it('opens the other peer and retires every stale editor tab', () => {
    const stale = new FakeEditorTab(OTHER_GROUP_PEER);
    const current = new FakeEditorTab(GROUP_PEER);
    expect(plan([stale, current], true, OTHER_GROUP_PEER)).toEqual({
      action: 'open',
      staleTabs: [stale, current]
    });
  });

  it('does not reuse a hidden tab for the same peer — it is stale too', () => {
    // Sidebar hidden without popping (Back, a resize, hide()): the tab is
    // still live in history. Reopening must not duplicate it.
    const hidden = new FakeEditorTab(GROUP_PEER);
    expect(plan([hidden], false)).toEqual({action: 'open', staleTabs: [hidden]});
  });

  it('wires the close branch through closeTab so the tab is popped, then hides the column', () => {
    const source = fs.readFileSync('src/components/peerActionsMenu.ts', 'utf-8');
    expect(source).toContain('appSidebarRight.closeTab(plan.tab)');
    expect(source).toContain('appSidebarRight.toggleSidebar(false)');
    // The old close path only toggled the column and left the tab in history.
    expect(source).not.toContain('existingTab');
    expect(source).toContain("document.body.classList.contains(RIGHT_COLUMN_ACTIVE_CLASSNAME)");
  });
});
