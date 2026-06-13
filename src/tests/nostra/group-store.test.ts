import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, beforeAll} from 'vitest';
import type {GroupRecord} from '@lib/nostra/group-types';

// ─── Dynamic module loading ───────────────────────────────────────
// Other test files (group-chat-api, group-management) mock
// @lib/nostra/group-store with a fake factory. Under isolate:false
// that mock persists and replaces the real GroupStore with a stub.
// We use vi.resetModules() to clear the contaminated cache and
// import the real modules fresh.

let GroupStore: any;
let GROUP_PEER_BASE: any;
let GROUP_PEER_RANGE: any;
let groupIdToPeerId: any;

beforeAll(async() => {
  // Other test files (group-chat-api, group-management) mock
  // @lib/nostra/group-store with a fake factory. Under isolate:false
  // that mock persists and replaces the real GroupStore with a stub.
  // Use doUnmock + resetModules + dynamic import to get the real modules.
  vi.doUnmock('@lib/nostra/group-store');
  vi.doUnmock('@lib/nostra/group-types');

  vi.resetModules();

  // Re-import fake-indexeddb/auto after resetModules to ensure
  // the IndexedDB polyfill is active for real GroupStore operations.
  await import('fake-indexeddb/auto');

  const storeMod = await import('@lib/nostra/group-store');
  GroupStore = storeMod.GroupStore;

  const typesMod = await import('@lib/nostra/group-types');
  GROUP_PEER_BASE = typesMod.GROUP_PEER_BASE;
  GROUP_PEER_RANGE = typesMod.GROUP_PEER_RANGE;
  groupIdToPeerId = typesMod.groupIdToPeerId;
});

function makeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
    name: 'Test Group',
    adminPubkey: 'admin00000000000000000000000000000000000000000000000000000000dead',
    members: [
      'member1000000000000000000000000000000000000000000000000000000001',
      'member2000000000000000000000000000000000000000000000000000000002'
    ],
    peerId: -2000000000000001,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  };
}

describe('GroupStore', () => {
  let store: any;

  beforeEach(async() => {
    if(store) {
      await store.destroy();
    }
    // Delete the DB to ensure clean state between tests
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('nostra-groups');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    store = new GroupStore();
  });

  it('save and get: stores a GroupRecord and retrieves it with all fields intact', async() => {
    const group = makeGroup();
    await store.save(group);
    const retrieved = await store.get(group.groupId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.groupId).toBe(group.groupId);
    expect(retrieved!.name).toBe(group.name);
    expect(retrieved!.adminPubkey).toBe(group.adminPubkey);
    expect(retrieved!.members).toEqual(group.members);
    expect(retrieved!.peerId).toBe(group.peerId);
    expect(retrieved!.createdAt).toBe(group.createdAt);
    expect(retrieved!.updatedAt).toBe(group.updatedAt);
  });

  it('getAll returns all stored groups', async() => {
    const g1 = makeGroup({groupId: 'aaa0000000000000000000000000000000000000000000000000000000000001', peerId: -2000000000000001});
    const g2 = makeGroup({groupId: 'bbb0000000000000000000000000000000000000000000000000000000000002', peerId: -2000000000000002});
    await store.save(g1);
    await store.save(g2);
    const all = await store.getAll();
    expect(all.length).toBe(2);
    const ids = all.map((g: any) => g.groupId).sort();
    expect(ids).toEqual([g1.groupId, g2.groupId].sort());
  });

  it('getByPeerId returns the correct group via index lookup', async() => {
    const group = makeGroup({peerId: -3000000000000099});
    await store.save(group);
    const found = await store.getByPeerId(-3000000000000099);
    expect(found).not.toBeNull();
    expect(found!.groupId).toBe(group.groupId);
  });

  it('delete removes the group', async() => {
    const group = makeGroup();
    await store.save(group);
    await store.delete(group.groupId);
    const retrieved = await store.get(group.groupId);
    expect(retrieved).toBeNull();
  });

  it('updateMembers updates the members array and updatedAt timestamp', async() => {
    const group = makeGroup({updatedAt: 1000});
    await store.save(group);
    const newMembers = ['new1', 'new2', 'new3'];
    await store.updateMembers(group.groupId, newMembers);
    const updated = await store.get(group.groupId);
    expect(updated!.members).toEqual(newMembers);
    expect(updated!.updatedAt).toBeGreaterThan(1000);
  });

  it('updateInfo updates metadata fields', async() => {
    const group = makeGroup({updatedAt: 1000});
    await store.save(group);
    await store.updateInfo(group.groupId, {
      name: 'Updated Name',
      description: 'A description',
      avatar: 'avatar-url'
    });
    const updated = await store.get(group.groupId);
    expect(updated!.name).toBe('Updated Name');
    expect(updated!.description).toBe('A description');
    expect(updated!.avatar).toBe('avatar-url');
    expect(updated!.updatedAt).toBeGreaterThan(1000);
  });
});

describe('GROUP_PEER_BASE', () => {
  it('equals 2 * 10^15', () => {
    expect(GROUP_PEER_BASE).toBe(BigInt(2 * 10 ** 15));
    expect(GROUP_PEER_BASE).toBe(BigInt(2000000000000000));
  });
});

describe('groupIdToPeerId', () => {
  it('produces a negative number in the GROUP_PEER_BASE range', async() => {
    const hexId = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
    const peerId = await groupIdToPeerId(hexId);
    expect(peerId).toBeLessThan(0);
    const abs = BigInt(Math.abs(peerId));
    expect(abs >= GROUP_PEER_BASE).toBe(true);
    expect(abs < GROUP_PEER_BASE + GROUP_PEER_RANGE).toBe(true);
  });

  it('is deterministic (same input gives same output)', async() => {
    const hexId = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const id1 = await groupIdToPeerId(hexId);
    const id2 = await groupIdToPeerId(hexId);
    expect(id1).toBe(id2);
  });

  it('different inputs give different outputs', async() => {
    const id1 = await groupIdToPeerId('1111111111111111111111111111111111111111111111111111111111111111');
    const id2 = await groupIdToPeerId('2222222222222222222222222222222222222222222222222222222222222222');
    expect(id1).not.toBe(id2);
  });
});
