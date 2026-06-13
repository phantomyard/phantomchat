import {JSX, For, createSignal, onMount, onCleanup} from 'solid-js';
import classNames from '@helpers/string/classNames';
import appSidebarLeft from '@components/sidebarLeft';
import rootScope from '@lib/rootScope';

export interface RelayStateInfo {
  url: string;
  connected: boolean;
  latencyMs: number;
  read: boolean;
  write: boolean;
}

type TorState = 'bootstrapping' | 'active' | 'direct' | 'failed' | 'disabled';

const STATE_LABELS: Record<TorState, {text: string; color: string}> = {
  active: {text: 'Attivo', color: 'green'},
  bootstrapping: {text: 'Bootstrap...', color: 'yellow'},
  direct: {text: 'Diretto', color: 'yellow'},
  failed: {text: 'Errore', color: 'red'},
  disabled: {text: 'Disabilitato', color: 'gray'}
};

export default function TorStatus(props: {
  relayStates: RelayStateInfo[];
  torState: TorState;
  onClose: () => void;
}): JSX.Element {
  const stateInfo = () => STATE_LABELS[props.torState] || STATE_LABELS.failed;

  const [liveStates, setLiveStates] = createSignal<RelayStateInfo[]>(props.relayStates);
  const states = () => liveStates();

  const handleRelayState = (update: RelayStateInfo) => {
    setLiveStates((prev) => {
      const idx = prev.findIndex((r) => r.url === update.url);
      if(idx === -1) return [...prev, update];
      const next = prev.slice();
      next[idx] = {...prev[idx], ...update};
      return next;
    });
  };

  onMount(() => {
    // Seed with a fresh snapshot + trigger a one-shot WS measurement so
    // relays that never pinged yet get a value immediately.
    const pool = (window as any).__nostraPool;
    try {
      pool?.measureAll?.();
      const snapshot = pool?.getRelayStates?.();
      if(Array.isArray(snapshot)) setLiveStates(snapshot);
    } catch{}

    rootScope.addEventListener('nostra_relay_state', handleRelayState);
    onCleanup(() => {
      rootScope.removeEventListener('nostra_relay_state', handleRelayState);
    });
  });

  const dotClass = (relay: RelayStateInfo) => {
    if(!relay.connected) return 'tor-status-dot--red';
    if(relay.latencyMs > 1000) return 'tor-status-dot--yellow';
    if(relay.latencyMs < 0) return 'tor-status-dot--yellow';
    return 'tor-status-dot--green';
  };

  const formatLatency = (relay: RelayStateInfo) => {
    if(!relay.connected) return 'n/a';
    if(relay.latencyMs < 0) return '…';
    return `${relay.latencyMs}ms`;
  };

  return (
    <div class="tor-popup-overlay" onClick={() => props.onClose()}>
      <div
        class={classNames('tor-popup', 'tor-status-popup')}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="tor-popup__title">Stato Tor</div>
        <div class="tor-popup__body">
          <span
            class={classNames('tor-status-dot', `tor-status-dot--${stateInfo().color}`)}
            style={{'margin-right': '8px'}}
          />
          {stateInfo().text}
        </div>

        <div class="tor-popup__title" style={{'font-size': '15px'}}>
          Relay connessi
        </div>

        <For each={states()}>
          {(relay) => (
            <div class="tor-status-relay">
              <span class={classNames('tor-status-dot', dotClass(relay))} />
              <span class="tor-status-url">{relay.url}</span>
              <span class="tor-status-latency">{formatLatency(relay)}</span>
              <span class="tor-status-badges">
                {relay.read && <span>R</span>}
                {relay.write && <span>W</span>}
              </span>
            </div>
          )}
        </For>

        <div class="tor-popup__actions" style={{'margin-top': '16px'}}>
          <button
            class="tor-popup__btn tor-popup__btn--secondary"
            onClick={() => props.onClose()}
          >
            Chiudi
          </button>
          <button
            class={classNames(
              'tor-popup__btn',
              'tor-popup__btn--link',
              props.torState === 'disabled' && 'tor-popup__btn--disabled'
            )}
            disabled={props.torState === 'disabled'}
            onClick={() => {
              if(props.torState === 'disabled') return;
              props.onClose();
              import('@components/sidebarLeft/tabs/nostraTorDashboard').then(({default: AppNostraTorDashboardTab}) => {
                appSidebarLeft.createTab(AppNostraTorDashboardTab).open();
              });
            }}
          >
            View circuit details
          </button>
        </div>
      </div>
    </div>
  );
}
