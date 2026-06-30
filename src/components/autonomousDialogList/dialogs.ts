import {Dialog} from '@appManagers/appMessagesManager';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE, REAL_FOLDERS, REAL_FOLDER_ID} from '@appManagers/constants';
import getDialogIndex from '@appManagers/utils/dialogs/getDialogIndex';
import getDialogIndexKey from '@appManagers/utils/dialogs/getDialogIndexKey';
import {isDialog, isForumTopic} from '@appManagers/utils/dialogs/isDialog';
import ArchiveDialog, {createArchiveDialogState, DisposableArchiveDialogState} from '@components/archiveDialog';
import {AutonomousDialogListBase, BaseConstructorArgs, LoadDialogsInnerArgs} from '@components/autonomousDialogList/base';
import {BADGE_TRANSITION_TIME} from '@components/autonomousDialogList/constants';
import groupCallActiveIcon from '@components/groupCallActiveIcon';
import Scrollable from '@components/scrollable';
import SetTransition from '@components/singleTransition';
import SortedDialogList, {CustomPinnedDialog} from '@components/sortedDialogList';
import IS_GROUP_CALL_SUPPORTED from '@environment/groupCallSupport';
import namedPromises from '@helpers/namedPromises';
import noop from '@helpers/noop';
import {Chat} from '@layer';
import apiManagerProxy from '@lib/apiManagerProxy';
import {AppDialogsManager, DialogDom} from '@lib/appDialogsManager';
import rootScope from '@lib/rootScope';
import SolidJSHotReloadGuardProvider from '@lib/solidjs/hotReloadGuardProvider';
import {runWithHotReloadGuard} from '@lib/solidjs/runWithHotReloadGuard';


type ConstructorArgs = BaseConstructorArgs & {
  filterId: number;
};

export class AutonomousDialogList extends AutonomousDialogListBase<Dialog> {
  protected filterId: number;
  private archiveDialogState?: DisposableArchiveDialogState;
  private customPinnedDialog?: CustomPinnedDialog;

  constructor({filterId, ...args}: ConstructorArgs) {
    super(args);

    this.filterId = filterId;

    if(filterId === FOLDER_ID_ALL) {
      this.customPinnedDialog = new CustomPinnedDialog({
        render: () => {
          const element = new ArchiveDialog;
          element.HotReloadGuard = SolidJSHotReloadGuardProvider;

          element.feedProps({
            state: this.archiveDialogState.state
          });

          return element;
        }
      });

      this.archiveDialogState = runWithHotReloadGuard(() => createArchiveDialogState({
        onHasArchiveDialogChanged: (hasDialogs) => {
          this.onHasArchiveDialogChanged(hasDialogs);
        }
      }));
    }

    this.needPlaceholderAtFirstTime = true;

    this.listenerSetter.add(rootScope)('peer_typings', async({peerId, typings}) => {
      const [dialog, isForum] = await Promise.all([
        this.managers.appMessagesManager.getDialogOnly(peerId),
        this.managers.appPeersManager.isForum(peerId)
      ]);

      if(!dialog || isForum) return;

      if(typings.length) {
        this.setTyping(dialog);
      } else {
        this.unsetTyping(dialog);
      }
    });

    this.listenerSetter.add(rootScope)('user_update', async(userId) => {
      if(!this.isActive) {
        return;
      }

      const peerId = userId.toPeerId();
      const dom = this.getDialogDom(peerId);
      if(!dom) {
        return;
      }

      const status = await this.managers.appUsersManager.getUserStatus(userId);
      const online = status?._ === 'userStatusOnline';
      this.setOnlineStatus(dom.avatarEl.node, online);
    });

    this.listenerSetter.add(rootScope)('chat_update', async(chatId) => {
      const peerId = chatId.toPeerId(true);
      this.processDialogForCallStatus(peerId);
    });

    this.listenerSetter.add(rootScope)('dialog_flush', ({dialog}) => {
      if(!this.isActive || !dialog) {
        return;
      }

      this.updateDialog(dialog);
    });

    this.listenerSetter.add(rootScope)('dialogs_multiupdate', (dialogs) => {
      if(!this.isActive) {
        return;
      }

      for(const [peerId, {dialog, topics}] of dialogs) {
        if(!isDialog(dialog)) {
          continue;
        }

        this.updateDialog(dialog);
        this.appDialogsManager.processContact?.(peerId.toPeerId());
      }
    });

    this.listenerSetter.add(rootScope)('dialog_drop', (dialog) => {
      if(!this.isActive || !isDialog(dialog)) {
        return;
      }

      this.deleteDialogByKey(this.getDialogKey(dialog));
      this.appDialogsManager.processContact?.(dialog.peerId);
    });

    this.listenerSetter.add(rootScope)('dialog_unread', ({dialog}) => {
      if(!this.isActive || !isDialog(dialog)) {
        return;
      }

      this.updateDialog(dialog);
    });

    this.listenerSetter.add(rootScope)('dialog_notify_settings', (dialog) => {
      if(!this.isActive || !isDialog(dialog)) {
        return;
      }

      this.updateDialog(dialog);
    });

    this.listenerSetter.add(rootScope)('dialog_draft', ({dialog, drop, peerId}) => {
      if(!this.isActive || isForumTopic(dialog)) {
        return;
      }

      if(drop) {
        this.deleteDialog(dialog);
      } else {
        this.updateDialog(dialog);
      }

      this.appDialogsManager.processContact?.(peerId);
    });

    this.listenerSetter.add(rootScope)('filter_update', async(filter) => {
      if(this.isActive && filter.id === this.filterId && !REAL_FOLDERS.has(filter.id)) {
        const dialogs = await this.managers.dialogsStorage.getCachedDialogs(true);
        await this.validateListForFilter();
        for(let i = 0, length = dialogs.length; i < length; ++i) {
          const dialog = dialogs[i];
          this.updateDialog(dialog);
        }

        if(this.appDialogsManager.filterId === this.filterId) {
          this.appDialogsManager.fetchChatlistUpdates?.();
        }
      }
    });

    this.listenerSetter.add(rootScope)('auto_delete_period_update', ({peerId, period}) => {
      this.getDialogElement(peerId)?.dom?.avatarEl?.setAutoDeletePeriod(period);
    });
  }

