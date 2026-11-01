/**
 * Regression coverage for sessions flipping between Sessions and Groups, archived
 * sessions returning to Sessions, and non-contacts entering the contacts list.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {isInconclusiveReconcile} from '@lib/phantomchat/crdt-sync';
import {createGroupsAdapter} from '@lib/phantomchat/groups-sync-adapter';
import {groupIdToPeerId} from '@lib/phantomchat/group-types';
import {AppUsersManager} from '@lib/appManagers/appUsersManager';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : +this;
  };
}

const GROUP_ID = 'ab'.repeat(16);

function adapterWith(local: any[]) {
  const upserted: any[] = [];
  const adapter = createGroupsAdapter({
    listGroups: async() => local,
    listTombstones: async() => [],
    listDeletedGroups: async() => [],
    recordDeletedGroup: async() => {},
    getLegacyDeleteCutoff: async() => 0,
    clearDeletedGroup: async() => {},
    upsertGroup: async(record) => { upserted.push(record); },
    removeGroup: async() => {},
    setTombstone: async() => {}
  });
  return {adapter, upserted};
}

const remote = (data: any) => ({[GROUP_ID]: {id: GROUP_ID, updatedAt: 2000, data: {groupId: GROUP_ID, name: 'x', members: [], adminPubkey: 'a', createdAt: 1, ...data}}});
const before = (data?: any) => data ? {[GROUP_ID]: {id: GROUP_ID, updatedAt: 1000, data}} : {};

describe('groups CRDT class ratchet', () => {
  it('keeps a local session when a newer writer republishes without a class', async() => {
    const peerId = await groupIdToPeerId(GROUP_ID, 'session');
    const local = {groupId: GROUP_ID, peerId, kind: 'session'};
    const {adapter, upserted} = adapterWith([local]);
    await adapter.apply(remote({}) as any, before(local) as any);
    expect(upserted[0].kind).toBe('session');
  });

  it('keeps a classless local record in the session range a session', async() => {
    const peerId = await groupIdToPeerId(GROUP_ID, 'session');
    const local = {groupId: GROUP_ID, peerId};
    const {adapter, upserted} = adapterWith([local]);
    await adapter.apply(remote({kind: 'group'}) as any, before(local) as any);
    expect(upserted[0].kind).toBe('session');
  });

  it('reads the class off a remote session peerId on a device with no record yet', async() => {
    const peerId = await groupIdToPeerId(GROUP_ID, 'session');
    const {adapter, upserted} = adapterWith([]);
    await adapter.apply(remote({peerId, kind: 'group'}) as any, {} as any);
    expect(upserted[0].kind).toBe('session');
  });

  it('reads the class off a remote legacy tag on a device with no record yet', async() => {
    const {adapter, upserted} = adapterWith([]);
    await adapter.apply(remote({tags: ['session']}) as any, {} as any);
    expect(upserted[0].kind).toBe('session');
  });

  it('leaves a classic group classless', async() => {
    const peerId = await groupIdToPeerId(GROUP_ID, 'group');
    const local = {groupId: GROUP_ID, peerId};
    const {adapter, upserted} = adapterWith([local]);
    await adapter.apply(remote({peerId}) as any, before(local) as any);
    expect(upserted[0].kind).toBeUndefined();
  });
});

describe('orphan sweep gate', () => {
  it('treats only a real read of the relay as definitive', () => {
    expect(isInconclusiveReconcile('failed')).toBe(true);
    expect(isInconclusiveReconcile('no-remote-nothing-local')).toBe(true);
    expect(isInconclusiveReconcile('in-sync')).toBe(false);
    expect(isInconclusiveReconcile('merged-applied')).toBe(false);
    expect(isInconclusiveReconcile('no-remote-published-local')).toBe(false);
  });
});

describe('contacts list membership', () => {
  function usersManager() {
    const manager: any = Object.create(AppUsersManager.prototype);
    manager.p2pSyntheticUsers = new Map();
    manager.p2pNonContactUsers = new Set();
    manager.users = {};
    manager.contactsList = new Set();
    manager.contactsIndex = {indexObject: vi.fn()};
    manager.peersStorage = {requestPeer: vi.fn()};
    manager.mirrorUser = vi.fn();
    manager.getUserSearchText = () => '';
    return manager;
  }

  it('does not list a sender known only through a group', () => {
    const manager = usersManager();
    manager.injectP2PUser('p', 5e15, 'Member', '', {asContact: false});
    expect(manager.contactsList.has(5e15)).toBe(false);
    expect(manager.p2pSyntheticUsers.has(5e15)).toBe(true);
  });

  it('promotes that sender when they are later added for real', () => {
    const manager = usersManager();
    manager.injectP2PUser('p', 5e15, 'Member', '', {asContact: false});
    manager.injectP2PUser('p', 5e15, 'Member', '');
    expect(manager.contactsList.has(5e15)).toBe(true);
  });

  it('does not re-add a deleted contact on a later injection', () => {
    const manager = usersManager();
    manager.injectP2PUser('p', 5e15, 'Friend', '');
    manager.contactsList.delete(5e15);
    manager.injectP2PUser('p', 5e15, 'Friend', '');
    expect(manager.contactsList.has(5e15)).toBe(false);
  });

  it('refuses a group or session id outright', () => {
    const manager = usersManager();
    manager.pushContact(-12e15);
    expect(manager.contactsList.size).toBe(0);
  });
});
