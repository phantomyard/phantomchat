/*
 * PhantomChat.chat Privacy & Security settings
 * Replaces Telegram's MTProto-dependent privacy settings with
 * Nostr-relevant security options.
 */

import SliderSuperTab from '@components/sliderTab';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import rootScope from '@lib/rootScope';
import CheckboxField from '@components/checkboxField';
import AppPhantomChatSecurityTab from '@components/sidebarLeft/tabs/phantomchatSecurity';
import AppPhantomChatSeedPhraseTab from '@components/sidebarLeft/tabs/phantomchatSeedPhrase';
import {getReadReceiptsEnabled, setReadReceiptsEnabledSetting} from '@lib/phantomchat/read-receipts-setting';

export default class AppPrivacyAndSecurityTab extends SliderSuperTab {
  public static getInitArgs(fromTab: SliderSuperTab) {
    return {};
  }

  public async init(_p?: any) {
    this.container.classList.add('privacy-container');
    this.setTitle('PrivacySettings');

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
        const tab = this.slider.createTab(AppPhantomChatSecurityTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    const recoveryPhraseRow = new Row({
      title: 'Recovery Phrase',
      subtitle: 'View your 12-word backup to restore access',
      icon: 'key',
      clickable: () => {
        const tab = this.slider.createTab(AppPhantomChatSeedPhraseTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    securitySection.content.append(keyProtectionRow.container, recoveryPhraseRow.container);

    // Section 2: Read Receipts (PhantomChat.chat-specific)
    const privacySection = new SettingSection({
      name: 'Privacy' as any
    });

    const readReceiptsRow = new Row({
      title: 'Read Receipts',
      // WhatsApp-style coupling: this single switch governs read receipts AND
      // typing/recording indicators, in both directions. Off → you send only a
      // single "sent" tick, no typing indicator, and you don't see others'
      // typing indicators either.
      subtitle: 'Send read receipts and typing indicators. If off, you won\'t send them — and you won\'t see others\' typing.',
      icon: 'readchats',
      checkboxField: new CheckboxField({
        toggle: true,
        checked: true
      })
    });

    readReceiptsRow.checkboxField.input.addEventListener('change', () => {
      const enabled = readReceiptsRow.checkboxField.checked;
      // Persist to the shared source of truth so the typing emit/receive gates
      // and the delivery-tracker all read a consistent value (previously this
      // toggle dispatched an event nobody listened to and never persisted, so
      // it was a no-op).
      setReadReceiptsEnabledSetting(enabled);
      rootScope.dispatchEvent('phantomchat_read_receipts_toggle', enabled);
      // Live-update the already-constructed delivery tracker so read receipts
      // take effect without a reload (it caches the value at construction).
      try {
        const chatAPI = (window as any).__phantomchatChatAPI;
        chatAPI?.getDeliveryTracker?.()?.setReadReceiptsEnabled?.(enabled);
      } catch{}
    });

    // Reflect the persisted state in the checkbox.
    readReceiptsRow.checkboxField.checked = getReadReceiptsEnabled();

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
        // Delete Account routes through the proven logout teardown
        // (showDeleteAccountPopup → logOut keepPhantomChatIdentity:false), which
        // deletes the Nostr key in the Worker context + clears tweb state. A
        // main-thread indexedDB.deleteDatabase() alone is blocked by the
        // SharedWorker's open connections and silently fails (the reported bug).
        const {showDeleteAccountPopup} = await import('@components/popups/resetLocalData');
        showDeleteAccountPopup();
      },
      listenerSetter: this.listenerSetter
    });
    deleteAccountRow.container.classList.add('danger');

    dangerSection.content.append(deleteAccountRow.container);

    this.scrollable.append(
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
