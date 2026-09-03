/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {SliderSuperTab} from '@components/slider';
import appDialogsManager, {DIALOG_LIST_ELEMENT_TAG} from '@lib/appDialogsManager';
import InputSearch from '@components/inputSearch';
import {IS_MOBILE} from '@environment/userAgent';
import {canFocus} from '@helpers/dom/canFocus';
import windowSize from '@helpers/windowSize';
import ButtonCorner from '@components/buttonCorner';
import Icon from '@components/icon';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import SortedUserList from '@components/sortedUserList';
import {getMiddleware} from '@helpers/middleware';
import replaceContent from '@helpers/dom/replaceContent';
import rootScope from '@lib/rootScope';
import {getAllMappings} from '@lib/phantomchat/virtual-peers-db';
import {showAddContactPopup as showAddContactPopupShared} from '@components/popups/addContact';
import {showEditContactPopup} from '@components/popups/editContact';
import createContextMenu from '@helpers/dom/createContextMenu';
import findUpTag from '@helpers/dom/findUpTag';
import confirmationPopup from '@components/confirmationPopup';
import wrapPeerTitle from '@components/wrappers/peerTitle';
import styles from './contacts.module.scss';

// TODO: поиск по людям глобальный, если не нашло в контактах никого

export default class AppContactsTab extends SliderSuperTab {
  public static noSame = true;
  private inputSearch: InputSearch;
  private middlewareHelperLoad: ReturnType<typeof getMiddleware>;
  private sortedUserList: SortedUserList;
  private listsContainer: HTMLElement;

  // Multi-select & batch delete state
  private selectedPeerIds = new Set<PeerId>();
  private headerWrap: HTMLElement;
  private headerDeleteBtn: HTMLButtonElement;

  public init() {
    this.container.id = 'contacts-container';

    // this.list = appDialogsManager.createChatList(/* {avatarSize: 48, handheldsSize: 66} */);

    const btnAdd = ButtonCorner({icon: 'add', className: 'is-visible'});
    this.content.append(btnAdd);

    attachClickEvent(btnAdd, () => {
      this.showAddContactPopup();
    }, {listenerSetter: this.listenerSetter});

    this.inputSearch = new InputSearch({
      placeholder: 'Search',
      onChange: (value) => {
        // [PhantomChat.chat] Detect npub paste and open P2P chat
        if(value && value.trim().startsWith('npub1') && value.trim().length >= 60) {
          this.handleNpubInput(value.trim());
          return;
        }
        this.openContacts(value);
      }
    });

    this.listenerSetter.add(rootScope)('contacts_update', async(userId) => {
      const isContact = await this.managers.appUsersManager.isContact(userId);
      const peerId = userId.toPeerId();
      if(isContact) {
        this.sortedUserList.add(peerId);
        this.decorateContactElement(peerId);
      } else {
        this.sortedUserList.delete(peerId);
      }
    });

    // Header wrap with search input and dynamic red Delete button
    const headerWrap = this.headerWrap = document.createElement('div');
    headerWrap.classList.add(styles.contactsHeaderWrap);

    this.inputSearch.container.classList.add(styles.contactsHeaderSearch);
    headerWrap.append(this.inputSearch.container);

    const headerDeleteBtn = this.headerDeleteBtn = document.createElement('button');
    headerDeleteBtn.type = 'button';
    headerDeleteBtn.classList.add(styles.headerDeleteBtn);
    headerDeleteBtn.title = 'Delete selected contacts';
    headerDeleteBtn.style.display = 'none'; // Only appears if any check box is ticked
    headerDeleteBtn.append(Icon('delete'), document.createTextNode(' Delete'));
    attachClickEvent(headerDeleteBtn, () => {
      this.confirmBatchDeleteSelected();
    }, {listenerSetter: this.listenerSetter});
    headerWrap.append(headerDeleteBtn);

    this.title.replaceWith(headerWrap);

    this.middlewareHelperLoad = getMiddleware();

    const listsContainer = this.listsContainer = document.createElement('div');
    this.scrollable.append(listsContainer);

    this.openContacts();

    // preload contacts
    // appUsersManager.getContacts();
  }

