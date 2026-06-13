/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {DialogFilter, InputChatlist, Update, Updates} from '@layer';
import type {Dialog} from '@appManagers/appMessagesManager';
import type {AnyDialog} from '@lib/storages/dialogs';
import forEachReverse from '@helpers/array/forEachReverse';
import copy from '@helpers/object/copy';
import {AppManager} from '@appManagers/manager';
import findAndSplice from '@helpers/array/findAndSplice';
import assumeType from '@helpers/assumeType';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS,
  REAL_FOLDERS,
  REAL_FOLDER_ID,
  START_LOCAL_ID
} from '@appManagers/constants';
import {buildLocalFilter, isDefaultLocalTitle} from '@lib/storages/filtersLocal';
import makeError from '@helpers/makeError';
import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import {isDialog} from '@appManagers/utils/dialogs/isDialog';
import {isProtectedFolder} from '@lib/nostra/folders-protection';

export type MyDialogFilter = Exclude<DialogFilter, DialogFilter.dialogFilterDefault>;

const convertment = [
  ['pinned_peers', 'pinnedPeerIds'],
  ['exclude_peers', 'excludePeerIds'],
  ['include_peers', 'includePeerIds']
] as ['pinned_peers' | 'exclude_peers' | 'include_peers', 'pinnedPeerIds' | 'excludePeerIds' | 'includePeerIds'][];

const PREPENDED_FILTERS = REAL_FOLDERS.size;


export default class FiltersStorage extends AppManager {
  private filters: {[filterId: string]: MyDialogFilter};
  private filtersArr: Array<MyDialogFilter>;
  private localFilters: {[filterId: string]: MyDialogFilter};
  private localId: number;
  private reloadedPeerIds: Set<PeerId>;

  protected after() {
    this.clear(true);

    this.apiUpdatesManager.addMultipleEventsListeners({
      updateDialogFilter: this.onUpdateDialogFilter,

      updateDialogFilters: this.onUpdateDialogFilters,

      updateDialogFilterOrder: this.onUpdateDialogFilterOrder
    });

    // delete peers when dialog is being dropped
    /* rootScope.addEventListener('peer_deleted', (peerId) => {
      for(const filterId in this.filters) {
        const filter = this.filters[filterId];
        let modified = false;
        [filter.pinned_peers, filter.include_peers, filter.exclude_peers].forEach((arr) => {
          forEachReverse(arr, (inputPeer, idx) => {
            if(getPeerId(inputPeer) === peerId) {
              arr.splice(idx, 1);
              modified = true;
            }
          });
        });

        if(modified) {
          this.saveDialogFilter(filter, true);
        }
      }
    }); */

    this.rootScope.addEventListener('premium_toggle', () => {
      this.onUpdateDialogFilters({_: 'updateDialogFilters'});
    });

    return this.appStateManager.getState().then((state) => {
      const filtersArr = this.prependFilters(state.filtersArr);
      filtersArr.map((filter) => {
        this.saveDialogFilter(filter, false, true);
      });
    });
  }

