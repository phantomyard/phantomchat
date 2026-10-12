import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toast} from '@components/toast';
import {
  getDesktopApi,
  hasDesktopPermissionApi,
  type PermissionSettings,
  type PermissionSetting
} from '@lib/phantomchat/desktop-api';

/*
 * Desktop-only: per-permission toggles for what the app may access on this
 * device (issue #215).
 *
 * The MAIN process owns the real policy — prompts, remembered grants and
 * overrides all live in permissions.json next to the update-ring file.
 * Everything here is a view over that state: a checkbox writes an explicit
 * override ('allow' | 'deny'), and "Reset to defaults" puts every permission
 * back on 'ask' (prompt on first use) except the promptless clipboard pair,
 * which the main process re-allows by default.
 *
 * Keep this list in sync with PERMISSION_LABELS in electron/main.ts.
 */

/** Keyboard-shortcut flows the main process grants without prompting. */
const PROMPTLESS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

type PermissionEntry = {
  permission: string;
  title: string;
  subtitle: string;
};

const PERMISSION_ENTRIES: PermissionEntry[] = [
  {permission: 'clipboard-read', title: 'Read clipboard', subtitle: 'Paste images and text from other apps (Ctrl+V). Turn off to stop the app reading your clipboard.'},
  {permission: 'clipboard-sanitized-write', title: 'Write clipboard', subtitle: 'Copy messages, npubs and keys (Ctrl+C). Turn off to block all copies from the app.'},
  {permission: 'media', title: 'Microphone & camera', subtitle: 'Voice messages and voice/video calls.'},
  {permission: 'notifications', title: 'Notifications', subtitle: 'New-message notifications.'},
  {permission: 'display-capture', title: 'Screen capture', subtitle: 'Sharing your screen in calls.'},
  {permission: 'geolocation', title: 'Location', subtitle: 'Your device location.'},
  // Electron 39 emits the camelCase 'fileSystem' identifier (review
  // blocker on #216) — must match electron/main.ts's PERMISSION_LABELS.
  {permission: 'fileSystem', title: 'File access', subtitle: 'Reading and writing files you pick.'},
  {permission: 'midi', title: 'MIDI', subtitle: 'MIDI devices (in/out).'},
  {permission: 'hid', title: 'HID devices', subtitle: 'Human-interface devices (gamepads, etc.).'},
  {permission: 'serial', title: 'Serial devices', subtitle: 'Serial-port devices.'},
  {permission: 'usb', title: 'USB devices', subtitle: 'USB devices.'},
  {permission: 'window-management', title: 'Window management', subtitle: 'Opening and placing windows.'},
  {permission: 'local-fonts', title: 'Local fonts', subtitle: 'Seeing your installed fonts.'},
  {permission: 'sensors', title: 'Motion sensors', subtitle: 'Accelerometer and friends.'}
];

/** Effective state as the main process would decide it, for the checkbox. */
function effectiveState(settings: PermissionSettings, permission: string): PermissionSetting {
  const override = settings.overrides[permission];
  if(override) return override;
  if(settings.granted.includes(permission)) return 'allow';
  return PROMPTLESS.has(permission) ? 'allow' : 'ask';
}

export default class AppPhantomChatDesktopPermissionsTab extends SliderSuperTab {
  private api: ReturnType<typeof getDesktopApi> = null;
  private rows: {
    entry: PermissionEntry;
    checkbox: CheckboxField;
  }[] = [];
  private resetBtn: HTMLButtonElement | null = null;

  public init() {
    this.container.classList.add('phantomchat-desktop-permissions');
    this.setTitle('App Permissions' as any);

    this.api = getDesktopApi();

    const section = new SettingSection({
      name: 'Device access' as any,
      caption: 'Unchecked permissions are blocked. Unlisted ones ask on first use; the prompt\'s "Always allow" is remembered here.' as any
    });

    for(const entry of PERMISSION_ENTRIES) {
      const checkbox = new CheckboxField({toggle: true, checked: false});
      const row = new Row({
        title: entry.title,
        subtitle: entry.subtitle,
        checkboxField: checkbox
      });
      checkbox.input.addEventListener('change', () => {
        void this.onToggled(entry.permission, checkbox.checked);
      });
      this.rows.push({entry, checkbox});
      section.content.append(row.container);
    }

    const resetBtn = this.resetBtn = Button('btn-primary btn-color-primary');
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.style.width = '100%';
    resetBtn.style.marginTop = '12px';
    attachClickEvent(resetBtn, () => void this.onReset());

    this.scrollable.append(section.container, resetBtn);

    if(!hasDesktopPermissionApi()) {
      // Defensive: the row that opens this tab is hidden on web and on
      // pre-#215 desktop builds.
      resetBtn.style.display = 'none';
      for(const {checkbox} of this.rows) {
        checkbox.input.disabled = true;
      }
      return;
    }

    void this.refresh();
  }

  private async refresh() {
    if(!this.api?.getPermissionSettings) return;
    try {
      const settings = await this.api.getPermissionSettings();
      for(const {entry, checkbox} of this.rows) {
        checkbox.checked = effectiveState(settings, entry.permission) === 'allow';
      }
    } catch(err) {
      console.error('could not load permission settings', err);
    }
  }

  private async onToggled(permission: string, allowed: boolean) {
    if(!this.api?.setPermissionSetting) return;
    try {
      await this.api.setPermissionSetting(permission, allowed ? 'allow' : 'deny');
      // Reflect main's validated state, not our click.
      await this.refresh();
    } catch(err) {
      toast('Could not save the permission setting');
      await this.refresh();
    }
  }

  private async onReset() {
    // Main-process reset (review blocker on #216): replaces the whole
    // settings object — overrides AND remembered grants, including for
    // permissions this tab doesn't list — with defaults atomically. A
    // per-key loop here could never clear grants it can't see.
    if(typeof this.api?.resetPermissionSettings !== 'function') return;
    try {
      await this.api.resetPermissionSettings();
      await this.refresh();
      toast('Permissions reset to defaults');
    } catch(err) {
      toast('Could not reset permissions');
    }
  }
}
