/**
 * #188/#189 — peerId derivation for id-bound groups (Robert's review blocker).
 *
 * Bound ids (<64-hex adminPubkey><32-hex random>) MUST derive their peerId
 * from the WHOLE id. Deriving from only the first 8 bytes hashed the admin
 * prefix, so every group one admin created collapsed onto the same peerId —
 * and the group store's unique peerId index made the second save fail
 * outright (ConstraintError). Legacy 32-hex ids must keep the original
 * first-8-bytes derivation or every existing group would change peerId.
 *
 * These tests use the REAL groupIdToPeerId and the REAL GroupStore
 * (fake-indexeddb). The group-chat-api suite mocks groupIdToPeerId to a
 * constant, which is exactly why it could not see this class of bug.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {groupIdToPeerId, isGroupPeer} from '@lib/phantomchat/group-types';
import type {GroupRecord} from '@lib/phantomchat/group-types';

const ADMIN = 'a'.repeat(64);

/** Mirror of group-api's mintBoundGroupId: <64-hex admin><32-hex random>. */
function mintBound(admin: string, rand: string): string {
  return admin + rand;
}

function record(groupId: string, peerId: number): GroupRecord {
  return {
    groupId,
    name: 'Group',
    adminPubkey: ADMIN,
    members: [ADMIN],
    peerId,
    createdAt: 1,
    updatedAt: 1
  };
}

describe('groupIdToPeerId — bound-id derivation (#188)', () => {
  it('two bound ids from ONE admin derive DISTINCT peerIds', async() => {
    const p1 = await groupIdToPeerId(mintBound(ADMIN, '1'.repeat(32)));
    const p2 = await groupIdToPeerId(mintBound(ADMIN, '2'.repeat(32)));
    expect(p1).not.toBe(p2);
  });

  it('a bound id changes peerId when ANY byte changes (even the last)', async() => {
    // Under the old first-8-bytes derivation, the random suffix — including
    // the last byte — never reached the hash.
    const base = mintBound(ADMIN, 'ab'.repeat(16));
    const flippedLast = base.slice(0, -1) + (base.endsWith('0') ? '1' : '0');
    expect(await groupIdToPeerId(base)).not.toBe(await groupIdToPeerId(flippedLast));
  });

  it('bound-id peerIds stay in the group range (negative, isGroupPeer)', async() => {
    const p = await groupIdToPeerId(mintBound(ADMIN, '3'.repeat(32)));
    expect(isGroupPeer(p)).toBe(true);
  });
});

describe('groupIdToPeerId — legacy ids keep their derivation', () => {
  it('a legacy 32-hex id still derives from ONLY the first 8 bytes', async() => {
    // Regression pin: byte 9 onward must not influence a LEGACY id's peerId —
    // existing deployed groups must never change peerId across this fix.
    const legacy = 'ab'.repeat(16); // 32 hex chars = 16 bytes
    const sameFirst8 = legacy.slice(0, 16) + 'ff'.repeat(8); // differs from byte 9 on
    expect(await groupIdToPeerId(legacy)).toBe(await groupIdToPeerId(sameFirst8));
  });

  it('a legacy id and a bound id never collide derivation rules (different byte length)', async() => {
    const legacy = 'ab'.repeat(16);
    const bound = mintBound(ADMIN, 'ab'.repeat(16));
    // The bound id's derivation hashes all 48 bytes; the legacy one hashes
    // the first 8. Same admin prefix is fine — results differ because the
    // inputs differ.
    expect(await groupIdToPeerId(legacy)).not.toBe(await groupIdToPeerId(bound));
  });
});

describe('GroupStore persistence with REAL peerIds (Robert\'s repro)', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    vi.resetModules();
  });

  it('one admin creating TWO groups: distinct peerIds, both records persist', async() => {
    const {getGroupStore} = await import('@lib/phantomchat/group-store');
    const g1 = mintBound(ADMIN, '1'.repeat(32));
    const g2 = mintBound(ADMIN, '2'.repeat(32));
    const p1 = await groupIdToPeerId(g1);
    const p2 = await groupIdToPeerId(g2);
    expect(p1).not.toBe(p2);

    const store = getGroupStore();
    await store.save(record(g1, p1));
    await store.save(record(g2, p2)); // ConstraintError under the old derivation
    expect((await store.get(g1))?.groupId).toBe(g1);
    expect((await store.get(g2))?.groupId).toBe(g2);
    expect((await store.getByPeerId(p1))?.groupId).toBe(g1);
    expect((await store.getByPeerId(p2))?.groupId).toBe(g2);
    expect((await store.getAll())).toHaveLength(2);
  });
});
