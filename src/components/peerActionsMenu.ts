/*
 * Shared peer-actions entry points.
 *
 * One source of truth for how an "Edit" action is routed for a peer, so the
 * topbar avatar click, the chat-list context menu and the topbar hamburger
 * menu can never drift apart:
 *   - Phantom groups  -> AppPhantomChatGroupEditTab
 *   - P2P contacts / users -> AppEditContactTab
 *   - MTProto groups / channels -> native peer-info sidebar
 *
 * Tabs are imported dynamically to avoid circular imports: the edit tabs
 * themselves pull in large parts of the sidebar / chat graph.
 */

import appSidebarRight, {RIGHT_COLUMN_ACTIVE_CLASSNAME} from '@components/sidebarRight';
import type {ButtonMenuItemOptionsVerifiable} from '@components/buttonMenu';
import {isGroupPeer} from '@lib/phantomchat/group-types';
import {isP2PPeerId} from '@lib/phantomchat/bridge-invariants';
import type {SliderSuperTab} from '@components/slider';

export function isPhantomEditablePeer(peerId: PeerId): boolean {
  const numId = +peerId;
  return isGroupPeer(numId) || isP2PPeerId(numId) || !!peerId?.isUser?.();
}

export async function openPeerEditor(peerId: PeerId) {
  const numId = +peerId;
  const isSidebarOpen = document.body.classList.contains(RIGHT_COLUMN_ACTIVE_CLASSNAME);

  if(isGroupPeer(numId)) {
    const {default: GroupEditTab} = await import('@components/sidebarRight/tabs/phantomchatGroupEdit');
    const existingTab = appSidebarRight.getTab(GroupEditTab) as SliderSuperTab & {groupPeerId?: number};
    if(isSidebarOpen && existingTab && existingTab.groupPeerId === numId) {
      appSidebarRight.toggleSidebar(false);
    } else {
      const tab = appSidebarRight.createTab(GroupEditTab, true) as SliderSuperTab & {groupPeerId: number};
      tab.groupPeerId = numId;
      // Await open() BEFORE toggling the sidebar: open() only pushes the tab
      // into the slider's history after the async init() resolves, and
      // toggleSidebar() falls back to opening the native peer-info tab
      // (sharedMediaTab) whenever history is empty — that race is what made
      // the old User Info screen flash before the editor appeared.
      await tab.open();
      appSidebarRight.toggleSidebar(true);
    }
    return;
  }

  if(isP2PPeerId(numId) || peerId?.isUser?.()) {
    const {default: EditContactTab} = await import('@components/sidebarRight/tabs/editContact');
    const existingTab = appSidebarRight.getTab(EditContactTab) as SliderSuperTab & {peerId?: PeerId};
    if(isSidebarOpen && existingTab && existingTab.peerId === peerId) {
      appSidebarRight.toggleSidebar(false);
    } else {
      const tab = appSidebarRight.createTab(EditContactTab, true) as SliderSuperTab & {peerId: PeerId};
      tab.peerId = peerId;
      // Same ordering rule as the group branch above.
      await tab.open();
      appSidebarRight.toggleSidebar(true);
    }
    return;
  }

  // MTProto groups / channels / anything else: native peer-info sidebar.
  appSidebarRight.toggleSidebar(true);
}

/**
 * Canonical "Edit" menu button for any peer context menu
 * (chat-list right-click, topbar hamburger, topbar right-click, ...).
 */
export function peerEditMenuButton(
  getPeerId: () => PeerId
): ButtonMenuItemOptionsVerifiable {
  return {
    icon: 'edit',
    text: 'Edit',
    onClick: () => {
      openPeerEditor(getPeerId());
    },
    verify: () => isPhantomEditablePeer(getPeerId())
  };
}
