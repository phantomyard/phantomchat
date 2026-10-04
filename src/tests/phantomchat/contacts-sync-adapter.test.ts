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
  deletedRows: Array<{pubkey: string; deletedAt: number}>;
  undeleted: string[];
  stamped: Array<{pubkey: string; deliberateAddAt: number}>;
  wiped: string[];
};

function makeDeps(
  mappings: VirtualPeerMapping[],
  tombstones: Array<{conversationId: string; deletedAt: number}>,
  own: string | null = OWN,
  deletedRows: Array<{pubkey: string; deletedAt: number}> = []
): {deps: ContactsAdapterDeps; calls: Calls} {
  const calls: Calls = {added: [], renamed: [], pinned: [], removed: [], tombstoned: [], deletedRows: [], undeleted: [], stamped: [], wiped: []};
  const durable = new Map(deletedRows.map((r) => [r.pubkey, r.deletedAt]));
  const deps: ContactsAdapterDeps = {
    getOwnPubkey: () => own,
    listMappings: async() => mappings,
    listTombstones: async() => tombstones,
    listDeletedPeers: async() => [...durable].map(([pubkey, deletedAt]) => ({pubkey, deletedAt})),
    recordDeletedPeer: async(pubkey, deletedAt) => {
      durable.set(pubkey, Math.max(durable.get(pubkey) ?? 0, deletedAt));
      calls.deletedRows.push({pubkey, deletedAt});
    },
    clearDeletedPeer: async(pubkey) => {
      durable.delete(pubkey);
      calls.undeleted.push(pubkey);
    },
    conversationId: convId,
    addContact: async(pubkey, displayName) => { calls.added.push({pubkey, displayName}); },
    setDisplayName: async(pubkey, displayName) => { calls.renamed.push({pubkey, displayName}); },
    setUpdatedAt: async(pubkey, updatedAt) => { calls.pinned.push({pubkey, updatedAt}); },
    setDeliberateAddAt: async(pubkey, deliberateAddAt) => { calls.stamped.push({pubkey, deliberateAddAt}); },
    removeContact: async(pubkey) => { calls.removed.push(pubkey); },
    setTombstone: async(conversationId, deletedAt) => { calls.tombstoned.push({conversationId, deletedAt}); },
    wipeConversationResidue: async(pubkey) => { calls.wiped.push(pubkey); }
  };
  return {deps, calls};
}

