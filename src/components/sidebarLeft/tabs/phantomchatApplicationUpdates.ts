import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import RadioField from '@components/radioField';
import RadioForm from '@components/radioForm';
import {hasDesktopUpdateApi} from '@lib/phantomchat/desktop-api';

type ApplicationChannel = 'stable' | 'preview';

declare global {
  interface Window {
    phantomchatChannels?: {
      readonly current: ApplicationChannel;
      choose(channel: ApplicationChannel): boolean;
    };
  }
}

/** Same Settings components as Electron's binary updater; independent channels. */
export default class AppPhantomChatApplicationUpdatesTab extends SliderSuperTab {
  public init() {
    this.container.classList.add('phantomchat-application-updates');
    this.setTitle('Updates' as any);

    const channels = window.phantomchatChannels;
    const section = new SettingSection({
      name: 'Application channel' as any,
      caption: 'Stable and Preview share your identity, chats and settings. Preview may be unstable.' as any
    });
    const radios = (['stable', 'preview'] as const).map((value) => {
      const radio = new RadioField({
        text: value === 'stable' ? 'Stable' : 'Preview',
        name: 'phantomchat-application-channel',
        value
      });
      radio.input.checked = value === (channels?.current ?? 'stable');
      radio.input.disabled = !channels;
      radio.input.setAttribute('aria-label', value === 'stable' ? 'Stable' : 'Preview');
      const row = new Row({
        radioField: radio,
        subtitle: value === 'stable' ? 'Tested releases, promoted manually' : 'Try upcoming application changes'
      });
      return {container: row.container, input: radio.input};
    });
    const form = RadioForm(radios, (value) => {
      if(!channels?.choose(value as ApplicationChannel)) {
        // Cancellation must not misrepresent the channel actually running.
        radios.forEach(({input}) => input.checked = input.value === channels?.current);
      }
    });
    form.setAttribute('aria-label', 'Application channel');
    section.content.append(form);
    this.scrollable.append(section.container);

    if(hasDesktopUpdateApi()) {
      const desktopSection = new SettingSection({
        name: 'Desktop app' as any,
        caption: 'The desktop installer update channel is independent of the application channel above.' as any
      });
      const row = new Row({
        title: 'Desktop updates',
        icon: 'download',
        clickable: async() => {
          const {default: DesktopUpdatesTab} = await import('@components/sidebarLeft/tabs/phantomchatDesktopUpdates');
          this.slider.createTab(DesktopUpdatesTab).open();
        },
        listenerSetter: this.listenerSetter
      });
      desktopSection.content.append(row.container);
      this.scrollable.append(desktopSection.container);
    }
  }
}
