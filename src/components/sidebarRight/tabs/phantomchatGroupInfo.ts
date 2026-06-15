import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import AppAddMembersTab from '@components/sidebarLeft/tabs/addMembers';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import confirmationPopup from '@components/confirmationPopup';
import {getGroupAPI} from '@lib/phantomchat/group-api';
import {getGroupStore} from '@lib/phantomchat/group-store';
import {getAllMappings} from '@lib/phantomchat/virtual-peers-db';
import {loadIdentity} from '@lib/phantomchat/identity';
import rootScope from '@lib/rootScope';
import type {LangPackKey} from '@lib/langPack';

export default class AppPhantomChatGroupInfoTab extends SliderSuperTab {
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
    this.container.classList.add('phantomchat-group-info-container');
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

    // Build one member row (admin-only remove handler). Reused for the initial
    // roster AND for members added live via "Add Members" below.
    const renderedMembers = new Set<string>();
    const appendMemberRow = (pubkey: string) => {
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
            renderedMembers.delete(pubkey);
          } catch{
            // user cancelled
          }
        }, {listenerSetter: this.listenerSetter});
      }

      membersSection.content.append(row.container);
      renderedMembers.add(pubkey);
    };

    for(const pubkey of group.members) {
      appendMemberRow(pubkey);
    }

    // Admin can ADD members after creation (addMember is admin-only). Opens the
    // contacts picker; selected peers are mapped back to pubkeys and added one
    // by one, with their rows appended live.
    if(isAdmin) {
      const addEl = document.createElement('span');
      addEl.style.color = 'var(--primary-color)';
      addEl.textContent = 'Add Members';

      const addRow = new Row({
        title: addEl,
        listenerSetter: this.listenerSetter
      });

      attachClickEvent(addRow.container, () => {
        this.slider.createTab(AppAddMembersTab).open({
          type: 'chat',
          skippable: false,
          title: 'GroupAddMembers' as LangPackKey,
          placeholder: 'SendMessageTo' as LangPackKey,
          takeOut: async(peerIds: PeerId[]) => {
            const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
            const resolved = await Promise.all(peerIds.map((pid) => getPubkey(+pid)));
            const pubkeys = resolved.filter((pk): pk is string => !!pk);
            for(const pk of pubkeys) {
              if(renderedMembers.has(pk)) continue;
              try {
                await getGroupAPI().addMember(this.groupId, pk);
                appendMemberRow(pk);
              } catch(err) {
                console.error('[PhantomChatGroupInfo] addMember failed:', err);
              }
            }
          }
        });
      }, {listenerSetter: this.listenerSetter});

      membersSection.content.append(addRow.container);
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

    // Admin-only: delete the group for EVERYONE (no restrictions). Broadcasts a
    // group_delete so other members' clients drop it too, then tears it down
    // locally. Non-admins only get "Leave Group" above.
    if(isAdmin) {
      const deleteEl = document.createElement('span');
      deleteEl.style.color = 'var(--danger-color)';
      deleteEl.textContent = 'Delete Group';

      const deleteRow = new Row({
        title: deleteEl,
        listenerSetter: this.listenerSetter
      });

      attachClickEvent(deleteRow.container, async() => {
        try {
          await confirmationPopup({
            title: 'Delete Group',
            description: 'Delete this group for everyone? It will be removed for all members and cannot be undone.',
            button: {langKey: 'Delete' as LangPackKey, isDanger: true}
          });
          await getGroupAPI().deleteGroup(this.groupId);

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

      leaveSection.content.append(deleteRow.container);
    }

    this.scrollable.append(leaveSection.container);
  }
}
