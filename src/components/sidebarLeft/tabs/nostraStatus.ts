/**
 * AppNostraStatusTab — Status page in hamburger menu
 *
 * Displays Tor status and Nostr relay connection status with
 * per-layer transport detail (WebSocket direct vs Tor HTTP polling).
 */

import SliderSuperTab from '@components/sliderTab';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import rootScope from '@lib/rootScope';
import {DEFAULT_RELAYS} from '@lib/nostra/nostr-relay-pool';
import {PrivacyTransport} from '@lib/nostra/privacy-transport';

type TorState = 'tor-active' | 'booting' | 'direct-active' | 'offline' | 'disabled';

const TOR_STATE_LABELS: Record<TorState, string> = {
  'tor-active': 'Active via Tor',
  'booting': 'Connecting via Tor…',
  'direct-active': 'Direct',
  'offline': 'Offline',
  'disabled': 'Disabled'
};

const MODE_ICONS: Record<string, string> = {
  'websocket': '🌐',
  'http-polling': '🧅'
};

function latencyBadge(ms: number): string {
  if(!ms || ms <= 0) return '';
  if(ms < 500) return `🟢 ${ms}ms`;
  if(ms < 1500) return `🟡 ${ms}ms`;
  return `🔴 ${ms}ms`;
}

function formatConnectionState(state: string, latencyMs: number, mode: string): string {
  const modeIcon = MODE_ICONS[mode] || '';
  switch(state) {
    case 'connected':
      return `${modeIcon} Connected · ${latencyBadge(latencyMs) || 'online'}`;
    case 'connecting':
      return `${modeIcon} ⏳ Connecting...`;
    case 'reconnecting':
      return `${modeIcon} ⏳ Reconnecting...`;
    case 'disconnected':
    default:
      return '🔴 Disconnected';
  }
}

export default class AppNostraStatusTab extends SliderSuperTab {
  public static getInitArgs() {
    return {};
  }

