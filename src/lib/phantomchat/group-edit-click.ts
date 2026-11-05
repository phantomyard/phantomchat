/*
 * Click routing for the chat list: when a PhantomChat chat — 1:1 contact,
 * group or session — is ALREADY the open one, clicking its row toggles the
 * edit sidebar (name + members for groups, contact fields for 1:1) instead of
 * re-selecting the same dialog. Kept out of appDialogsManager so the rule is
 * unit-testable without booting the whole dialog manager / sidebar graph.
 */

import cancelEvent from '@helpers/dom/cancelEvent';
import {isGroupPeer} from './group-types';
import {isP2PPeerId} from './bridge-invariants';

export type SelectedChatClick = {
  peerId: number,
  lastMsgId?: number,
  threadId?: number,
  monoforumParentPeerId?: number,
  /** The dialog row carries the `active` class, i.e. it is the open chat. */
  isActive: boolean,
  /**
   * The left column does not fit beside the chat pane, so the chat replaces
   * the list (`mediaSizes.isLessThanFloatingLeftSidebar`). There the row click
   * must still bring the chat forward instead of opening the editor.
   */
  isLessThanFloatingLeftSidebar: boolean,
  shiftKey?: boolean,
  /** Ctrl-click already means "open in a new tab" further down the listener. */
  ctrlKey?: boolean,
  /** Cmd-click, the macOS spelling of the same shortcut. */
  metaKey?: boolean
};

export type SelectedChatRoute = Omit<SelectedChatClick, 'shiftKey' | 'ctrlKey' | 'metaKey'>;

/**
 * True only for a plain click on the row of the chat that is already open and
 * whose peer is a PhantomChat peer — 1:1 contact, group or session — AND only
 * while the list and the chat pane are on screen together. The routed
 * `openPeerEditor` toggles, so a second click on that row closes the editor
 * again. On narrow layouts the chat replaces the list, so a click on the
 * selected row has to fall through to the normal "open this chat" path — that
 * is the only way back to the conversation. Modified clicks (shift, ctrl,
 * meta) and message-jump clicks (lastMsgId), forum/thread rows keep their
 * existing behaviour — ctrl/meta in particular must still reach
 * openDialogInNewTab.
 */
export function shouldOpenEditorOnSelectedChat(click: SelectedChatClick): boolean {
  return click.isActive &&
    !click.isLessThanFloatingLeftSidebar &&
    !click.lastMsgId &&
    !click.threadId &&
    !click.monoforumParentPeerId &&
    !click.shiftKey &&
    !click.ctrlKey &&
    !click.metaKey &&
    (isGroupPeer(click.peerId) || isP2PPeerId(click.peerId));
}

/**
 * The listener body for the already-open-chat rule: decides, cancels the event
 * and hands the peer to `openEditor` (which toggles the editor pane). Returns
 * true when it took the click, so
 * the caller can `return` and leave the rest of the mousedown handler — the
 * ctrl/meta open-in-new-tab branch included — untouched.
 */
export function handleSelectedChatClick(
  e: MouseEvent,
  route: SelectedChatRoute,
  openEditor: (peerId: number) => void
): boolean {
  const handles = shouldOpenEditorOnSelectedChat({
    ...route,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey
  });

  if(!handles) return false;

  cancelEvent(e);
  openEditor(route.peerId);
  return true;
}
