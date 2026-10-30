import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import RadioField from '@components/radioField';
import RadioForm from '@components/radioForm';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toast} from '@components/toast';
import {
  getDesktopApi,
  hasDesktopUpdateApi,
  type PhantomChatDesktopApi,
  type UpdateChannel,
  type UpdateState
} from '@lib/phantomchat/desktop-api';
import {
  describeUpdateStatus,
  describeLastChecked,
  describeActionButton
} from '@lib/phantomchat/desktop-update-view';
import {getChannelChoiceState, applyChannelChoice} from '@lib/phantomchat/update-channel-choice';

declare global {
  interface Window {
    phantomchatChannels?: {
      readonly current: UpdateChannel;
      choose(channel: UpdateChannel): boolean;
    };
  }
}

/*
 * The ONE Updates tab (owner batch 8, 2026-10-30).
 *
 * Before this there were two controls: an application channel picker and a
 * separate "Desktop app → Desktop updates" screen that carried its own
 * Stable/Preview ring. Two radios for one intent ("which release am I on")
 * is a trip hazard — a user could end up on preview web with a stable
 * installer and believe they had switched.
 *
 * Now a single Release channel radio drives both surfaces:
 *   - the application channel (web: /index.html ↔ /preview/index.html),
 *   - the desktop installer ring (Electron main's update feed).
 *
 * A surface that is absent (PWA has no installer; a desktop build packaged
 * before #164 has no update bridge) simply contributes nothing — the radio
 * still works for the surface that exists, and is disabled only when neither
 * does. When the desktop feed has no build for the chosen ring there is
 * nothing to install, which is a normal no-op, not an error.
 */
export default class AppPhantomChatUpdatesTab extends SliderSuperTab {
  private api: PhantomChatDesktopApi | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Application channel, or null when this build has no channel shell. */
  private applicationChannel: UpdateChannel | null = null;
  /** Last channel the desktop installer reported, or null without a bridge. */
  private desktopChannel: UpdateChannel | null = null;

  private statusEl: HTMLElement | null = null;
  private lastCheckedEl: HTMLElement | null = null;
  private actionBtn: HTMLButtonElement | null = null;
  private checkBtn: HTMLButtonElement | null = null;
  private radios: Record<UpdateChannel, RadioField> | null = null;

  public init() {
    this.container.classList.add('phantomchat-updates', 'phantomchat-application-updates');
    this.setTitle('Updates' as any);

    this.api = hasDesktopUpdateApi() ? getDesktopApi() : null;
    this.applicationChannel = window.phantomchatChannels?.current ?? null;

    const choice = getChannelChoiceState({
      application: this.applicationChannel,
      desktop: this.desktopChannel
    });

    // ─── Release channel: one control, both surfaces ────────
    const channelSection = new SettingSection({
      name: 'Release channel' as any,
      caption: (this.api ?
        'Applies to the app and the desktop installer together. Stable builds are promoted by hand; Preview ships every merged change and may be unstable.' :
        'Stable and Preview share your identity, chats and settings. Preview may be unstable.'
      ) as any
    });

    const stableRadio = new RadioField({
      text: 'Stable',
      name: 'phantomchat-update-channel',
      value: 'stable'
    });
    const previewRadio = new RadioField({
      text: 'Preview',
      name: 'phantomchat-update-channel',
      value: 'preview'
    });
    // Row adds a subtitle inside an outer label. Keep the radio's accessible
    // name independent of that descriptive text (including in pinned Stable).
    stableRadio.input.setAttribute('aria-label', 'Stable');
    previewRadio.input.setAttribute('aria-label', 'Preview');
    this.radios = {stable: stableRadio, preview: previewRadio};
    this.radios[choice.selected].input.checked = true;
    if(!choice.interactive) {
      stableRadio.input.disabled = true;
      previewRadio.input.disabled = true;
    }

    const stableRow = new Row({radioField: stableRadio, subtitle: 'Tested releases, promoted manually'});
    const previewRow = new Row({radioField: previewRadio, subtitle: 'Every merged change, as soon as it builds'});
    // aria-label replaces the *whole* accessible name, so the Row subtitle is
    // announced to nobody once it is set. Describe the input by that subtitle
    // instead: the control keeps an exact, wrapper-independent name for
    // assistive tech (and for the channel smoke tests) and the explanation
    // still reaches the user.
    stableRow.subtitle.id = 'pc-release-channel-stable-description';
    previewRow.subtitle.id = 'pc-release-channel-preview-description';
    stableRadio.input.setAttribute('aria-describedby', stableRow.subtitle.id);
    previewRadio.input.setAttribute('aria-describedby', previewRow.subtitle.id);

    const form = RadioForm([
      {container: stableRow.container, input: stableRadio.input},
      {container: previewRow.container, input: previewRadio.input}
    ], (value) => {
      void this.onChannelChosen(value as UpdateChannel);
    });
    form.setAttribute('aria-label', 'Release channel');
    channelSection.content.append(form);

    this.scrollable.append(channelSection.container);

    if(!this.api) {
      // PWA: the browser and the service worker own the update itself, so
      // there is no installer status to report — only the channel choice.
      return;
    }

    // ─── Installer status ───────────────────────────────────
    const statusSection = new SettingSection({name: 'This installation' as any, caption: true});

    const versionEl = document.createElement('div');
    versionEl.classList.add('desktop-update-version');

    const statusEl = this.statusEl = document.createElement('div');
    statusEl.classList.add('desktop-update-status');

    const lastCheckedEl = this.lastCheckedEl = document.createElement('div');
    lastCheckedEl.classList.add('desktop-update-last-checked');

    statusSection.content.append(versionEl, statusEl, lastCheckedEl);

    const checkBtn = this.checkBtn = Button('btn-primary btn-color-primary');
    checkBtn.textContent = 'Check now';
    checkBtn.style.width = '100%';
    checkBtn.style.marginTop = '12px';
    attachClickEvent(checkBtn, () => void this.onCheckNow());

    const actionBtn = this.actionBtn = Button('btn-primary btn-color-primary');
    actionBtn.style.width = '100%';
    actionBtn.style.marginTop = '8px';
    actionBtn.style.display = 'none';
    attachClickEvent(actionBtn, () => void this.onAction());

    statusSection.content.append(checkBtn, actionBtn);

    this.scrollable.append(statusSection.container);

    this.unsubscribe = this.api.onUpdateState((state) => this.render(state, versionEl));
    void this.api.getUpdateState().then((state) => this.render(state, versionEl));
  }

