/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {SliderSuperTab} from '@components/slider';
import appDialogsManager from '@lib/appDialogsManager';
import InputSearch from '@components/inputSearch';
import {IS_MOBILE} from '@environment/userAgent';
import {canFocus} from '@helpers/dom/canFocus';
import windowSize from '@helpers/windowSize';
import ButtonCorner from '@components/buttonCorner';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import SortedUserList from '@components/sortedUserList';
import {getMiddleware} from '@helpers/middleware';
import replaceContent from '@helpers/dom/replaceContent';
import rootScope from '@lib/rootScope';
import {getAllMappings} from '@lib/nostra/virtual-peers-db';
import {showAddContactPopup as showAddContactPopupShared} from '@components/popups/addContact';

// TODO: поиск по людям глобальный, если не нашло в контактах никого

export default class AppContactsTab extends SliderSuperTab {
  public static noSame = true;
  private inputSearch: InputSearch;
  private middlewareHelperLoad: ReturnType<typeof getMiddleware>;
  private sortedUserList: SortedUserList;
  private listsContainer: HTMLElement;

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
        // [Nostra.chat] Detect npub paste and open P2P chat
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
      if(isContact) this.sortedUserList.add(peerId);
      else this.sortedUserList.delete(peerId);
    });

    this.title.replaceWith(this.inputSearch.container);

    this.middlewareHelperLoad = getMiddleware();

    const listsContainer = this.listsContainer = document.createElement('div');
    this.scrollable.append(listsContainer);

    this.openContacts();

    // preload contacts
    // appUsersManager.getContacts();
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
      onFound: () => {
        this.close();
      },
      withContext: undefined,
      autonomous: true
    });
    return sortedUserList;
  }

  protected onClose() {
    this.middlewareHelperLoad.clean();
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
      const mappings = await getAllMappings();
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
      const {NostraBridge} = await import('@lib/nostra/nostra-bridge');
      const bridge = NostraBridge.getInstance();
      const {NostraPeerMapper} = await import('@lib/nostra/nostra-peer-mapper');
      const mapper = new NostraPeerMapper();
      const {MOUNT_CLASS_TO} = await import('@config/debug');
      const proxy = MOUNT_CLASS_TO.apiManagerProxy;
      const {reconcilePeer} = await import('@stores/peers');
      const rootScope = (await import('@lib/rootScope')).default;

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
      }

      if(!middleware()) return;
      this.renderContactsList(peerIds, middleware);
    } catch(err) {
      console.error('[Nostra.chat] failed to load P2P contacts:', err);
      const emptyEl = document.createElement('div');
      emptyEl.classList.add('contacts-empty');
      emptyEl.textContent = 'Tap + to add a contact';
      replaceContent(this.listsContainer, emptyEl);
    }
  }

  private async handleNpubInput(npub: string, nickname?: string) {
    try {
      const {addP2PContact} = await import('@lib/nostra/add-p2p-contact');
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
      console.error('[Nostra.chat] failed to add contact from npub:', err);
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
