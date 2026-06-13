/**
 * AppNostraTorDashboardTab — Tor circuit dashboard in sidebar
 *
 * Shows guard/middle/exit hop chain, exit IP, circuit age, latency.
 * Rebuild button forces a new circuit by re-invoking setMode() with the current mode.
 */

import SliderSuperTab from '@components/sliderTab';
import SettingSection from '@components/settingSection';
import rootScope from '@lib/rootScope';
import {PrivacyTransport} from '@lib/nostra/privacy-transport';

type HopRole = 'guard' | 'middle' | 'exit';

interface HopUi {
  container: HTMLElement;
  labelEl: HTMLElement;
  idEl: HTMLElement;
  descEl: HTMLElement;
  fingerprint: string;
}

const HOP_META: Record<HopRole, {label: string; icon: string; desc: string}> = {
  guard: {
    label: 'Guard',
    icon: '🛡',
    desc: 'First hop — the only relay that sees your real IP address.'
  },
  middle: {
    label: 'Middle',
    icon: '🔗',
    desc: 'Intermediate relay — cannot see source or destination.'
  },
  exit: {
    label: 'Exit',
    icon: '🌐',
    desc: 'Final hop — forwards traffic to the Nostr relay. Content is still encrypted (NIP-44).'
  }
};

const STATE_META: Record<string, {label: string; className: string}> = {
  'booting': {label: 'Bootstrapping circuit…', className: 'tor-state-pill--bootstrapping'},
  'tor-active': {label: 'Circuit active', className: 'tor-state-pill--active'},
  'direct-active': {label: 'Direct mode — Tor not in use', className: 'tor-state-pill--direct'},
  'offline': {label: 'Offline', className: 'tor-state-pill--direct'}
};

export default class AppNostraTorDashboardTab extends SliderSuperTab {
  private circuitEl: HTMLElement;
  private exitIpEl: HTMLElement;
  private circuitAgeEl: HTMLElement;
  private latencyEl: HTMLElement;
  private circuitAgeInterval: ReturnType<typeof setInterval>;
  private circuitBuiltAt: number = 0;
  private rebuildBtn: HTMLButtonElement;
  private statePill: HTMLElement;
  private hops: Record<HopRole, HopUi>;

  public static getInitArgs() {
    return {};
  }

