/**
 * SearchBarStatusIcons — Nostrich relay status indicator
 */

import {createSignal, onCleanup, JSX} from 'solid-js';
import rootScope from '@lib/rootScope';

type RelayState = 'all' | 'partial' | 'none';

const RELAY_COLORS: Record<RelayState, string> = {
  all: '#4caf50',
  partial: '#ffeb3b',
  none: '#f44336'
};

// Green when at least 60% of configured relays are connected, yellow below
// that, red when down to 1 or 0. With a 7-relay pool that means green at 5+,
// yellow at 2–4, red at 0–1 — the pool stays fully functional on 2 relays,
// so red is reserved for the genuinely degraded state.
const RELAY_GREEN_THRESHOLD = 0.6;

// ─── SVG Icons ───────────────────────────────────────────────────

// Nostrich ostrich silhouette — the PNG is pre-processed (cropped + alpha
// channel, ~1.5KB). Used as a CSS mask so we can tint it via background-color.
function NostrichIcon(props: {color: string; onClick?: () => void}): JSX.Element {
  return (
    <div
      role="img"
      aria-label="Nostr relay status"
      onClick={props.onClick}
      style={{
        'width': '28px',
        'height': '16px',
        'cursor': 'pointer',
        'margin-left': '0',
        'background-color': props.color,
        '-webkit-mask-image': 'url(assets/img/nostrich.png)',
        'mask-image': 'url(assets/img/nostrich.png)',
        '-webkit-mask-size': 'contain',
        'mask-size': 'contain',
        '-webkit-mask-repeat': 'no-repeat',
        'mask-repeat': 'no-repeat',
        '-webkit-mask-position': 'center',
        'mask-position': 'center'
      }}
    />
  );
}

// ─── Main Component ──────────────────────────────────────────────

export default function SearchBarStatusIcons(props: {
  onRelayClick?: () => void;
}): JSX.Element {
  // Default to red — "prove you're connected" rather than the other way.
  const [relayState, setRelayState] = createSignal<RelayState>('none');

  // Per-URL connection map. `phantomchat_relay_state` fires once per relay with
  // `{url, connected: boolean}`, so we aggregate here rather than treating
  // `connected` as a count.
  const relayConnections = new Map<string, boolean>();

  const recomputeRelayState = () => {
    const total = relayConnections.size;
    if(total === 0) { setRelayState('none'); return; }
    let up = 0;
    for(const ok of relayConnections.values()) if(ok) up++;
    if(up <= 1) setRelayState('none');
    else if(up / total >= RELAY_GREEN_THRESHOLD) setRelayState('all');
    else setRelayState('partial');
  };

  const relayHandler = (state: any) => {
    if(!state || typeof state !== 'object' || typeof state.url !== 'string') return;
    relayConnections.set(state.url, !!state.connected);
    recomputeRelayState();
  };

  rootScope.addEventListener('phantomchat_relay_state', relayHandler);

  onCleanup(() => {
    rootScope.removeEventListener('phantomchat_relay_state', relayHandler);
  });

  // Seed from the live pool so the icon is correct on first paint, before
  // any state event fires.
  try {
    const chatAPI = (window as any).__phantomchatChatAPI;
    const pool = chatAPI?.relayPool;
    if(pool?.relayEntries) {
      for(const entry of pool.relayEntries) {
        relayConnections.set(
          entry.config.url,
          entry.instance?.getState?.() === 'connected'
        );
      }
      recomputeRelayState();
    }
  } catch{}

  return (
    <div
      class="search-bar-status-icons"
      style={{
        'display': 'flex',
        'align-items': 'center',
        'position': 'absolute',
        'right': '36px',
        'top': '50%',
        'transform': 'translateY(-50%)',
        'z-index': '2',
        'pointer-events': 'auto'
      }}
    >
      <NostrichIcon
        color={RELAY_COLORS[relayState()]}
        onClick={props.onRelayClick}
      />
    </div>
  );
}
