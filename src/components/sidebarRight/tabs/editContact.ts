/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {SliderSuperTab} from '@components/slider'
import InputField from '@components/inputField';
import EditPeer from '@components/editPeer';
import Row, {CreateRowFromCheckboxField} from '@components/row';
import CheckboxField from '@components/checkboxField';
import Button, {replaceButtonIcon} from '@components/button';
import rootScope from '@lib/rootScope';
import {i18n} from '@lib/langPack';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import toggleDisability from '@helpers/dom/toggleDisability';
import getPeerId from '@appManagers/utils/peers/getPeerId';
import SettingSection from '@components/settingSection';
import wrapPeerTitle from '@components/wrappers/peerTitle';
import {wrapEmojiTextWithEntities} from '@lib/richTextProcessor/wrapEmojiText';
import EditFolderInput from '@components/sidebarLeft/tabs/editFolderInput';
import {toastNew, toast} from '@components/toast';
import {isP2PPeerId} from '@lib/phantomchat/bridge-invariants';
import appSidebarRight from '..';

export default class AppEditContactTab extends SliderSuperTab {
  private nameInputField: InputField;
  private editPeer: EditPeer;
  private sharePhoneCheckboxField: CheckboxField;
  private localToolsCheckboxField?: CheckboxField;
  private contactPubkey: string | null = null;
  public peerId: PeerId;
  /**
   * Opened from the Contacts list on a phone: the pane covers the list, so it
   * gets a back arrow and closing it goes back to the list.
   */
  public overContactsList = false;

