/*
 * PhantomChat.chat — rename a session (owner batch 11)
 *
 * Sessions deliberately have NO edit dialog: the whole object is a name, one
 * phantom member and its history, so the only mutable field a user can reach is
 * the title. This is that one field, as a single-input popup.
 */

import InputField from '@components/inputField';
import PopupElement from '.';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toastNew} from '@components/toast';

export default class PopupRenameSession extends PopupElement {
  constructor(private groupId: string, currentTitle: string) {
    super('popup-create-contact popup-send-photo popup-new-media', {
      closable: true,
      withConfirm: 'Save',
      title: 'Edit'
    });
    this.construct(currentTitle);
  }

  private construct(currentTitle: string) {
    const inputField = new InputField({
      label: 'SessionName',
      name: 'rename-session',
      maxLength: 64,
      required: true
    });
    inputField.value = currentTitle;
    inputField.container.classList.add('input-field-name');

    this.container.append(inputField.container);

    const submit = async() => {
      const name = inputField.value.trim();
      if(!name) return false;

      try {
        const {getGroupAPI} = await import('@lib/phantomchat/group-api');
        await getGroupAPI().renameGroup(this.groupId, name);
        this.hide();
        return true;
      } catch(err) {
        console.error('[PhantomChat.chat] rename session failed:', err);
        toastNew({langPackKey: 'SessionActionFailed'});
        return false;
      }
    };

    attachClickEvent(this.btnConfirm, () => {
      void submit();
    }, {listenerSetter: this.listenerSetter});

    this.listenerSetter.add(inputField.input)('keydown', (e) => {
      if(e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    });

    this.show();
  }
}
