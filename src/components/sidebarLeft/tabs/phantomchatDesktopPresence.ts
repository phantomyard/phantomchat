import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import {toast} from '@components/toast';
import {
  getDesktopApi,
  hasDesktopPresenceApi,
  visiblePresenceRows,
  type DesktopPresenceState,
  type PresenceRow
} from '@lib/phantomchat/desktop-api';

/*
 * Desktop-only: start at login and close to tray (owner decision, 2026-11-06).
 *
 * Main owns the truth (electron/presence.ts): the stored flags, what this
 * desktop can actually deliver, and their AND. This tab is a view over it.
 *
 * A row exists only where the platform can honour it. Ubuntu Desktop and
 * Plasma have a tray (StatusNotifier watcher), bare GNOME does not; a package
 * that cannot write a login entry gets no autostart row. The Settings entry
 * that opens this tab uses the same gate, so the PWA — which has no
 * capability at all — shows neither.
 *
 * Hidden is not deleted: turning a row on stores the flag, and the row comes
 * back with those settings on a desktop that supports it again.
 */
export default class AppPhantomChatDesktopPresenceTab extends SliderSuperTab {
  private state: DesktopPresenceState | null = null;
  private checkboxes: Partial<Record<PresenceRow, CheckboxField>> = {};

  public init() {
    this.container.classList.add('phantomchat-desktop-presence');
    this.setTitle('Desktop' as any);

    if(!hasDesktopPresenceApi()) {
      // Defensive: the row that opens this tab is already hidden on web and
      // on installs packaged before the presence API existed.
      return;
    }

    void this.refresh();
  }

  private async refresh() {
    const api = getDesktopApi();
    if(!api?.getPresence) return;
    try {
      this.render(await api.getPresence());
    } catch(err) {
      console.error('could not load desktop settings', err);
    }
  }

  private render(state: DesktopPresenceState) {
    this.state = state;
    this.scrollable.replaceChildren();
    this.checkboxes = {};

    const rows = visiblePresenceRows(state.capability);
    if(!rows.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 1rem; color: var(--secondary-text-color); font-size: .875rem;';
      empty.textContent = 'This desktop cannot keep PhantomChat in a tray or start it at login.';
      this.scrollable.append(empty);
      return;
    }

    const section = new SettingSection({
      name: 'On this PC' as any,
      caption: 'PhantomChat keeps receiving in the tray and can come back with your session.' as any
    });

    if(rows.includes('startAtLogin')) {
      section.content.append(this.row('startAtLogin',
        'Start at login',
        'Starts PhantomChat in the tray when you sign in to this PC.'
      ).container);
    }
    if(rows.includes('closeToTray')) {
      section.content.append(this.row('closeToTray',
        'Close to tray',
        'Closing the window keeps PhantomChat running. Quit from the tray to exit.'
      ).container);
    }

    this.scrollable.append(section.container);
  }

  private row(key: PresenceRow, title: string, subtitle: string): Row {
    const checkbox = new CheckboxField({toggle: true, checked: false});
    const row = new Row({title, subtitle, checkboxField: checkbox});
    this.checkboxes[key] = checkbox;
    // Main's validated state is the truth, so the initial paint is silent and
    // never re-enters this listener (see the permission tab for the freeze
    // that the `checked` setter caused).
    checkbox.setValueSilently(this.state!.settings[key]);
    checkbox.input.addEventListener('change', () => void this.onToggled(key, checkbox.checked));
    return row;
  }

  private async onToggled(key: PresenceRow, checked: boolean) {
    const api = getDesktopApi();
    if(!api?.setPresence) return;
    try {
      this.render(await api.setPresence({[key]: checked}));
    } catch(err) {
      console.error('could not save desktop setting', err);
      toast('Could not save the desktop setting');
      void this.refresh();
    }
  }
}