  /**
   * ! use it only with saving
   *
   * Ensures the 4 locally-seeded system folders (All, Persons, Groups, Archive)
   * are present in the filter array, in that order, followed by any user custom
   * folders. For existing users whose filtersArr already contains only [ALL, ARCHIVE],
   * this method retroactively inserts Persons and Groups. Preserves user-renamed
   * titles across reloads via the LANGPACK: sentinel check.
   */
  private prependFilters(filters: DialogFilter[]) {
    filters = filters.slice();

    const allChatsFilter = this.localFilters[FOLDER_ID_ALL];
    const archiveFilter = this.localFilters[FOLDER_ID_ARCHIVE];
    const personsFilter = this.localFilters[FOLDER_ID_PERSONS];
    const groupsFilter = this.localFilters[FOLDER_ID_GROUPS];

    // ALL: replace existing or prepend
    const allIdx = filters.findIndex(
      (f) => f._ === 'dialogFilterDefault' || (f as MyDialogFilter).id === FOLDER_ID_ALL
    );
    if(allIdx !== -1) filters[allIdx] = allChatsFilter;
    else filters.unshift(allChatsFilter);

    // Helper: if a previously-persisted filter has a user-renamed literal
    // title, keep it; otherwise re-seed with the fresh default. Legacy
    // LANGPACK: sentinels are treated as defaults so they get upgraded.
    const preserveRename = (
      existing: MyDialogFilter | undefined,
      fresh: MyDialogFilter
    ): MyDialogFilter => {
      if(!existing) return fresh;
      const existingTitle = (existing as DialogFilter.dialogFilter).title?.text ?? '';
      if(!isDefaultLocalTitle(fresh.id, existingTitle)) {
        return {...fresh, title: (existing as DialogFilter.dialogFilter).title};
      }
      return fresh;
    };

    // PERSONS: ensure present at index 1, preserve rename
    const existingPersons = filters.find(
      (f) => (f as MyDialogFilter).id === FOLDER_ID_PERSONS
    ) as MyDialogFilter | undefined;
    findAndSplice(filters, (f) => (f as MyDialogFilter).id === FOLDER_ID_PERSONS);
    filters.splice(1, 0, preserveRename(existingPersons, personsFilter));

    // GROUPS: ensure present at index 2, preserve rename
    const existingGroups = filters.find(
      (f) => (f as MyDialogFilter).id === FOLDER_ID_GROUPS
    ) as MyDialogFilter | undefined;
    findAndSplice(filters, (f) => (f as MyDialogFilter).id === FOLDER_ID_GROUPS);
    filters.splice(2, 0, preserveRename(existingGroups, groupsFilter));

    // ARCHIVE: ensure present at index 3 (after all system folders)
    findAndSplice(filters, (f) => (f as MyDialogFilter).id === FOLDER_ID_ARCHIVE);
    filters.splice(3, 0, archiveFilter);

    this.localId = START_LOCAL_ID;
    filters.forEach((filter) => {
      delete filter.localId;
    });

    return filters;
  }

  private generateLocalFilter(id: number) {
    const filter = buildLocalFilter(id);
    if(REAL_FOLDERS.has(id)) {
      filter.pinnedPeerIds = this.dialogsStorage.getPinnedOrders(id as REAL_FOLDER_ID);
    }
    return filter;
  }

  // private getLocalFilter(id: number) {
  //   return this.filters[id] ??= this.generateLocalFilter(id);
  // }

  public clear = (init?: boolean) => {
    if(!init) {
      // safeReplaceObject(this.filters, {});
      this.reloadedPeerIds.clear();
      this.clearFilters();
    } else {
      this.filters = {};
      this.filtersArr = [];
      this.reloadedPeerIds = new Set();

      this.localFilters = {};
      for(const filterId of REAL_FOLDERS) {
        this.localFilters[filterId] = this.generateLocalFilter(filterId as REAL_FOLDER_ID);
      }
    }

    this.localId = START_LOCAL_ID;
  };

  private onUpdateDialogFilter = (update: Update.updateDialogFilter) => {
    if(update.filter) {
      this.saveDialogFilter(update.filter as any);
    } else if(this.filters[update.id]) { // Папка удалена
      // this.getDialogFilters(true);
      this.rootScope.dispatchEvent('filter_delete', this.filters[update.id]);
      delete this.filters[update.id];
      findAndSplice(this.filtersArr, (filter) => (filter as DialogFilter.dialogFilter).id === update.id);
    }

    this.pushToState();
  };

  private onUpdateDialogFilters = (update: Update.updateDialogFilters) => {
    // console.warn('updateDialogFilters', update);

    const oldFilters = copy(this.filters);

    this.getDialogFilters(true).then((filters) => {
      for(const _filterId in oldFilters) {
        const filterId = +_filterId;
        if(!filters.find((filter) => filter.id === filterId)) { // * deleted
          this.onUpdateDialogFilter({_: 'updateDialogFilter', id: filterId});
        }
      }

      this.onUpdateDialogFilterOrder({_: 'updateDialogFilterOrder', order: filters.map((filter) => filter.id)});
    });
  };

  private onUpdateDialogFilterOrder = (update: Update.updateDialogFilterOrder) => {
    // console.log('updateDialogFilterOrder', update);

    const order = update.order.slice();
    if(!order.includes(FOLDER_ID_ARCHIVE)) {
      order.splice(order[0] === FOLDER_ID_ALL ? 1 : 0, 0, FOLDER_ID_ARCHIVE);
    }

    this.localId = START_LOCAL_ID;
    order.forEach((filterId) => {
      const filter = this.filters[filterId];
      delete filter.localId;
      this.setLocalId(filter);
    });

    this.rootScope.dispatchEvent('filter_order', order);

    this.pushToState();
  };

  private pushToState() {
    this.appStateManager.pushToState('filtersArr', this.filtersArr);
  }

