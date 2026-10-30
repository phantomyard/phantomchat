/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {MyDialogFilter} from '@lib/storages/filters';
import type {DialogFilter, DialogFilterSuggested} from '@layer';
import type _rootScope from '@lib/rootScope';
import {SliderSuperTab} from '@components/slider';
import lottieLoader, {LottieLoader} from '@lib/rlottie/lottieLoader';
import rootScope from '@lib/rootScope';
import Row from '@components/row';
import {i18n, i18n_, LangPackKey, join} from '@lib/langPack';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import positionElementByIndex from '@helpers/dom/positionElementByIndex';
import RLottiePlayer from '@lib/rlottie/rlottiePlayer';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE, FOLDER_ID_GROUPS} from '@appManagers/constants';
import replaceContent from '@helpers/dom/replaceContent';
import SettingSection from '@components/settingSection';
import {joinDeepPath} from '@helpers/object/setDeepProperty';
import RadioField from '@components/radioField';
import appImManager from '@lib/appImManager';
import appSidebarLeft from '..';
import wrapFolderTitle from '@components/wrappers/folderTitle';
import useHasFoldersSidebar from '@stores/foldersSidebar';
import {isProtectedFolder} from '@lib/phantomchat/folders-protection';

export default class AppChatFoldersTab extends SliderSuperTab {
  private foldersSection: SettingSection;
  private viewSection: SettingSection;
  private stickerContainer: HTMLElement;
  private animation: RLottiePlayer;
  private list: HTMLElement;

  private filtersRendered: {[filterId: number]: Row} = {};
  private loadAnimationPromise: ReturnType<LottieLoader['waitForFirstFrame']>;

  public static getInitArgs() {
    return {
      animationData: lottieLoader.loadAnimationFromURLManually('Folders_1'),
      filters: rootScope.managers.filtersStorage.getDialogFilters()
    };
  }

  private async renderFolder(
    dialogFilter: DialogFilterSuggested | MyDialogFilter,
    container?: HTMLElement,
    row?: Row,
    append?: boolean
  ) {
    let filter: MyDialogFilter;
    let description = '';
    const d: HTMLElement[] = [];
    if(dialogFilter._ === 'dialogFilterSuggested') {
      filter = dialogFilter.filter as MyDialogFilter;
      description = dialogFilter.description;
    } else {
      filter = dialogFilter;

      const pFlags = (filter as DialogFilter.dialogFilter).pFlags || {};
      const enabledFilters = Object.keys(pFlags).length;
      /* (['include_peers', 'exclude_peers'] as ['include_peers', 'exclude_peers']).forEach((key) => {
        enabledFilters += +!!filter[key].length;
      }); */

      if(enabledFilters === 1) {
        let k: LangPackKey;
        if(pFlags.contacts) k = 'FilterAllContacts';
        else if(pFlags.non_contacts) k = 'FilterAllNonContacts';
        else if(pFlags.groups) k = 'FilterAllGroups';
        else if(pFlags.broadcasts) k = 'FilterAllChannels';
        else if(pFlags.bots) k = 'FilterAllBots';

        if(k) {
          d.push(i18n(k));
        }
      }

      if(!d.length) {
        // Chats (0) is group-free by presentation rule (see
        // DialogsStorage.getFolderDialogs), so the group bucket has to be read from
        // the built-in Groups folder or this subtitle can never show one.
        const folder = (await this.managers.dialogsStorage.getFolderDialogs(filter.id)).concat(
          filter.id === FOLDER_ID_ALL ? await this.managers.dialogsStorage.getFolderDialogs(FOLDER_ID_GROUPS) : []
        );
        let chats = 0, channels = 0, groups = 0;
        await Promise.all(folder.map(async(dialog) => {
          if(await this.managers.appPeersManager.isAnyGroup(dialog.peerId)) ++groups;
          else if(await this.managers.appPeersManager.isBroadcast(dialog.peerId)) ++channels;
          else ++chats;
        }));

        if(chats) d.push(i18n('Chats', [chats]));
        if(channels) d.push(i18n('Channels', [channels]));
        if(groups) d.push(i18n('Groups', [groups]));
      }
    }

    if(!row) {
      const isSuggested = dialogFilter._ === 'dialogFilterSuggested';
      const resolvedTitle = filter.id === FOLDER_ID_ALL && !isSuggested ?
        i18n('FilterAllChats') :
        await wrapFolderTitle(filter.title, this.middlewareHelper.get(), false, {textColor: 'primary-text-color'});
      row = new Row({
        title: resolvedTitle,
        subtitle: description,
        clickable: true,
        buttonRightLangKey: isSuggested ? 'Add' : undefined
      });

      if(d.length) {
        row.subtitle.append(...join(d));
      }

      if(!isSuggested) {
        // Folders are code-defined (folders-default / filtersLocal): the list is
        // display-only, so rows are not clickable and cannot be reordered.
        this.filtersRendered[filter.id] = row;
      }
    } else {
      if(filter.id !== FOLDER_ID_ALL) {
        const updatedTitle = await wrapFolderTitle(filter.title, this.middlewareHelper.get());
        replaceContent(row.title, updatedTitle);
      }

      row.subtitle.textContent = '';
      row.subtitle.append(...join(d));
    }

    const div = row.container;

    if(append) {
      const localId = (filter as MyDialogFilter).localId;
      if(localId !== undefined) {
        // ! header will be at 0 index
        positionElementByIndex(div, div.parentElement || container, localId);
      } else if(container) {
        container.append(div);
      }
    }

    return row;
  }

