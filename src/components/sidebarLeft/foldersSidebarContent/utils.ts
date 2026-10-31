
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE, FOLDER_ID_SESSION} from '@appManagers/constants';
import type {AppManagers} from '@lib/managers';
import {MyDialogFilter} from '@lib/storages/filters';
import {DialogFilter} from '@layer';
import assumeType from '@helpers/assumeType';

import {FolderItemPayload} from '@components/sidebarLeft/foldersSidebarContent/types';

export async function getNotificationCountForFilter(filterId: number, managers: AppManagers) {
  const {
    unreadUnmutedCount,
    unreadCount,
    unreadMentionsCount
  } = await managers.dialogsStorage.getFolderUnreadCount(filterId);

  return {
    count: filterId === FOLDER_ID_ALL ? unreadUnmutedCount : unreadCount,
    muted: !unreadUnmutedCount && !!unreadCount && !unreadMentionsCount
  };
}

export function getIconForFilter(filter: MyDialogFilter): Icon {
  if(filter.id === FOLDER_ID_ALL) return 'round_chats_filled';
  // Archives renders as a space in the rail (its pFlags carry no entity kind,
  // so the derived-icon walk below would fall through to 'limit_folders').
  if(filter.id === FOLDER_ID_ARCHIVE) return 'archive';
  // Sessions never render a font icon — the row draws a literal `#` (see
  // FolderItemPayload.glyph). This fallback only feeds the payload for
  // completeness, so any icon key will do.
  if(filter.id === FOLDER_ID_SESSION) return 'tag';
  const matchedIcons: Icon[] = [];

  assumeType<DialogFilter.dialogFilter>(filter);
  if(filter.pFlags.contacts) matchedIcons.push('person');
  if(filter.pFlags.bots) matchedIcons.push('bot_filled');
  if(filter.pFlags.broadcasts) matchedIcons.push('channel_filled');
  if(filter.pFlags.groups) matchedIcons.push('group_filled');
  if(filter.pFlags.non_contacts) matchedIcons.push('noncontacts');

  if(matchedIcons.length === 1) return matchedIcons[0];
  return 'limit_folders';
}

/**
 * #266: fallback icon emoji for a folder whose title carries no emoji.
 * Custom folders (and renamable system folders like Groups) may set
 * `filter.emoticon` via the edit-folder icon picker; All Chats keeps its
 * built-in icon, so it never falls back to an emoticon.
 */
export function folderEmoticonFallback(filter: MyDialogFilter): string | undefined {
  if(filter.id === FOLDER_ID_ALL) return undefined;
  assumeType<DialogFilter.dialogFilter>(filter);
  return filter.emoticon || undefined;
}

export async function getFolderItemsInOrder(folderItems: FolderItemPayload[], managers: AppManagers) {
  const filters = new Map<number, MyDialogFilter>();

  const filtersPromises = folderItems
  .filter((item) => item.id)
  .map((item) => managers.filtersStorage.getFilter(item.id));
  const filtersArr = await Promise.all(filtersPromises);
  for(const filter of filtersArr) {
    filters.set(filter.id, filter);
  }

  return folderItems.sort((a, b) => {
    if(!a.id || !b.id) return 0;
    return filters.get(a.id)?.localId - filters.get(b.id)?.localId;
  });
}