  public testDialogForFilter(dialog: AnyDialog, filter?: MyDialogFilter) {
    if(!filter || !isDialog(dialog)) {
      return true;
    }

    const {peerId} = dialog;

    // Only the Telegram-style folder ids (All=0, Archive=1) are stored on
    // dialog.folder_id. Persons (2) / Groups (3) are locally-seeded system
    // folders whose membership is computed from pFlags below — do NOT
    // short-circuit them here, otherwise they always appear empty.
    if(filter.id === FOLDER_ID_ALL || filter.id === FOLDER_ID_ARCHIVE) {
      return dialog.folder_id === filter.id && this.dialogsStorage.canSaveDialog(peerId, dialog);
    }

    // * check whether dialog exists
    if(!this.appMessagesManager.getDialogOnly(peerId)) {
      return false;
    }

    // exclude_peers
    if((filter as DialogFilter.dialogFilter).excludePeerIds?.includes(peerId)) {
      return false;
    }

    // include_peers
    if((filter as DialogFilter.dialogFilter).includePeerIds?.includes(peerId)) {
      return true;
    }

    const pFlags = (filter as DialogFilter.dialogFilter).pFlags;

    if(!pFlags) {
      return true;
    }

    // exclude_archived
    if(pFlags.exclude_archived && dialog.folder_id === FOLDER_ID_ARCHIVE) {
      return false;
    }

    // exclude_read
    if(pFlags.exclude_read && !this.appMessagesManager.isDialogUnread(dialog)) {
      return false;
    }

    // exclude_muted
    if(pFlags.exclude_muted && this.appNotificationsManager.isPeerLocalMuted({peerId}) && !(dialog.unread_mentions_count && dialog.unread_count)) {
      return false;
    }

    if(this.appPeersManager.isAnyChat(peerId)) {
      // broadcasts
      if(pFlags.broadcasts && this.appPeersManager.isBroadcast(peerId)) {
        return true;
      }

      // groups
      if(pFlags.groups && this.appPeersManager.isAnyGroup(peerId)) {
        return true;
      }
    } else {
      const userId = peerId.toUserId();

      // bots
      if(this.appUsersManager.isBot(userId)) {
        return !!pFlags.bots;
      }

      // non_contacts
      if(pFlags.non_contacts && !this.appUsersManager.isContact(userId)) {
        return true;
      }

      // contacts
      if(pFlags.contacts && this.appUsersManager.isContact(userId)) {
        return true;
      }
    }

    return false;
  }

  public testDialogForFilterId(dialog: Dialog, filterId: number) {
    return this.testDialogForFilter(dialog, this.filters[filterId]);
  }

  public getFilter(filterId: number) {
    return this.filters[filterId];
  }

  public getFilters() {
    return this.filters;
  }

  public clearFilters() {
    const filters = this.getFilters();
    for(const filterId in filters) { // delete filters
      if(REAL_FOLDERS.has(+filterId)) {
        continue;
      }

      this.onUpdateDialogFilter({
        _: 'updateDialogFilter',
        id: +filterId
      });
    }
  }

  /**
   * Atomically replace all filters with a new set. Used by FoldersSync
   * when applying a remote snapshot. Dispatches filter_delete for filters
   * that disappear, filter_update for each new/changed filter, and
   * filter_order for the final ordering.
   */
  public replaceAllFilters(next: MyDialogFilter[]) {
    const nextIds = new Set(next.map((f) => f.id));
    // Delete removed filters
    for(const idStr in this.filters) {
      const id = +idStr;
      if(!nextIds.has(id)) {
        this.rootScope.dispatchEvent('filter_delete', this.filters[id]);
        delete this.filters[id];
      }
    }
    // Upsert new / changed filters
    this.filtersArr = [];
    for(const filter of next) {
      this.filters[filter.id] = filter;
      this.filtersArr.push(filter);
      this.rootScope.dispatchEvent('filter_update', filter);
    }
    // Notify order
    this.rootScope.dispatchEvent('filter_order', next.map((f) => f.id));
    this.pushToState();
  }

  /**
   * Ensure the 4 system folders (All/Persons/Groups/Archive) are present
   * in filtersArr after a replaceAllFilters call. Re-runs prependFilters
   * and updates the in-memory maps.
   */
  public reseedSystemFolders() {
    const seeded = this.prependFilters(this.filtersArr) as MyDialogFilter[];
    this.filtersArr = seeded;
    this.filters = {};
    for(const f of seeded) {
      this.filters[f.id] = f;
    }
    this.pushToState();
  }

