/*
 * Click-outside dismissal for the peer editor pane (1:1 contact, group,
 * session).
 *
 * The pane opens from the chat row / topbar avatar and toggles from those same
 * entry points (see peer-editor-toggle.ts), but it used to stay open while the
 * user moved on: selecting another chat, switching a sidebar tab, opening a
 * menu or reaching into the prompt bar all left it showing the PREVIOUS peer.
 * The rule now is that the pane survives only a pointer that belongs to it.
 *
 * Two families of clicks are deliberately NOT "outside":
 *
 *   - `#column-right` — the pane itself: its fields, its buttons, its own X.
 *   - The toggle entry points, because they already own the open/close
 *     decision. Dismissing there would close the pane and let the very same
 *     click reopen it — a visible close-then-open flash: the topbar / avatar
 *     (its click handler routes to `openPeerEditor`) and the list row of the
 *     pane's OWN peer (the already-open-chat rule, and the Contacts tab's
 *     `openContactEditor`). A row for a DIFFERENT peer is outside; that click
 *     means "go to that chat".
 *
 * The topbar's utility cluster is NOT a toggle entry point: the topbar handler
 * returns early for it, so a click there dismisses like any other (a menu
 * opens, the pane closes).
 *
 * Kept free of the sidebar graph and of side effects, so the whole matrix is
 * unit-testable against a hand-built DOM
 * (src/tests/phantomchat/peer-editor-dismiss.test.ts).
 */

/** The pane's root: every right-column tab renders inside this column. */
export const PEER_EDITOR_PANE_SELECTOR = '#column-right';

/** The chat topbar, whose click handler routes to `openPeerEditor`. */
export const PEER_EDITOR_TOPBAR_SELECTOR = '.topbar';

/** Topbar children the topbar handler ignores — no toggle there. */
export const PEER_EDITOR_TOPBAR_IGNORE_SELECTORS = ['.chat-utils', '.topbar-search-container'];

/** Lists whose rows route straight to a peer editor. */
export const PEER_EDITOR_ROW_LIST_SELECTOR = '.chatlist, .contacts-container';

/** Marker the editor tabs put on their container. */
export const PEER_EDITOR_PANE_CLASSNAME = 'peer-editor-pane';

/** The bits of a `SliderSuperTab` this rule needs. */
export type PeerEditorPaneTab = {
  container?: Element,
  groupPeerId?: number,
  peerId?: number | string
};

export function isPeerEditorPaneContainer(container: Element | null | undefined): boolean {
  return !!container?.classList?.contains(PEER_EDITOR_PANE_CLASSNAME);
}

/** The peer the pane is editing: groups and sessions keep it in
 * `groupPeerId`, the contact tab in `peerId` (a `PeerId` is a number). */
export function peerEditorPanePeerId(tab: PeerEditorPaneTab | null | undefined): number | null {
  const raw = tab?.groupPeerId ?? tab?.peerId;
  if(raw === undefined) return null;
  const peerId = +raw;
  return Number.isFinite(peerId) ? peerId : null;
}

export function isInsidePeerEditorPane(target: Element | null | undefined): boolean {
  return !!target?.closest?.(PEER_EDITOR_PANE_SELECTOR);
}

export function isPeerEditorToggleEntryPoint(
  target: Element | null | undefined,
  panePeerId: number | null
): boolean {
  if(!target?.closest) return false;

  const topbar = target.closest(PEER_EDITOR_TOPBAR_SELECTOR);
  if(topbar && !PEER_EDITOR_TOPBAR_IGNORE_SELECTORS.some((selector) => target.closest(selector))) {
    return true;
  }

  if(panePeerId === null) return false;

  // The row of the pane's own peer is the click the toggle rule answers.
  // Rows elsewhere (a bubble carries `data-peer-id` too) are not entry points.
  const row = target.closest('[data-peer-id]');
  if(!row || !row.closest(PEER_EDITOR_ROW_LIST_SELECTOR)) return false;
  return +row.getAttribute('data-peer-id') === panePeerId;
}

export function shouldDismissPeerEditorOnPointerDown(params: {
  isInsidePane: boolean,
  isToggleEntryPoint: boolean
}): boolean {
  return !params.isInsidePane && !params.isToggleEntryPoint;
}
