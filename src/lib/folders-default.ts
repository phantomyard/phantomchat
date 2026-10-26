/*
 * Preferred chat folder on startup (#267).
 *
 * The preference lives in the common app settings store
 * (StateSettings.defaultChatFolderId) and is therefore DEVICE-LOCAL: common
 * settings persist to this browser's IndexedDB and are never published to
 * Nostr. Folder data itself syncs cross-device via FoldersSync, but which
 * folder opens at launch is a per-device comfort setting, same category as
 * `tabsInSidebar` or `showArchiveInChatList`.
 *
 * All decision logic here is pure so it is unit-testable without the app.
 */

import {isChatDeepLink} from '@lib/phantomchat/phantomchat-launch-dialogs';
import {FOLDER_ID_ALL} from '@appManagers/constants';

/** StateSettings key under `settings.` where the preferred folder id lives. */
export const DEFAULT_CHAT_FOLDER_SETTING_KEY = 'defaultChatFolderId' as const;

/**
 * URL hash captured at module load. The app consumes and clears the hash
 * early during boot (appImManager.onHashChange → replaceState), so a
 * capture taken later would never see the launch deep link.
 */
const LAUNCH_HASH = typeof location !== 'undefined' ? location.hash : '';

/** True when the app was launched with a link that opens a specific chat. */
export function wasLaunchedWithChatDeepLink(): boolean {
  return isChatDeepLink(LAUNCH_HASH);
}

/**
 * Resolve the preferred folder id to a folder that actually exists.
 * All Chats (or a missing/invalid id) falls back to FOLDER_ID_ALL, the
 * app's natural initial view.
 */
export function effectiveDefaultFolderId(
  preferred: number | undefined,
  availableFilterIds: Iterable<number>
): number {
  if(preferred === undefined || !Number.isInteger(preferred)) {
    return FOLDER_ID_ALL;
  }

  // Storing FOLDER_ID_ALL is normalized to "no preference": All Chats is
  // already the fallback, so there is nothing to remember.
  if(preferred === FOLDER_ID_ALL) {
    return FOLDER_ID_ALL;
  }

  return new Set(availableFilterIds).has(preferred) ? preferred : FOLDER_ID_ALL;
}

/**
 * Folder id the chat list should open on fresh startup. A deep link to a
 * specific chat always takes precedence over the preference — the deep link
 * decides what the user sees, so the folder list stays on its All Chats
 * default and does not move the view out from under the link.
 */
export function startupFolderId({preferred, availableFilterIds, launchedWithDeepLink}: {
  preferred?: number,
  availableFilterIds: Iterable<number>,
  launchedWithDeepLink: boolean
}): number {
  if(launchedWithDeepLink) {
    return FOLDER_ID_ALL;
  }

  return effectiveDefaultFolderId(preferred, availableFilterIds);
}