  public init() {
    this.setTitle('Tor Circuit' as any);
    this.container.classList.add('tor-dashboard-container');

    // ─── Section: State banner ───────────────────────────────

    const stateSection = new SettingSection({});
    this.statePill = document.createElement('div');
    this.statePill.className = 'tor-state-pill tor-state-pill--bootstrapping';
    this.statePill.innerHTML = '<span class="tor-state-dot"></span><span class="tor-state-label">Checking status…</span>';
    stateSection.content.append(this.statePill);

    // ─── Section: Circuit Hops (vertical) ────────────────────

    const circuitSection = new SettingSection({
      name: 'Circuit' as any,
      caption: 'Your traffic hops through three relays. Only Guard sees your IP; only Exit sees the destination. No single relay knows both.' as any
    });

    const hopChain = document.createElement('div');
    hopChain.className = 'tor-hop-chain tor-hop-chain--vertical';

    const guardEl = this.createHop('guard');
    const middleEl = this.createHop('middle');
    const exitEl = this.createHop('exit');

    hopChain.append(
      guardEl.container,
      this.createArrow(),
      middleEl.container,
      this.createArrow(),
      exitEl.container
    );
    circuitSection.content.append(hopChain);

    this.circuitEl = hopChain;
    this.hops = {guard: guardEl, middle: middleEl, exit: exitEl};

    // ─── Section: Details ────────────────────────────────────

    const detailsSection = new SettingSection({
      name: 'Details' as any
    });

    const exitIpRow = this.createDetailRow('Exit IP');
    const circuitAgeRow = this.createDetailRow('Circuit Age');
    const latencyRow = this.createDetailRow('Latency');

    this.exitIpEl = exitIpRow.valueEl;
    this.circuitAgeEl = circuitAgeRow.valueEl;
    this.latencyEl = latencyRow.valueEl;

    detailsSection.content.append(
      exitIpRow.rowEl,
      circuitAgeRow.rowEl,
      latencyRow.rowEl
    );

    // ─── Rebuild Button ──────────────────────────────────────

    const rebuildSection = new SettingSection({});

    const btn = document.createElement('button');
    btn.className = 'btn-primary tor-rebuild-btn';
    btn.textContent = 'Rebuild Circuit';
    btn.onclick = () => this.handleRebuild();
    this.rebuildBtn = btn;

    rebuildSection.content.append(btn);

    // ─── Event Listener ──────────────────────────────────────

    const onCircuitUpdate = (details: {
      guard: string;
      middle: string;
      exit: string;
      latency: number;
      exitIp: string;
      healthy: boolean;
    }) => {
      this.updateHop(this.hops.guard, details.guard, details.healthy);
      this.updateHop(this.hops.middle, details.middle, details.healthy);
      this.updateHop(this.hops.exit, details.exit, details.healthy);

      this.exitIpEl.textContent = details.exitIp || '—';
      this.latencyEl.textContent = details.latency ? `${details.latency}ms` : '—';

      if(details.guard || details.middle || details.exit) {
        this.circuitBuiltAt = Date.now();
        this.updateCircuitAge();
      }
    };

    const onStateChange = (payload: {state: string; error?: string}) => {
      this.applyState(payload.state, payload.error);
    };

    rootScope.addEventListener('nostra_tor_circuit_update', onCircuitUpdate);
    rootScope.addEventListener('nostra_tor_state', onStateChange);

    // ─── Initial hydration ───────────────────────────────────
    // Pull current circuit details synchronously — the dashboard is usually
    // opened after bootstrap has completed, so the onCircuitChange callback
    // already fired before the listener above was registered. Without this
    // pull, hop/exit/latency rows would stay blank until the next 10s poll.
    try {
      const transport = (window as any).__nostraPrivacyTransport;
      const webtorClient = transport?.webtorClient;
      const details = webtorClient?.getCircuitDetails?.();
      const torState = transport?.getRuntimeState?.() || 'booting';
      this.applyState(torState);

      if(details && (details.guard || details.middle || details.exit)) {
        onCircuitUpdate({
          guard: details.guard || '',
          middle: details.middle || '',
          exit: details.exit || '',
          latency: details.latency > 0 ? details.latency : 0,
          exitIp: details.exitIp || '',
          healthy: details.healthy ?? false
        });
      }
    } catch(err) {
      console.debug('[TorDashboard] initial hydration failed:', err);
    }

    // ─── Circuit Age Timer ───────────────────────────────────

    this.circuitAgeInterval = setInterval(() => {
      this.updateCircuitAge();
    }, 1000);

    // ─── Cleanup ─────────────────────────────────────────────

    (this as any).eventListener?.addEventListener('destroy', () => {
      clearInterval(this.circuitAgeInterval);
      rootScope.removeEventListener('nostra_tor_circuit_update', onCircuitUpdate);
      rootScope.removeEventListener('nostra_tor_state', onStateChange);
    });

    this.scrollable.append(
      stateSection.container,
      circuitSection.container,
      detailsSection.container,
      rebuildSection.container
    );
  }