  public init(p: ReturnType<typeof AppChatFoldersTab['getInitArgs']> = AppChatFoldersTab.getInitArgs()) {
    this.container.classList.add('chat-folders-container');
    this.setTitle('ChatList.Filter.List.Title');

    this.scrollable.container.classList.add('chat-folders');

    this.stickerContainer = document.createElement('div');
    this.stickerContainer.classList.add('sticker-container');

    const caption = document.createElement('div');
    caption.classList.add('caption');
    i18n_({element: caption, key: 'ChatList.Filter.Header'});

    this.foldersSection = new SettingSection({
      name: 'Filters'
    });
    this.foldersSection.container.classList.add('hide');

    this.list = document.createElement('div');
    this.foldersSection.content.append(this.list);

    this.viewSection = new SettingSection({
      name: 'FiltersView'
    });

    const form = document.createElement('form');

    const name = 'theme';
    const stateKey = joinDeepPath('settings', 'tabsInSidebar');

    const onLeftRow = new Row({
      radioField: new RadioField({
        langKey: 'FiltersOnLeft',
        name,
        value: 'true',
        valueForState: true,
        stateKey
      })
    });

    const nonTopRow = new Row({
      radioField: new RadioField({
        langKey: 'FiltersOnTop',
        name,
        value: 'false',
        valueForState: false,
        stateKey
      })
    });

    this.listenerSetter.add(rootScope)('settings_updated', ({key, value}) => {
      if(key === stateKey) {
        const [, setHasFoldersSidebar] = useHasFoldersSidebar();
        setHasFoldersSidebar(!!value);
        appImManager.adjustChatPatternBackground();
        if(!value) appSidebarLeft.showCtrlFTip();
      }
    });

    form.append(onLeftRow.container, nonTopRow.container);
    this.viewSection.content.append(form);

    this.scrollable.append(
      this.stickerContainer,
      caption,
      this.foldersSection.container,
      this.viewSection.container
    );

    const onFiltersContainerUpdate = () => {
      this.foldersSection.container.classList.toggle('hide', !Object.keys(this.filtersRendered).length);
    };

    const loadPromises: Promise<any>[] = [];
    const renderFiltersPromise = p.filters.then(async(filters) => {
      for(const filter of filters) {
        if(filter.id === FOLDER_ID_ARCHIVE) {
          continue;
        }

        await this.renderFolder(filter, this.list, undefined, true);
      }

      this.toggleAllChats();

      onFiltersContainerUpdate();
    });

    loadPromises.push(renderFiltersPromise);

    this.listenerSetter.add(rootScope)('filter_update', async(filter) => {
      const filterRendered = this.filtersRendered[filter.id];
      if(filterRendered) {
        await this.renderFolder(filter, null, filterRendered);
      } else if(filter.id !== FOLDER_ID_ARCHIVE) {
        await this.renderFolder(filter, this.list, undefined, true);
      }

      onFiltersContainerUpdate();
    });

    this.listenerSetter.add(rootScope)('filter_delete', (filter) => {
      const filterRendered = this.filtersRendered[filter.id];
      if(filterRendered) {
        filterRendered.container.remove();
        delete this.filtersRendered[filter.id];
      }

      onFiltersContainerUpdate();
    });

    this.listenerSetter.add(rootScope)('filter_order', (order) => {
      order.filter((filterId) => !!this.filtersRendered[filterId]).forEach((filterId, idx) => {
        const filterRendered = this.filtersRendered[filterId];
        const container = filterRendered.container;
        positionElementByIndex(container, container.parentElement, idx + 1); // ! + 1 due to header
      });
    });

    this.listenerSetter.add(rootScope)('premium_toggle', () => {
      this.toggleAllChats();
    });

    this.loadAnimationPromise = p.animationData.then(async(cb) => {
      const player = await cb({
        container: this.stickerContainer,
        loop: false,
        autoplay: false,
        width: 86,
        height: 86
      });

      this.animation = player;

      return lottieLoader.waitForFirstFrame(player);
    });

    loadPromises.push(this.loadAnimationPromise);

    /* return Promise.all([
      this.loadAnimationPromise
    ]); */
    return Promise.all(loadPromises);
  }

  onOpenAfterTimeout() {
    this.loadAnimationPromise.then(() => {
      this.animation.autoplay = true;
      this.animation.play();
    });

    return super.onOpenAfterTimeout();
  }

  private toggleAllChats() {
    const filterRendered = this.filtersRendered[FOLDER_ID_ALL];
    filterRendered.container.classList.toggle('hide', !rootScope.premium);
  }
}
