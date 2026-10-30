import type {AppManagers} from '@lib/managers';
import type AppChatFoldersTab from '@components/sidebarLeft/tabs/chatFolders';
import type {AppSidebarLeft} from '@components/sidebarLeft';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE} from '@appManagers/constants';
import createContextMenu from '@helpers/dom/createContextMenu';
import findUpClassName from '@helpers/dom/findUpClassName';
import {appSettings, setAppSettings} from '@stores/appSettings';
import {DEFAULT_CHAT_FOLDER_SETTING_KEY} from '@lib/folders-default';
import {toastNew} from '@components/toast';

export default function createFolderContextMenu({
  appSidebarLeft,
  AppChatFoldersTab: _AppChatFoldersTab,
  managers,
  className,
  listenTo
}: {
  appSidebarLeft: AppSidebarLeft,
  AppChatFoldersTab: typeof AppChatFoldersTab,
  managers: AppManagers,
  className: string,
  listenTo: HTMLElement
}) {
  let clickFilterId: number;
  const setDefaultFolder = (filterId: number) => {
    // All Chats is the natural fallback — picking it just clears the preference.
    setAppSettings(DEFAULT_CHAT_FOLDER_SETTING_KEY, filterId === FOLDER_ID_ALL ? undefined : filterId);
    toastNew({langPackKey: filterId === FOLDER_ID_ALL ? 'ChatList.Filter.RemoveDefaultToast' : 'ChatList.Filter.SetDefaultToast'});
  };

  const {destroy} = createContextMenu({
    buttons: [{
      icon: 'star',
      text: 'ChatList.Filter.SetDefault',
      onClick: () => {
        setDefaultFolder(clickFilterId);
      },
      verify: () => appSettings[DEFAULT_CHAT_FOLDER_SETTING_KEY] !== clickFilterId
    }, {
      icon: 'close',
      text: 'ChatList.Filter.RemoveDefault',
      onClick: () => {
        setDefaultFolder(FOLDER_ID_ALL);
      },
      verify: () => appSettings[DEFAULT_CHAT_FOLDER_SETTING_KEY] === clickFilterId && clickFilterId !== FOLDER_ID_ALL
    }, {
      icon: 'edit',
      text: 'FilterEditAll',
      onClick: () => {
        appSidebarLeft.closeTabsBefore(() => {
          appSidebarLeft.createTab(_AppChatFoldersTab).open();
        });
      },
      verify: () => clickFilterId === FOLDER_ID_ALL
    }, {
      icon: 'readchats',
      text: 'MarkAllAsRead',
      onClick: () => {
        managers.dialogsStorage.markFolderAsRead(clickFilterId);
      },
      verify: async() => !!(await managers.dialogsStorage.getFolderUnreadCount(clickFilterId)).unreadCount
    }],
    listenTo,
    findElement: (e) => findUpClassName(e.target, className),
    onOpen: (e, target) => {
      clickFilterId = +target.dataset.filterId;
    }
  });

  return {destroy};
}
