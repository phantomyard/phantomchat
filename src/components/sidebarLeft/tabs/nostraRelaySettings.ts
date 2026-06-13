import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import InputField from '@components/inputField';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import rootScope from '@lib/rootScope';
import {NostrRelayPool, RelayConfig, DEFAULT_RELAYS} from '@lib/nostra/nostr-relay-pool';

const LS_ONLY_MY_RELAYS = 'nostra-only-my-relays';

export default class AppNostraRelaySettingsTab extends SliderSuperTab {
  private relayPool: NostrRelayPool | null = null;
  private cardListEl: HTMLElement | null = null;
  private captionEl: HTMLElement | null = null;
  private stateCleanup: (() => void) | null = null;
  private listCleanup: (() => void) | null = null;

  public init(relayPool?: NostrRelayPool) {
    this.container.classList.add('nostra-relay-settings');
    this.setTitle('Nostr Relays' as any);

    this.relayPool = relayPool ?? (window as any).__nostraPool ?? null;

    // ─── Preferences ────────────────────────────────────────
    const prefSection = new SettingSection({
      name: 'Preferenze' as any,
      caption: 'Ignora i relay di default e usa solo quelli che hai aggiunto tu' as any
    });

    const onlyMineCheckbox = new CheckboxField({
      toggle: true,
      checked: localStorage.getItem(LS_ONLY_MY_RELAYS) === '1'
    });
    onlyMineCheckbox.input.addEventListener('change', () => {
      localStorage.setItem(LS_ONLY_MY_RELAYS, onlyMineCheckbox.checked ? '1' : '0');
    });

    const onlyMineRow = new Row({
      title: 'Usa solo i miei relay',
      checkboxField: onlyMineCheckbox,
      clickable: true
    });
    prefSection.content.append(onlyMineRow.container);

    // ─── Current Relays ─────────────────────────────────────
    const relaysSection = new SettingSection({
      name: 'I tuoi relay' as any,
      caption: true
    });
    this.captionEl = relaysSection.caption;

    const cardList = document.createElement('div');
    cardList.classList.add('relay-card-list');
    this.cardListEl = cardList;
    relaysSection.content.append(cardList);

    this.renderCards();

    const stateHandler = () => this.renderCards();
    rootScope.addEventListener('nostra_relay_state', stateHandler);
    this.stateCleanup = () => rootScope.removeEventListener('nostra_relay_state', stateHandler);

    const listHandler = () => this.renderCards();
    rootScope.addEventListener('nostra_relay_list_changed', listHandler);
    this.listCleanup = () => rootScope.removeEventListener('nostra_relay_list_changed', listHandler);

    // ─── Add Relay ──────────────────────────────────────────
    const addSection = new SettingSection({
      name: 'Aggiungi relay' as any
    });

    const urlInput = new InputField({
      labelText: 'wss://relay.example.com',
      name: 'relay-url',
      plainText: true
    });

    const addBtn = Button('btn-primary btn-color-primary');
    addBtn.textContent = 'Aggiungi';
    addBtn.style.width = '100%';
    addBtn.style.marginTop = '8px';
    attachClickEvent(addBtn, () => {
      const url = urlInput.value.trim();
      if(!url || !url.startsWith('wss://')) {
        urlInput.container.classList.add('error');
        return;
      }
      urlInput.container.classList.remove('error');
      if(this.relayPool) {
        this.relayPool.addRelay({url, read: true, write: true});
        urlInput.value = '';
        this.renderCards();
      }
    }, {listenerSetter: this.listenerSetter});

    addSection.content.append(urlInput.container, addBtn);

    // ─── Reset ──────────────────────────────────────────────
    const resetSection = new SettingSection({
      caption: 'Ripristina la lista ai relay di default di Nostra.chat' as any
    });

    const resetBtn = Button('btn-primary btn-color-primary btn-transparent danger');
    resetBtn.textContent = 'Ripristina predefiniti';
    attachClickEvent(resetBtn, () => {
      if(!this.relayPool) return;
      const current = this.relayPool.getRelays();
      for(const relay of current) {
        this.relayPool.removeRelay(relay.url);
      }
      for(const relay of DEFAULT_RELAYS) {
        this.relayPool.addRelay(relay);
      }
      this.renderCards();
    }, {listenerSetter: this.listenerSetter});

    resetSection.content.append(resetBtn);

    this.scrollable.append(
      prefSection.container,
      relaysSection.container,
      addSection.container,
      resetSection.container
    );
  }

  public destroy() {
    if(this.stateCleanup) this.stateCleanup();
    if(this.listCleanup) this.listCleanup();
  }

