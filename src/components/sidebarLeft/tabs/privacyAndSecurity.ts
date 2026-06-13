/*
 * Nostra.chat Privacy & Security settings
 * Replaces Telegram's MTProto-dependent privacy settings with
 * Nostr-relevant security options.
 */

import SliderSuperTab from '@components/sliderTab';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import rootScope from '@lib/rootScope';
import CheckboxField from '@components/checkboxField';
import AppNostraSecurityTab from '@components/sidebarLeft/tabs/nostraSecurity';
import AppNostraSeedPhraseTab from '@components/sidebarLeft/tabs/nostraSeedPhrase';
import {PrivacyTransport} from '@lib/nostra/privacy-transport';

export default class AppPrivacyAndSecurityTab extends SliderSuperTab {
  public static getInitArgs(fromTab: SliderSuperTab) {
    return {};
  }

  public async init(_p?: any) {
    this.container.classList.add('privacy-container');
    this.setTitle('PrivacySettings');

    // --- Tor section ---
    const torSection = new SettingSection({
      name: 'Tor.Mode.SectionTitle' as any,
      caption: 'Tor.Mode.SectionCaption' as any
    });

    type TorModeOption = {
      mode: 'only' | 'when-available' | 'off';
      titleKey: string;
      descKey: string;
    };
    const MODE_OPTIONS: TorModeOption[] = [
      {mode: 'when-available', titleKey: 'Tor.Mode.WhenAvailable.Label', descKey: 'Tor.Mode.WhenAvailable.Desc'},
      {mode: 'only', titleKey: 'Tor.Mode.Only.Label', descKey: 'Tor.Mode.Only.Desc'},
      {mode: 'off', titleKey: 'Tor.Mode.Off.Label', descKey: 'Tor.Mode.Off.Desc'}
    ];

    const currentMode = PrivacyTransport.readMode();
    const checkboxes = new Map<TorModeOption['mode'], CheckboxField>();

    MODE_OPTIONS.forEach((opt) => {
      // tweb CheckboxField has no built-in radio style — we use `toggle: true`
      // and enforce exclusivity in `selectMode` below. If the codebase grows a
      // radio primitive (`round: true` etc.) later, swap it in here.
      const cb = new CheckboxField({
        toggle: true,
        checked: opt.mode === currentMode
      });
      checkboxes.set(opt.mode, cb);

      const row = new Row({
        checkboxField: cb,
        titleLangKey: opt.titleKey as any,
        subtitleLangKey: opt.descKey as any,
        clickable: true,
        listenerSetter: this.listenerSetter
      });

      cb.input.addEventListener('change', () => {
        if(!cb.checked) {
          // The user tapped to de-select the active mode — re-assert it,
          // there's no "no mode" state.
          cb.setValueSilently(true);
          return;
        }
        void selectMode(opt.mode);
      });

      torSection.content.append(row.container);
    });

    async function selectMode(next: TorModeOption['mode']) {
      for(const [m, cb] of checkboxes) {
        cb.setValueSilently(m === next);
      }
      const transport = (window as any).__nostraPrivacyTransport;
      if(transport?.setMode) {
        await transport.setMode(next);
      } else {
        // No live transport (onboarding/offline fixtures) — persist directly.
        PrivacyTransport.setModeStatic(next);
      }
    }

    // --- Mesh Network section ---
    const meshSection = new SettingSection({name: 'Mesh Network' as any});

    const meshRow = new Row({
      title: 'P2P Mesh Settings',
      subtitle: 'Direct connections between contacts',
      icon: 'link',
      clickable: async() => {
        const {default: AppNostraMeshSettingsTab} = await import('@components/sidebarLeft/tabs/nostraMeshSettings');
        const tab = new AppNostraMeshSettingsTab(this.slider);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    meshSection.content.append(meshRow.container);

    // Section 1: Key Security
    const securitySection = new SettingSection({
      name: 'Key Protection' as any,
      caption: 'Protect your Nostr private keys' as any
    });

    const keyProtectionRow = new Row({
      title: 'PIN / Passphrase',
      subtitle: 'Protect your seed phrase with a PIN or passphrase',
      icon: 'lock',
      clickable: () => {
        const tab = this.slider.createTab(AppNostraSecurityTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    const recoveryPhraseRow = new Row({
      title: 'Recovery Phrase',
      subtitle: 'View your 12-word backup to restore access',
      icon: 'key',
      clickable: () => {
        const tab = this.slider.createTab(AppNostraSeedPhraseTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    securitySection.content.append(keyProtectionRow.container, recoveryPhraseRow.container);

    // Section 2: Read Receipts (Nostra.chat-specific)
    const privacySection = new SettingSection({
      name: 'Privacy' as any
    });

    const readReceiptsRow = new Row({
      title: 'Read Receipts',
      subtitle: 'Let others know when you read their messages',
      icon: 'readchats',
      checkboxField: new CheckboxField({
        toggle: true,
        checked: true
      })
    });

    readReceiptsRow.checkboxField.input.addEventListener('change', () => {
      const enabled = readReceiptsRow.checkboxField.checked;
      rootScope.dispatchEvent('nostra_read_receipts_toggle', enabled);
    });

    // Check current state from localStorage
    try {
      const stored = localStorage.getItem('nostra:read-receipts-enabled');
      if(stored === 'false') {
        readReceiptsRow.checkboxField.checked = false;
      }
    } catch{}

    const relayPrivacyRow = new Row({
      title: 'Relay Privacy',
      subtitle: 'Messages are encrypted end-to-end via NIP-17',
      icon: 'key',
      clickable: false
    });

    privacySection.content.append(
      readReceiptsRow.container,
      relayPrivacyRow.container
    );

    // Section 3: Danger Zone
    const dangerSection = new SettingSection({
      name: 'Danger Zone' as any
    });

    const deleteAccountRow = new Row({
      title: 'Delete Account',
      subtitle: 'Remove all local data and identity',
      icon: 'delete',
      clickable: async() => {
        const {default: confirmationPopup} = await import('@components/confirmationPopup');
        try {
          await confirmationPopup({
            titleLangKey: 'DeleteAccount' as any,
            descriptionLangKey: 'AreYouSure' as any,
            button: {
              langKey: 'Delete' as any,
              isDanger: true
            }
          });
          indexedDB.deleteDatabase('Nostra.chat');
          location.reload();
        } catch{}
      },
      listenerSetter: this.listenerSetter
    });
    deleteAccountRow.container.classList.add('danger');

    dangerSection.content.append(deleteAccountRow.container);

    this.scrollable.append(
      torSection.container,
      meshSection.container,
      securitySection.container,
      privacySection.container,
      dangerSection.container
    );
  }
}

// Register lazily to avoid circular import with solidJsTabs
import('@components/solidJsTabs').then(({providedTabs}) => {
  providedTabs.AppPrivacyAndSecurityTab = AppPrivacyAndSecurityTab;
});
