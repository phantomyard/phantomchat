import type {AppManagers} from '@lib/managers';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE, FOLDER_ID_SESSION_ARCHIVE} from '@appManagers/constants';
import createContextMenu from '@helpers/dom/createContextMenu';
import findUpClassName from '@helpers/dom/findUpClassName';
import {appSettings, setAppSettings} from '@stores/appSettings';
import {DEFAULT_CHAT_FOLDER_SETTING_KEY} from '@lib/folders-default';
import {toastNew} from '@components/toast';

export default function createFolderContextMenu({
  managers,
  className,
  listenTo
}: {
  managers: AppManagers,
  className: string,
  listenTo: HTMLElement
}) {
  let clickFilterId: number;
  // Archive views are read-only dead ends — nobody wants the app to open on
  // one, so Set/Remove default are suppressed there (both chat and session
  // archive). The rest of the menu still applies.
  const isArchiveFolder = (filterId: number) => filterId === FOLDER_ID_ARCHIVE || filterId === FOLDER_ID_SESSION_ARCHIVE;
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
      verify: () => !isArchiveFolder(clickFilterId) && appSettings[DEFAULT_CHAT_FOLDER_SETTING_KEY] !== clickFilterId
    }, {
      icon: 'close',
      text: 'ChatList.Filter.RemoveDefault',
      onClick: () => {
        setDefaultFolder(FOLDER_ID_ALL);
      },
      verify: () => !isArchiveFolder(clickFilterId) && appSettings[DEFAULT_CHAT_FOLDER_SETTING_KEY] === clickFilterId && clickFilterId !== FOLDER_ID_ALL
    }, {
      // Owner batch 6 (2026-10-30): the "Edit folders" entry is gone — folders
      // are code-defined, so there is no folder-editing surface to send anyone
      // to. Set/Remove default and Mark all as read stay.
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
