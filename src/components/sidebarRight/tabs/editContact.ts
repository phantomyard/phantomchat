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
import PopupPeer from '@components/popups/peer';
import PopupElement, {addCancelButton} from '@components/popups';
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
    replaceButtonIcon(this.closeBtn, 'close');

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
      this.localToolsCheckboxField = contactPubkey && prefsMod.kindSupportsLocalTools(contactKind) ?
        new CheckboxField({text: 'ContactLocalTools', checked: !!prefs?.localTools}) :
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
        const div = document.createElement('div');
        div.classList.add('avatar-edit');
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
          field.input.addEventListener('change', (e) => {
            if(!e.isTrusted) return;
            prefsMod.setContactPrefs(pubkey, {localTools: field.checked}).catch((err) => {
              console.error('[PhantomChat] failed to save Local tools', err);
              field.checked = !field.checked;
              toastNew({langPackKey: 'Error.AnError'});
            });
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

      attachClickEvent(btnDelete, () => {
        PopupElement.createPopup(PopupPeer, 'popup-delete-contact', {
          peerId: peerId,
          titleLangKey: 'DeleteContact',
          descriptionLangKey: 'AreYouSureDeleteContact',
          buttons: addCancelButton([{
            langKey: 'Delete',
            callback: async() => {
              const toggle = toggleDisability([btnDelete], true);

              try {
                const isP2P = isP2PPeerId(Number(userId));
                if(isP2P) {
                  const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
                  const pubkey = await getPubkey(Number(userId));
                  if(!pubkey) {
                    toggle();
                    toast(i18n('Contact.Delete.CouldNotResolve'));
                    return;
                  }

                  const chatAPI = (window as any).__phantomchatChatAPI;
                  if(!chatAPI?.deleteConversation) {
                    toggle();
                    toast(i18n('Contact.Delete.ChatNotReady'));
                    return;
                  }

                  await chatAPI.deleteConversation(pubkey);
                  const {clearContactPrefs} = await import('@lib/phantomchat/contact-prefs');
                  await clearContactPrefs(pubkey);
                } else {
                  if(userId) {
                    await this.managers.appUsersManager.deleteContacts([userId]);
                  }
                  await rootScope.managers.appMessagesManager.flushHistory({peerId, justClear: false, revoke: true});
                }

                // Ensure UI removes active chat & dialog everywhere
                rootScope.dispatchEvent('dialog_drop', {peerId} as any);

                this.close();
                appSidebarRight.toggleSidebar(false);
                toast(i18n('Contact.Delete.Success'));
              } catch(err) {
                console.error('[PhantomChat] failed to delete contact:', err);
                toggle();
                toast(i18n('Contact.Delete.Failed'));
              }
            },
            isDanger: true
          }])
        }).show();
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
}