  public async toggleDialogPin(peerId: PeerId, filterId: number) {
    const filter = this.filters[filterId];

    const index = filter.pinnedPeerIds.indexOf(peerId);
    const wasPinned = index !== -1;

    if(wasPinned) {
      filter.pinned_peers.splice(index, 1);
      filter.pinnedPeerIds.splice(index, 1);
    }

    if(!wasPinned) {
      if(filter.pinned_peers.length >= (await this.apiManager.getLimit('folderPin'))) {
        return Promise.reject(makeError('PINNED_DIALOGS_TOO_MUCH'));
      }

      filter.pinned_peers.unshift(this.appPeersManager.getInputPeerById(peerId));
      filter.pinnedPeerIds.unshift(peerId);
    }

    return this.updateDialogFilter(filter);
  }

  public createDialogFilter(filter: MyDialogFilter, prepend?: boolean) {
    const maxId = Math.max(1, ...Object.keys(this.filters).map((i) => +i));
    filter = copy(filter);
    filter.id = maxId + 1;
    return this.updateDialogFilter(filter, undefined, prepend);
  }

  public updateDialogFilter(filter: MyDialogFilter, remove = false, prepend = false) {
    if(remove && isProtectedFolder(filter.id)) {
      return Promise.reject(makeError('FILTER_PROTECTED'));
    }

    return this.apiManager.invokeApi('messages.updateDialogFilter', {
      id: filter.id,
      filter: remove ? undefined : this.getOutputDialogFilter(filter)
    }).then(() => {
      this.onUpdateDialogFilter({
        _: 'updateDialogFilter',
        id: filter.id,
        filter: remove ? undefined : filter as any
      });

      if(prepend) {
        const f = Object.values(this.filters);
        const order = f.sort((a, b) => a.localId - b.localId).map((filter) => filter.id);
        indexOfAndSplice(order, filter.id);
        indexOfAndSplice(order, FOLDER_ID_ARCHIVE);
        order.splice(order[0] === FOLDER_ID_ALL ? 1 : 0, 0, filter.id);
        this.onUpdateDialogFilterOrder({
          _: 'updateDialogFilterOrder',
          order
        });
      }

      return filter;
    });
  }

  public updateDialogFiltersOrder(order: number[]) {
    return this.apiManager.invokeApi('messages.updateDialogFiltersOrder', {
      order
    }).then(() => {
      this.onUpdateDialogFilterOrder({
        _: 'updateDialogFilterOrder',
        order
      });
    });
  }

  public getOutputDialogFilter(filter: MyDialogFilter) {
    const c = copy(filter);
    /* convertment.forEach(([from, to]) => {
      c[from] = c[to].map((peerId) => this.appPeersManager.getInputPeerById(peerId));
    }); */

    this.filterIncludedPinnedPeers(filter);

    return c;
  }

  private filterIncludedPinnedPeers(filter: MyDialogFilter) {
    forEachReverse(filter.includePeerIds, (peerId, idx) => {
      if(filter.pinnedPeerIds.includes(peerId)) {
        filter.include_peers.splice(idx, 1);
        filter.includePeerIds.splice(idx, 1);
      }
    });
  }

  // private spliceMissingPeerIds(filterId: number, type: ArgumentTypes<FiltersStorage['reloadMissingPeerIds']>[1], missingPeerIds: PeerId[]) {
  //   const filter = this.getFilter(filterId);
  //   const peers = filter && filter[type];
  //   if(!peers?.length) {
  //     return;
  //   }

  //   let spliced = false;
  //   missingPeerIds.forEach((peerId) => {
  //     const inputPeer = findAndSplice(peers, (inputPeer) => getPeerId(inputPeer) === peerId);
  //     if(inputPeer) {
  //       spliced = true;
  //     }
  //   });

  //   if(spliced) {
  //     this.onUpdateDialogFilter({
  //       _: 'updateDialogFilter',
  //       id: filterId,
  //       filter
  //     });
  //   }
  // }

