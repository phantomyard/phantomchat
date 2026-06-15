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
      subtitle: 'Let others know when you read their messages',
      icon: 'readchats',
      checkboxField: new CheckboxField({
        toggle: true,
        checked: true
      })
    });

    readReceiptsRow.checkboxField.input.addEventListener('change', () => {
      const enabled = readReceiptsRow.checkboxField.checked;
      rootScope.dispatchEvent('phantomchat_read_receipts_toggle', enabled);
    });

    // Check current state from localStorage
    try {
      const stored = localStorage.getItem('phantomchat:read-receipts-enabled');
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
            title: 'Delete Account',
            descriptionRaw: 'This permanently deletes your identity (keys), all messages, contacts, groups, relays, and settings on this device. It cannot be undone — make sure you have your Recovery Phrase if you ever want this account back. Continue?',
            button: {
              text: document.createTextNode('Delete'),
              isDanger: true
            }
          });
        } catch{
          return; // user cancelled
        }

        // Full wipe. The old handler deleted only the identity database WITHOUT
        // awaiting it and then reloaded immediately — the delete was blocked by
        // the app's open IDB connections and lost the race against reload, so the
        // account survived (the reported bug). clearAllPhantomChatData()
        // force-closes connections and deletes EVERY PhantomChat DB (identity +
        // messages + groups + virtual-peers + pool), awaited to completion.
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);color:#fff;font-size:1.25rem;backdrop-filter:blur(8px)';
        overlay.textContent = 'Deleting account…';
        document.body.appendChild(overlay);

        try {
          const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
          const failed = await clearAllPhantomChatData();
          if(failed.length) console.warn('[PrivacyAndSecurity] delete account: some DBs failed to delete:', failed.join(', '));
        } catch(err) {
          console.warn('[PrivacyAndSecurity] delete account error:', err);
        }
        try { localStorage.clear(); } catch{}
        try { sessionStorage.clear(); } catch{}

        overlay.textContent = 'Account deleted — reloading…';
        location.href = location.origin;
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
