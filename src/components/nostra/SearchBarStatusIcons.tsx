/**
 * SearchBarStatusIcons — Tor onion + Nostrich relay status indicators
 */

import {createSignal, onCleanup, JSX} from 'solid-js';
import rootScope from '@lib/rootScope';
import {TorUiState, TOR_UI_COLORS, computeTorUiState} from '@components/nostra/tor-ui-state';

type RelayState = 'all' | 'partial' | 'none';

const RELAY_COLORS: Record<RelayState, string> = {
  all: '#4caf50',
  partial: '#ffeb3b',
  none: '#f44336'
};

// ─── SVG Icons ───────────────────────────────────────────────────

function TorOnionIcon(props: {color: string; opacity?: number; onClick?: () => void}): JSX.Element {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke={props.color} stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"
      style={{'cursor': 'pointer', 'margin-left': '4px', 'opacity': String(props.opacity ?? 1)}}
      onClick={props.onClick}
    >
      <ellipse cx="12" cy="14" rx="4" ry="6" />
      <ellipse cx="12" cy="14" rx="7" ry="9" />
      <ellipse cx="12" cy="14" rx="10" ry="10" />
      <line x1="12" y1="4" x2="12" y2="2" />
      <line x1="10" y1="3" x2="14" y2="3" />
    </svg>
  );
}

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
  onTorClick?: () => void;
  onRelayClick?: () => void;
}): JSX.Element {
  // Default both to red — "prove you're connected" rather than the other way.
  const [torState, setTorState] = createSignal<TorUiState>(computeTorUiState());
  const [relayState, setRelayState] = createSignal<RelayState>('none');

  // Per-URL connection map. `nostra_relay_state` fires once per relay with
  // `{url, connected: boolean}`, so we aggregate here rather than treating
  // `connected` as a count.
  const relayConnections = new Map<string, boolean>();

  const recomputeRelayState = () => {
    const total = relayConnections.size;
    if(total === 0) { setRelayState('none'); return; }
    let up = 0;
    for(const ok of relayConnections.values()) if(ok) up++;
    if(up === 0) setRelayState('none');
    else if(up === total) setRelayState('all');
    else setRelayState('partial');
  };

  const torHandler = () => {
    setTorState(computeTorUiState());
  };

  const torEnabledHandler = () => {
    setTorState(computeTorUiState());
  };

  const relayHandler = (state: any) => {
    if(!state || typeof state !== 'object' || typeof state.url !== 'string') return;
    relayConnections.set(state.url, !!state.connected);
    recomputeRelayState();
  };

  rootScope.addEventListener('nostra_tor_state', torHandler);
  rootScope.addEventListener('nostra_relay_state', relayHandler);
  rootScope.addEventListener('nostra_tor_mode_changed', torEnabledHandler);

  onCleanup(() => {
    rootScope.removeEventListener('nostra_tor_state', torHandler);
    rootScope.removeEventListener('nostra_relay_state', relayHandler);
    rootScope.removeEventListener('nostra_tor_mode_changed', torEnabledHandler);
  });

  // Seed from the live pool so the icon is correct on first paint, before
  // any state event fires.
  try {
    const chatAPI = (window as any).__nostraChatAPI;
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
      <TorOnionIcon
        color={TOR_UI_COLORS[torState()]}
        opacity={torState() === 'disabled' ? 0.55 : 1}
        onClick={props.onTorClick}
      />
      <NostrichIcon
        color={RELAY_COLORS[relayState()]}
        onClick={props.onRelayClick}
      />
    </div>
  );
}