  private get isActive() {
    return this.appDialogsManager.xd === this;
  }

  public getRectFromForPlaceholder() {
    return this.filterId === FOLDER_ID_ARCHIVE ? this.appDialogsManager.chatsContainer : this.appDialogsManager.folders.container;
  }

  protected getFilterId() {
    return this.filterId;
  }

  public setOnlineStatus(element: HTMLElement, online: boolean) {
    const className = 'is-online';
    const hasClassName = element.classList.contains(className);
    !hasClassName && online && element.classList.add(className);
    SetTransition({
      element: element,
      className: 'is-visible',
      forwards: online,
      duration: 250,
      onTransitionEnd: online ? undefined : () => {
        element.classList.remove(className);
      },
      useRafs: online && !hasClassName ? 2 : 0
    });
  }

  public generateScrollable(filter: Parameters<AppDialogsManager['addFilter']>[0]) {
    const filterId = filter.id;
    const scrollable = new Scrollable(null, 'CL', 500);
    scrollable.container.dataset.filterId = '' + filterId;

    // Real/system folders (All=0, Archive=1, Groups=3) are indexed in storage
    // by their folder id (getDialogIndexKeyByFilterId), NOT by filter.localId.
    // Groups carries id=3 but localId=5, so using localId here built `index_5`
    // while the dialog only ever has `index_3` — every update then read an
    // undefined index, failed testDialogForFilter, and evicted the row (which
    // flashed the empty-folder placeholder/edit-folder screen). Mirror storage.
    const indexKey = REAL_FOLDERS.has(filterId) ?
      getDialogIndexKey(filterId as REAL_FOLDER_ID) :
      getDialogIndexKey(filter.localId);
    const sortedDialogList = new SortedDialogList({
      appDialogsManager: this.appDialogsManager,
      managers: rootScope.managers,
      log: this.log,
      scrollable: scrollable,
      indexKey,
      requestItemForIdx: this.requestItemForIdx,
      onListShrinked: this.onListShrinked,
      itemSize: 72,
      onListLengthChange: () => {
        scrollable.onSizeChange();
        this.appDialogsManager.onListLengthChange?.();
      }
    });


    this.scrollable = scrollable;
    this.sortedList = sortedDialogList;
    this.setIndexKey(indexKey);
    this.bindScrollable();

    // list.classList.add('hide');
    // scrollable.container.style.backgroundColor = '#' + (Math.random() * (16 ** 6 - 1) | 0).toString(16);

    return {scrollable, list: sortedDialogList.list};
  }

