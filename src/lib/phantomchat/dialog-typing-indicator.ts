/**
 * Chat-list typing indicator — one paint path, always derived from live state.
 *
 * The dialog row used to show "‹peer› is working" only if a `peer_typings`
 * event happened to reach it while the row was mounted (`setTyping` bailed on a
 * missing dom), and the very next subtitle repaint wiped it again: every
 * `addDialogNew`/`dialog_flush`/`dialogs_multiupdate` goes through
 * `AppDialogsManager.setLastMessageN`, which replaces `lastMessageSpan` whole,
 * and the old `user-typing` guard around that block is commented out. When a
 * dialog update lands with no last message resolvable yet, the row is left
 * *empty* — the header still says "Robbie is working", the row says nothing.
 *
 * The header never has this problem because `setPeerStatus` re-derives the
 * status on every paint instead of trusting one event. This helper gives the
 * dialog row the same model: whoever paints a row's subtitle calls it last, and
 * it reads `typingsInPeer` at paint time.
 */

import replaceContent from '@helpers/dom/replaceContent';

export const DIALOG_TYPING_ROW_CLASS = 'user-typing';
export const DIALOG_TYPING_CONTAINER_CLASS = 'peer-typing-container';

export type GetPeerTyping = (
  peerId: PeerId,
  container?: HTMLElement,
  threadId?: number
) => Promise<HTMLElement | undefined>;

export type DialogTypingDom = {
  lastMessageSpan: HTMLElement
};

export type PaintDialogTypingOptions = {
  dom: DialogTypingDom,
  peerId: PeerId,
  threadId?: number,
  getPeerTyping: GetPeerTyping,
  /**
   * Called after the (async) typing lookup resolves and before anything is
   * written to the DOM. Return false to drop the paint — the subtitle was
   * repainted by a newer call (or the row now shows another peer) while we
   * awaited, so writing here would resurrect a stale indicator.
   */
  isStillValid?: () => boolean
};

/**
 * Paints (or clears) the "‹peer› is working" line inside a dialog row.
 * Returns true when a typing element is displayed after the call.
 */
export default async function paintDialogTyping({
  dom,
  peerId,
  threadId,
  getPeerTyping,
  isStillValid
}: PaintDialogTypingOptions): Promise<boolean> {
  const span = dom.lastMessageSpan;
  const previous = span.querySelector('.' + DIALOG_TYPING_CONTAINER_CLASS) as HTMLElement | null;
  const typingElement = await getPeerTyping(peerId, previous ?? undefined, threadId);

  if(isStillValid && !isStillValid()) {
    return false;
  }

  if(!typingElement) {
    // Never delete content here: with no typings the subtitle has to keep
    // whatever the last-message pass just wrote.
    span.classList.remove(DIALOG_TYPING_ROW_CLASS);
    return false;
  }

  // getPeerTyping updates the container we hand it in place, so only move it
  // into the row when it is not already there.
  if(typingElement !== previous) {
    replaceContent(span, typingElement);
  }

  span.classList.add(DIALOG_TYPING_ROW_CLASS);
  return true;
}