  private createHop(role: HopRole): HopUi {
    const meta = HOP_META[role];

    const container = document.createElement('div');
    container.className = `tor-hop tor-hop--${role} tor-hop--empty`;
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');
    container.title = 'Click to copy full fingerprint';

    const header = document.createElement('div');
    header.className = 'tor-hop-header';

    const iconEl = document.createElement('span');
    iconEl.className = 'tor-hop-icon';
    iconEl.textContent = meta.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'tor-hop-label';
    labelEl.textContent = meta.label;

    const badgeEl = document.createElement('span');
    badgeEl.className = 'tor-hop-badge';
    badgeEl.textContent = '•••';

    header.append(iconEl, labelEl, badgeEl);

    const idEl = document.createElement('div');
    idEl.className = 'tor-hop-id';
    idEl.textContent = 'building…';

    const descEl = document.createElement('div');
    descEl.className = 'tor-hop-desc';
    descEl.textContent = meta.desc;

    container.append(header, idEl, descEl);

    const hopUi: HopUi = {container, labelEl, idEl, descEl, fingerprint: ''};

    const handleCopy = () => {
      if(!hopUi.fingerprint) return;
      this.copyToClipboard(hopUi.fingerprint);
      const prevLabel = meta.label;
      labelEl.textContent = '✓ Copied';
      container.classList.add('tor-hop--copied');
      setTimeout(() => {
        labelEl.textContent = prevLabel;
        container.classList.remove('tor-hop--copied');
      }, 1200);
    };

    container.addEventListener('click', handleCopy);
    container.addEventListener('keydown', (ev) => {
      if(ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        handleCopy();
      }
    });

    return hopUi;
  }

  private createArrow(): HTMLElement {
    const arrow = document.createElement('span');
    arrow.className = 'tor-hop-arrow tor-hop-arrow--vertical';
    arrow.textContent = '↓';
    arrow.setAttribute('aria-hidden', 'true');
    return arrow;
  }

  private updateHop(hop: HopUi, fingerprint: string, healthy: boolean) {
    hop.fingerprint = fingerprint || '';
    hop.container.classList.remove('tor-hop--healthy', 'tor-hop--unhealthy', 'tor-hop--empty');
    if(fingerprint) {
      hop.idEl.textContent = fingerprint;
      hop.container.classList.add(healthy ? 'tor-hop--healthy' : 'tor-hop--unhealthy');
    } else {
      hop.idEl.textContent = 'building…';
      hop.container.classList.add('tor-hop--empty');
    }
  }

  private applyState(state: string, error?: string) {
    if(!this.statePill) return;
    const meta = STATE_META[state] || STATE_META.offline;
    this.statePill.className = `tor-state-pill ${meta.className}`;
    const labelEl = this.statePill.querySelector('.tor-state-label') as HTMLElement | null;
    if(labelEl) {
      labelEl.textContent = error && state === 'failed' ? `${meta.label}: ${error}` : meta.label;
    }
  }

  private copyToClipboard(text: string) {
    try {
      if(navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => this.copyFallback(text));
      } else {
        this.copyFallback(text);
      }
    } catch{
      this.copyFallback(text);
    }
  }

  private copyFallback(text: string) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch{}
    document.body.removeChild(ta);
  }

  private createDetailRow(label: string): {rowEl: HTMLElement, valueEl: HTMLElement} {
    const rowEl = document.createElement('div');
    rowEl.className = 'tor-detail-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'tor-detail-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'tor-detail-value';
    valueEl.textContent = '—';

    rowEl.append(labelEl, valueEl);
    return {rowEl, valueEl};
  }

  private updateCircuitAge() {
    if(!this.circuitBuiltAt) {
      this.circuitAgeEl.textContent = '—';
      return;
    }
    const elapsed = Math.floor((Date.now() - this.circuitBuiltAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    this.circuitAgeEl.textContent = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  private handleRebuild() {
    const transport = (window as any).__nostraPrivacyTransport;
    if(!transport) return;

    this.rebuildBtn.disabled = true;
    this.rebuildBtn.textContent = 'Rebuilding…';

    const mode = PrivacyTransport.readMode();
    Promise.resolve(transport.setMode?.(mode)).then(() => {
      this.rebuildBtn.disabled = false;
      this.rebuildBtn.textContent = 'Rebuild Circuit';
    }).catch(() => {
      this.rebuildBtn.disabled = false;
      this.rebuildBtn.textContent = 'Rebuild Circuit';
    });
  }
}
