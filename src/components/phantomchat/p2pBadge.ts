/*
 * PhantomChat.chat — P2P transport badge (issue #52)
 *
 * A small green "P2P" chip (DTS/Dolby-logo style) that marks a contact whose
 * conversation is going over the DIRECT WebRTC transport instead of falling
 * through to the Nostr relay. Rendered on each contact/dialog row in the chat
 * list.
 *
 * DATA SOURCE. The verdict comes from `TransportStatus.stateFor(pubkey)`, which
 * is 'p2p' ONLY when there is a VERIFIED-live WebRTC data channel to the peer
 * right now (open AND a PING/PONG round-trip proven). Advertised capability
 * alone does NOT light the badge — green means a rock-solid ESTABLISHED direct
 * connection, not merely a peer that runs a node. See transport-status.ts.
 *
 * REACTIVITY WITHOUT PLUMBING. Capability is filled asynchronously by the
 * ingestor (no change event) and delivery tiers land on sends. Rather than
 * thread events through every layer, every mounted badge is re-evaluated on:
 *   - a TransportStatus notification (a delivery just crossed the direct/relay
 *     line — immediate), and
 *   - a slow shared poll (picks up freshly-ingested capability adverts).
 * Detached badges (their row/topbar was torn down) are reaped from the registry
 * on the next pass by an `isConnected` check, so this never leaks.
 *
 * AUDIT. Each badge state flip logs once under `[p2p]` (terse, per-flip not
 * per-poll) so a live session can be audited alongside the delivery + presence
 * logs.
 */

import {getTransportStatus, P2PState} from '@lib/phantomchat/transport/transport-status';
import {getPubkey} from '@lib/phantomchat/virtual-peers-db';

const LOG_PREFIX = '[p2p]';

/** Virtual (P2P) peer ids are minted well above this; smaller ids are core. */
const VIRTUAL_PEER_MIN = 1e15;

/** How often to re-scan mounted badges for freshly-ingested capability. */
const POLL_MS = 8_000;

interface MountedBadge {
  el: HTMLElement;
  pubkey: string | null;
  label: string; // for logging (peer id / where it lives)
  state: P2PState;
}

const mounted = new Set<MountedBadge>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/** Resolve a tweb peerId to its nostr hex pubkey (async; null for non-P2P). */
async function resolvePubkey(peerId: number | string): Promise<string | null> {
  const n = typeof peerId === 'number' ? peerId : +peerId;
  if(!Number.isFinite(n) || n < VIRTUAL_PEER_MIN) return null;
  try {
    return await getPubkey(n);
  } catch{
    return null;
  }
}

function applyState(el: HTMLElement, state: P2PState): void {
  const isP2P = state === 'p2p';
  // Only two visible outcomes: a GREEN chip when the peer is on a direct P2P
  // transport, or NO chip at all otherwise. `.is-p2p` both colours the chip
  // green and un-hides it (the base `.p2p-badge` rule is `display:none`), so a
  // relay-only peer shows nothing rather than a muted grey badge.
  el.classList.toggle('is-p2p', isP2P);
  if(isP2P) {
    el.title = 'Connected over a direct P2P transport';
    el.setAttribute('aria-label', 'P2P transport connected');
  } else {
    // Hidden — clear a11y so a screen reader doesn't announce an invisible chip.
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
  }
}

function evaluate(b: MountedBadge): void {
  const next: P2PState = b.pubkey ? getTransportStatus().stateFor(b.pubkey) : 'relay';
  if(next === b.state) return;
  b.state = next;
  applyState(b.el, next);
  console.debug(`${LOG_PREFIX} badge ${b.label} → ${next}`);
}

/** Re-evaluate every mounted badge; reap any whose element has been detached. */
function refreshAll(): void {
  for(const b of mounted) {
    if(!b.el.isConnected) {
      mounted.delete(b);
      continue;
    }
    evaluate(b);
  }
  if(mounted.size === 0) stopEngine();
}

function startEngine(): void {
  if(pollTimer) return;
  unsubscribe = getTransportStatus().subscribe(refreshAll);
  pollTimer = setInterval(refreshAll, POLL_MS);
}

function stopEngine(): void {
  if(pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if(unsubscribe) { unsubscribe(); unsubscribe = null; }
}

/**
 * Create a P2P badge element and keep it live for `peerId`. The chip renders in
 * exactly one of two ways — a GREEN "P2P" chip when the peer is reachable over a
 * direct transport, or NOTHING at all otherwise (relay-only peers show no
 * badge). Starts hidden so there's never a flash of a chip before the pubkey
 * resolves. Append the returned element wherever you want the chip; it
 * self-manages its own state and reaps itself once detached from the DOM.
 * Returns the element.
 */
export function createP2PBadge(peerId: number | string, extraClass?: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'p2p-badge' + (extraClass ? ' ' + extraClass : '');
  el.textContent = 'P2P';
  applyState(el, 'relay');

  const badge: MountedBadge = {el, pubkey: null, label: String(peerId), state: 'relay'};
  mounted.add(badge);
  startEngine();

  // Resolve the pubkey, then do an initial evaluation. Until it resolves the
  // badge stays in its hidden `relay` state (no flash of a wrong badge).
  void resolvePubkey(peerId).then((pk) => {
    badge.pubkey = pk;
    if(el.isConnected || mounted.has(badge)) evaluate(badge);
  });

  return el;
}
