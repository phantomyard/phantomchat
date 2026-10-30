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
import useHasFoldersSidebar from '@stores/foldersSidebar';
import Scrollable from '@components/scrollable2';
import extractEmojiFromFilterTitle, {ExtractEmojiFromFilterTitleResult} from '@components/sidebarLeft/foldersSidebarContent/extractEmojiFromFilterTitle';
import FolderItem from '@components/sidebarLeft/foldersSidebarContent/folderItem';
import type {FolderItemPayload} from '@components/sidebarLeft/foldersSidebarContent/types';
import {getFolderItemsInOrder, getIconForFilter, getNotificationCountForFilter, folderEmoticonFallback} from '@components/sidebarLeft/foldersSidebarContent/utils';
import {toggleFoldersSidebar} from '@lib/folders-sidebar-layout';


const log = logger('FoldersSidebarContent', LogTypes.Debug);


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
    showLimitPopup,
    i18n
  } = useHotReloadGuard();

  const [selectedFolderId, setSelectedFolderId] = createSignal<number>(FOLDER_ID_ALL);
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
      managers: rootScope.managers,
      className: 'folders-sidebar__folder-item',
      listenTo: folderItemsContainer
    });

    listenerSetter.add(rootScope)('dialog_flush', ({dialog}) => {
      if(!dialog) return;
      updateAllFolderNotifications();
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

    listenerSetter.add(rootScope)('changing_folder_from_chatlist', (id) => {
      setSelectedFolderId(id);
    });

    onCleanup(() => {
      listenerSetter.removeAll();
      contextMenu.destroy();
    });
  });

  createEffect(() => {
    if(!props.isFiltersInited) return;

    const folderFilters = props.filters.filter((filter) => filter.id !== FOLDER_ID_ARCHIVE);

    let cleaned = false;
    onCleanup(() => void (cleaned = true));

    (async() => {
      const folderItems = await Promise.all(folderFilters.map(makeFolderItemPayload));
      const orderedFolderItems = await getFolderItemsInOrder(folderItems, rootScope.managers);

      if(!cleaned) setFolderItems(orderedFolderItems);
    })();
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
                selected={isSelected(id)}
                onClick={() => setSelectedFolder(id)}
              />
            );
          }}</For>
        </Scrollable>
      </div>

      {/* Owner batch 8 (2026-10-30): same glyph as the hamburger's "Disable
          Sidebar" entry — the two are the same toggle, so they must not look
          like different actions. */}
      <FolderItem
        class="folders-sidebar__menu-button"
        icon="rightpanel"
        onClick={() => {
          // Owner batch 6 (2026-10-30): this button used to open the Chat Folders
          // settings page (the only place the left/top layout could be changed).
          // With folder management gone there is nothing left to edit, so it is
          // the layout toggle itself — the same preference the hamburger's
          // "Disable Sidebar" flips.
          toggleFoldersSidebar();
        }}
      />
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
