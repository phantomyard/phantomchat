import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import InputField from '@components/inputField';
import ButtonCorner from '@components/buttonCorner';
import Button from '@components/button';
import AvatarEdit from '@components/avatarEdit';
import {avatarNew} from '@components/avatarNew';
import {replaceButtonIcon} from '@components/button';
import toggleDisability from '@helpers/dom/toggleDisability';
import AppAddMembersTab from '@components/sidebarLeft/tabs/addMembers';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import confirmationPopup from '@components/confirmationPopup';
import {getGroupAPI} from '@lib/phantomchat/group-api';
import {getGroupStore} from '@lib/phantomchat/group-store';
import {getAllMappings} from '@lib/phantomchat/virtual-peers-db';
import {BlossomClient} from '@lib/phantomchat/blossom-client';
import rootScope from '@lib/rootScope';
import {i18n, LangPackKey} from '@lib/langPack';
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

    // Determine own pubkey for admin check. The canonical runtime source is
    // window.__phantomchatOwnPubkey (set once onboarding completes, see
    // bridge-invariants Rule 4). loadIdentity() reads an IndexedDB store that
    // production code never writes, so it returns null in real sessions and
    // silently demoted group admins (FIND: group admin check always false).
    const ownPubkey: string | null =
      (window as {__phantomchatOwnPubkey?: string}).__phantomchatOwnPubkey ?? null;

    const isAdmin = ownPubkey === group.adminPubkey;
    const originalMembers = [...group.members];
    let draftMembers = [...originalMembers];
    let refreshSave = () => {};
    let renderMembers = () => {};

    // Commit the current member diff through GroupAPI. Shared by the check
    // button (staged changes from the per-row X buttons) and the member
    // picker's apply arrow, so both paths persist identically.
    const applyMemberChanges = async() => {
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
    };

    // Avatar section: click to change (admin only). Uploads the cropped image
    // to Blossom (public URL) and broadcasts it via updateGroupInfo so every
    // member's client picks it up. Non-admins see the current avatar.
    const avatarSection = new SettingSection({noDelimiter: true});
    const avatarWrap = document.createElement('div');
    avatarWrap.classList.add('avatar-edit');
    avatarSection.content.append(avatarWrap);

    let avatarElem: ReturnType<typeof avatarNew>;
    // The avatar element must live inside the click-to-change host when the
    // viewer is admin (avatarEdit.container), otherwise directly in the wrap
    // — and it must keep rendering into that host on every re-render, or the
    // first avatar change leaves the edit overlay empty.
    let avatarHost: HTMLElement = avatarWrap;
    const renderAvatarPreview = () => {
      avatarElem?.node.remove();
      avatarElem = avatarNew({
        middleware: this.middlewareHelper.get(),
        size: 120,
        peerId: this.groupPeerId.toPeerId(true)
      });
      avatarElem.node.classList.add('avatar-placeholder');
      avatarHost.append(avatarElem.node);
    };
    renderAvatarPreview();

    if(isAdmin) {
      const avatarEdit = new AvatarEdit(async(_upload, blob) => {
        try {
          const client = new BlossomClient();
          const descriptor = await client.upload(await blob.arrayBuffer(), blob.type || 'image/jpeg');
          await getGroupAPI().updateGroupInfo(this.groupId, {avatar: descriptor.url});
          renderAvatarPreview();
        } catch(err) {
          console.error('[PhantomChatGroupEdit] avatar upload failed:', err);
          toastNew({langPackKey: 'Error.AnError'});
        }
      });
      avatarHost = avatarEdit.container;
      avatarEdit.container.append(avatarElem.node);
      avatarWrap.append(avatarEdit.container);
      avatarEdit.container.title = i18n('PhantomChat.GroupEdit.ChangePhoto').textContent;
    }

    this.scrollable.append(avatarSection.container);

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

      // Save only appears when something actually changed (name, description
      // or a staged member removal via the per-row X) AND the name is
      // non-empty — a visible button that silently does nothing on click is
      // worse than a hidden one. The picker's arrow commits immediately, so
      // it re-hides the button via refreshSave too.
      refreshSave = () => {
        const {added, removed} = getGroupMemberChanges(originalMembers, draftMembers);
        const dirty = !!nameInput.value.trim() &&
          (nameInput.value.trim() !== group.name ||
          (descInput.value.trim() || undefined) !== group.description ||
          added.length > 0 || removed.length > 0);
        saveBtn.classList.toggle('is-visible', dirty);
      };
      this.listenerSetter.add(nameInput.input)('input', refreshSave);
      this.listenerSetter.add(descInput.input)('input', refreshSave);

      attachClickEvent(saveBtn, async() => {
        const name = nameInput.value.trim();
        if(!name) return;
        const toggle = toggleDisability([saveBtn], true);
        try {
          await applyMemberChanges();
          const description = descInput.value.trim() || undefined;
          if(name !== group.name || description !== group.description) {
            await getGroupAPI().updateGroupInfo(this.groupId, {name, description});
          }
          group.name = name;
          group.description = description;
          group.members = [...draftMembers];

          // Close the editor on save: an empty screen where the pane was
          // reads as "saved", whereas staying open reads as "nothing happened".
          this.close();
          appSidebarRight.toggleSidebar(false);
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
      name: 'GroupMembers'
    });

    // Build one member row (admin-only remove handler). Reused for the initial
    // roster AND for members added live via "Add Members" below. Removal is an
    // explicit per-row button with a confirmation, not a hidden row click.
    const appendMemberRow = (pubkey: string) => {
      const displayName = mappingByPubkey.get(pubkey) || 'P2P ' + pubkey.slice(0, 6).toUpperCase();
      const isAdminMember = pubkey === group.adminPubkey;

      const rowOptions: ConstructorParameters<typeof Row>[0] = {
        title: displayName,
        subtitleLangKey: isAdminMember ? 'PhantomChat.GroupEdit.AdminSubtitle' : undefined,
        listenerSetter: this.listenerSetter
      };

      // Admin can manage non-admin members: explicit per-row buttons for
      // admin transfer and removal (no hidden gestures).
      if(isAdmin && !isAdminMember) {
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;align-items:center;gap:.25rem;';

        const makeAdminBtn = Button('btn-icon btn-transparent', {icon: 'person'});
        makeAdminBtn.title = i18n('PhantomChat.GroupEdit.MakeAdmin').textContent;
        attachClickEvent(makeAdminBtn, async() => {
          let cancelled = false;
          try {
            await confirmationPopup({
              descriptionLangKey: 'PhantomChat.GroupEdit.MakeAdminDescription' as LangPackKey,
              descriptionLangArgs: [displayName],
              button: {langKey: 'PhantomChat.GroupEdit.MakeAdmin' as LangPackKey}
            });
          } catch{
            cancelled = true;
          }
          if(cancelled) return;
          try {
            await getGroupAPI().transferAdmin(this.groupId, pubkey);
            group.adminPubkey = pubkey;
            renderMembers();
          } catch(err) {
            console.error('[PhantomChatGroupEdit] admin transfer failed:', err);
            toastNew({langPackKey: 'Error.AnError'});
          }
        }, {listenerSetter: this.listenerSetter});

        const removeBtn = Button('btn-icon btn-transparent danger', {icon: 'close'});
        attachClickEvent(removeBtn, async() => {
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
        actions.append(makeAdminBtn, removeBtn);
        rowOptions.buttonRight = actions;
      }

      const row = new Row(rowOptions);
      membersSection.content.append(row.container);
    };

    renderMembers = () => {
      membersSection.content.replaceChildren();
      for(const pubkey of draftMembers) appendMemberRow(pubkey);
      if(isAdmin) membersSection.content.append(addRow.container);
    };

    let addRow: Row;
    if(isAdmin) {
      addRow = new Row({
        titleLangKey: 'PhantomChat.GroupEdit.GroupMembers',
        clickable: true,
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
          title: 'PhantomChat.GroupEdit.GroupMembers',
          placeholder: 'SendMessageTo' as LangPackKey,
          selectedPeerIds,
          takeOutOnClose: true,
          takeOut: async(peerIds: PeerId[]) => {
            const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
            const resolved = await Promise.all(peerIds.map((pid) => getPubkey(+pid)));
            const selected = resolved.filter((pk): pk is string => !!pk);
            const unmappedMembers = draftMembers.filter((pubkey) => !mappingByPubkey.has(pubkey));
            draftMembers = Array.from(new Set([...selected, ...unmappedMembers, group.adminPubkey]));
            // Commit FIRST, render AFTER: the roster must never show members
            // that were not actually persisted. On failure the rejection
            // propagates to the picker's attachToPromise (which stops the
            // loader and closes the tab — its only working close affordance
            // is the close itself), and the draft resyncs from what really
            // landed in the store before the editor re-renders.
            try {
              await applyMemberChanges();
            } catch(err) {
              console.error('[PhantomChatGroupEdit] member change from picker failed:', err);
              try {
                const fresh = await getGroupStore().get(this.groupId);
                draftMembers = [...(fresh?.members ?? originalMembers)];
                originalMembers.splice(0, originalMembers.length, ...draftMembers);
              } catch{}
              renderMembers();
              refreshSave();
              toastNew({langPackKey: 'Error.AnError'});
              throw err;
            }
            renderMembers();
            // The picker's arrow is the apply affordance members expect: it
            // commits the membership change right away instead of waiting
            // for the editor's check button.
            refreshSave();
          }
        });
      }, {listenerSetter: this.listenerSetter});
    }

    renderMembers();
    this.scrollable.append(membersSection.container);

    // Leave group section. Danger actions use the same full-width red Button
    // as the contact editor (editContact.ts) so both editors share one
    // design language (Row has no danger styling of its own).
    const leaveSection = new SettingSection({noDelimiter: true});

    const btnLeave = Button('btn-primary btn-transparent danger', {icon: 'delete', text: 'ChatList.Context.LeaveGroup'});

    // Admins can't leave: they must transfer admin (or delete the group).
    // Grey the button out and explain why on hover.
    if(isAdmin) {
      btnLeave.disabled = true;
      btnLeave.title = i18n('PhantomChat.GroupEdit.AdminLeaveHint' as LangPackKey).textContent;
    }

    attachClickEvent(btnLeave, async() => {
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

    leaveSection.content.append(btnLeave);

    // Admin-only: delete the group for EVERYONE (no restrictions). Broadcasts a
    // group_delete so other members' clients drop it too, then tears it down
    // locally. Non-admins only get "Leave Group" above.
    if(isAdmin) {
      const btnDelete = Button('btn-primary btn-transparent danger', {icon: 'delete', text: 'PhantomChat.GroupEdit.DeleteGroup' as LangPackKey});

      attachClickEvent(btnDelete, async() => {
        try {
          await confirmationPopup({
            titleLangKey: 'PhantomChat.GroupEdit.DeleteGroup' as LangPackKey,
            descriptionLangKey: 'PhantomChat.GroupEdit.DeleteGroupDescription' as LangPackKey,
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

      leaveSection.content.append(btnDelete);
    }

    this.scrollable.append(leaveSection.container);
  }
}