  public reloadMissingPeerIds(
    filterId: number,
    type: 'pinned_peers' | 'include_peers' | 'exclude_peers' = 'pinned_peers'
  ) {
    const filter = this.getFilter(filterId);
    const peers = (filter as DialogFilter.dialogFilter)?.[type];
    if(!peers?.length) {
      return;
    }

    // const missingPeerIds: PeerId[] = [];
    const reloadDialogs = peers.filter((inputPeer) => {
      const peerId = this.appPeersManager.getPeerId(inputPeer);
      const isAlreadyReloaded = this.reloadedPeerIds.has(peerId);
      const dialog = this.appMessagesManager.getDialogOnly(peerId);
      // if(isAlreadyReloaded && !dialog) {
      //   missingPeerIds.push(peerId);
      // }

      const reload = !isAlreadyReloaded && !dialog;
      return reload;
    });

    if(!reloadDialogs.length) {
      // if(missingPeerIds.length) {
      //   this.spliceMissingPeerIds(filterId, type, missingPeerIds);
      // }

      return;
    }

    const reloadPromises = reloadDialogs.map((inputPeer) => {
      const peerId = this.appPeersManager.getPeerId(inputPeer);
      const promise = this.appMessagesManager.reloadConversation(inputPeer)
      .then((dialog) => {
        this.reloadedPeerIds.add(peerId);

        return dialog ? undefined : peerId;
      });

      return promise;
    });

    const reloadPromise = Promise.all(reloadPromises).then((missingPeerIds) => {
      missingPeerIds = missingPeerIds.filter(Boolean);
      if(!missingPeerIds.length) {
        return;
      }

      // this.spliceMissingPeerIds(filterId, type, missingPeerIds);
    });

    return reloadPromise;
  }

  public async getDialogFilters(overwrite = false): Promise<MyDialogFilter[]> {
    const keys = Object.keys(this.filters);
    if(keys.length > PREPENDED_FILTERS && !overwrite) {
      return keys.map((filterId) => this.filters[filterId]).sort((a, b) => a.localId - b.localId);
    }

    const messagesDialogFilters = await this.apiManager.invokeApiSingle('messages.getDialogFilters');
    const prepended = this.prependFilters(messagesDialogFilters.filters);
    return prepended.map((filter) => this.saveDialogFilter(filter, overwrite)).filter(Boolean);
  }

  public getSuggestedDialogsFilters() {
    return this.apiManager.invokeApi('messages.getSuggestedDialogFilters');
  }

  public saveDialogFilter(filter: DialogFilter, update = true, silent?: boolean) {
    // defineNotNumerableProperties(filter, ['includePeerIds', 'excludePeerIds', 'pinnedPeerIds']);

    if(filter._ === 'dialogFilterDefault') {
      filter = this.localFilters[FOLDER_ID_ALL];
    }

    assumeType<MyDialogFilter>(filter);
    if(!REAL_FOLDERS.has(filter.id)) {
      convertment.forEach(([from, to]) => {
        const arrayFrom = (filter as DialogFilter.dialogFilter)[from];
        if(!arrayFrom) return;
        (filter as DialogFilter.dialogFilter)[to] = arrayFrom.map((peer) => this.appPeersManager.getPeerId(peer));
      });

      this.filterIncludedPinnedPeers(filter);

      filter.include_peers = filter.pinned_peers.concat(filter.include_peers);
      filter.includePeerIds = filter.pinnedPeerIds.concat(filter.includePeerIds);
    }

    const oldFilter = this.filters[filter.id];
    if(oldFilter) {
      filter = Object.assign(oldFilter, filter);
    } else {
      this.filters[filter.id] = filter;
    }

    this.setLocalId(filter);

    if(!silent) {
      if(update) {
        this.rootScope.dispatchEvent('filter_update', filter);
      } else if(!oldFilter) {
        this.rootScope.dispatchEvent('filter_new', filter);
      }
    }

    return filter;
  }

  private setLocalId(filter: MyDialogFilter) {
    if(filter.localId !== undefined) {
      if(filter.localId >= this.localId) {
        this.localId = filter.localId + 1;
      }
    } else {
      filter.localId = this.localId++ as MyDialogFilter['localId'];
      findAndSplice(this.filtersArr, (_filter) => _filter.id === filter.id);
      this.filtersArr.push(filter);
      this.pushToState();
    }
  }

  public async isFilterIdAvailable(filterId: number) {
    if(REAL_FOLDERS.has(filterId)) {
      return true;
    }

    const limit = await this.apiManager.getLimit('folders');
    const isFolderAvailable = this.filtersArr.filter((filter) => !REAL_FOLDERS.has(filter.id)).slice(0, limit).some((filter) => filter.id === filterId);

    return isFolderAvailable;
  }

  public getChatlistInput(id: number): InputChatlist {
    return {
      _: 'inputChatlistDialogFilter',
      filter_id: id
    };
  }

