import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import confirmationPopup from '@components/confirmationPopup';
import {getGroupAPI} from '@lib/nostra/group-api';
import {getGroupStore} from '@lib/nostra/group-store';
import {getAllMappings} from '@lib/nostra/virtual-peers-db';
import {loadIdentity} from '@lib/nostra/identity';
import rootScope from '@lib/rootScope';
import type {LangPackKey} from '@lib/langPack';

export default class AppNostraGroupInfoTab extends SliderSuperTab {
  public groupPeerId: number;
  private groupId: string;

  public async init() {
    const store = getGroupStore();
    const group = await store.getByPeerId(this.groupPeerId);
    if(!group) {
      this.setTitle('Group' as LangPackKey);
      return;
    }

    this.groupId = group.groupId;
    this.container.classList.add('nostra-group-info-container');
    this.setTitle(group.name as LangPackKey);

    // Load member display names
    const allMappings = await getAllMappings();
    const mappingByPubkey = new Map(
      allMappings.map(m => [m.pubkey, m.displayName || 'P2P ' + m.pubkey.slice(0, 6).toUpperCase()])
    );

    // Determine own pubkey for admin check
    let ownPubkey: string | null = null;
    try {
      const identity = await loadIdentity();
      ownPubkey = identity?.publicKey ?? null;
    } catch{
      // identity not available
    }

    const isAdmin = ownPubkey === group.adminPubkey;

    // Members section
    const membersSection = new SettingSection({
      name: 'Members' as LangPackKey
    });

    for(const pubkey of group.members) {
      const displayName = mappingByPubkey.get(pubkey) || 'P2P ' + pubkey.slice(0, 6).toUpperCase();
      const isAdminMember = pubkey === group.adminPubkey;

      const row = new Row({
        title: displayName,
        subtitle: isAdminMember ? 'admin' : undefined,
        listenerSetter: this.listenerSetter
      });

      // Admin can remove non-admin members
      if(isAdmin && !isAdminMember) {
        attachClickEvent(row.container, async() => {
          try {
            await confirmationPopup({
              descriptionLangKey: 'Permissions.RemoveFromGroup' as LangPackKey,
              descriptionLangArgs: [displayName],
              button: {langKey: 'Remove' as LangPackKey, isDanger: true}
            });
            await getGroupAPI().removeMember(this.groupId, pubkey);
            row.container.remove();
          } catch{
            // user cancelled
          }
        }, {listenerSetter: this.listenerSetter});
      }

      membersSection.content.append(row.container);
    }

    this.scrollable.append(membersSection.container);

    // Leave group section
    const leaveSection = new SettingSection({noDelimiter: true});

    const leaveEl = document.createElement('span');
    leaveEl.style.color = 'var(--danger-color)';
    leaveEl.textContent = 'Leave Group';

    const leaveRow = new Row({
      title: leaveEl,
      listenerSetter: this.listenerSetter
    });

    attachClickEvent(leaveRow.container, async() => {
      try {
        await confirmationPopup({
          titleLangKey: 'ChatList.Context.LeaveGroup' as LangPackKey,
          button: {langKey: 'ChatList.Context.LeaveGroup' as LangPackKey, isDanger: true}
        });
        await getGroupAPI().leaveGroup(this.groupId);

        // Remove group dialog from chat list
        try {
          const dialogsStorage = (rootScope.managers as any).dialogsStorage;
          if(dialogsStorage?.dropP2PDialog) {
            await dialogsStorage.dropP2PDialog(this.groupPeerId.toPeerId(true));
          }
        } catch{/* ignore */}
        rootScope.dispatchEvent('dialog_drop', {peerId: this.groupPeerId.toPeerId(true)} as any);

        this.close();
      } catch{
        // user cancelled
      }
    }, {listenerSetter: this.listenerSetter});

    leaveSection.content.append(leaveRow.container);
    this.scrollable.append(leaveSection.container);
  }
}