  private togglePeerSelection(peerId: PeerId, checkBtn?: HTMLElement) {
    if(this.selectedPeerIds.has(peerId)) {
      this.selectedPeerIds.delete(peerId);
      checkBtn?.classList.remove(styles.isChecked);
    } else {
      this.selectedPeerIds.add(peerId);
      checkBtn?.classList.add(styles.isChecked);
    }
    this.updateSelectionUI();
  }

  private updateSelectionUI() {
    const count = this.selectedPeerIds.size;
    if(count > 0) {
      this.headerDeleteBtn.style.display = 'inline-flex';
      this.headerDeleteBtn.replaceChildren(Icon('delete'), document.createTextNode(` Delete (${count})`));
    } else {
      this.headerDeleteBtn.style.display = 'none';
    }
  }

  private async confirmBatchDeleteSelected() {
    const count = this.selectedPeerIds.size;
    if(count === 0) return;

    const description = document.createElement('span');
    description.textContent = `Delete ${count} selected contact${count > 1 ? 's' : ''} along with their entire conversation history? This cannot be undone.`;

    try {
      await confirmationPopup({
        title: 'DeleteContacts',
        description,
        button: {
          langKey: 'Delete',
          isDanger: true,
          callback: async() => {
            await this.deleteBatchContactsAndChats();
          }
        }
      });
    } catch{
      // dismissed
    }
  }

  private async deleteBatchContactsAndChats() {
    const {toast} = await import('@components/toast');
    const peersToDelete = Array.from(this.selectedPeerIds);
    let deletedCount = 0;

    for(const peerId of peersToDelete) {
      const sortedUser = (this.sortedUserList as any)?.elements?.get(peerId);
      const listEl = sortedUser?.dom?.listEl as HTMLElement;
      const rawId = Number(listEl?.dataset?.peerId || peerId);
      const success = await this.deleteContactAndChat(peerId, rawId, false);
      if(success !== false) {
        deletedCount++;
      }
    }

    this.selectedPeerIds.clear();
    this.updateSelectionUI();
    toast(`${deletedCount} contact${deletedCount > 1 ? 's' : ''} deleted`);
  }

  protected createList() {
    const sortedUserList = new SortedUserList({
      managers: this.managers,
      middleware: this.middlewareHelper.get()
    });
    const list = sortedUserList.list;
    list.id = 'contacts';
    list.classList.add('contacts-container');
    appDialogsManager.setListClickListener({
      list,
      onFound: (target) => {
        this.close();
      },
      withContext: undefined,
      autonomous: true
    });
    this.attachContactContextMenu(list);
    return sortedUserList;
  }

  /**
   * Decorate a contact row with inline Checkbox, Edit (pencil), and Delete (trash) action buttons.
   */
  private decorateContactElement(peerId: PeerId) {
    const sortedUser = (this.sortedUserList as any)?.elements?.get(peerId);
    if(!sortedUser?.dom?.listEl) return;
    const listEl = sortedUser.dom.listEl as HTMLElement;

    // Avoid duplicate action badges
    if(listEl.querySelector(`.${styles.contactRowActions}`)) return;

    const rawId = Number(listEl.dataset.peerId || peerId);

    const actionsEl = document.createElement('div');
    actionsEl.classList.add(styles.contactRowActions);

    // 1. Check Box
    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.classList.add(styles.contactCheckbox);
    if(this.selectedPeerIds.has(peerId)) {
      checkBtn.classList.add(styles.isChecked);
    }
    checkBtn.title = 'Select contact';
    checkBtn.append(Icon('check'));
    checkBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    attachClickEvent(checkBtn, (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.togglePeerSelection(peerId, checkBtn);
    }, {listenerSetter: this.listenerSetter});

    // 2. Edit badge (pencil)
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.classList.add(styles.actionBadgeBtn, styles.actionBadgeEdit);
    btnEdit.title = 'Edit contact';
    btnEdit.append(Icon('edit'));
    btnEdit.addEventListener('mousedown', (e) => e.stopPropagation());
    attachClickEvent(btnEdit, (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.openEditContact(peerId, rawId);
    }, {listenerSetter: this.listenerSetter});

    // 3. Delete badge (trash can)
    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.classList.add(styles.actionBadgeBtn, styles.actionBadgeDelete);
    btnDelete.title = 'Delete contact';
    btnDelete.append(Icon('delete'));
    btnDelete.addEventListener('mousedown', (e) => e.stopPropagation());
    attachClickEvent(btnDelete, (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.confirmDeleteContactAndChat(peerId, rawId);
    }, {listenerSetter: this.listenerSetter});

    actionsEl.append(checkBtn, btnEdit, btnDelete);
    listEl.append(actionsEl);
  }

