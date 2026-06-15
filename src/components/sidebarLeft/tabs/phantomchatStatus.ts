/**
 * AppPhantomChatStatusTab — Status page in hamburger menu
 *
 * Displays Nostr relay connection status.
 */

import SliderSuperTab from '@components/sliderTab';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import rootScope from '@lib/rootScope';
import {DEFAULT_RELAYS} from '@lib/phantomchat/nostr-relay-pool';
import App from '@config/app';
import appNavigationController from '@components/appNavigationController';

function latencyBadge(ms: number): string {
  if(!ms || ms <= 0) return '';
  if(ms < 500) return `🟢 ${ms}ms`;
  if(ms < 1500) return `🟡 ${ms}ms`;
  return `🔴 ${ms}ms`;
}

function formatConnectionState(state: string, latencyMs: number): string {
  switch(state) {
    case 'connected':
      return `🌐 Connected · ${latencyBadge(latencyMs) || 'online'}`;
    case 'connecting':
      return '🌐 ⏳ Connecting...';
    case 'reconnecting':
      return '🌐 ⏳ Reconnecting...';
    case 'disconnected':
    default:
      return '🔴 Disconnected';
  }
}

export default class AppPhantomChatStatusTab extends SliderSuperTab {
  public static getInitArgs() {
    return {};
  }

  public async init() {
    this.container.classList.add('phantomchat-status-container');
    this.setTitle('Status' as any);

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
        const pool = (window as any).__phantomchatPool;
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

          if(connected) connectedCount++;
          row.subtitle.textContent = formatConnectionState(state, latency);
        });

        // Update relay section caption with live connected count
        const total = relayRows.length;
        if(relaySection.caption) {
          relaySection.caption.textContent =
            `${connectedCount}/${total} connected · routing and storage`;
        }
      } catch(err) {
        console.debug('[PhantomChatStatus] relay status update failed:', err);
      }
    };

    // Initial update + periodic refresh
    updateRelayStatus();
    const interval = setInterval(updateRelayStatus, 5000);

    // Listen for relay state changes
    rootScope.addEventListener('phantomchat_relay_state', updateRelayStatus as any);

    // Clean up on tab destroy
    (this as any).eventListener?.addEventListener('destroy', () => {
      clearInterval(interval);
    });

    // ─── Section: Quick links ───────────────────────────────

    const linksSection = new SettingSection({});

    const privacyLink = new Row({
      title: 'Privacy & Security settings',
      subtitle: 'Manage privacy and security',
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
      title: 'Manage Nostr relays',
      subtitle: 'Add, remove and configure relays',
      icon: 'link',
      clickable: () => {
        import('@components/sidebarLeft/tabs/phantomchatRelaySettings').then(
          ({default: AppPhantomChatRelaySettingsTab}) => {
            this.slider.createTab(AppPhantomChatRelaySettingsTab).open();
          }
        );
      }
    });

    linksSection.content.append(
      privacyLink.container,
      relaysLink.container
    );

    // ─── Section: About / App version ────────────────────────

    const aboutSection = new SettingSection({
      name: 'About' as any,
      caption: 'App version and updates' as any
    });

    const currentVersion = App.versionFull || App.version || 'dev';

    const versionRow = new Row({
      title: 'Version',
      subtitle: `PhantomChat ${currentVersion}`,
      icon: 'info'
    });

    let updateReady = false;
    let checking = false;

    const updateRow = new Row({
      title: 'Check for updates',
      subtitle: 'Tap to check now',
      icon: 'download',
      clickable: () => {
        // If a newer build was already found, this acts as "Update now".
        if(updateReady) {
          appNavigationController.reload();
          return;
        }

        if(checking) return;
        checking = true;
        updateRow.subtitle.textContent = 'Checking…';

        fetch('version', {cache: 'no-cache'})
        .then((res) => (res.status === 200 && res.ok && res.text()) || Promise.reject(new Error('bad response')))
        .then((text) => {
          const latest = text.trim();
          if(latest && latest !== currentVersion) {
            updateReady = true;
            updateRow.title.textContent = 'Update now';
            updateRow.subtitle.textContent = `Version ${latest} is ready — tap to reload`;
          } else {
            updateRow.subtitle.textContent = `You're on the latest version (${currentVersion})`;
          }
        })
        .catch(() => {
          updateRow.subtitle.textContent = 'Could not check — tap to retry';
        })
        .finally(() => {
          checking = false;
        });
      }
    });

    aboutSection.content.append(
      versionRow.container,
      updateRow.container
    );

    this.scrollable.append(
      relaySection.container,
      linksSection.container,
      aboutSection.container
    );
  }
}