  private render(state: UpdateState, versionEl: HTMLElement) {
    this.desktopChannel = state.channel;
    versionEl.textContent = `PhantomChat ${state.currentVersion}`;

    if(this.radios) {
      // The application channel wins when both surfaces exist: it is the
      // surface the user is looking at, and a rejected desktop ring must not
      // leave the radio claiming something the app is not running.
      const selected = this.applicationChannel ?? state.channel;
      this.radios[selected].input.checked = true;
    }

    if(this.statusEl) {
      const capabilityNote = state.capability === 'notify' && state.capabilityReason ?
        `\n${state.capabilityReason}` :
        '';
      this.statusEl.textContent = describeUpdateStatus(state) + capabilityNote;
      this.statusEl.classList.toggle('is-error', state.status === 'error');
    }

    if(this.lastCheckedEl) {
      this.lastCheckedEl.textContent = describeLastChecked(state.lastCheckedAt);
    }

    if(this.checkBtn) {
      this.checkBtn.disabled = state.status === 'checking' || state.status === 'downloading';
    }

    if(this.actionBtn) {
      const action = describeActionButton(state);
      if(action) {
        this.actionBtn.textContent = action.label;
        this.actionBtn.style.display = '';
        this.actionBtn.disabled = !action.enabled;
      } else {
        this.actionBtn.style.display = 'none';
      }
    }
  }

  private checkRadio(channel: UpdateChannel) {
    if(this.radios) this.radios[channel].input.checked = true;
  }

  /** One radio, two surfaces — the ordering and rollback live in the pure
   *  helper so both failure paths are testable without a DOM. */
  private async onChannelChosen(channel: UpdateChannel) {
    const api = this.api;
    const channels = window.phantomchatChannels ?? null;

    const result = await applyChannelChoice({
      application: channels ?
        {current: channels.current, choose: (value) => channels.choose(value)} :
        null,
      desktop: api ?
        {
          current: this.desktopChannel,
          set: async(value) => (await api.setUpdateChannel(value)).channel
        } :
        null
    }, channel);

    this.applicationChannel = result.application;
    this.desktopChannel = result.desktop;
    this.checkRadio(result.application ?? result.desktop ?? 'stable');

    if(result.outcome === 'desktop-rejected') {
      toast('Could not change the desktop release channel');
    }
  }

  private async onCheckNow() {
    if(!this.api) return;
    try {
      await this.api.checkForUpdates();
    } catch{
      toast('Update check failed');
    }
  }

  private async onAction() {
    if(!this.api) return;
    try {
      await this.api.installUpdate();
    } catch{
      toast('Could not install the update');
    }
  }

  protected onCloseAfterTimeout() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return super.onCloseAfterTimeout();
  }
}