  private openEditContact(peerId: PeerId, rawId: number) {
    showEditContactPopup({
      peerId,
      rawId,
      managers: this.managers,
      onSave: () => {
        this.sortedUserList?.update(peerId);
      }
    });
  }

  /**
   * [PhantomChat.chat] Right-click / long-press a contact to delete it along
   * with its whole conversation. P2P peers route through ChatAPI
   * .deleteConversation (3-level cleanup: local messages + tombstone +
   * virtual-peers mapping + peer notification + relay NIP-09), regular
   * MTProto contacts through contacts.deleteContacts + history flush.
   */
  private attachContactContextMenu(list: HTMLUListElement) {
    let targetPeerId: PeerId;
    let targetRawId = 0;

    createContextMenu({
      listenTo: list,
      findElement: (e): HTMLElement => findUpTag(e.target as HTMLElement, DIALOG_LIST_ELEMENT_TAG),
      onOpen: (_e, li) => {
        targetPeerId = (li as HTMLElement).dataset.peerId.toPeerId();
        targetRawId = Number((li as HTMLElement).dataset.peerId);
      },
      buttons: [{
        icon: 'edit',
        text: 'Edit',
        verify: () => !!targetPeerId,
        onClick: () => {
          const peerId = targetPeerId;
          const rawId = targetRawId;
          this.openEditContact(peerId, rawId);
        }
      }, {
        icon: 'delete',
        className: 'danger',
        text: 'DeleteContact',
        verify: () => !!targetPeerId,
        onClick: () => {
          const peerId = targetPeerId;
          const rawId = targetRawId;
          this.confirmDeleteContactAndChat(peerId, rawId);
        }
      }]
    });
  }

  private async confirmDeleteContactAndChat(peerId: PeerId, rawId: number) {
    const peerTitleElement = await wrapPeerTitle({peerId}).catch((): undefined => undefined);

    // Compose the confirmation copy manually: there is no lang-pack key for
    // the combined contact + chat deletion wording, and i18n() renders a
    // missing key verbatim.
    const description = document.createElement('span');
    if(peerTitleElement) {
      description.append(peerTitleElement, document.createTextNode(' '));
    }
    description.append(document.createTextNode('will be deleted along with the entire conversation history. This cannot be undone.'));

    try {
      await confirmationPopup({
        title: 'DeleteContact',
        description,
        button: {
          langKey: 'Delete',
          isDanger: true,
          callback: () => {
            this.deleteContactAndChat(peerId, rawId);
          }
        }
      });
    } catch{
      // cancelled / dismissed — nothing to do
    }
  }