  public async init() {
    const {peerId} = this;
    const userId = peerId.toUserId();
    this.container.classList.add('edit-peer-container', 'edit-contact-container');
    const [isContact, privacy] = await Promise.all([
      userId ? this.managers.appUsersManager.isContact(userId) : Promise.resolve(false),
      this.managers.appPrivacyManager.getPrivacy('inputPrivacyKeyPhoneNumber')
    ]);
    const isNew = !isContact;
    this.setTitle('Edit');
    const newCloseBtn = this.closeBtn.cloneNode(true) as HTMLElement;
    this.closeBtn.replaceWith(newCloseBtn);
    this.closeBtn = newCloseBtn;
    // Back arrow (the tab default) over the Contacts list on a phone; a close
    // X beside the chat everywhere else.
    if(!this.overContactsList) replaceButtonIcon(this.closeBtn, 'close');

    attachClickEvent(this.closeBtn, () => {
      this.close();
      appSidebarRight.toggleSidebar(false);
    }, {listenerSetter: this.listenerSetter});

    {
      const section = new SettingSection({noDelimiter: true});
      const inputFields: InputField[] = [];

      const inputWrapper = document.createElement('div');
      inputWrapper.classList.add('input-wrapper');

      // Contacts redesign: one Contact Name field (no last name, no note).
      // A legacy contact's first + last name are shown joined, and saving
      // writes the whole name to the first-name slot.
      this.nameInputField = new InputField({
        label: 'ContactName',
        name: 'contact-name',
        maxLength: 70,
        required: true
      });

      let isBot = false;
      if(userId) {
        const user = await this.managers.appUsersManager.getUser(userId);

        if(user) {
          isBot = !!user.pFlags?.bot;
          const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
          if(isNew && !fullName) {
            this.nameInputField.setDraftValue('');
          } else {
            this.nameInputField.setOriginalValue(fullName);
          }
        }
      }

      inputWrapper.append(this.nameInputField.container);
      inputFields.push(this.nameInputField);

      // Contact type decides whether Local tools is offered at all.
      const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
      const contactPubkey = userId && isP2PPeerId(Number(userId)) ? await getPubkey(Number(userId)) : null;
      const prefsMod = await import('@lib/phantomchat/contact-prefs');
      const prefs = contactPubkey ? await prefsMod.getContactPrefs(contactPubkey) : undefined;
      const contactKind = prefsMod.resolveContactKind(prefs?.kind, isBot);
      this.contactPubkey = contactPubkey;
      // Phantom: the switch is main's Local tools gate (phantombot #747), so it
      // only exists in a desktop build that has it, and main's list is the
      // truth.
      const localToolsMod = contactKind === 'phantom' ? await import('@lib/phantomchat/local-tools') : undefined;
      const localToolsApi = localToolsMod?.getLocalToolsApi();
      // Provider: no switch until the engine can turn a hosted channel's tools off.
      const offerLocalTools = !!contactPubkey && contactKind === 'phantom' && !!localToolsApi;
      const localToolsOn = localToolsApi && contactPubkey ?
        (await localToolsApi.enabled().catch((): string[] => [])).includes(contactPubkey) :
        !!prefs?.localTools;
      this.localToolsCheckboxField = offerLocalTools ?
        new CheckboxField({text: 'ContactLocalTools', checked: localToolsOn}) :
        undefined;

      this.editPeer = new EditPeer({
        peerId: peerId,
        inputFields,
        listenerSetter: this.listenerSetter,
        doNotEditAvatar: true,
        middleware: this.middlewareHelper.get()
      });
      this.content.append(this.editPeer.nextBtn);

      if(peerId) {
        // Display-only: only the user's own profile picture is editable.
        const div = document.createElement('div');
        div.classList.add('avatar-static');
        div.append(this.editPeer.avatarElem.node);

        const notificationsCheckboxField = new CheckboxField({
          text: 'Notifications'
        });

        notificationsCheckboxField.input.addEventListener('change', (e) => {
          if(!e.isTrusted) {
            return;
          }

          this.managers.appMessagesManager.togglePeerMute({peerId});
        });

        this.listenerSetter.add(rootScope)('notify_settings', async(update) => {
          if(update.peer._ !== 'notifyPeer') return;
          const updatedPeerId = getPeerId(update.peer.peer);
          if(updatedPeerId === peerId) {
            const enabled = !(await this.managers.appNotificationsManager.isMuted(update.notify_settings));
            if(enabled !== notificationsCheckboxField.checked) {
              notificationsCheckboxField.checked = enabled;
            }
          }
        });

        section.content.append(div, inputWrapper);

        if(this.localToolsCheckboxField) {
          // Saved on toggle, like Notifications: the Save button only tracks
          // the text fields.
          const field = this.localToolsCheckboxField;
          const pubkey = this.contactPubkey;
          field.input.addEventListener('change', async(e) => {
            if(!e.isTrusted) return;
            const wanted = field.checked;
            try {
              let on = wanted;
              if(localToolsMod && localToolsApi) {
                const user = await this.managers.appUsersManager.getUser(userId).catch((): undefined => undefined);
                const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'This contact';
                // ON asks in a native dialog; a Cancel leaves it off.
                on = await localToolsMod.setPhantomLocalTools(pubkey, wanted, name);
                field.checked = on;
              }
              await prefsMod.setContactPrefs(pubkey, {localTools: on});
            } catch(err) {
              console.error('[PhantomChat] failed to save Local tools', err);
              field.checked = !wanted;
              toastNew({langPackKey: 'Error.AnError'});
            }
          });
          const localToolsRow = new Row({
            checkboxField: this.localToolsCheckboxField,
            withCheckboxSubtitle: true,
            listenerSetter: this.listenerSetter
          });
          localToolsRow.container.setAttribute('data-testid', 'edit-contact-local-tools');
          section.content.append(localToolsRow.container);
        }

        const notificationsRow = new Row({
          checkboxField: notificationsCheckboxField,
          withCheckboxSubtitle: true,
          listenerSetter: this.listenerSetter
        });

        const enabled = !(await this.managers.appNotificationsManager.isPeerLocalMuted({peerId, respectType: false}));
        notificationsCheckboxField.checked = enabled;

        section.content.append(notificationsRow.container);
      } else {
        section.content.append(inputWrapper);
      }

      this.scrollable.append(section.container);
    }

    if(peerId) {
      const section = new SettingSection();

      const btnDelete = Button('btn-primary btn-transparent danger', {icon: 'delete', text: 'PeerInfo.DeleteContact'});

      attachClickEvent(btnDelete, async() => {
        const {default: confirmDeleteContact} = await import('@components/phantomchat/confirmDeleteContact');
        if(!await confirmDeleteContact(peerId)) return;
        const toggle = toggleDisability([btnDelete], true);

        try {
          if(isP2PPeerId(Number(userId))) {
            // The one delete path (delete-contact.ts): a Provider contact's
            // persona and local data first, then the contact, here and on
            // every other device.
            const {deleteContact} = await import('@lib/phantomchat/delete-contact');
            const outcome = await deleteContact(Number(userId));
            if(outcome !== 'deleted') {
              toggle();
              toast(i18n(outcome === 'unresolved' ? 'Contact.Delete.CouldNotResolve' : 'Contact.Delete.ChatNotReady'));
              return;
            }
          } else {
            if(userId) {
              await this.managers.appUsersManager.deleteContacts([userId]);
            }
            await rootScope.managers.appMessagesManager.flushHistory({peerId, justClear: false, revoke: true});
            rootScope.dispatchEvent('dialog_drop', {peerId} as any);
          }

          this.close();
          appSidebarRight.toggleSidebar(false);
          toast(i18n('Contact.Delete.Success'));
        } catch(err) {
          console.error('[PhantomChat] failed to delete contact:', err);
          toggle();
          toast(i18n('Contact.Delete.Failed'));
        }
      }, {listenerSetter: this.listenerSetter});

      section.content.append(btnDelete);

      this.scrollable.append(section.container);
    } else if(
      privacy.some((privacyRule) => privacyRule._ === 'privacyValueDisallowAll') &&
      !privacy.some((privacyRule) => privacyRule._ === 'privacyValueAllowUsers' && privacyRule.users.includes(userId))
    ) {
      const section = new SettingSection({
        caption: 'NewContact.Exception.ShareMyPhoneNumber.Desc',
        captionArgs: [await wrapPeerTitle({peerId: this.peerId})]
      });
      const checkboxField = this.sharePhoneCheckboxField = new CheckboxField({
        text: 'NewContact.Exception.ShareMyPhoneNumber',
        checked: true
      });
      const row = CreateRowFromCheckboxField(checkboxField);

      section.content.append(row.container);

      this.scrollable.append(section.container);
    }

    attachClickEvent(this.editPeer.nextBtn, async() => {
      this.editPeer.nextBtn.disabled = true;

      try {
        // PhantomChat P2P peers are synthetic (no Telegram backend), so the
        // stock contacts.addContact path no-ops against the virtual-MTProto
        // server and the rename silently reverts. Drive the working P2P
        // rename primitives instead.
        const {isP2PPeer} = await import('@lib/phantomchat/phantomchat-bridge');
        if(isP2PPeer(Number(userId))) {
          const {renameP2PContact} = await import('@lib/phantomchat/rename-p2p-contact');
          if(this.nameInputField.isChanged()) {
            await renameP2PContact(Number(userId), this.nameInputField.value, '');
          }
        } else {
          await this.managers.appUsersManager.addContact(
            userId,
            this.nameInputField.value,
            '',
            (await this.managers.appUsersManager.getUser(userId)).phone,
            this.sharePhoneCheckboxField?.checked
          )
        }
      } catch(error) {
        console.error(error)
        toastNew({langPackKey: 'Error.AnError'});
        return
      }

      this.editPeer.nextBtn.removeAttribute('disabled');
      this.close();
      appSidebarRight.toggleSidebar(false);
    }, {listenerSetter: this.listenerSetter});
  }

