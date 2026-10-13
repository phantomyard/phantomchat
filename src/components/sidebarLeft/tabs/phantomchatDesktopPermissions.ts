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
 * device (issue #215, freeze + list redesign per owner decision on #219).
 *
 * The MAIN process owns the real policy — prompts, remembered grants and
 * overrides all live in permissions.json next to the update-ring file.
 * Everything here is a view over that state.
 *
 * Owner decision (2026-10-13): only permissions that CAN show a user prompt
 * get a toggle here. Permissions that cannot prompt — the clipboard pair,
 * whose Ctrl+C/V keyboard flows cannot wait on a dialog — are allowed by
 * default with NO toggle at all. So every listed row is ON by default,
 * meaning "the app asks you the first time it's needed" (never a silent
 * failure), and the toggle exists so a worried user can block the
 * permission outright.
 *
 * Toggle semantics: ON writes 'ask' (clears any override and remembered
 * grant — the native prompt returns on next use), OFF writes 'deny'.
 * "Reset to defaults" clears every override and remembered grant, so all
 * rows return to ON/ask and the main process re-allows the clipboard pair.
 *
 * Keep this list in sync with PERMISSION_LABELS in electron/main.ts — and
 * keep the promptless clipboard pair OUT of it (those get no toggle).
 */

type PermissionEntry = {
  permission: string;
  title: string;
  subtitle: string;
};

const PERMISSION_ENTRIES: PermissionEntry[] = [
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

/**
 * A row is ON unless the permission is explicitly blocked: 'ask' (the
 * default — prompt on first use) and 'allow' ("Always allow" in a prompt)
 * both read as enabled.
 */
function isPermissionEnabled(settings: PermissionSettings, permission: string): boolean {
  return settings.overrides[permission] !== 'deny';
}

/** ON = back to prompting on first use; OFF = blocked. */
function toggleSetting(checked: boolean): PermissionSetting {
  return checked ? 'ask' : 'deny';
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
      caption: 'On by default — the app asks you the first time a permission is needed ("Always allow" is remembered). Turn a permission off to block it. Clipboard copy/paste is always available. Unlisted permissions ask on first use.' as any
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
        // setValueSilently, NEVER `checkbox.checked =`: the checked setter
        // fires a synthetic 'change' event (checkboxField.ts), which re-enters
        // each row's own change listener -> onToggled -> save -> refresh() and
        // froze the app the moment this tab opened (#219), while clobbering
        // permissions.json with synthetic overrides.
        checkbox.setValueSilently(isPermissionEnabled(settings, entry.permission));
      }
    } catch(err) {
      console.error('could not load permission settings', err);
    }
  }

  private async onToggled(permission: string, allowed: boolean) {
    if(!this.api?.setPermissionSetting) return;
    try {
      await this.api.setPermissionSetting(permission, toggleSetting(allowed));
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
