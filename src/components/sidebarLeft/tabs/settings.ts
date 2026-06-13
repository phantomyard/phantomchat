/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {SliderSuperTab} from '@components/slider';
import ButtonMenuToggle from '@components/buttonMenuToggle';
import AppGeneralSettingsTab from '@components/sidebarLeft/tabs/generalSettings';
import lottieLoader from '@lib/rlottie/lottieLoader';
import Row from '@components/row';
import SettingSection from '@components/settingSection';
import AppPhantomChatRelaySettingsTab from '@components/sidebarLeft/tabs/phantomchatRelaySettings';
import AppEditProfileTab from '@components/sidebarLeft/tabs/editProfile';
import showLogOutPopup from '@components/popups/logOut';
import showResetLocalDataPopup from '@components/popups/resetLocalData';
import {loadCachedProfile} from '@lib/phantomchat/profile-cache';
import {loadEncryptedIdentity} from '@lib/phantomchat/key-storage';
import {decodePubkey} from '@lib/phantomchat/nostr-identity';
import {generateDicebearAvatar} from '@helpers/generateDicebearAvatar';
import {copyTextToClipboard} from '@helpers/clipboard';
import {toast} from '@components/toast';
import rootScope from '@lib/rootScope';
import App from '@config/app';

export default class AppSettingsTab extends SliderSuperTab {
  public async init() {
    this.container.classList.add('settings-container');
    this.setTitle('Settings');

    const btnMenu = ButtonMenuToggle({
      listenerSetter: this.listenerSetter,
      direction: 'bottom-left',
      buttons: [{
        icon: 'delete',
        regularText: 'Reset Local Data',
        onClick: () => {
          showResetLocalDataPopup();
        }
      }, {
        icon: 'logout',
        text: 'EditAccount.Logout',
        onClick: () => {
          showLogOutPopup();
        }
      }]
    });

    this.header.append(btnMenu);

    // Profile section — avatar + name + truncated npub, click-to-copy full npub.
    // HMR-safe: reads profile cache directly and listens to
    // phantomchat_identity_updated/_loaded rather than depending on the Solid store,
    // mirroring the hamburger profile entry (sidebarLeft/index.ts).
    if(!document.getElementById('phantomchat-settings-profile-style')) {
      const style = document.createElement('style');
      style.id = 'phantomchat-settings-profile-style';
      style.textContent = `
        .phantomchat-settings-profile{display:flex;align-items:center;gap:0.875rem;padding:0.5rem 0.25rem;cursor:pointer;border-radius:0.5rem;transition:background-color .15s}
        .phantomchat-settings-profile:hover{background-color:var(--light-secondary-text-color)}
        .phantomchat-settings-profile-avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;flex-shrink:0;background-color:var(--light-secondary-text-color)}
        .phantomchat-settings-profile-text{display:flex;flex-direction:column;min-width:0;line-height:1.25}
        .phantomchat-settings-profile-name{font-weight:600;font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .phantomchat-settings-profile-npub{font-size:0.8125rem;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      `;
      document.head.appendChild(style);
    }

    const profileSection = new SettingSection({noDelimiter: true});
    const profileDiv = document.createElement('div');
    profileDiv.classList.add('phantomchat-settings-profile');
    profileDiv.setAttribute('role', 'button');
    profileDiv.setAttribute('tabindex', '0');

    const avatarEl = document.createElement('img');
    avatarEl.classList.add('phantomchat-settings-profile-avatar');
    avatarEl.alt = '';

    const textWrap = document.createElement('div');
    textWrap.classList.add('phantomchat-settings-profile-text');

    const nameEl = document.createElement('div');
    nameEl.classList.add('phantomchat-settings-profile-name');

    const npubEl = document.createElement('div');
    npubEl.classList.add('phantomchat-settings-profile-npub');

    textWrap.append(nameEl, npubEl);
    profileDiv.append(avatarEl, textWrap);
    profileSection.content.append(profileDiv);

    let fullNpub = '';
    let hasRealPicture = false;

    const renderFromCache = () => {
      const cached = loadCachedProfile()?.profile;
      if(cached) {
        nameEl.textContent = cached.display_name || cached.name || '';
        if(cached.picture && avatarEl.src !== cached.picture) {
          avatarEl.src = cached.picture;
          hasRealPicture = true;
        }
      }
    };

    renderFromCache();
    this.listenerSetter.add(rootScope)('phantomchat_identity_updated', renderFromCache);
    this.listenerSetter.add(rootScope)('phantomchat_identity_loaded', renderFromCache);

    (async() => {
      try {
        const record = await loadEncryptedIdentity();
        if(!record?.npub) return;
        fullNpub = record.npub;
        npubEl.textContent = `${record.npub.slice(0, 12)}…${record.npub.slice(-8)}`;
        if(!nameEl.textContent) nameEl.textContent = record.displayName || 'Profile';
        if(hasRealPicture || avatarEl.src) return;
        try {
          const hex = decodePubkey(record.npub);
          const url = await generateDicebearAvatar(hex);
          if(!hasRealPicture) avatarEl.src = url;
        } catch{}
      } catch{}
    })();

    const copyNpub = () => {
      if(!fullNpub) return;
      copyTextToClipboard(fullNpub);
      toast('Copied to clipboard');
    };
    this.listenerSetter.add(profileDiv)('click', copyNpub);
    this.listenerSetter.add(profileDiv)('keydown', (e: KeyboardEvent) => {
      if(e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        copyNpub();
      }
    });

    // Menu rows
    const buttonsDiv = document.createElement('div');
    buttonsDiv.classList.add('profile-buttons');

    const identityRow = new Row({
      title: 'Identity',
      icon: 'user',
      clickable: () => {
        const tab = this.slider.createTab(AppEditProfileTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    const relayRow = new Row({
      title: 'Nostr Relays',
      icon: 'link',
      clickable: () => {
        const tab = this.slider.createTab(AppPhantomChatRelaySettingsTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    const privacyRow = new Row({
      title: 'Privacy & Security',
      icon: 'lock',
      clickable: async() => {
        const {default: AppPrivacyAndSecurityTab} = await import('@components/sidebarLeft/tabs/privacyAndSecurity');
        const tab = this.slider.createTab(AppPrivacyAndSecurityTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    const notificationsRow = new Row({
      titleLangKey: 'PhantomChat.NotificationSettingsViewController',
      icon: 'unmute',
      clickable: async() => {
        const {AppNotificationsTab} = await import('@components/solidJsTabs');
        const tab = this.slider.createTab(AppNotificationsTab);
        tab.open();
      },
      listenerSetter: this.listenerSetter
    });

    const generalRow = new Row({
      titleLangKey: 'PhantomChat.GeneralSettingsViewController',
      icon: 'settings',
      clickable: () => {
        const tab = this.slider.createTab(AppGeneralSettingsTab);
        tab.open(AppGeneralSettingsTab.getInitArgs());
      },
      listenerSetter: this.listenerSetter
    });

    buttonsDiv.append(
      identityRow.container,
      relayRow.container,
      privacyRow.container,
      notificationsRow.container,
      generalRow.container
    );

    const buttonsSection = new SettingSection();
    buttonsSection.content.append(buttonsDiv);

    const versionEl = document.createElement('div');
    versionEl.textContent = `PhantomChat ${App.versionFull}`;
    versionEl.style.cssText = 'padding: .5rem 1rem 1rem; text-align: center; color: var(--secondary-text-color); font-size: .8125rem;';

    this.scrollable.append(
      profileSection.container,
      buttonsSection.container,
      versionEl
    );

    lottieLoader.loadLottieWorkers();
  }
}