  protected onClose() {
    // Closing the right sidebar selects the CHAT tab; over the Contacts list
    // on a phone there is no chat behind the pane, so go back to the list.
    if(this.overContactsList) {
      void import('@lib/appImManager').then(({default: appImManager, APP_TABS}) => appImManager.selectTab(APP_TABS.CHATLIST));
    }
  }
}

/**
 * A click on a contact in the Contacts list. On a wide screen the chat opens
 * in the middle and the Edit pane to its right; the Contacts list stays open
 * on the left. On a phone the Edit pane takes over the screen with a back
 * arrow that returns to the list. Clicking another contact replaces the pane.
 */
export async function openContactEditor(peerId: PeerId): Promise<void> {
  const [{default: mediaSizes}, {default: appImManager}] = await Promise.all([
    import('@helpers/mediaSizes'),
    import('@lib/appImManager')
  ]);
  const overList = mediaSizes.isMobile;

  const existing = appSidebarRight.getTab(AppEditContactTab);
  if(existing) existing.close();

  if(!overList) await appImManager.setInnerPeer({peerId});

  const tab = appSidebarRight.createTab(AppEditContactTab, true);
  tab.peerId = peerId;
  tab.overContactsList = overList;
  // open() before showing the sidebar: an empty history makes toggleSidebar
  // fall back to the native peer-info tab (see openAddContactPane).
  await tab.open();
  appSidebarRight.toggleSidebar(true);
}