  private async deleteContactAndChat(peerId: PeerId, rawId: number, showToast = true) {
    const {toast} = await import('@components/toast');

    // P2P peers live in the synthetic range (>= 1e15); the raw dataset id is
    // the virtual peer id used for the reverse pubkey lookup.
    const isP2P = rawId >= 1e15;

    try {
      if(isP2P) {
        const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
        const pubkey = await getPubkey(rawId);
        if(!pubkey) {
          if(showToast) toast('Could not resolve contact to delete');
          return false;
        }

        const chatAPI = (window as any).__phantomchatChatAPI;
        if(!chatAPI?.deleteConversation) {
          if(showToast) toast('Chat is not ready yet');
          return false;
        }

        await chatAPI.deleteConversation(pubkey);
      } else {
        await this.managers.appUsersManager.deleteContacts([peerId.toUserId()]);
        await rootScope.managers.appMessagesManager.flushHistory({peerId, justClear: false, revoke: true});
      }

      this.selectedPeerIds.delete(peerId);
      this.updateSelectionUI();
      this.sortedUserList?.delete(peerId);
      if(showToast) toast('Contact deleted');
      return true;
    } catch(err) {
      console.error('[PhantomChat.chat] failed to delete contact:', err);
      if(showToast) toast('Failed to delete contact');
      return false;
    }
  }

  protected onClose() {
    this.middlewareHelperLoad.clean();
    this.selectedPeerIds.clear();
    this.updateSelectionUI();
    /* // need to clear, and left 1 page for smooth slide
    let pageCount = appPhotosManager.windowH / 56 * 1.25 | 0;
    (Array.from(this.list.children) as HTMLElement[]).slice(pageCount).forEach((el) => el.remove()); */
  }

  protected onOpenAfterTimeout() {
    if(IS_MOBILE || !canFocus(true)) return;
    this.inputSearch.input.focus();
  }

  public openContacts(query?: string) {
    this.middlewareHelperLoad.clean();
    const middleware = this.middlewareHelperLoad.get();
    this.scrollable.onScrolledBottom = null;
    this.listsContainer.replaceChildren();
    this.selectedPeerIds.clear();
    this.updateSelectionUI();

    this.managers.appUsersManager.getContactsPeerIds(query, undefined, 'online').then((contacts) => {
      if(!middleware()) {
        return;
      }

      this.renderContactsList(contacts, middleware);
    }).catch(() => {
      // MTProto disabled — load P2P contacts from IndexedDB
      if(!middleware()) return;
      this.loadP2PContacts(query, middleware);
    });
  }

  private renderContactsList(contacts: PeerId[], middleware: () => boolean) {
    const sortedUserList = this.sortedUserList = this.createList();

    let renderPage = () => {
      const pageCount = windowSize.height / 56 * 1.25 | 0;
      const arr = contacts.splice(0, pageCount); // надо splice!

      arr.forEach((peerId) => {
        sortedUserList.add(peerId);
        this.decorateContactElement(peerId);
      });

      if(!contacts.length) {
        renderPage = undefined;
        this.scrollable.onScrolledBottom = null;
      }
    };

    renderPage();
    this.scrollable.onScrolledBottom = () => {
      if(renderPage) {
        renderPage();
      } else {
        this.scrollable.onScrolledBottom = null;
      }
    };

    replaceContent(this.listsContainer, sortedUserList.list);
  }

