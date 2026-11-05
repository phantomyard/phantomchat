/*
 * Toggle rule for the peer editor pane (1:1 contact, group, session).
 *
 * The three entry points that can show the editor — the chat-list row of the
 * already-open chat, the topbar avatar and the "Edit" context-menu item — all
 * route through `openPeerEditor`, and all of them must TOGGLE: a click with
 * the pane closed opens it, a click with the pane showing the SAME peer's
 * editor closes it again. Keeping the decision pure lets the tests drive the
 * whole matrix (open/closed × same peer/different peer × other tabs in
 * history) without booting the sidebar graph.
 *
 * Two things this rule exists to prevent, both observed on the real sidebar:
 *
 *  - The old lookup took the FIRST editor tab in the slider history
 *    (`getTab`), which is a stale tab whenever an editor was opened, hidden
 *    without being popped, and another one opened on top. The peer then never
 *    matched, so the "toggle" branch was unreachable and every click created
 *    yet another tab — the pane appeared to reopen instead of closing.
 *  - A hidden-but-retained tab is live state; it is planned as stale and
 *    closed before a new pane is built, so the history never accumulates one
 *    editor tab per peer visited.
 */

export type PeerEditorPlan<T> =
  /** The pane already shows this peer: close it (pop the tab, hide the column). */
  | {action: 'close', tab: T}
  /** No pane for this peer is showing: build one, dropping the listed stale editor tabs first. */
  | {action: 'open', staleTabs: T[]};

export type PeerEditorToggleParams<T> = {
  /** The sidebar's tab history, oldest first (`SidebarSlider.getHistory()`). */
  history: readonly unknown[],
  /** `document.body.classList.contains(RIGHT_COLUMN_ACTIVE_CLASSNAME)`. */
  isSidebarOpen: boolean,
  /** Narrowed to the editor tab class being toggled. */
  isEditorTab: (tab: unknown) => tab is T,
  /** Whether a live editor tab is showing THIS peer. */
  isSamePeer: (tab: T) => boolean
};

export function planPeerEditorToggle<T>(
  params: PeerEditorToggleParams<T>
): PeerEditorPlan<T> {
  const {history, isSidebarOpen, isEditorTab, isSamePeer} = params;
  const editorTabs = history.filter(isEditorTab);
  // The last one is the pane that is on screen; anything before it is a tab
  // that was hidden without being popped.
  const current = editorTabs.length ? editorTabs[editorTabs.length - 1] : undefined;
  const staleTabs = editorTabs.filter((tab) => tab !== current);

  if(current && isSamePeer(current)) {
    // Same peer, so the click toggles: close when it is on screen, otherwise
    // rebuild it (the hidden tab is stale and must not be left behind).
    return isSidebarOpen ?
      {action: 'close', tab: current} :
      {action: 'open', staleTabs: editorTabs};
  }

  return {action: 'open', staleTabs: current ? [...staleTabs, current] : staleTabs};
}