  private renderCards(): void {
    const container = this.cardListEl;
    if(!container) return;
    container.innerHTML = '';

    const relays: RelayConfig[] = this.relayPool?.getRelays() ?? [];
    const states = this.relayPool?.getRelayStates() ?? [];
    const stateMap = new Map(states.map((s: any) => [s.url, s]));
    const entries = this.relayPool?.getRelayEntries() ?? [];
    const instanceMap = new Map(entries.map((e: any) => [e.config.url, e.instance]));

    if(relays.length === 0) {
      const empty = document.createElement('div');
      empty.classList.add('relay-list-empty');
      empty.textContent = 'Nessun relay configurato';
      container.append(empty);
      this.updateCaption(0, 0);
      return;
    }

    let overheadSum = 0;
    let overheadCount = 0;
    let connectedCount = 0;

    for(const relay of relays) {
      const st = stateMap.get(relay.url);
      if(st?.connected) connectedCount++;
      const instance = instanceMap.get(relay.url);
      const torLat = instance?.torLatencyMs ?? -1;
      const dirLat = instance?.directLatencyMs ?? -1;
      if(torLat >= 0 && dirLat >= 0) {
        overheadSum += torLat - dirLat;
        overheadCount++;
      }
    }

    if(overheadCount > 0) {
      const avgOverhead = Math.round(overheadSum / overheadCount);
      const aggEl = document.createElement('div');
      aggEl.classList.add('relay-tor-aggregate');
      aggEl.textContent = `🧅 Avg Tor overhead: +${avgOverhead}ms across ${overheadCount} relay${overheadCount > 1 ? 's' : ''}`;
      container.append(aggEl);
    }

    this.updateCaption(connectedCount, relays.length);

    for(const relay of relays) {
      const st = stateMap.get(relay.url);
      const connected = st?.connected ?? false;
      const latencyMs = st?.latencyMs ?? -1;
      const enabled = st?.enabled ?? true;
      const instance = instanceMap.get(relay.url);
      const torLatency = instance?.torLatencyMs ?? -1;
      const directLatency = instance?.directLatencyMs ?? -1;

      container.append(
        this.createCard(relay, connected, latencyMs, enabled, torLatency, directLatency)
      );
    }
  }

  private createCard(
    relay: RelayConfig,
    connected: boolean,
    latencyMs: number,
    enabled: boolean,
    torLatency: number,
    directLatency: number
  ): HTMLElement {
    const card = document.createElement('div');
    card.classList.add('relay-card');
    if(!enabled) card.classList.add('relay-card--disabled');

    const header = document.createElement('div');
    header.classList.add('relay-card__header');

    const dot = document.createElement('span');
    const dotColor = !connected ? 'red' : latencyMs > 1000 ? 'yellow' : 'green';
    dot.classList.add('relay-card__dot', `relay-card__dot--${dotColor}`);

    const url = document.createElement('span');
    url.classList.add('relay-card__url');
    url.textContent = relay.url;

    const lat = document.createElement('span');
    lat.classList.add('relay-card__latency');
    if(latencyMs >= 0) {
      if(torLatency >= 0 && directLatency >= 0) {
        const overhead = torLatency - directLatency;
        lat.textContent = `${latencyMs}ms (Tor +${overhead}ms)`;
        lat.classList.add(overhead < 200 ? 'latency-good' : overhead < 500 ? 'latency-moderate' : 'latency-slow');
      } else {
        lat.textContent = `${latencyMs}ms`;
      }
    } else {
      lat.textContent = connected ? '…' : 'offline';
    }

    header.append(dot, url, lat);

    const footer = document.createElement('div');
    footer.classList.add('relay-card__footer');

    const readChip = this.createChip('R', relay.read, () => {
      this.updateRelayRW(relay.url, !relay.read, relay.write);
    });

    const writeChip = this.createChip('W', relay.write, () => {
      this.updateRelayRW(relay.url, relay.read, !relay.write);
    });

    const onChip = this.createChip('On', enabled, () => {
      if(!this.relayPool) return;
      if(enabled) {
        this.relayPool.disableRelay(relay.url);
      } else {
        this.relayPool.enableRelay(relay.url);
      }
      this.renderCards();
    });

    footer.append(readChip, writeChip, onChip);

    const deleteBtn = document.createElement('button');
    deleteBtn.classList.add('relay-card__delete', 'tgico-close');
    deleteBtn.addEventListener('click', () => {
      if(this.relayPool) {
        this.relayPool.removeRelay(relay.url);
        this.renderCards();
      }
    });

    card.append(header, footer, deleteBtn);
    return card;
  }

  private createChip(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.classList.add('relay-chip');
    if(active) chip.classList.add('relay-chip--active');
    chip.textContent = label;
    chip.addEventListener('click', onClick);
    return chip;
  }

  private updateRelayRW(url: string, read: boolean, write: boolean): void {
    if(!this.relayPool) return;
    this.relayPool.removeRelay(url);
    this.relayPool.addRelay({url, read, write});
    this.renderCards();
  }

  private updateCaption(connected: number, total: number): void {
    if(this.captionEl) {
      this.captionEl.textContent = `${connected}/${total} connessi`;
    }
  }
}
