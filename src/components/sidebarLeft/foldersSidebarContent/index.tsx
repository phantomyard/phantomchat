import {batch, createEffect, createSelector, createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {createStore, reconcile} from 'solid-js/store';
import {render} from 'solid-js/web';
import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import createFolderContextMenu from '@helpers/dom/createFolderContextMenu';
import ListenerSetter from '@helpers/listenerSetter';
import {Middleware} from '@helpers/middleware';
import pause from '@helpers/schedulers/pause';
import {logger, LogTypes} from '@lib/logger';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE, REAL_FOLDERS} from '@appManagers/constants';
import {useHotReloadGuard} from '@lib/solidjs/hotReloadGuard';
import type SolidJSHotReloadGuardProvider from '@lib/solidjs/hotReloadGuardProvider';
import {MyDialogFilter} from '@lib/storages/filters';
import {appSettings, setAppSettings} from '@stores/appSettings';
import {
  CODE_MODE_ENTER_EVENT,
  CODE_MODE_EVENT,
  CODE_MODE_LANG_KEY,
  CODE_MODE_RAIL_GLYPH,
  CODE_MODE_SETTING_KEY,
  applyCodeModeClass,
  isCodeModeEnabled
} from '@lib/code-mode';
import useHasFoldersSidebar from '@stores/foldersSidebar';
import Scrollable from '@components/scrollable2';
import extractEmojiFromFilterTitle, {ExtractEmojiFromFilterTitleResult} from '@components/sidebarLeft/foldersSidebarContent/extractEmojiFromFilterTitle';
import FolderItem from '@components/sidebarLeft/foldersSidebarContent/folderItem';
import type {FolderItemPayload} from '@components/sidebarLeft/foldersSidebarContent/types';
import {getFolderItemsInOrder, getIconForFilter, getNotificationCountForFilter, folderEmoticonFallback} from '@components/sidebarLeft/foldersSidebarContent/utils';


const log = logger('FoldersSidebarContent', LogTypes.Debug);

/**
 * How long after a pointerdown a `changing_folder_from_chatlist` counts as the
 * user choosing a chat list rather than the app restoring or syncing one.
 */
const GESTURE_WINDOW_MS = 1000;


export type FoldersSidebarControls = {
  hydrateFilters: (filters: MyDialogFilter[]) => void;
};

