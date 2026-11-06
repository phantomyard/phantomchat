/**
 * Sessions `+` (owner 2026-11-06): no contacts -> New Contact pane, then a
 * session with the saved contact; one contact of any type -> that session
 * directly; more -> the picker, where picking the contact whose 1:1 chat is
 * open must create the session, not open its Edit pane.
 * The browser run is src/tests/e2e/e2e-sessions-plus.ts.
 */
import {describe, it, expect} from 'vitest';
import '@helpers/peerIdPolyfill';
import fs from 'fs';
import {listSessionContacts, routeSessionPlus} from '@lib/phantomchat/session-plus';
import {shouldOpenEditorOnSelectedChat} from '@lib/phantomchat/group-edit-click';
import type {VirtualPeerMapping} from '@lib/phantomchat/virtual-peers-db';

const read = (path: string) => fs.readFileSync(path, 'utf-8');
const p2pPeerId = 1000000000000001;
const mapping = (peerId: number, pubkey: string) => ({peerId, pubkey} as VirtualPeerMapping);

describe('Sessions + routing', () => {
  it('opens the New Contact pane when there is nobody to pick', () => {
    expect(routeSessionPlus([])).toEqual({kind: 'add-contact'});
  });

  it('skips the picker for exactly one contact', () => {
    expect(routeSessionPlus([p2pPeerId as PeerId])).toEqual({kind: 'direct', peerId: p2pPeerId});
  });

  it('shows the picker for two or more', () => {
    expect(routeSessionPlus([1, 2] as PeerId[])).toEqual({kind: 'picker'});
  });
});

describe('the contacts counted are the ones the picker lists', () => {
  it('trusts an EMPTY worker answer (a fresh install still maps its own key)', async() => {
    const peers = await listSessionContacts({
      getContactsPeerIds: async() => [],
      getAllMappings: async() => [mapping(5, 'self')],
      isTombstoned: async() => false
    });
    expect(peers).toEqual([]);
  });

  it('uses the worker list when it answers', async() => {
    const peers = await listSessionContacts({
      getContactsPeerIds: async() => [7 as PeerId],
      getAllMappings: async() => [mapping(5, 'a'), mapping(7, 'b')],
      isTombstoned: async() => false
    });
    expect(peers).toEqual([7]);
  });

  it('falls back to live mappings only when the worker path rejects', async() => {
    const peers = await listSessionContacts({
      getContactsPeerIds: () => Promise.reject(new Error('MTProto disabled')),
      getAllMappings: async() => [mapping(5, 'gone'), mapping(7, 'live')],
      isTombstoned: async(m) => m.pubkey === 'gone'
    });
    expect(peers).toEqual([7]);
  });
});

describe('picking the contact whose chat is open', () => {
  const openChat = {peerId: p2pPeerId, isActive: true, isLessThanFloatingLeftSidebar: false};

  it('is a pick in the picker, not an Edit-pane toggle', () => {
    expect(shouldOpenEditorOnSelectedChat({...openChat, isPicker: true})).toBe(false);
  });

  it('still toggles the Edit pane outside the picker', () => {
    expect(shouldOpenEditorOnSelectedChat(openChat)).toBe(true);
  });

  it('is wired: the Contacts list tells the shared click handler when it is picking', () => {
    const contacts = read('src/components/sidebarLeft/tabs/contacts.ts');
    expect(contacts).toContain('isPicker: () => !!this.onPickPeer');
    const manager = read('src/lib/appDialogsManager.ts');
    expect(manager).toContain('isPicker: !!isPicker?.()');
  });
});

describe('the Sessions flow routes before the picker', () => {
  const sidebar = read('src/components/sidebarLeft/index.ts');
  const flow = sidebar.slice(sidebar.indexOf('private async openNewSessionFlow'), sidebar.indexOf('private async listSessionContacts'));

  it('counts first, then opens the New Contact pane, the session, or the picker', () => {
    const route = flow.indexOf('routeSessionPlus(await this.listSessionContacts())');
    expect(route).toBeGreaterThan(-1);
    expect(flow.indexOf('openAddContactPane(')).toBeGreaterThan(route);
    expect(flow.indexOf('this.createTab(AppContactsTab)')).toBeGreaterThan(route);
    // the contact saved in the New Contact pane becomes the session
    expect(flow).toContain('onContactAdded: (peerId) => void createSession(peerId)');
  });
});
