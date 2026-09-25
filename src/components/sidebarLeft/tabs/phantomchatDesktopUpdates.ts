import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import RadioField from '@components/radioField';
import RadioForm from '@components/radioForm';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toast} from '@components/toast';
import {getDesktopApi, type PhantomChatDesktopApi, type UpdateChannel, type UpdateState} from '@lib/phantomchat/desktop-api';
import {describeUpdateStatus, describeLastChecked, describeActionButton} from '@lib/phantomchat/desktop-update-view';

/*
 * Desktop-only: release ring selection and update status (issue #164).
 *
 * This tab is reachable only when window.phantomchatDesktop exists, i.e. in
 * the packaged Electron app. The PWA has no installer to replace, so the
 * settings row that opens it is hidden on web.
 *
 * The ring itself is owned by the MAIN process, not by this tab — the first
 * update check runs before any renderer exists, so localStorage could never
 * be the source of truth. Everything here is a view over main's state.
 */

export default class AppPhantomChatDesktopUpdatesTab extends SliderSuperTab {
  private api: PhantomChatDesktopApi | null = null;
  private unsubscribe: (() => void) | null = null;

  private statusEl: HTMLElement | null = null;
  private lastCheckedEl: HTMLElement | null = null;
  private actionBtn: HTMLButtonElement | null = null;
  private checkBtn: HTMLButtonElement | null = null;
  private radios: Record<UpdateChannel, RadioField> | null = null;

  public init() {
    this.container.classList.add('phantomchat-desktop-updates');
    this.setTitle('Updates' as any);

    this.api = getDesktopApi();

    // ─── Release ring ───────────────────────────────────────
    const channelSection = new SettingSection({
      name: 'Release channel' as any,
      caption: 'Preview builds ship on every change and may be unstable. Stable builds are promoted by hand after soaking on preview.' as any
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
    this.radios = {stable: stableRadio, preview: previewRadio};

    const stableRow = new Row({radioField: stableRadio, subtitle: 'Tested releases, promoted manually'});
    const previewRow = new Row({radioField: previewRadio, subtitle: 'Every merged change, as soon as it builds'});

    const form = RadioForm([
      {container: stableRow.container, input: stableRadio.input},
      {container: previewRow.container, input: previewRadio.input}
    ], (value) => {
      void this.onChannelChosen(value as UpdateChannel);
    });
    channelSection.content.append(form);

    // ─── Status ─────────────────────────────────────────────
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

    this.scrollable.append(channelSection.container, statusSection.container);

    if(!this.api) {
      // Defensive: the row that opens this tab is already hidden on web.
      versionEl.textContent = 'Updates are managed by your browser in the web app.';
      checkBtn.style.display = 'none';
      return;
    }

    this.unsubscribe = this.api.onUpdateState((state) => this.render(state, versionEl));

    void this.api.getUpdateState().then((state) => this.render(state, versionEl));
  }

  private render(state: UpdateState, versionEl: HTMLElement) {
    versionEl.textContent = `PhantomChat ${state.currentVersion}`;

    if(this.radios) {
      // Reflect main's state rather than assuming our click took effect —
      // an invalid channel is rejected there and must not leave the radio
      // showing a ring the app is not actually on.
      this.radios[state.channel].input.checked = true;
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

  private async onChannelChosen(channel: UpdateChannel) {
    if(!this.api) return;
    try {
      await this.api.setUpdateChannel(channel);
    } catch(err) {
      toast('Could not change release channel');
    }
  }

  private async onCheckNow() {
    if(!this.api) return;
    try {
      await this.api.checkForUpdates();
    } catch(err) {
      toast('Update check failed');
    }
  }

  private async onAction() {
    if(!this.api) return;
    try {
      await this.api.installUpdate();
    } catch(err) {
      toast('Could not install the update');
    }
  }

  protected onCloseAfterTimeout() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return super.onCloseAfterTimeout();
  }
}
