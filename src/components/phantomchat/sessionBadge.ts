/*
 * PhantomChat.chat — session chip for the chat list (owner batch 11)
 *
 * A session is a peer CLASS (its peerId lives in the SESSION range), so the
 * verdict here is a pure scalar test: no IndexedDB read, no per-thread index,
 * and nothing to keep in step. Every session row gets a small `#` chip next to
 * its title, styled like the P2P chip (see p2pBadge.ts) but static.
 */

import {isSessionPeer} from '@lib/phantomchat/group-types';

/**
 * Create the `#` chip for a session group, or an inert (hidden) element for any
 * other peer. Appending unconditionally keeps the call site free of a branch,
 * exactly like the P2P badge.
 */
export function createSessionBadge(peerId: number | string, extraClass?: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'session-badge' + (extraClass ? ' ' + extraClass : '');
  el.textContent = '#';
  el.title = 'Session';
  el.setAttribute('aria-label', 'Session');

  const raw = typeof peerId === 'number' ? peerId : +peerId;
  const isSession = Number.isFinite(raw) && isSessionPeer(raw);
  el.classList.toggle('is-session', isSession);
  if(!isSession) {
    el.title = '';
    el.removeAttribute('aria-label');
  }

  return el;
}
