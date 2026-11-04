/*
 * Click routing for the chat list: when a group/session chat is ALREADY the
 * open one, clicking its row opens the edit sidebar (name + members) instead
 * of re-selecting the same dialog. Kept out of appDialogsManager so the rule
 * is unit-testable without booting the whole dialog manager / sidebar graph.
 */

import cancelEvent from '@helpers/dom/cancelEvent';
import {isGroupPeer} from './group-types';

export type SelectedChatClick = {
  peerId: number,
  lastMsgId?: number,
  threadId?: number,
  monoforumParentPeerId?: number,
  /** The dialog row carries the `active` class, i.e. it is the open chat. */
  isActive: boolean,
  shiftKey?: boolean,
  /** Ctrl-click already means "open in a new tab" further down the listener. */
  ctrlKey?: boolean,
  /** Cmd-click, the macOS spelling of the same shortcut. */
  metaKey?: boolean
};

export type SelectedChatRoute = Omit<SelectedChatClick, 'shiftKey' | 'ctrlKey' | 'metaKey'>;

/**
 * True only for a plain click on the row of the chat that is already open and
 * whose peer is a Phantom group or session. Modified clicks (shift, ctrl, meta)
 * and message-jump clicks (lastMsgId), forum/thread rows keep their existing
 * behaviour — ctrl/meta in particular must still reach openDialogInNewTab.
 */
export function shouldOpenEditorOnSelectedChat(click: SelectedChatClick): boolean {
  return click.isActive &&
    !click.lastMsgId &&
    !click.threadId &&
    !click.monoforumParentPeerId &&
    !click.shiftKey &&
    !click.ctrlKey &&
    !click.metaKey &&
    isGroupPeer(click.peerId);
}

/**
 * The listener body for the already-open-chat rule: decides, cancels the event
 * and hands the peer to `openEditor`. Returns true when it took the click, so
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