  /**
   * Only All Chats (0) and Archive (1) key membership on the stable
   * `dialog.folder_id`. Every other tab — custom filters AND the locally-seeded
   * system folders Persons (2) / Groups (3), which no dialog carries a folder_id
   * for — tests membership via the transient per-filter index (`index_<localId>`),
   * so it is exposed to the saveDialogs reindex race. NOTE: this is a strict
   * subset of REAL_FOLDERS (which also includes Groups) — do not conflate them,
   * or Groups gets the unsafe sync-delete path it can't actually tolerate.
   */
  private get keysOnStableFolderId() {
    return this.filterId === FOLDER_ID_ALL || this.filterId === FOLDER_ID_ARCHIVE;
  }

  public testDialogForFilter(dialog: Dialog) {
    if(!this.keysOnStableFolderId ? getDialogIndex(dialog, this.indexKey) === undefined : this.filterId !== dialog.folder_id) {
      return false;
    }

    return true;
  }

  protected async loadDialogsInner({offsetIndex, canFinish}: LoadDialogsInnerArgs) {
    const isFirstLoad = !offsetIndex;

    const unblock = isFirstLoad ? this.sortedList.blockAnimation() : noop;

    const {result} = await namedPromises({
      result: super.loadDialogsInner({offsetIndex, removePlaceholder: false, canFinish}),
      _ignore: this.ensureArchiveDialogHydrated()
    }).finally(unblock);

    this.placeholder?.detach(this.sortedList.itemsLength());

    return result;
  }

  private async ensureArchiveDialogHydrated() {
    if(!this.archiveDialogState) return;

    const promise = this.archiveDialogState.state.ensureHydrated();
    if(!promise) {
      await this.onHasArchiveDialogChanged(this.archiveDialogState.hasArchiveDialog());
      return;
    }

    const ackedResult = await promise;
    if(!ackedResult.cached) return;

    return ackedResult.result;
  }

  /**
   * Удалит неподходящие чаты из списка, но не добавит их(!)
   */
  public async validateListForFilter() {
    this.sortedList.getAllDialogElementsMap().forEach(async(_, key) => {
      const dialog = await rootScope.managers.appMessagesManager.getDialogOnly(key);
      if(!this.testDialogForFilter(dialog)) {
        this.deleteDialog(dialog);
      }
    });
  }

  public updateDialog(dialog: Dialog) {
    if(!this.testDialogForFilter(dialog)) {
      if(this.getDialogElement(dialog.peerId)) {
        // A custom folder tests membership via the per-filter index
        // (`index_<localId>`). DialogsStorage.saveDialogs wipes every `index_N`
        // and regenerates them on each save, so a `dialogs_multiupdate`
        // snapshot captured mid-reindex can momentarily lack the index and make
        // testDialogForFilter report a genuine member as excluded. Removing the
        // row on that transient signal — then re-adding it a tick later when the
        // index is back — is what makes rows bounce/vanish inside folders (All
        // Chats is immune: it keys on the stable `dialog.folder_id`). Before
        // yanking a shown row, confirm exclusion against the authoritative,
        // index-independent rule check.
        this.confirmDialogExcludedFromFilter(dialog);
      }

      return;
    }

    return super.updateDialog(dialog);
  }

  private confirmDialogExcludedFromFilter(dialog: Dialog) {
    const peerId = dialog.peerId;

    // All Chats / Archive key on the stable `folder_id`, so the sync test is
    // already authoritative — trust it. Groups (a REAL_FOLDER) is deliberately
    // NOT trusted here: it uses the same transient per-filter index as custom
    // filters, so it must go through the authoritative confirmation below.
    if(this.keysOnStableFolderId) {
      this.deleteDialog(dialog);
      return;
    }

    (async() => {
      // Re-fetch the canonical dialog (indices regenerated) and re-test against
      // the rule-based predicate, which never reads the transient index.
      const fresh = await this.managers.appMessagesManager.getDialogOnly(peerId);
      if(!this.isActive || !this.getDialogElement(peerId)) {
        return;
      }

      // Dialog gone entirely — `dialog_drop` owns that removal; don't race it.
      if(!fresh) {
        return;
      }

      const stillMember = await this.managers.filtersStorage.testDialogForFilterId(fresh, this.filterId);
      if(!this.isActive || !this.getDialogElement(peerId)) {
        return;
      }

      if(stillMember) {
        // False alarm from the reindex race — reposition with the fresh dialog
        // (correct index + unread state) instead of removing the row.
        super.updateDialog(fresh);
        return;
      }

      this.deleteDialog(fresh);
    })();
  }

