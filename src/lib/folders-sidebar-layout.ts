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
 *
 * The one other writer of the key is the `RadioField`s inside
 * `components/sidebarLeft/tabs/chatFolders.ts` (stateKey
 * `settings.tabsInSidebar`). That tab is unreachable by decision - it was
 * dropped from the folder context menu and from the hamburger - so those radios
 * are dead code rather than a live second writer, and they stay for the same
 * reason `editFolder.ts` does. Anything reachable goes through here.
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
 * Idempotent: calling it with the value already in effect changes nothing - the
 * signal is only written when it has actually drifted, and the background
 * remeasure and Ctrl+F tip are skipped entirely.
 */
export function setFoldersSidebarEnabled(enabled: boolean) {
  const [hasFoldersSidebar, setHasFoldersSidebar] = useHasFoldersSidebar();
  const current = isFoldersSidebarEnabled();

  if(current === enabled) {
    // Still reconcile the signal if something else moved the stored value
    // without it: the signal drives `body.has-folders-sidebar`, which is what
    // the CSS keys off. A write here is a no-op when they already agree.
    if(hasFoldersSidebar() !== enabled) setHasFoldersSidebar(enabled);
    return;
  }

  // The signal drives `body.has-folders-sidebar` (stores/foldersSidebar), which
  // is what the CSS actually keys off — so it has to move with the setting.
  setHasFoldersSidebar(enabled);
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
