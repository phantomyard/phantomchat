/**
 * The editor pane closes on any click that is not its own (owner, 2026-11-10):
 * clicking another chat, switching a sidebar tab, opening a menu or reaching
 * into the prompt bar must close it, while the pane's own controls and the two
 * entry points that TOGGLE it (topbar / avatar, the row of the pane's own peer)
 * must not, or the toggle would close the pane and reopen it on the same click.
 *
 * These drive the real predicates from peer-editor-dismiss.ts against a DOM
 * skeleton shaped like the app's own (only the elements the selectors and the
 * `data-peer-id` rows care about), so the rule is pinned without booting the
 * sidebar graph.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import {
  isInsidePeerEditorPane,
  isPeerEditorPaneContainer,
  isPeerEditorToggleEntryPoint,
  peerEditorPanePeerId,
  shouldDismissPeerEditorOnPointerDown
} from '@lib/phantomchat/peer-editor-dismiss';

const GROUP_PEER = -2000000000000007;
const OTHER_GROUP_PEER = -2000000000000009;
const CONTACT_PEER = 1000000000000042;

beforeEach(() => {
  document.body.innerHTML = `
    <div class="chat">
      <div class="topbar">
        <div class="chat-info"><div class="avatar" data-e2e="avatar"></div></div>
        <div class="chat-utils"><button data-e2e="menu-toggle"></button></div>
        <div class="topbar-search-container"><input data-e2e="topbar-search"></div>
      </div>
      <div class="bubble" data-peer-id="${GROUP_PEER}" data-e2e="bubble"></div>
      <div class="chat-input" data-e2e="composer"><textarea></textarea></div>
    </div>
    <div id="column-left">
      <div class="chatlist">
        <a class="row chatlist-chat" data-peer-id="${GROUP_PEER}" data-e2e="row-same"></a>
        <a class="row chatlist-chat" data-peer-id="${OTHER_GROUP_PEER}" data-e2e="row-other"></a>
      </div>
      <div class="menu-horizontal-div-item" data-e2e="sidebar-tab"></div>
    </div>
    <div class="contacts-container">
      <li data-peer-id="${GROUP_PEER}" data-e2e="contact-same"></li>
    </div>
    <div id="column-right">
      <div class="tabs-tab sidebar-slider-item peer-editor-pane edit-peer-container" data-e2e="pane">
        <div class="sidebar-header"><button class="sidebar-close-button" data-e2e="pane-close"></button></div>
        <input class="input-field" data-e2e="pane-field">
      </div>
    </div>
    <div class="popup" data-e2e="menu"></div>
  `;
});

const el = (e2e: string) => document.querySelector(`[data-e2e="${e2e}"]`);

/** The dismissal as the sidebar decides it: pane open on `panePeerId`. */
function dismisses(target: Element | null, panePeerId: number | null = GROUP_PEER) {
  return shouldDismissPeerEditorOnPointerDown({
    isInsidePane: isInsidePeerEditorPane(target),
    isToggleEntryPoint: isPeerEditorToggleEntryPoint(target, panePeerId)
  });
}

describe('editor pane: clicks that close it', () => {
  it('closes on another chat in the chat list', () => {
    expect(dismisses(el('row-other'))).toBe(true);
  });

  it('closes on a sidebar tab', () => {
    expect(dismisses(el('sidebar-tab'))).toBe(true);
  });

  it('closes on the prompt bar', () => {
    expect(dismisses(el('composer'))).toBe(true);
    expect(dismisses(el('composer')?.querySelector('textarea') || null)).toBe(true);
  });

  it('closes on a menu', () => {
    expect(dismisses(el('menu'))).toBe(true);
  });

  it('closes on a click in the chat itself (a bubble carries data-peer-id too)', () => {
    // Same `data-peer-id` as the pane's peer, but a bubble is not a row and
    // never routes to the editor: it must not be mistaken for an entry point.
    expect(dismisses(el('bubble'))).toBe(true);
  });

  it('closes on the topbar utility cluster (search, hamburger menu)', () => {
    // The topbar handler returns early for these, so nothing here toggles.
    expect(dismisses(el('menu-toggle'))).toBe(true);
    expect(dismisses(el('topbar-search'))).toBe(true);
  });

  it('closes even when the pane has no peer id yet', () => {
    expect(dismisses(el('row-other'), null)).toBe(true);
  });
});

describe('editor pane: clicks that leave it alone', () => {
  it('stays on a click inside the pane', () => {
    expect(dismisses(el('pane-field'))).toBe(false);
    expect(dismisses(el('pane-close'))).toBe(false);
    expect(dismisses(el('pane'))).toBe(false);
  });

  it('stays on the topbar / avatar, which toggles it', () => {
    expect(dismisses(el('avatar'))).toBe(false);
  });

  it('stays on the row of the pane\'s own peer (the toggle)', () => {
    expect(dismisses(el('row-same'))).toBe(false);
  });

  it('stays on the Contacts tab row of the pane\'s own peer', () => {
    expect(dismisses(el('contact-same'))).toBe(false);
  });

  it('treats a row for another peer as outside', () => {
    expect(isPeerEditorToggleEntryPoint(el('row-other'), GROUP_PEER)).toBe(false);
  });
});

describe('peerEditorPanePeerId', () => {
  it('reads the group/session field and the contact field', () => {
    expect(peerEditorPanePeerId({groupPeerId: GROUP_PEER})).toBe(GROUP_PEER);
    expect(peerEditorPanePeerId({peerId: CONTACT_PEER})).toBe(CONTACT_PEER);
  });

  it('prefers the group field when both are set', () => {
    expect(peerEditorPanePeerId({groupPeerId: GROUP_PEER, peerId: CONTACT_PEER})).toBe(GROUP_PEER);
  });

  it('is null without a peer', () => {
    expect(peerEditorPanePeerId(undefined)).toBe(null);
    expect(peerEditorPanePeerId({})).toBe(null);
  });
});

describe('peer editor pane marker', () => {
  it('matches the edit panes and not the other right-column panes', () => {
    expect(isPeerEditorPaneContainer(el('pane'))).toBe(true);
    // The Add Contact pane shares `edit-peer-container` but is a whole task of
    // its own: a half-typed contact must survive a click elsewhere.
    const addContact = document.createElement('div');
    addContact.className = 'edit-peer-container edit-contact-container add-contact-container';
    expect(isPeerEditorPaneContainer(addContact)).toBe(false);
    expect(isPeerEditorPaneContainer(null)).toBe(false);
  });
});