  public setCallStatus(dom: DialogDom, visible: boolean) {
    let {callIcon, listEl} = dom;
    if(!callIcon && visible) {
      const {canvas, startAnimation} = dom.callIcon = callIcon = groupCallActiveIcon(listEl.classList.contains('active'));
      canvas.classList.add('dialog-group-call-icon');
      listEl.append(canvas);

      listEl.classList.add('has-group-call-icon');
      startAnimation();
    }

    if(!callIcon) {
      return;
    }

    SetTransition({
      element: dom.callIcon.canvas,
      className: 'is-visible',
      forwards: visible,
      duration: BADGE_TRANSITION_TIME,
      onTransitionEnd: visible ? undefined : () => {
        dom.callIcon.canvas.remove();
        dom.callIcon = undefined;
        listEl.classList.remove('has-group-call-icon');
      },
      useRafs: visible ? 2 : 0
    });
  }

  public processDialogForCallStatus(peerId: PeerId, dom?: DialogDom) {
    if(!IS_GROUP_CALL_SUPPORTED) {
      return;
    }

    if(!dom) dom = this.getDialogDom(peerId);
    if(!dom) return;

    const chat = apiManagerProxy.getChat(peerId.toChatId()) as Chat.chat | Chat.channel;
    this.setCallStatus(dom, !!(chat.pFlags.call_active && chat.pFlags.call_not_empty));
  }

  protected onScrolledBottom() {
    super.onScrolledBottom();

    if(this.hasReachedTheEnd) {
      this.appDialogsManager.loadContacts?.();
    }
  }

  public toggleAvatarUnreadBadges(value: boolean, useRafs: number) {
    if(!value) {
      this.sortedList.getAllDialogElementsMap().forEach((dialogElement) => {
        const {dom} = dialogElement;
        if(!dom.unreadAvatarBadge) {
          return;
        }

        dialogElement.toggleBadgeByKey('unreadAvatarBadge', false, false, false);
      });

      return;
    }

    const reuseClassNames = ['unread', 'mention'];
    this.sortedList.getAllDialogElementsMap().forEach((dialogElement) => {
      const {dom} = dialogElement;
      const unreadContent = dom.unreadBadge?.textContent;
      if(
        !unreadContent ||
        dom.unreadBadge.classList.contains('backwards') ||
        dom.unreadBadge.classList.contains('dialog-pinned-icon')
      ) {
        return;
      }

      const isUnreadAvatarBadgeMounted = !!dom.unreadAvatarBadge;
      dialogElement.createUnreadAvatarBadge();
      dialogElement.toggleBadgeByKey('unreadAvatarBadge', true, isUnreadAvatarBadgeMounted);
      dom.unreadAvatarBadge.textContent = unreadContent;
      const unreadAvatarBadgeClassList = dom.unreadAvatarBadge.classList;
      const unreadBadgeClassList = dom.unreadBadge.classList;
      reuseClassNames.forEach((className) => {
        unreadAvatarBadgeClassList.toggle(className, unreadBadgeClassList.contains(className));
      });
    });
  }

  public getDialogKey(dialog: Dialog) {
    return dialog.peerId;
  }

  public getDialogKeyFromElement(element: HTMLElement) {
    return +element.dataset.peerId;
  }

  public getDialogFromElement(element: HTMLElement) {
    return rootScope.managers.appMessagesManager.getDialogOnly(element.dataset.peerId.toPeerId());
  }

  protected canUpdateDialog(dialog: Dialog): boolean {
    if(dialog.migratedTo !== undefined || !this.testDialogForFilter(dialog)) return false;
    return super.canUpdateDialog(dialog);
  }

  private async onHasArchiveDialogChanged(hasArchiveDialog: boolean) {
    if(!this.customPinnedDialog || !this.archiveDialogState) return;

    if(hasArchiveDialog) {
      await this.sortedList.ensurePinned(this.customPinnedDialog);
    } else {
      this.sortedList.removePinned(this.customPinnedDialog);
    }
  }

  public destroy(): void {
    super.destroy();
    this.archiveDialogState?.dispose();
  }
}