  /**
   * @param filter should be client-generated
   */
  public exportChatlistInvite(filter: DialogFilter.dialogFilterChatlist) {
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.exportChatlistInvite',
      params: {
        chatlist: this.getChatlistInput(filter.id),
        title: filter.title.text,
        peers: filter.include_peers
      },
      processResult: (exportedChatlistInvite) => {
        this.saveDialogFilter(exportedChatlistInvite.filter);
        return exportedChatlistInvite;
      }
    });
  }

  public deleteExportedInvite(id: number, slug: string) {
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.deleteExportedInvite',
      params: {
        chatlist: this.getChatlistInput(id),
        slug
      }
    });
  }

  public editExportedInvite(id: number, slug: string, peerIds: PeerId[], title: string) {
    return this.apiManager.invokeApi('chatlists.editExportedInvite', {
      chatlist: this.getChatlistInput(id),
      slug,
      title,
      peers: peerIds.map((peerId) => this.appPeersManager.getInputPeerById(peerId))
    });
  }

  public getExportedInvites(id: number) {
    const filter = this.getFilter(id);
    if(filter?._ === 'dialogFilter') {
      return Promise.reject(makeError('FILTER_NOT_SUPPORTED'));
    }

    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.getExportedInvites',
      params: {
        chatlist: this.getChatlistInput(id)
      },
      processResult: (exportedInvites) => {
        this.appUsersManager.saveApiUsers(exportedInvites.users);
        this.appChatsManager.saveApiChats(exportedInvites.chats);
        return exportedInvites.invites;
      }
    });
  }

  public checkChatlistInvite(slug: string) {
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.checkChatlistInvite',
      params: {slug},
      processResult: (chatlistInvite) => {
        this.appUsersManager.saveApiUsers(chatlistInvite.users);
        this.appChatsManager.saveApiChats(chatlistInvite.chats);
        return chatlistInvite;
      }
    });
  }

  public joinChatlistInvite(slug: string, peerIds: PeerId[]) {
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.joinChatlistInvite',
      params: {
        slug,
        peers: peerIds.map((peerId) => this.appPeersManager.getInputPeerById(peerId))
      },
      processResult: (updates) => {
        this.apiUpdatesManager.processUpdateMessage(updates);
        const update = (updates as Updates.updates).updates.find((update) => update._ === 'updateDialogFilter') as Update.updateDialogFilter;
        const filterId = update.id;
        this.rootScope.dispatchEvent('filter_joined', this.getFilter(filterId));
        return filterId;
      }
    });
  }

  public getChatlistUpdates(id: number) {
    const filter = this.getFilter(id);
    if(filter?._ !== 'dialogFilterChatlist') {
      return Promise.reject(makeError('FILTER_NOT_SUPPORTED'));
    }

    const time = Date.now();
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.getChatlistUpdates',
      params: {
        chatlist: this.getChatlistInput(id)
      },
      processResult: (chatlistUpdates) => {
        this.appUsersManager.saveApiUsers(chatlistUpdates.users);
        this.appChatsManager.saveApiChats(chatlistUpdates.chats);

        const filter = this.getFilter(id);
        if(filter?._ === 'dialogFilterChatlist') {
          filter.updatedTime = time;
          this.pushToState();
        }

        return chatlistUpdates;
      }
    });
  }

  public joinChatlistUpdates(id: number, peerIds: PeerId[]) {
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.joinChatlistUpdates',
      params: {
        chatlist: this.getChatlistInput(id),
        peers: peerIds.map((peerId) => this.appPeersManager.getInputPeerById(peerId))
      },
      processResult: (updates) => {
        this.apiUpdatesManager.processUpdateMessage(updates);
      }
    });
  }

  public hideChatlistUpdates(id: number) {
    return this.apiManager.invokeApiSingle('chatlists.hideChatlistUpdates', {
      chatlist: this.getChatlistInput(id)
    });
  }

  public getLeaveChatlistSuggestions(id: number) {
    return this.apiManager.invokeApiSingle('chatlists.getLeaveChatlistSuggestions', {
      chatlist: this.getChatlistInput(id)
    });
  }

  public leaveChatlist(id: number, peerIds: PeerId[]) {
    return this.apiManager.invokeApiSingleProcess({
      method: 'chatlists.leaveChatlist',
      params: {
        chatlist: this.getChatlistInput(id),
        peers: peerIds.map((peerId) => this.appPeersManager.getInputPeerById(peerId))
      },
      processResult: (updates) => {
        this.apiUpdatesManager.processUpdateMessage(updates);
      }
    });
  }
}
