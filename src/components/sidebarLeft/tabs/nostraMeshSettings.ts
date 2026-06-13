/**
 * AppNostraMeshSettingsTab — P2P mesh network settings
 *
 * Shows mesh toggle, connection stats, and per-contact status.
 */

import SliderSuperTab from '@components/sliderTab';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import rootScope from '@lib/rootScope';
import CheckboxField from '@components/checkboxField';

const MESH_ENABLED_KEY = 'nostra-mesh-enabled';

export default class AppNostraMeshSettingsTab extends SliderSuperTab {
  private statsEl: HTMLElement;
  private contactListEl: HTMLElement;
  private updateInterval: ReturnType<typeof setInterval>;

  public static getInitArgs() {
    return {};
  }

  public async init() {
    this.container.classList.add('mesh-settings-container');
    this.setTitle('Mesh Network' as any);

    // ─── Section: Toggle ─────────────────────────────────────

    const toggleSection = new SettingSection({
      name: 'P2P Mesh' as any,
      caption: 'Connect directly to your contacts when possible' as any
    });

    const meshEnabled = localStorage.getItem(MESH_ENABLED_KEY) !== 'false';

    const meshCheckbox = new CheckboxField({
      toggle: true,
      checked: meshEnabled
    });

    const toggleRow = new Row({
      title: 'Enable P2P mesh',
      subtitle: meshEnabled ? 'Direct connections active' : 'Relay-only mode',
      checkboxField: meshCheckbox,
      clickable: true
    });

    meshCheckbox.input.addEventListener('change', () => {
      const enabled = meshCheckbox.checked;
      localStorage.setItem(MESH_ENABLED_KEY, String(enabled));
      toggleRow.subtitle.textContent = enabled ?
        'Direct connections active' :
        'Relay-only mode';
      try {
        const pool = (window as any).__nostraPool;
        if(pool?.setMeshEnabled) pool.setMeshEnabled(enabled);
      } catch{}
    });

    toggleSection.content.append(toggleRow.container);

    // ─── Section: Stats ──────────────────────────────────────

    const statsSection = new SettingSection({
      name: 'Status' as any
    });

    this.statsEl = document.createElement('div');
    this.statsEl.className = 'mesh-stats';
    this.statsEl.textContent = 'Gathering mesh info...';
    statsSection.content.append(this.statsEl);

    // ─── Section: Contacts ───────────────────────────────────

    const contactsSection = new SettingSection({
      name: 'Contacts' as any,
      caption: 'P2P connection status per contact' as any
    });

    this.contactListEl = document.createElement('div');
    contactsSection.content.append(this.contactListEl);

    // ─── Initial render + periodic refresh ───────────────────

    this.renderMeshStatus();
    this.updateInterval = setInterval(() => this.renderMeshStatus(), 5000);

    // Listen for peer events
    rootScope.addEventListener('nostra_mesh_peer_connected' as any, () => this.renderMeshStatus());
    rootScope.addEventListener('nostra_mesh_peer_disconnected' as any, () => this.renderMeshStatus());

    (this as any).eventListener?.addEventListener('destroy', () => {
      clearInterval(this.updateInterval);
    });

    this.scrollable.append(
      toggleSection.container,
      statsSection.container,
      contactsSection.container
    );
  }

  private renderMeshStatus() {
    try {
      const pool = (window as any).__nostraPool;
      const peers: Array<{pubkey: string, status: string}> = pool?.getMeshPeers?.() || [];

      const connected = peers.filter((p) => p.status === 'online').length;
      const total = peers.length;

      this.statsEl.textContent = total === 0 ?
        'No contacts in mesh' :
        `Connected to ${connected}/${total} contacts`;

      // Rebuild contact rows
      this.contactListEl.innerHTML = '';

      if(total === 0) {
        const empty = document.createElement('div');
        empty.className = 'mesh-stats';
        empty.textContent = 'Add contacts to enable mesh';
        this.contactListEl.append(empty);
        return;
      }

      for(const peer of peers) {
        const row = document.createElement('div');
        row.className = 'mesh-contact-row';

        const dot = document.createElement('div');
        dot.className = `mesh-dot mesh-dot--${peer.status === 'online' ? 'online' : 'offline'}`;

        const name = document.createElement('div');
        name.className = 'mesh-contact-name';
        const pk = peer.pubkey || '';
        name.textContent = pk.length > 20 ? pk.slice(0, 8) + '...' + pk.slice(-8) : pk;

        const status = document.createElement('div');
        status.className = 'mesh-contact-status';
        status.textContent = peer.status || 'unknown';

        row.append(dot, name, status);
        this.contactListEl.append(row);
      }
    } catch(err) {
      console.debug('[MeshSettings] renderMeshStatus failed:', err);
      this.statsEl.textContent = 'Mesh status unavailable';
    }
  }
}
