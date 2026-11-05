/*
 * Shared peer-actions entry points.
 *
 * One source of truth for how an "Edit" action is routed for a peer, so the
 * topbar avatar click, the chat-list row of the already-open chat, the
 * chat-list context menu and the topbar hamburger menu can never drift apart:
 *   - Phantom groups  -> AppPhantomChatGroupEditTab
 *   - P2P contacts / users -> AppEditContactTab
 *   - MTProto groups / channels -> native peer-info sidebar
 *
 * Every entry point TOGGLES: with the pane closed the peer's editor is opened,
 * with the pane already showing that same peer it is closed again. The
 * decision itself lives in `planPeerEditorToggle` so it is unit-testable.
 *
 * Tabs are imported dynamically to avoid circular imports: the edit tabs
 * themselves pull in large parts of the sidebar / chat graph.
 */

import appSidebarRight, {RIGHT_COLUMN_ACTIVE_CLASSNAME} from '@components/sidebarRight';
import type {ButtonMenuItemOptionsVerifiable} from '@components/buttonMenu';
import {isGroupPeer} from '@lib/phantomchat/group-types';
import {isP2PPeerId} from '@lib/phantomchat/bridge-invariants';
import {planPeerEditorToggle} from '@lib/phantomchat/peer-editor-toggle';
import type {SliderSuperTab} from '@components/slider';
import type {SliderSuperTabConstructable} from '@components/sliderTab';

type PeerEditorTab = SliderSuperTab & {
  groupPeerId?: number,
  peerId?: PeerId
};

export function isPhantomEditablePeer(peerId: PeerId): boolean {
  const numId = +peerId;
  return isGroupPeer(numId) || isP2PPeerId(numId) || !!peerId?.isUser?.();
}

/**
 * Opens the peer's editor tab, or closes it when it is already on screen.
 * `getPeerId`/`setPeerId` keep the group and contact tabs' own field names
 * out of the shared toggle.
 */
async function togglePeerEditorTab(
  ctor: SliderSuperTabConstructable<PeerEditorTab>,
  peerId: number,
  getPeerId: (tab: PeerEditorTab) => number,
  setPeerId: (tab: PeerEditorTab, peerId: number) => void
) {
  const plan = planPeerEditorToggle({
    history: appSidebarRight.getHistory(),
    isSidebarOpen: document.body.classList.contains(RIGHT_COLUMN_ACTIVE_CLASSNAME),
    isEditorTab: (tab): tab is PeerEditorTab => tab instanceof ctor,
    isSamePeer: (tab) => getPeerId(tab) === peerId
  });

  if(plan.action === 'close') {
    // Pop the tab, don't just hide the column: `toggleSidebar(false)` leaves
    // the tab in the slider history, and the next open re-selects it and
    // animates the pane back in. `closeTab` runs the tab's own close path and
    // hides the column once the history empties (mirrors the pane's X button).
    appSidebarRight.closeTab(plan.tab);
    appSidebarRight.toggleSidebar(false);
    return;
  }

  // One live editor pane at a time: a stale tab for another peer (or one left
  // behind by a hide that never popped it) would otherwise pile up in history.
  plan.staleTabs.forEach((tab) => appSidebarRight.closeTab(tab));

  const tab = appSidebarRight.createTab(ctor, true) as PeerEditorTab;
  setPeerId(tab, peerId);
  // Await open() BEFORE toggling the sidebar: open() only pushes the tab
  // into the slider's history after the async init() resolves, and
  // toggleSidebar() falls back to opening the native peer-info tab
  // (sharedMediaTab) whenever history is empty — that race is what made the
  // old User Info screen flash before the editor appeared.
  await tab.open();
  appSidebarRight.toggleSidebar(true);
}

export async function openPeerEditor(peerId: PeerId) {
  const numId = +peerId;

  if(isGroupPeer(numId)) {
    const {default: GroupEditTab} = await import('@components/sidebarRight/tabs/phantomchatGroupEdit');
    await togglePeerEditorTab(
      GroupEditTab,
      numId,
      (tab) => +tab.groupPeerId,
      (tab, id) => (tab.groupPeerId = id)
    );
    return;
  }

  if(isP2PPeerId(numId) || peerId?.isUser?.()) {
    const {default: EditContactTab} = await import('@components/sidebarRight/tabs/editContact');
    await togglePeerEditorTab(
      EditContactTab,
      numId,
      (tab) => +tab.peerId,
      (tab, id) => (tab.peerId = id.toPeerId())
    );
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