  public async init() {
    this.container.classList.add('nostra-status-container');
    this.setTitle('Status' as any);

    // ─── Section: Tor Status ─────────────────────────────────

    const torSection = new SettingSection({
      name: 'Tor Connection' as any,
      caption: 'Anonymous routing via Tor network' as any
    });

    const torStatusRow = new Row({
      title: 'Tor Status',
      subtitle: 'Checking...',
      icon: 'lock'
    });

    const torTransportRow = new Row({
      title: 'Transport',
      subtitle: 'Unknown',
      icon: 'settings'
    });

    const torErrorRow = new Row({
      title: 'Last error',
      subtitle: '—',
      icon: 'info'
    });
    torErrorRow.container.style.display = 'none';

    const torCircuitRow = new Row({
      title: 'View Tor Circuit',
      subtitle: 'Guard → Middle → Exit, rebuild, exit IP',
      icon: 'forward',
      clickable: () => {
        if(!PrivacyTransport.isTorEnabled()) return;
        import('@components/sidebarLeft/tabs/nostraTorDashboard').then(
          ({default: AppNostraTorDashboardTab}) => {
            this.slider.createTab(AppNostraTorDashboardTab).open();
          }
        );
      }
    });

    const updateTorState = (state: TorState, error?: string) => {
      torStatusRow.subtitle.textContent = TOR_STATE_LABELS[state] || state;

      const transport = state === 'tor-active' ?
        '🧅 Tor SOCKS (WebSocket over Tor)' :
        state === 'booting' ?
          '⏳ Waiting for Tor bootstrap...' :
          state === 'disabled' ?
            '🌐 Direct WebSocket (Tor disabled)' :
            '🌐 Direct WebSocket (no Tor)';
      torTransportRow.subtitle.textContent = transport;

      if(state === 'offline' && error) {
        torErrorRow.subtitle.textContent = error;
        torErrorRow.container.style.display = '';
      } else {
        torErrorRow.container.style.display = 'none';
      }

      if(state === 'disabled') {
        torCircuitRow.container.classList.add('row-disabled');
      } else {
        torCircuitRow.container.classList.remove('row-disabled');
      }
    };

    const computeInitialTor = (): TorState => {
      if(PrivacyTransport.readMode() === 'off') return 'disabled';
      const raw = (window as any).__nostraPrivacyTransport?.getRuntimeState?.();
      if(raw === 'tor-active' || raw === 'direct-active' || raw === 'booting') return raw as TorState;
      return 'direct-active';
    };
    updateTorState(computeInitialTor());

    rootScope.addEventListener('nostra_tor_state', (payload) => {
      const state = (typeof payload === 'string' ? payload : payload?.state) as TorState;
      const error = typeof payload === 'object' ? payload?.error : undefined;
      updateTorState(state || 'direct-active', error);
    });

    rootScope.addEventListener('nostra_tor_mode_changed', () => {
      updateTorState(computeInitialTor());
    });

    torSection.content.append(
      torStatusRow.container,
      torTransportRow.container,
      torErrorRow.container,
      torCircuitRow.container
    );

    // ─── Section: Relay Status ───────────────────────────────

    const relaySection = new SettingSection({
      name: 'Nostr Relays' as any,
      caption: 'Message routing and storage' as any
    });

    // Create a row for each relay
    const relayRows: Row[] = [];
    for(const relay of DEFAULT_RELAYS) {
      const row = new Row({
        title: relay.url,
        subtitle: 'Connecting...',
        icon: 'link'
      });

      // Add R/W badges
      const badges = document.createElement('span');
      badges.style.cssText = 'margin-left:auto;font-size:11px;opacity:0.7;';
      if(relay.read) badges.textContent += ' R';
      if(relay.write) badges.textContent += ' W';
      row.container.querySelector('.row-title')?.append(badges);

      relayRows.push(row);
      relaySection.content.append(row.container);
    }

    // Update relay status from the global relay pool
    const updateRelayStatus = () => {
      try {
        const pool = (window as any).__nostraPool;
        if(!pool) return;

        const entries = pool.getRelayEntries?.() || [];
        let connectedCount = 0;
        entries.forEach((entry: any, i: number) => {
          if(i >= relayRows.length) return;
          const row = relayRows[i];
          const instance = entry.instance;
          const connected = instance?.isConnected?.() ?? false;
          const latency = instance?.getLatency?.() ?? 0;
          const state = instance?.getConnectionState?.() || 'disconnected';
          const mode = instance?.getMode?.() || 'websocket';

          if(connected) connectedCount++;
          row.subtitle.textContent = formatConnectionState(state, latency, mode);
        });

        // Update relay section caption with live connected count
        const total = relayRows.length;
        if(relaySection.caption) {
          relaySection.caption.textContent =
            `${connectedCount}/${total} connected · routing and storage`;
        }
      } catch(err) {
        console.debug('[NostraStatus] relay status update failed:', err);
      }
    };

    // Initial update + periodic refresh
    updateRelayStatus();
    const interval = setInterval(updateRelayStatus, 5000);

    // Listen for relay state changes
    rootScope.addEventListener('nostra_relay_state', updateRelayStatus as any);

    // Clean up on tab destroy
    (this as any).eventListener?.addEventListener('destroy', () => {
      clearInterval(interval);
    });

    // ─── Section: Quick links ───────────────────────────────

    const linksSection = new SettingSection({});

    const privacyLink = new Row({
      title: 'Impostazioni privacy e Tor',
      subtitle: 'Abilita o disabilita Tor, gestisci privacy',
      icon: 'lock',
      clickable: () => {
        import('@components/sidebarLeft/tabs/privacyAndSecurity').then(
          ({default: AppPrivacyAndSecurityTab}) => {
            this.slider.createTab(AppPrivacyAndSecurityTab).open();
          }
        );
      }
    });

    const relaysLink = new Row({
      title: 'Gestisci Nostr relays',
      subtitle: 'Aggiungi, rimuovi e configura i relay',
      icon: 'link',
      clickable: () => {
        import('@components/sidebarLeft/tabs/nostraRelaySettings').then(
          ({default: AppNostraRelaySettingsTab}) => {
            this.slider.createTab(AppNostraRelaySettingsTab).open();
          }
        );
      }
    });

    linksSection.content.append(
      privacyLink.container,
      relaysLink.container
    );

    this.scrollable.append(
      torSection.container,
      relaySection.container,
      linksSection.container
    );
  }
}