  private async loadP2PContacts(query: string | undefined, middleware: () => boolean) {
    try {
      const allMappings = await getAllMappings();
      if(!middleware()) return;

      // Backstop against delete-boomerang: even though the delete paths now call
      // removeMapping, drop any peer whose conversation carries a tombstone. This
      // keeps a deleted contact from reappearing if a stale mapping survives (e.g.
      // re-injected by an in-flight relay event between delete and reload).
      let mappings = allMappings;
      try {
        const {loadIdentity} = await import('@lib/phantomchat/identity');
        const identity = await loadIdentity();
        const ownPubkey = identity?.publicKey ?? null;
        if(ownPubkey) {
          const {getMessageStore} = await import('@lib/phantomchat/message-store');
          const store = getMessageStore();
          const checks = await Promise.all(allMappings.map(async(m) => {
            try {
              const conversationId = store.getConversationId(ownPubkey, m.pubkey);
              const deletedAt = await store.getTombstone(conversationId);
              return deletedAt > 0;
            } catch{
              return false;
            }
          }));
          mappings = allMappings.filter((_, i) => !checks[i]);
        }
      } catch(err) {
        console.warn('[PhantomChat.chat] tombstone backstop skipped:', err);
      }
      if(!middleware()) return;

      const lowerQuery = query?.toLowerCase();
      const filtered = lowerQuery ?
        mappings.filter((m) => (m.displayName || m.pubkey).toLowerCase().includes(lowerQuery)) :
        mappings;

      if(!filtered.length) {
        const emptyEl = document.createElement('div');
        emptyEl.classList.add('contacts-empty');
        emptyEl.textContent = query ? 'No contacts found' : 'Tap + to add a contact';
        replaceContent(this.listsContainer, emptyEl);
        return;
      }

      // Inject P2P users into Worker + main thread mirrors
      const {PhantomChatBridge} = await import('@lib/phantomchat/phantomchat-bridge');
      const bridge = PhantomChatBridge.getInstance();
      const {PhantomChatPeerMapper} = await import('@lib/phantomchat/phantomchat-peer-mapper');
      const mapper = new PhantomChatPeerMapper();
      const {MOUNT_CLASS_TO} = await import('@config/debug');
      const proxy = MOUNT_CLASS_TO.apiManagerProxy;
      const {reconcilePeer} = await import('@stores/peers');
      const rootScope = (await import('@lib/rootScope')).default;

      // Presence (#52): register each contact so an inbound ping/pong resolves
      // to the right peer and drives a REAL online / "last seen at HH:MM" status.
      const {trackPeerPresence} = await import('@lib/phantomchat/phantomchat-presence');

      const peerIds: PeerId[] = [];
      for(const m of filtered) {
        const displayName = m.displayName || 'npub...' + m.pubkey.slice(0, 16);
        const avatar = bridge.deriveAvatarFromPubkeySync(m.pubkey);
        // Worker injection
        try {
          await rootScope.managers.appUsersManager.injectP2PUser(m.pubkey, m.peerId, displayName, avatar);
        } catch(err) { /* ignore */ }
        // Main thread mirror + Solid store
        const user = mapper.createTwebUser({peerId: m.peerId, firstName: displayName, pubkey: m.pubkey});
        if(proxy?.mirrors?.peers) proxy.mirrors.peers[m.peerId.toPeerId(false)] = user;
        reconcilePeer(m.peerId.toPeerId(false), user);
        peerIds.push(m.peerId.toPeerId(false));
        // Wire this contact into presence tracking (idempotent).
        try { trackPeerPresence(m.pubkey, m.peerId); } catch(err) { /* presence is optional */ }
      }

      if(!middleware()) return;
      this.renderContactsList(peerIds, middleware);
    } catch(err) {
      console.error('[PhantomChat.chat] failed to load P2P contacts:', err);
      const emptyEl = document.createElement('div');
      emptyEl.classList.add('contacts-empty');
      emptyEl.textContent = 'Tap + to add a contact';
      replaceContent(this.listsContainer, emptyEl);
    }
  }

  private async handleNpubInput(npub: string, nickname?: string) {
    try {
      const {addP2PContact} = await import('@lib/phantomchat/add-p2p-contact');
      const {toast} = await import('@components/toast');

      const result = await addP2PContact({
        pubkey: npub,
        nickname,
        openChat: true,
        source: 'contacts-tab'
      });

      toast('Contact added: ' + result.displayName);
      this.close();
    } catch(err) {
      console.error('[PhantomChat.chat] failed to add contact from npub:', err);
      const {toast} = await import('@components/toast');
      toast('Invalid npub format');
    }
  }

  private showAddContactPopup() {
    showAddContactPopupShared({
      managers: this.managers,
      onSubmit: (npub, nickname) => this.handleNpubInput(npub, nickname)
    });
  }

  public focus() {
    this.onOpenAfterTimeout();
  }
}