export function FoldersSidebarContent(props: {
  filters: MyDialogFilter[];
  isFiltersInited: boolean;
  notificationsElement: HTMLElement;
}) {
  log.debug('Rendering FoldersSidebarContent');
  onCleanup(() => log.debug('Cleaning up FoldersSidebarContent'));

  const {
    rootScope,
    appSidebarLeft,
    AppChatFoldersTab,
    AppEditFolderTab,
    showLimitPopup,
    i18n
  } = useHotReloadGuard();

  const [selectedFolderId, setSelectedFolderId] = createSignal<number>(FOLDER_ID_ALL);
  /**
   * Code Mode is a rail selection, not a dialogFilter: it owns no filter id and
   * therefore never reaches filter_order / FoldersSync. See lib/code-mode.
   *
   * Read straight out of the settings store (never snapshotted into a signal)
   * so the mode comes back after a reload: StateSettings hydrates from IndexedDB
   * asynchronously, and a snapshot taken at init would always be "off".
   */
  const codeMode = () => isCodeModeEnabled(appSettings[CODE_MODE_SETTING_KEY]);
  const [folderItems, setFolderItems] = createStore<FolderItemPayload[]>([]);
  const [menuTarget, setMenuTarget] = createSignal<HTMLDivElement>();

  const [folderItemRefs, setFolderItemRefs] = createStore<Record<number, HTMLDivElement>>({});

  const isSelected = createSelector(selectedFolderId);

  let folderItemsContainer: HTMLDivElement;

  function updateFolderItem(folderId: number, payload: Partial<FolderItemPayload>) {
    const idx = folderItems.findIndex((item) => item.id === folderId);
    if(idx === -1) {
      return;
    }

    const folderItem = folderItems[idx];
    setFolderItems(idx, reconcile({...folderItem, ...payload}));
  }

  async function updateFolderNotifications(folderId: number) {
    updateFolderItem(folderId, {
      notifications: await getNotificationCountForFilter(folderId, rootScope.managers)
    });
  }

  async function updateAllFolderNotifications() {
    const items = folderItems;

    for(const folderItem of items) {
      if(!folderItem.id) continue;
      updateFolderNotifications(folderItem.id);
    }
  }

  async function makeFolderItemPayload(filter: MyDialogFilter): Promise<FolderItemPayload> {
    const [notifications, folder] = await Promise.all([
      getNotificationCountForFilter(filter.id, rootScope.managers),
      rootScope.managers.dialogsStorage.getFolder(filter.id)
    ]);

    let cleanTitle: ExtractEmojiFromFilterTitleResult;

    const titleRest: Pick<FolderItemPayload, 'name' | 'title'> = filter.id === FOLDER_ID_ALL ? {
      name: i18n('FilterAllChats')
    } : {
      title: (cleanTitle = extractEmojiFromFilterTitle(filter.title)).text
    };

    const iconRest: Pick<FolderItemPayload, 'iconDocId' | 'emojiIcon'> = {
      // #266 (Kai review): an explicit pick WINS over the title emoji — for a
      // folder titled "🔥 Work" the title emoji must not mask the chosen icon.
      // When a pick exists, leave iconDocId unset so the title's
      // custom-emoji docId doesn't win inside FolderItem's FolderAnimatedIcon.
      // Unpicked folders keep today's behaviour exactly (title emoji/docId,
      // derived flag icon as last resort).
      iconDocId: folderEmoticonFallback(filter) ? undefined : cleanTitle?.docId,
      emojiIcon: folderEmoticonFallback(filter) ?? cleanTitle?.emoji
    };

    return {
      id: filter.id,
      icon: getIconForFilter(filter),
      notifications: notifications,
      chatsCount: folder?.dialogs?.length || 0,
      dontAnimate: filter.pFlags?.title_noanimate,
      ...titleRest,
      ...iconRest
    };
  }

  async function updateOrAddFolder(filter: MyDialogFilter) {
    const items = [...folderItems];
    const existingItem = items.find((item) => item.id === filter.id);

    if(existingItem) {
      updateFolderItem(filter.id, await makeFolderItemPayload(filter));
      return;
    }

    const [payload, orderedFolderItems] = await Promise.all([
      makeFolderItemPayload(filter),
      getFolderItemsInOrder(items, rootScope.managers)
    ]);

    items.push(payload);
    setFolderItems(orderedFolderItems);
  }

  async function deleteFolder(filterId: number) {
    const items = [...folderItems];
    const existingItemIndex = items.findIndex((item) => item.id === filterId);

    if(existingItemIndex === -1) return;

    const item = items[existingItemIndex];

    items.splice(existingItemIndex, 1);
    setFolderItems(items);
  }

  async function updateItemsOrder(order: number[]) {
    order = [...order];
    indexOfAndSplice(order, FOLDER_ID_ARCHIVE);

    const items = [...folderItems];

    items.sort((a, b) => {
      const aIndex = order.indexOf(a.id);
      const bIndex = order.indexOf(b.id);

      if(aIndex === -1) return -1;
      if(bIndex === -1) return 1;

      return aIndex - bIndex;
    });

    setFolderItems(items);
  }

  async function setSelectedFolder(folderId: number) {
    const isFilterAvailable = await rootScope.managers.filtersStorage.isFilterIdAvailable(folderId);
    if(!isFilterAvailable) {
      showLimitPopup('folders');
      return false;
    }

    setSelectedFolderId(folderId);
    const hasSomethingOpen = appSidebarLeft.hasSomethingOpenInside();
    appSidebarLeft.closeEverythingInside();

    hasSomethingOpen && await pause(300);
    rootScope.dispatchEventSingle('changing_folder_from_sidebar', {id: folderId});
    return true;
  }

  /**
   * Persist the Code Mode rail selection. Device-local (StateSettings), so it
   * survives a reload on this device only and is never published. The event is
   * how the inbox learns the mode moved — the rail owns the state, nothing
   * else does.
   */
  function enterCodeMode(enabled: boolean) {
    if(codeMode() === enabled) return;
    void setAppSettings(CODE_MODE_SETTING_KEY, enabled);
    rootScope.dispatchEvent(CODE_MODE_EVENT, enabled);
  }

  /**
   * Load and mount the Code inbox once, on demand. Dynamic import keeps the
   * inbox out of the boot path, so Code Mode costs nothing until it is used.
   */
  let codeInboxMounted = false;
  function ensureCodeInboxMounted() {
    if(codeInboxMounted) return;
    codeInboxMounted = true;
    void import('@components/phantomchat/codeInbox')
    .then((module) => module.mountCodeMode())
    .catch((err) => {
      codeInboxMounted = false;
      console.error('[CodeMode] mount failed', err);
    });
  }

  /**
   * Picking a real folder leaves Code Mode. If the folder cannot be selected
   * (folder limit popup already shown) the mode is left alone, so the rail
   * never lies about where the chat list is pointing.
   */
  async function selectFolderFromRail(folderId: number) {
    if(await setSelectedFolder(folderId)) {
      enterCodeMode(false);
    }
  }

  /**
   * The Code list is derived from the phantom mappings (who is a phantom) plus
   * the cached dialogs (unread + recency), so entering the mode only has to
   * park the chat list and mount the inbox. No filter, no storage, no migration.
   */
  async function selectCodeMode() {
    ensureCodeInboxMounted();
    // Same guard as selectFolderFromRail: if the chat list cannot be parked
    // (folder limit popup already shown) the rail must not claim the mode.
    if(await setSelectedFolder(FOLDER_ID_ALL)) enterCodeMode(true);
  }

  createEffect(() => {
    const _menuTarget = menuTarget();
    if(!_menuTarget) return;

    appSidebarLeft.createToolsMenu(_menuTarget);
    _menuTarget.classList.add('sidebar-tools-button', 'is-visible');
    _menuTarget.append(props.notificationsElement);
  });

  let contextMenu: ReturnType<typeof createFolderContextMenu>;
  onMount(() => {
    const listenerSetter = new ListenerSetter();

    contextMenu = createFolderContextMenu({
      appSidebarLeft,
      AppChatFoldersTab,
      AppEditFolderTab,
      managers: rootScope.managers,
      className: 'folders-sidebar__folder-item',
      listenTo: folderItemsContainer
    });

    listenerSetter.add(rootScope)('dialog_flush', ({dialog}) => {
      if(!dialog) return;
      updateAllFolderNotifications();
    });

    // `New Code Session` lives in the global pencil, outside this rail, so it
    // asks for the mode instead of setting the flag itself.
    listenerSetter.add(rootScope)(CODE_MODE_ENTER_EVENT, () => {
      void selectCodeMode();
    });

    listenerSetter.add(rootScope)('folder_unread', (filter) => {
      if(filter.id < 0) return;
      updateFolderNotifications(filter.id);
    });

    listenerSetter.add(rootScope)('filter_update', (filter) => {
      if(REAL_FOLDERS.has(filter.id)) return;
      updateOrAddFolder(filter);
    });

    listenerSetter.add(rootScope)('filter_delete', (filter) => {
      deleteFolder(filter.id);
    });

    listenerSetter.add(rootScope)('filter_order', (order) => {
      updateItemsOrder(order);
    });

    /**
     * `changing_folder_from_chatlist` also fires when the app RESTORES its
     * initial filter on boot, which would silently cancel a Code Mode the user
     * left on. Only a gesture can be a choice — but the same event is also
     * fired later by `selectStartupFolderTab` and by a folder synced in from
     * another device, so a once-only latch is wrong in the other direction: it
     * would leave a stale "the user chose" forever. A short recency window gets
     * both: a click is a choice, a background folder update is not.
     */
    let lastGestureAt = 0;
    const onUserGesture = (): void => { lastGestureAt = Date.now(); };
    document.addEventListener('pointerdown', onUserGesture, {passive: true});
    onCleanup(() => document.removeEventListener('pointerdown', onUserGesture));

    listenerSetter.add(rootScope)('changing_folder_from_chatlist', (id) => {
      setSelectedFolderId(id);
      // A tab click is an explicit choice of chat list, so it also leaves Code Mode.
      if(Date.now() - lastGestureAt < GESTURE_WINDOW_MS) enterCodeMode(false);
    });

    onCleanup(() => {
      listenerSetter.removeAll();
      contextMenu.destroy();
    });
  });

  createEffect(() => {
    if(!props.isFiltersInited) return;

    // Andrew (2026-10-29): the rail shows exactly All Chats, Groups and Code.
    // Custom folders and the archive entry are hidden, not deleted — nothing
    // migrates or wipes, they simply have no rail row any more (and with New
    // Folder and the folders settings page gone, they are no longer editable).
    const folderFilters = props.filters.filter((filter) => REAL_FOLDERS.has(filter.id) && filter.id !== FOLDER_ID_ARCHIVE);

    let cleaned = false;
    onCleanup(() => void (cleaned = true));

    (async() => {
      const folderItems = await Promise.all(folderFilters.map(makeFolderItemPayload));
      const orderedFolderItems = await getFolderItemsInOrder(folderItems, rootScope.managers);

      if(!cleaned) setFolderItems(orderedFolderItems);
    })();
  });


  createEffect(() => {
    applyCodeModeClass(document.body, codeMode());
  });

  /**
   * Code Mode is persisted per device, so a reload with the mode on must land
   * back in the inbox — mount it on boot as well as on click.
   */
  createEffect(() => {
    if(codeMode()) ensureCodeInboxMounted();
  });

  return (
    <>
      <FolderItem ref={setMenuTarget} class="folders-sidebar__menu-button" icon="menu" />

      <div class="folders-sidebar__scrollable-position">
        <Scrollable
          ref={folderItemsContainer}
          class="folders-sidebar__scrollable"
          withBorders="both"
        >
          <For each={folderItems}>{(folderItem) => {
            const {id} = folderItem;

            onCleanup(() => {
              setFolderItemRefs({[id]: undefined});
            });

            return (
              <FolderItem
                {...folderItem}
                ref={(el) => setFolderItemRefs({[id]: el})}
                selected={isSelected(id) && !codeMode()}
                onClick={() => selectFolderFromRail(id)}
              />
            );
          }}</For>

          {/*
            * Code Mode sits directly under the folder list, where Andrew sketched
            * it. It is deliberately NOT a `dialogFilter`: no filter id, no
            * filter_order entry, no FoldersSync snapshot row — see lib/code-mode.
            */}
          <FolderItem
            class="folders-sidebar__menu-button folders-sidebar__code-button"
            icon="limit_folders"
            iconText={CODE_MODE_RAIL_GLYPH}
            name={i18n(CODE_MODE_LANG_KEY)}
            selected={codeMode()}
            onClick={() => selectCodeMode()}
          />
        </Scrollable>
      </div>
    </>
  );
}

export function renderFoldersSidebarContent(
  element: HTMLElement,
  notificationsElement: HTMLElement,
  HotReloadGuardProvider: typeof SolidJSHotReloadGuardProvider,
  middleware: Middleware
): FoldersSidebarControls {
  const [hasFoldersSidebar] = useHasFoldersSidebar();
  const [filters, setFilters] = createSignal<MyDialogFilter[]>([]);
  const [isFiltersInited, setIsFiltersInited] = createSignal(false);

  const dispose = render(() => (
    <HotReloadGuardProvider>
      <Show when={hasFoldersSidebar()}>
        <FoldersSidebarContent
          notificationsElement={notificationsElement}
          filters={filters()}
          isFiltersInited={isFiltersInited()}
        />
      </Show>
    </HotReloadGuardProvider>
  ), element);
  middleware.onDestroy(dispose);

  return {
    hydrateFilters: (filters) => batch(() => {
      setFilters(filters);
      setIsFiltersInited(true);
    })
  };
}
