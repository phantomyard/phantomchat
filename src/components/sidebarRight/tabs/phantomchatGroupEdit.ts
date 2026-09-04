import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import InputField from '@components/inputField';
import ButtonCorner from '@components/buttonCorner';
import {replaceButtonIcon} from '@components/button';
import toggleDisability from '@helpers/dom/toggleDisability';
import AppAddMembersTab from '@components/sidebarLeft/tabs/addMembers';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import confirmationPopup from '@components/confirmationPopup';
import {getGroupAPI} from '@lib/phantomchat/group-api';
import {getGroupStore} from '@lib/phantomchat/group-store';
import {getAllMappings} from '@lib/phantomchat/virtual-peers-db';
import {loadIdentity} from '@lib/phantomchat/identity';
import rootScope from '@lib/rootScope';
import type {LangPackKey} from '@lib/langPack';
import {toastNew} from '@components/toast';
import appSidebarRight from '..';
import {getGroupMemberChanges} from './phantomchatGroupEditState';

export default class AppPhantomChatGroupEditTab extends SliderSuperTab {
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
    this.container.classList.add('edit-peer-container', 'phantomchat-group-edit-container');
    this.setTitle('Edit');

    const newCloseBtn = this.closeBtn.cloneNode(true) as HTMLElement;
    this.closeBtn.replaceWith(newCloseBtn);
    this.closeBtn = newCloseBtn;
    replaceButtonIcon(this.closeBtn, 'close');
    attachClickEvent(this.closeBtn, () => {
      this.close();
      appSidebarRight.toggleSidebar(false);
    }, {listenerSetter: this.listenerSetter});

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
    const originalMembers = [...group.members];
    let draftMembers = [...originalMembers];
    let refreshSave = () => {};
    let renderMembers = () => {};

    // Admin-only: edit group name + description. This replaces the native
    // Telegram AppEditChatTab for P2P groups (which is Telegram-backed — its
    // Administrators/Members/Permissions sub-tabs query a server that doesn't
    // exist and render the empty "No Results" state). updateGroupInfo broadcasts
    // the change to members and refreshes the chat-list/topbar title.
    if(isAdmin) {
      const editSection = new SettingSection({});
      const inputWrapper = document.createElement('div');
      inputWrapper.classList.add('input-wrapper');

      const nameInput = new InputField({label: 'CreateGroup.NameHolder', maxLength: 128});
      nameInput.setOriginalValue(group.name);

      const descInput = new InputField({label: 'DescriptionPlaceholder', maxLength: 255});
      if(group.description) descInput.setOriginalValue(group.description);

      inputWrapper.append(nameInput.container, descInput.container);
      editSection.content.append(inputWrapper);

      const saveBtn = ButtonCorner({icon: 'check'});
      this.content.append(saveBtn);

      refreshSave = () => {
        const name = nameInput.value.trim();
        const desc = descInput.value.trim();
        const {added, removed} = getGroupMemberChanges(originalMembers, draftMembers);
        const changed = name !== group.name || desc !== (group.description || '') || !!added.length || !!removed.length;
        saveBtn.classList.toggle('is-visible', changed && !!name);
      };
      this.listenerSetter.add(nameInput.input)('input', refreshSave);
      this.listenerSetter.add(descInput.input)('input', refreshSave);

      attachClickEvent(saveBtn, async() => {
        const name = nameInput.value.trim();
        if(!name) return;
        const toggle = toggleDisability([saveBtn], true);
        try {
          const api = getGroupAPI();
          const {added, removed} = getGroupMemberChanges(originalMembers, draftMembers);
          for(const pubkey of removed) {
            await api.removeMember(this.groupId, pubkey);
            originalMembers.splice(originalMembers.indexOf(pubkey), 1);
          }
          for(const pubkey of added) {
            await api.addMember(this.groupId, pubkey);
            originalMembers.push(pubkey);
          }
          const description = descInput.value.trim() || undefined;
          if(name !== group.name || description !== group.description) {
            await api.updateGroupInfo(this.groupId, {name, description});
          }
          group.name = name;
          group.description = description;
          group.members = [...draftMembers];
          saveBtn.classList.remove('is-visible');
        } catch(err) {
          console.error('[PhantomChatGroupEdit] save failed:', err);
          toastNew({langPackKey: 'Error.AnError'});
        } finally {
          toggle();
          refreshSave();
        }
      }, {listenerSetter: this.listenerSetter});

      this.scrollable.append(editSection.container);
    }

    // Members section
    const membersSection = new SettingSection({
      name: 'Members' as LangPackKey
    });

    // Build one member row (admin-only remove handler). Reused for the initial
    // roster AND for members added live via "Add Members" below.
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
            draftMembers = draftMembers.filter((member) => member !== pubkey);
            renderMembers();
            refreshSave();
          } catch{
            // user cancelled
          }
        }, {listenerSetter: this.listenerSetter});
      }

      membersSection.content.append(row.container);
    };

    renderMembers = () => {
      membersSection.content.replaceChildren();
      for(const pubkey of draftMembers) appendMemberRow(pubkey);
      if(isAdmin) membersSection.content.append(addRow.container);
    };

    let addRow: Row;
    if(isAdmin) {
      const addEl = document.createElement('span');
      addEl.style.color = 'var(--primary-color)';
      addEl.textContent = 'Add or Remove Members';

      addRow = new Row({
        title: addEl,
        listenerSetter: this.listenerSetter
      });

      attachClickEvent(addRow.container, () => {
        const selectedPeerIds = draftMembers
        .map((pubkey) => allMappings.find((mapping) => mapping.pubkey === pubkey)?.peerId)
        .filter((peerId): peerId is number => peerId !== undefined)
        .map((peerId) => peerId.toPeerId());
        this.slider.createTab(AppAddMembersTab).open({
          type: 'chat',
          skippable: false,
          title: 'GroupAddMembers' as LangPackKey,
          placeholder: 'SendMessageTo' as LangPackKey,
          selectedPeerIds,
          takeOut: async(peerIds: PeerId[]) => {
            const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
            const resolved = await Promise.all(peerIds.map((pid) => getPubkey(+pid)));
            const selected = resolved.filter((pk): pk is string => !!pk);
            const unmappedMembers = draftMembers.filter((pubkey) => !mappingByPubkey.has(pubkey));
            draftMembers = Array.from(new Set([...selected, ...unmappedMembers, group.adminPubkey]));
            renderMembers();
            refreshSave();
          }
        });
      }, {listenerSetter: this.listenerSetter});
    }

    renderMembers();
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
