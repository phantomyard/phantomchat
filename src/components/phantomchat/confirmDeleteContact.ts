/**
 * The one confirm dialog for deleting a contact, used by the Contacts list
 * context menu and the Edit pane. Small on purpose: "Delete Name?" and one
 * line saying it goes from every device (and, for a Provider contact, that its
 * local AI data goes too). Resolves true only when Delete is pressed.
 *
 * confirmationPopup owns the button callback (it resolves the promise), so the
 * delete runs AFTER this resolves, never inside a callback: a callback passed
 * to confirmationPopup is overwritten and never runs, which is how the
 * context-menu delete silently did nothing.
 */
import confirmationPopup from '@components/confirmationPopup';
import getPeerTitle from '@components/wrappers/getPeerTitle';
import {getContactPrefs} from '@lib/phantomchat/contact-prefs';
import {getPubkey} from '@lib/phantomchat/virtual-peers-db';

export default async function confirmDeleteContact(peerId: PeerId): Promise<boolean> {
  const [name, isProvider] = await Promise.all([
    getPeerTitle({peerId, plainText: true}).catch((): string => ''),
    getPubkey(Number(peerId))
    .then((pubkey) => pubkey ? getContactPrefs(pubkey) : undefined)
    .then((prefs) => prefs?.kind === 'provider')
    .catch(() => false)
  ]);

  try {
    await confirmationPopup({
      titleLangKey: 'Contact.Delete.ConfirmTitle',
      titleLangArgs: [name || 'contact'],
      descriptionLangKey: isProvider ? 'Contact.Delete.ConfirmDescProvider' : 'Contact.Delete.ConfirmDesc',
      button: {langKey: 'Delete', isDanger: true}
    });
    return true;
  } catch{
    return false;
  }
}
