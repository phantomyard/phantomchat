/*
 * PhantomChat — folders layout switch (owner batch 6, 2026-10-30)
 *
 * ONE place that flips the single stored preference (`settings.tabsInSidebar`)
 * and all the runtime side effects that follow it:
 *   - true  → folders live in the left rail ("Folders on the Left")
 *   - false → the rail is gone and folders sit above the chat list
 *             ("Folders above chats", i.e. what the menu calls "Disable Sidebar")
 *
 * Before this, only the Chat Folders settings page wrote the preference (via a
 * RadioField), so anything else that toggled it had to remember to also sync the
 * `hasFoldersSidebar` signal and re-render the chat pattern background. The
 * sidebar toggle and the rail's own bottom button both go through here now.
 */

import {appSettings, setAppSettings} from '@stores/appSettings';
import useHasFoldersSidebar from '@stores/foldersSidebar';
import appImManager from '@lib/appImManager';

/** True when the folders rail is showing on the left. */
export function isFoldersSidebarEnabled() {
  return !!appSettings.tabsInSidebar;
}

/**
 * Move folders between the left rail and a strip above the chat list.
 * Idempotent: calling it with the value already in effect is a no-op.
 */
export function setFoldersSidebarEnabled(enabled: boolean) {
  const [, setHasFoldersSidebar] = useHasFoldersSidebar();
  // The signal drives `body.has-folders-sidebar` (stores/foldersSidebar), which
  // is what the CSS actually keys off — so it has to move with the setting.
  setHasFoldersSidebar(enabled);

  if(isFoldersSidebarEnabled() === enabled) return;

  setAppSettings('tabsInSidebar', enabled);

  // The chat background pattern is sized from the column it sits in, so it has
  // to be remeasured once the rail is gone.
  appImManager.adjustChatPatternBackground();

  if(!enabled) {
    // Same nudge the settings page gave when the rail went away: the search box
    // is the only entry point left, so point at its shortcut.
    import('@components/sidebarLeft').then(({default: appSidebarLeft}) => {
      appSidebarLeft.showCtrlFTip();
    });
  }
}

export function toggleFoldersSidebar() {
  setFoldersSidebarEnabled(!isFoldersSidebarEnabled());
}