function mapping(
  pubkey: string,
  updatedAtMillis: number,
  displayName?: string,
  deliberateAddAtMillis?: number
): VirtualPeerMapping {
  return {
    pubkey,
    peerId: 1,
    displayName,
    addedAt: updatedAtMillis,
    updatedAt: updatedAtMillis,
    ...(deliberateAddAtMillis !== undefined ? {deliberateAddAt: deliberateAddAtMillis} : {})
  };
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

  it('exports a DURABLE deletion row with no own pubkey and no watermark (#173)', async() => {
    // The old read() silently published no deletion at all when the own pubkey
    // wasn't wired — a fresh device then re-added the deleted peer everywhere.
    const {deps} = makeDeps([], [], null, [{pubkey: A, deletedAt: 4242}]);
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBe(true);
    expect(map[A].updatedAt).toBe(4242);
  });

  it('unions durable rows with derived watermarks — latest stamp per peer wins', async() => {
    const {deps} = makeDeps(
      [],
      [{conversationId: convId(OWN, A), deletedAt: 9000}],
      OWN,
      [{pubkey: A, deletedAt: 4000}]
    );
    const map = await createContactsAdapter(deps).read();
    expect(map[A].updatedAt).toBe(9000); // watermark is newer
  });

  it('#180: a mapping newer than the delete but WITHOUT a deliberate stamp loses (auto-minted stamps no longer resurrect)', async() => {
    // The stale-client resurrection loop: a pre-#180 client (or any automatic
    // path) re-creates the mapping with a FRESH updatedAt. Under the old rule
    // that outranked the delete and muted it forever; now the lack of a
    // deliberate-add proof means the mapping is torn down and the delete
    // re-asserted.
    const {deps, calls} = makeDeps([mapping(A, 12_000_000, 'Alice')], [], OWN, [{pubkey: A, deletedAt: 9000}]);
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBe(true);
    expect(map[A].updatedAt).toBe(9000);
    expect(calls.removed).toEqual([A]); // resurrected mapping torn down
  });

  it('#180: a mapping with a deliberate stamp NEWER than the delete wins and clears the durable row', async() => {
    const {deps, calls} = makeDeps(
      [mapping(A, 12_000_000, 'Alice', 10_000_000)],
      [],
      OWN,
      [{pubkey: A, deletedAt: 9000}]
    );
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBeFalsy();
    expect(map[A].deliberateAddAt).toBe(10_000); // 10_000_000ms -> 10_000s
    expect(calls.undeleted).toEqual([A]); // durable row cleared: store converges
    expect(calls.removed).toHaveLength(0);
  });

  it('#180: a deliberate stamp OLDER than the delete loses (re-add proof predates the delete)', async() => {
    const {deps} = makeDeps(
      [mapping(A, 12_000_000, 'Alice', 5_000_000)],
      [],
      OWN,
      [{pubkey: A, deletedAt: 9000}]
    );
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBe(true);
  });

  it('an exact tie goes to the TOMBSTONE (> semantics, consistent with mergeEntry)', async() => {
    // Seconds-floored stamps make an earlier-in-the-same-second live mapping
    // tie the delete; equality cannot mean a deliberate re-add, so the
    // tombstone must win — same invariant as mergeEntry. Holds even WITH a
    // stamp: the re-add proof must be strictly newer than the delete (#180).
    const {deps} = makeDeps([mapping(A, 9_000_000, 'Alice')], [], OWN, [{pubkey: A, deletedAt: 9000}]);
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBe(true);
    expect(map[A].updatedAt).toBe(9000);

    const {deps: tieDeps} = makeDeps(
      [mapping(A, 9_000_000, 'Alice', 9_000_000)],
      [],
      OWN,
      [{pubkey: A, deletedAt: 9000}]
    );
    const map2 = await createContactsAdapter(tieDeps).read();
    expect(map2[A].deleted).toBe(true); // stamp == delete second: not strictly newer
  });

  it('live and tombstone timestamps are comparable on the same axis (the unit bug guard)', async() => {
    // A delete at t=6000s must be able to beat an add at t=5000s. If live used
    // raw millis (5_000_000) it would tower over the tombstone (6000) forever.
    const {deps} = makeDeps([mapping(A, 5_000_000, 'Alice')], []);
    const live = (await createContactsAdapter(deps).read())[A];
    const del = {updatedAt: 6000, deleted: true};
    expect(del.updatedAt).toBeGreaterThan(live.updatedAt); // delete correctly wins
  });

  describe('#198 conversation residue wipe', () => {
    it('wipes residue for a peer whose delete is backed by the DURABLE log', async() => {
      // Durable row present, mapping gone (the converged post-delete state):
      // read() re-derives the delete every pass — the wipe must fire so the
      // message-store rows that DERIVE the contact/dialog get cleaned.
      const {deps, calls} = makeDeps([], [], OWN, [{pubkey: A, deletedAt: 4242}]);
      await createContactsAdapter(deps).read();
      expect(calls.wiped).toEqual([A]);
    });

    it('does NOT wipe on a watermark-only delete (may be cleared history)', async() => {
      // Tombstone present, no mapping, NO durable row — the watermark may
      // only mean cleared history; the residue wipe is durable-log-only.
      const {deps, calls} = makeDeps([], [{conversationId: convId(OWN, A), deletedAt: 4242}]);
      await createContactsAdapter(deps).read();
      expect(calls.wiped).toEqual([]);
    });

    it('does not wipe when a deliberate re-add outranks the delete', async() => {
      // deliberateAddAt 9_000_000ms = 9000s > delete 4242s — the contact is
      // live again; the durable row is cleared and nothing is wiped.
      const {deps, calls} = makeDeps(
        [mapping(A, 6_000_000, 'Alice', 9_000_000)],
        [],
        OWN,
        [{pubkey: A, deletedAt: 4242}]
      );
      await createContactsAdapter(deps).read();
      expect(calls.undeleted).toEqual([A]); // durable row cleared
      expect(calls.wiped).toEqual([]);      // contact is live again — no wipe
    });
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
    // The store fixture holds the mapping — before (read() output) is derived
    // from the same store in the real engine, so wasLive and the store
    // snapshot agree.
    const {deps, calls} = adapter([mapping(A, 5_000_000, 'Alice')]);
    const before: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    const merged: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 6000, deleted: true}};
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.removed).toEqual([A]);
    expect(calls.tombstoned).toEqual([{conversationId: convId(OWN, A), deletedAt: 6000}]);
    expect(calls.deletedRows).toEqual([{pubkey: A, deletedAt: 6000}]);
  });

  it('records a delete learned from another device durably, even with nothing live locally (#173)', async() => {
    // A device with neither a live entry nor a watermark must still be able
    // to re-publish the delete later — otherwise it contributes only an
    // ABSENCE, and a stale live blob elsewhere revives the contact.
    const {deps, calls} = adapter();
    const merged: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 6000, deleted: true}};
    await createContactsAdapter(deps).apply(merged, empty);
    expect(calls.removed).toHaveLength(0);
    expect(calls.tombstoned).toHaveLength(0);
    expect(calls.deletedRows).toEqual([{pubkey: A, deletedAt: 6000}]);
  });

  it('a live re-add that won the LWW compare clears the durable row', async() => {
    const {deps, calls} = adapter();
    const before: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 5000, deleted: true}};
    const merged: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 6000, data: {pubkey: A, displayName: 'Alice', addedAt: 6_000_000}}
    };
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.undeleted).toEqual([A]);
    expect(calls.added).toEqual([{pubkey: A, displayName: 'Alice'}]);
  });

  it('#180: a deliberate re-add from another device persists its stamp locally', async() => {
    // The remote entry won over our durable delete BECAUSE of its stamp; the
    // local store must carry that proof, or this device's next read() exports
    // an unstamped entry and loses a later tombstone compare it should win.
    const {deps, calls} = adapter();
    const before: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 5000, deleted: true}};
    const merged: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 6000, deliberateAddAt: 5500, data: {pubkey: A, displayName: 'Alice', addedAt: 6_000_000}}
    };
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.undeleted).toEqual([A]);
    expect(calls.added).toEqual([{pubkey: A, displayName: 'Alice'}]);
    expect(calls.stamped).toEqual([{pubkey: A, deliberateAddAt: 5500}]);
  });

  it('#180: a stamp that advanced without an updatedAt advance is persisted (no re-materialize)', async() => {
    // A live/live merge forwards the max stamp onto the winner; the store
    // snapshot must learn it without re-adding the contact.
    const {deps, calls} = adapter([mapping(A, 5_000_000, 'Alice')]);
    const before: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    const merged: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, deliberateAddAt: 6000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.added).toHaveLength(0); // unchanged contact — no expensive materialize
    expect(calls.stamped).toEqual([{pubkey: A, deliberateAddAt: 6000}]);
  });

  it('does not clear the durable row for an unchanged live contact', async() => {
    const {deps, calls} = adapter();
    const same: SyncMap<ContactSyncData> = {
      [A]: {id: A, updatedAt: 5000, data: {pubkey: A, displayName: 'Alice', addedAt: 5_000_000}}
    };
    await createContactsAdapter(deps).apply(same, same);
    expect(calls.undeleted).toHaveLength(0);
  });

  it('tears down a resurrected mapping even when read() had already overridden it (wasLive false)', async() => {
    // Same gap Robert flagged on the groups adapter: with the strict compare,
    // read() reports a stale live mapping as `deleted: true`, so wasLive in
    // apply() is false and the old wasLive-gated teardown never fired — the
    // resurrected contact stayed in the mapping store forever. Teardown now
    // follows store reality.
    const {deps, calls} = adapter([mapping(A, 5_000_000, 'Alice')]);
    const before: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 9000, deleted: true}};
    const merged: SyncMap<ContactSyncData> = {[A]: {id: A, updatedAt: 9000, deleted: true}};
    await createContactsAdapter(deps).apply(merged, before);
    expect(calls.removed).toEqual([A]);
    expect(calls.deletedRows).toEqual([{pubkey: A, deletedAt: 9000}]);
  });

  it('resurrection self-heal in read(): a mapping that LOSES to a durable delete row is removed', async() => {
    // The already-resurrected device never reaches apply(): read() overrides
    // the stale mapping with the delete, merged == local, so the engine skips
    // apply entirely. read() itself must tear the resurrection down.
    const {deps, calls} = makeDeps([mapping(A, 5_000_000, 'Alice')], [], OWN, [{pubkey: A, deletedAt: 9000}]);
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBe(true);
    expect(calls.removed).toEqual([A]);
    // The durable row survives: it stays the re-publishable positive fact.
    expect(calls.undeleted).toHaveLength(0);
  });

  it('read() teardown never fires for cleared history: watermark under a LIVE mapping', async() => {
    // #173 rule: a watermark with a live mapping may be "cleared history",
    // not a contact delete — no teardown, no tombstone in the exported map.
    const {deps, calls} = makeDeps(
      [mapping(A, 9_000_000, 'Alice')],
      [{conversationId: convId(OWN, A), deletedAt: 4242}]
    );
    const map = await createContactsAdapter(deps).read();
    expect(map[A].deleted).toBeFalsy();
    expect(calls.removed).toEqual([]);
  });
});
