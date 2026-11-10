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
 *   - A popup — the pane's own dialogs. `PopupElement` mounts at `document.body`
 *     (`DEFAULT_APPEND_TO`), so the confirm button of the Make admin / Remove
 *     member / Leave / Delete group confirmations is neither inside the column
 *     nor a toggle entry point. The pane opened that dialog; the pointer there
 *     answers it, it does not move on. The topbar hamburger is unaffected: its
 *     pointerdown lands on the button inside `.chat-utils` before the popup
 *     exists, and that one dismisses.
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

/** Popups mount at `document.body`, so this is how a pane-opened dialog is
 * recognised from the pointer target alone. */
export const PEER_EDITOR_POPUP_SELECTOR = '.popup';

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

export function isInsidePeerEditorPopup(target: Element | null | undefined): boolean {
  return !!target?.closest?.(PEER_EDITOR_POPUP_SELECTOR);
}

/** The peer of the LIST ROW the target belongs to, or null. The row is the
 * OUTERMOST `data-peer-id` carrier inside the list: a group row rerenders its
 * last-message preview through `wrapPeerTitle({peerId: lastMessage.fromId})`,
 * which nests `.peer-title[data-peer-id=<sender>]` inside the row's own
 * `.chatlist-chat[data-peer-id=<group>]`. Reading the nearest carrier would
 * call the sender name "a row for a different peer" and flash the pane
 * close-then-reopen. */
export function peerEditorRowPeerId(target: Element | null | undefined): number | null {
  if(!target?.closest) return null;

  const list = target.closest(PEER_EDITOR_ROW_LIST_SELECTOR);
  if(!list) return null;

  let row: Element | null = null;
  for(let el = target.closest('[data-peer-id]'); el && el !== list && list.contains(el); el = el.parentElement) {
    if(el.hasAttribute('data-peer-id')) row = el; // keep climbing: outermost wins
  }

  if(!row) return null;
  const peerId = +(row.getAttribute('data-peer-id') as string);
  return Number.isFinite(peerId) ? peerId : null;
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
  return peerEditorRowPeerId(target) === panePeerId;
}

export function shouldDismissPeerEditorOnPointerDown(params: {
  isInsidePane: boolean,
  isInsidePopup: boolean,
  isToggleEntryPoint: boolean
}): boolean {
  return !params.isInsidePane && !params.isInsidePopup && !params.isToggleEntryPoint;
}
