import anchorCallback from '@helpers/dom/anchorCallback';
import createContextMenu from '@helpers/dom/createContextMenu';
import findUpTag from '@helpers/dom/findUpTag';
import noop from '@helpers/noop';
import {FOLDER_ID_ARCHIVE} from '@lib/appManagers/constants';
import {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {archiveDialogTagName} from './archiveDialog';
import confirmationPopup from './confirmationPopup';
import createFeatureDetailsIconSticker from './featureDetailsIconSticker';
import showFeatureDetailsPopup from './popups/featureDetails';
import appSidebarLeft from './sidebarLeft';
import {AppArchiveSettingsTab} from './solidJsTabs/tabs';
import {ButtonMenuItemOptionsVerifiable} from './buttonMenu';


type CreateArchiveDialogContextMenuArgs = {
  element: HTMLElement;
};

const showConfirmationWhenAbove = 1000;

export const createArchiveDialogContextMenu = ({
  element
}: CreateArchiveDialogContextMenuArgs) => {
  let dialogElement: HTMLElement;

  createContextMenu({
    listenTo: element,
    buttons: getArchiveContextMenuButtons(),
    onOpen: async(_, li) => {
      dialogElement = li;
      li.classList.add('menu-open');
    },
    onClose: () => {
      dialogElement.classList.remove('menu-open');
    },
    findElement: (e) => {
      return findUpTag(e.target, archiveDialogTagName);
    }
  });
};

export const getArchiveContextMenuButtons = (): ButtonMenuItemOptionsVerifiable[] => {
  const markAllAsRead = createMarkAllAsReadHandler();

  return [
    // Owner batch 14: the "show/hide archive row in the chat list" pair is
    // gone with the pinned row itself (Archives is a rail space now), so
    // there is nothing left for these toggles to toggle.
    {
      icon: 'readchats',
      text: 'MarkAllAsRead',
      onClick: async() => {
        const unreadCount = await getUnreadCount();
        if(unreadCount > showConfirmationWhenAbove) {
          confirmationPopup({
            titleLangKey: 'Archive.MarkAllAsRead.ConfirmationTitle',
            descriptionLangKey: 'Archive.MarkAllAsRead.ConfirmationDescription',
            button: {
              langKey: 'Confirm'
            }
          }).then(() => {
            markAllAsRead();
          }, noop);
        } else {
          markAllAsRead();
        }
      },
      verify: async() => !markAllAsRead.isLoading() && (await getUnreadCount() > 0)
    },
    {
      icon: 'tools',
      text: 'ArchiveSettings',
      onClick: () => {
        appSidebarLeft.createTab(AppArchiveSettingsTab).open();
      }
    },
    {
      icon: 'help',
      text: 'ArchiveFeatureDetails.MenuOption',
      onClick: () => {
        openFeatureDetails();
      }
    }
  ]
};

function createMarkAllAsReadHandler() {
  let isLoading = false;

  const markAllAsRead = async() => {
    try {
      isLoading = true;
      rootScope.managers.dialogsStorage.markFolderAsRead(FOLDER_ID_ARCHIVE);
    } finally {
      isLoading = false;
    }
  };

  markAllAsRead.isLoading = () => isLoading;

  return markAllAsRead;
};

async function getUnreadCount() {
  const {unreadCount} = await rootScope.managers.dialogsStorage.getFolderUnreadCount(FOLDER_ID_ARCHIVE);
  return unreadCount;
};

function openFeatureDetails() {
  const close = showFeatureDetailsPopup({
    title: i18n('ArchiveFeatureDetails.Title'),
    subtitle: i18n('ArchiveFeatureDetails.Subtitle', [anchorCallback(() => {
      close();
      appSidebarLeft.createTab(AppArchiveSettingsTab).open();
    })]),
    rows: [
      {
        icon: 'archive',
        title: i18n('ArchiveFeatureDetails.HowTo.Title'),
        subtitle: i18n('ArchiveFeatureDetails.HowTo.Subtitle', [i18n('Archive'), i18n('Unarchive')])
      },
      {
        icon: 'eyecross_outline',
        title: i18n('ArchiveFeatureDetails.Hide.Title'),
        subtitle: i18n('ArchiveFeatureDetails.Hide.Subtitle', [i18n('Archive.HideFromChatList')])
      },
      {
        icon: 'story',
        title: i18n('ArchiveFeatureDetails.Stories.Title'),
        subtitle: i18n('ArchiveFeatureDetails.Stories.Subtitle')
      }
    ],
    buttons: [
      {
        text: i18n('ArchiveFeatureDetails.Button')
      }
    ],
    sticker: {
      element: createFeatureDetailsIconSticker('archive_filled', 'background-gradient-archive')
    }
  });
}
