/*
 * Click routing for the chat list: when a group/session chat is ALREADY the
 * open one, clicking its row opens the edit sidebar (name + members) instead
 * of re-selecting the same dialog. Kept out of appDialogsManager so the rule
 * is unit-testable without booting the whole dialog manager / sidebar graph.
 */

import {isGroupPeer} from './group-types';

export type SelectedChatClick = {
  peerId: number,
  lastMsgId?: number,
  threadId?: number,
  monoforumParentPeerId?: number,
  /** The dialog row carries the `active` class, i.e. it is the open chat. */
  isActive: boolean,
  shiftKey?: boolean
};

/**
 * True only for a plain click on the row of the chat that is already open and
 * whose peer is a Phantom group or session. Message-jump clicks (lastMsgId),
 * forum/thread rows and shift-clicks keep their existing behaviour.
 */
export function shouldOpenEditorOnSelectedChat(click: SelectedChatClick): boolean {
  return click.isActive &&
    !click.lastMsgId &&
    !click.threadId &&
    !click.monoforumParentPeerId &&
    !click.shiftKey &&
    isGroupPeer(click.peerId);
}
