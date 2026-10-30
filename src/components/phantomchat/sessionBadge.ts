/*
 * PhantomChat.chat — session chip for the chat list (2026-10-30)
 *
 * A group created from the Code folder's + button carries the `session` tag.
 * Folder membership already keeps those rows out of Chats and Groups, but once
 * the user is looking at the Code folder it should still be obvious which kind
 * of row this is — so every session row gets a small `#` chip next to its
 * title, styled like the P2P chip (see p2pBadge.ts) but static.
 *
 * STATIC BY DESIGN. The tag only changes through a group-info update the local
 * user rarely receives, and re-reading IndexedDB per row is exactly the hot
 * path the architecture forbids. The verdict comes from the synchronous session
 * index (lib/phantomchat/group-tags), which the group store keeps fresh on
 * every save / delete / full read.
 */

import {isSessionPeer} from '@lib/phantomchat/group-tags';

/**
 * Create the `#` chip for a session group, or an inert (hidden) element for any
 * other peer. Appending unconditionally keeps the call site free of a branch,
 * exactly like the P2P badge.
 */
export function createSessionBadge(peerId: number | string, extraClass?: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'session-badge' + (extraClass ? ' ' + extraClass : '');
  el.textContent = '#';
  el.title = 'Code session';
  el.setAttribute('aria-label', 'Code session');

  const raw = typeof peerId === 'number' ? peerId : +peerId;
  const isSession = Number.isFinite(raw) && isSessionPeer(raw);
  el.classList.toggle('is-session', isSession);
  if(!isSession) {
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
  }

  return el;
}
