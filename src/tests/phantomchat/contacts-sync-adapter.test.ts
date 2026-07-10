import {describe, it, expect} from 'vitest';
import {createContactsAdapter, _peerFromConversationId, type ContactsAdapterDeps} from '@lib/phantomchat/contacts-sync-adapter';
import type {VirtualPeerMapping} from '@lib/phantomchat/virtual-peers-db';
import type {SyncMap} from '@lib/phantomchat/sync-crdt';
import type {ContactSyncData} from '@lib/phantomchat/contacts-sync-adapter';

const OWN = 'f'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const convId = (x: string, y: string) => [x, y].sort().join(':');

type Calls = {
  added: Array<{pubkey: string; displayName?: string}>;
  renamed: Array<{pubkey: string; displayName: string}>;
  pinned: Array<{pubkey: string; updatedAt: number}>;
  removed: string[];
  tombstoned: Array<{conversationId: string; deletedAt: number}>;
};

function makeDeps(
  mappings: VirtualPeerMapping[],
  tombstones: Array<{conversationId: string; deletedAt: number}>,
  own: string | null = OWN
): {deps: ContactsAdapterDeps; calls: Calls} {
  const calls: Calls = {added: [], renamed: [], pinned: [], removed: [], tombstoned: []};
  const deps: ContactsAdapterDeps = {
    getOwnPubkey: () => own,
    listMappings: async() => mappings,
    listTombstones: async() => tombstones,
    conversationId: convId,
    addContact: async(pubkey, displayName) => { calls.added.push({pubkey, displayName}); },
    setDisplayName: async(pubkey, displayName) => { calls.renamed.push({pubkey, displayName}); },
    setUpdatedAt: async(pubkey, updatedAt) => { calls.pinned.push({pubkey, updatedAt}); },
    removeContact: async(pubkey) => { calls.removed.push(pubkey); },
    setTombstone: async(conversationId, deletedAt) => { calls.tombstoned.push({conversationId, deletedAt}); }
  };
  return {deps, calls};
}

function mapping(pubkey: string, updatedAtMillis: number, displayName?: string): VirtualPeerMapping {
  return {pubkey, peerId: 1, displayName, addedAt: updatedAtMillis, updatedAt: updatedAtMillis};
}

describe('peerFromConversationId', () => {
  it('reverses a sorted DM id to the non-own peer', () => {
    expect(_peerFromConversationId(convId(OWN, A), OWN)).toBe(A);
    expect(_peerFromConversationId(convId(A, OWN), OWN)).toBe(A);
  });
  it('rejects group ids and non-hex ids', () => {
    expect(_peerFromConversationId('group:abc', OWN)).toBeNull();
    expect(_peerFromConversationId('not-a-conv', OWN)).toBeNull();
    expect(_peerFromConversationId(convId(A, B), OWN)).toBeNull(); // own not present
  });
});

describe('contacts adapter read()', () => {
  it('normalises live mapping updatedAt from millis to seconds', async() => {
    const {deps} = makeDeps([mapping(A, 5_000_000, 'Alice')], []);
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBeFalsy();
    expect(map[A].updatedAt).toBe(5000); // 5_000_000ms -> 5000s
    expect(map[A].data!.displayName).toBe('Alice');
  });

  it('derives a tombstone for a deleted contact (tombstone present, no live mapping)', async() => {
    const {deps} = makeDeps([], [{conversationId: convId(OWN, A), deletedAt: 4242}]);
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBe(true);
    expect(map[A].updatedAt).toBe(4242); // already seconds
  });

  it('does NOT tombstone a contact that still has a live mapping (cleared history)', async() => {
    const {deps} = makeDeps(
      [mapping(A, 9_000_000, 'Alice')],
      [{conversationId: convId(OWN, A), deletedAt: 4242}]
    );
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBeFalsy(); // live entry wins
  });

  it('skips tombstone derivation when own pubkey is unknown', async() => {
    const {deps} = makeDeps([], [{conversationId: convId(OWN, A), deletedAt: 4242}], null);
    const map = await createContactsAdapter(deps).read();
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('live and tombstone timestamps are comparable on the same axis (the unit bug guard)', async() => {
    // A delete at t=6000s must be able to beat an add at t=5000s. If live used
    // raw millis (5_000_000) it would tower over the tombstone (6000) forever.
    const {deps} = makeDeps([mapping(A, 5_000_000, 'Alice')], []);
    const live = (await createContactsAdapter(deps).read())[A];
    const del = {updatedAt: 6000, deleted: true};
    expect(del.updatedAt).toBeGreaterThan(live.updatedAt); // delete correctly wins
  });
});

describe('contacts adapter apply()', () => {
  const adapter = (mappings: VirtualPeerMapping[] = [], tombstones: any[] = []) => makeDeps(mappings, tombstones);

  const empty: SyncMap<ContactSyncData> = {};

  it('materialises a new contact and pins its timestamp to the merged value', async() => {
    const {deps, calls} = adapter();
    const merged: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    await createContactsAdapter(deps).apply(merged, empty);
    expect(calls.added).toEqual([{pubkey: A, displayName: 'Alice'}]);
    expect(calls.pinned).toEqual([{pubkey: A, updatedAt: 5_000_000}]); // seconds*1000
  });

  it('applies a rename when the remote mutation is newer', async() => {
    const {deps, calls} = adapter();
    const before: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    const merged: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 6000, data: {pubkey: A, displayName: 'Alice (work)', addedAt: 5_000_000}}
    };
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.added).toHaveLength(0);
    expect(calls.renamed).toEqual([{pubkey: A, displayName: 'Alice (work)'}]);
    expect(calls.pinned).toEqual([{pubkey: A, updatedAt: 6_000_000}]);
  });

  it('skips an unchanged contact (no expensive re-materialize)', async() => {
    const {deps, calls} = adapter();
    const same: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    await createContactsAdapter(deps).apply(same, same);
    expect(calls.added).toHaveLength(0);
    expect(calls.renamed).toHaveLength(0);
    expect(calls.pinned).toHaveLength(0);
  });

  it('deletes a contact that was live and writes the local tombstone', async() => {
    const {deps, calls} = adapter();
    const before: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    const merged: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 6000, deleted: true}};
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.removed).toEqual([A]);
    expect(calls.tombstoned).toEqual([{conversationId: convId(OWN, A), deletedAt: 6000}]);
  });

  it('does not re-delete a contact that was already gone', async() => {
    const {deps, calls} = adapter();
    const merged: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 6000, deleted: true}};
    await createContactsAdapter(deps).apply(merged, empty);
    expect(calls.removed).toHaveLength(0);
    expect(calls.tombstoned).toHaveLength(0);
  });
});
