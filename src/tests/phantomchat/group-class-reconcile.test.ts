/**
 * Group CLASS reconcile (owner report 2026-10-31: "my updated Electron app
 * shows the sessions inside the groups folder, the PWA filters them
 * correctly").
 *
 * Same release, diverged local data. A group's class is baked into its peerId
 * at first ingest and nothing re-derives it afterwards — `group_create` replays
 * are dropped by the live-record guard and `groups-sync-adapter.apply()` keeps
 * the LOCAL kind — so a session ingested in the batch-10 `tags: ['session']`
 * era keeps a group-range peerId forever. Folder membership is a pure range
 * test on that id, so Groups claims the row and Sessions stays empty.
 *
 * The reconcile adopts the class (explicit `kind`, else the legacy tag),
 * re-derives the peerId, re-stamps the conversation rows, moves the dialog row
 * and saves the record. These tests pin: the class decision, the re-key, the
 * no-op on a converged store, and that a failed move never half-migrates.
 */
import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {GroupClassRepair, intendedGroupKind, reconcileGroupPeerClasses} from '@lib/phantomchat/group-class-reconcile';
import {GROUP_PEER_BASE, SESSION_PEER_BASE, groupIdToPeerId, isSessionPeer} from '@lib/phantomchat/group-types';
import type {GroupRecord} from '@lib/phantomchat/group-types';
import {MessageStore, StoredMessage} from '@lib/phantomchat/message-store';

// Bound group id shape (<64-hex admin><32-hex random>), so the derivation hashes
// the whole id — the same shape production mints.
const ADMIN = 'a'.repeat(64);
const GROUP_ID = ADMIN + '0123456789abcdef0123456789abcdef';
const OTHER_GROUP_ID = ADMIN + 'fedcba9876543210fedcba9876543210';

/** A pre-class record: no `kind`, group-range peerId, optional legacy tag. */
async function legacyRecord(overrides: Partial<GroupRecord> & {tags?: string[]} = {}): Promise<GroupRecord & {tags?: string[]}> {
  const groupId = overrides.groupId ?? GROUP_ID;
  return {
    groupId,
    name: 'Session name',
    adminPubkey: ADMIN,
    members: [ADMIN],
    // Wrong on purpose: derived as a classic group, whatever the record says.
    peerId: await groupIdToPeerId(groupId, 'group'),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  };
}

function harness(records: Array<GroupRecord & {tags?: string[]}>) {
  const saved: GroupRecord[] = [];
  const rekeyed: Array<{conversationId: string, peerId: number}> = [];
  const relocated: Array<{groupId: string, fromPeerId: number, toPeerId: number}> = [];
  const deps = {
    listGroups: vi.fn().mockResolvedValue(records),
    saveGroup: vi.fn(async(record: GroupRecord) => {
      saved.push(record);
      const i = records.findIndex((r) => r.groupId === record.groupId);
      if(i !== -1) records[i] = record;
    }),
    rekeyConversation: vi.fn(async(conversationId: string, peerId: number) => {
      rekeyed.push({conversationId, peerId});
      return 3;
    }),
    relocateDialog: vi.fn(async(args: {record: GroupRecord, fromPeerId: number, toPeerId: number}) => {
      relocated.push({groupId: args.record.groupId, fromPeerId: args.fromPeerId, toPeerId: args.toPeerId});
    }),
    log: vi.fn()
  };
  return {deps, saved, rekeyed, relocated};
}

describe('intendedGroupKind', () => {
  it('trusts an explicit class', () => {
    expect(intendedGroupKind({kind: 'session'})).toBe('session');
    expect(intendedGroupKind({kind: 'group'})).toBe('group');
  });

  it('reads the retired batch-10 tag when the record has no class field', () => {
    expect(intendedGroupKind({tags: ['session']})).toBe('session');
    expect(intendedGroupKind({tags: []})).toBe('group');
    expect(intendedGroupKind({})).toBe('group');
  });

  it('lets an explicit class beat a stale tag — the field is the newer truth', () => {
    expect(intendedGroupKind({kind: 'group', tags: ['session']})).toBe('group');
  });

  it('falls back to the peerId range before defaulting to classic', async() => {
    const sessionPeerId = await groupIdToPeerId(GROUP_ID, 'session');
    const groupPeerId = await groupIdToPeerId(GROUP_ID, 'group');
    // No class field, no tag — the range is the only evidence, and it is the
    // same test every folder decision already uses.
    expect(intendedGroupKind({peerId: sessionPeerId} as any)).toBe('session');
    expect(intendedGroupKind({peerId: groupPeerId} as any)).toBe('group');
    // Evidence still wins over the range it disagrees with.
    expect(intendedGroupKind({kind: 'group', peerId: sessionPeerId} as any)).toBe('group');
    expect(intendedGroupKind({tags: ['session'], peerId: groupPeerId} as any)).toBe('session');
    // No peerId at all: the pre-class default.
    expect(intendedGroupKind({})).toBe('group');
  });
});

describe('reconcileGroupPeerClasses', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('re-keys a tag-era session out of the group range', async() => {
    const record = await legacyRecord({tags: ['session']});
    const {deps, saved, rekeyed, relocated} = harness([record]);
    const sessionPeerId = await groupIdToPeerId(GROUP_ID, 'session');

    const repairs = await reconcileGroupPeerClasses(deps);

    // The bug, stated as an assertion: the stale id is a GROUP id even though
    // the record is a session.
    expect(isSessionPeer(record.peerId)).toBe(false);
    expect(repairs).toEqual<GroupClassRepair[]>([{
      groupId: GROUP_ID,
      kind: 'session',
      fromPeerId: record.peerId,
      toPeerId: sessionPeerId,
      recordOnly: false
    }]);
    // History first (same conversation key), then the dialog, then the record.
    expect(rekeyed).toEqual([{conversationId: `group:${GROUP_ID}`, peerId: sessionPeerId}]);
    expect(relocated).toEqual([{groupId: GROUP_ID, fromPeerId: record.peerId, toPeerId: sessionPeerId}]);
    expect(saved).toHaveLength(1);
    expect(saved[0].peerId).toBe(sessionPeerId);
    expect(saved[0].kind).toBe('session');
    // The retired field is gone, so nothing reads it again.
    expect((saved[0] as any).tags).toBeUndefined();
    expect(deps.rekeyConversation.mock.invocationCallOrder[0])
    .toBeLessThan(deps.saveGroup.mock.invocationCallOrder[0]);
  });

  it('re-keys an explicit session whose peerId landed in the group range', async() => {
    // The same defect with the class already on the record: no tag needed.
    const record = await legacyRecord({kind: 'session'});
    const {deps, relocated} = harness([record]);

    const repairs = await reconcileGroupPeerClasses(deps);

    expect(repairs).toHaveLength(1);
    expect(relocated).toHaveLength(1);
    expect(isSessionPeer(repairs[0].toPeerId)).toBe(true);
  });

  it('re-keys a session that sits in the group range back out even when tagged twice', async() => {
    const record = await legacyRecord({groupId: OTHER_GROUP_ID, tags: ['session', 'other']});
    const {deps} = harness([record]);
    const repairs = await reconcileGroupPeerClasses(deps);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].toPeerId).toBe(await groupIdToPeerId(OTHER_GROUP_ID, 'session'));
  });

  it('writes nothing for a converged classic group', async() => {
    const record = await legacyRecord({kind: 'group'});
    const {deps, saved, rekeyed, relocated} = harness([record]);

    const repairs = await reconcileGroupPeerClasses(deps);

    expect(repairs).toEqual([]);
    expect(saved).toEqual([]);
    expect(rekeyed).toEqual([]);
    expect(relocated).toEqual([]);
    // …and no hashing either: the cheap range test short-circuits first.
    expect(deps.listGroups).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a converged session', async() => {
    const peerId = await groupIdToPeerId(GROUP_ID, 'session');
    const record = await legacyRecord({kind: 'session', peerId});
    const {deps, saved} = harness([record]);

    expect(await reconcileGroupPeerClasses(deps)).toEqual([]);
    expect(saved).toEqual([]);
    expect(isSessionPeer(peerId)).toBe(true);
  });

  it('stamps the class once on a pre-class classic group, without re-keying', async() => {
    const record = await legacyRecord();
    const {deps, saved, relocated, rekeyed} = harness([record]);

    const repairs = await reconcileGroupPeerClasses(deps);

    // No class evidence → it stays a classic group; only the field is added so
    // later boots short-circuit on the range test. That is not a repair, so it
    // is not reported — but it must be written, and nothing may be re-keyed.
    expect(repairs).toEqual([]);
    expect(relocated).toEqual([]);
    expect(rekeyed).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].kind).toBe('group');
    expect(saved[0].peerId).toBe(record.peerId);

    // Second boot, against what the store now holds: the field is there, so
    // not even that write happens.
    const again = harness([saved[0]]);
    expect(await reconcileGroupPeerClasses(again.deps)).toEqual([]);
    expect(again.saved).toEqual([]);
  });

  it('is idempotent — a second pass repairs nothing', async() => {
    const record = await legacyRecord({tags: ['session']});
    const {deps} = harness([record]);

    expect(await reconcileGroupPeerClasses(deps)).toHaveLength(1);
    expect(await reconcileGroupPeerClasses(deps)).toEqual([]);
  });

  it('stamps a classless record that is already in the session range — it must not be re-keyed into Groups', async() => {
    // The trap: "no class field" defaulting to classic would label this session
    // `group`, and the next boot's range test would then move it into the group
    // range. Adopting the range it is already in is the only safe reading.
    const sessionPeerId = await groupIdToPeerId(GROUP_ID, 'session');
    const record = await legacyRecord({peerId: sessionPeerId});
    const {deps, saved, rekeyed, relocated} = harness([record]);

    const repairs = await reconcileGroupPeerClasses(deps);

    expect(rekeyed).toEqual([]);
    expect(relocated).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].kind).toBe('session');
    expect(saved[0].peerId).toBe(sessionPeerId);
    expect(repairs).toEqual<GroupClassRepair[]>([{
      groupId: GROUP_ID,
      kind: 'session',
      fromPeerId: sessionPeerId,
      toPeerId: sessionPeerId,
      recordOnly: true
    }]);

    // And the next boot is a no-op — `kind` is there, the range agrees.
    const again = harness([saved[0]]);
    expect(await reconcileGroupPeerClasses(again.deps)).toEqual([]);
    expect(again.saved).toEqual([]);
  });

  it('does not half-migrate when the dialog move fails', async() => {
    const record = await legacyRecord({tags: ['session']});
    const {deps, saved} = harness([record]);
    deps.relocateDialog.mockRejectedValueOnce(new Error('dialogsStorage unavailable'));

    const repairs = await reconcileGroupPeerClasses(deps);

    expect(repairs).toEqual([]);
    // The record still claims the OLD peerId, so the next boot retries cleanly.
    expect(saved).toEqual([]);
    expect((record as any).peerId).toBe(await groupIdToPeerId(GROUP_ID, 'group'));
    expect(deps.log).toHaveBeenCalled();
  });

  it('puts the history re-stamp back when the dialog move fails', async() => {
    // The re-key order is history → dialog → record. A dialog failure after the
    // history moved leaves rows under a peer with no dialog row, so the pass has
    // to re-stamp them back onto the id the record still claims.
    const record = await legacyRecord({tags: ['session']});
    const {deps, rekeyed} = harness([record]);
    deps.relocateDialog.mockRejectedValueOnce(new Error('dialogsStorage unavailable'));

    await reconcileGroupPeerClasses(deps);

    const sessionPeerId = await groupIdToPeerId(GROUP_ID, 'session');
    expect(rekeyed).toEqual([
      {conversationId: `group:${GROUP_ID}`, peerId: sessionPeerId},
      {conversationId: `group:${GROUP_ID}`, peerId: record.peerId}
    ]);
    // The rollback is the LAST storage write of the pass.
    expect(deps.rekeyConversation.mock.invocationCallOrder[1])
    .toBeGreaterThan(deps.relocateDialog.mock.invocationCallOrder[0]);
  });

  it('logs and keeps the record when the rollback itself fails', async() => {
    const record = await legacyRecord({tags: ['session']});
    const {deps} = harness([record]);
    deps.relocateDialog.mockRejectedValueOnce(new Error('boom'));
    deps.rekeyConversation.mockRejectedValueOnce(new Error('rekey down')).mockRejectedValueOnce(new Error('rollback down'));

    await expect(reconcileGroupPeerClasses(deps)).resolves.toEqual([]);
    expect(deps.log).toHaveBeenCalledWith(
      'class re-key rollback failed for', expect.any(String), expect.any(Error)
    );
  });

  it('skips records with an unusable peerId and survives an unreadable store', async() => {
    const record = await legacyRecord({tags: ['session']});
    const {deps} = harness([record]);
    deps.listGroups.mockRejectedValueOnce(new Error('VersionError'));
    expect(await reconcileGroupPeerClasses(deps)).toEqual([]);

    const broken = {...record, peerId: undefined} as any;
    const h2 = harness([broken]);
    expect(await reconcileGroupPeerClasses(h2.deps)).toEqual([]);
    expect(h2.saved).toEqual([]);
  });
});

describe('MessageStore.setConversationTwebPeerId', () => {
  let store: MessageStore;
  let convId: string;
  let midCounter = 50_000;
  let convSeq = 0;

  function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
    const mid = overrides.mid ?? ++midCounter;
    return {
      eventId: overrides.eventId || ('evt-' + mid + '-' + Math.random().toString(36).slice(2, 8)),
      conversationId: convId,
      senderPubkey: 'b'.repeat(64),
      content: 'hello ' + mid,
      type: 'text',
      timestamp: 1_700_000_000 + mid,
      deliveryState: 'delivered',
      mid,
      twebPeerId: -Number(GROUP_PEER_BASE + BigInt(7)),
      isOutgoing: false,
      ...overrides
    };
  }

  beforeEach(async() => {
    // A fresh DB per test: the store singleton memoises its connection, and
    // `_dbPromise` is module state, so the conversation key is what isolates one
    // test from the next.
    store = new MessageStore();
    convId = 'group:' + GROUP_ID.slice(0, 24) + '-reconcile-' + (++convSeq);
  });

  it('re-stamps only twebPeerId, keeping eventId, mid and content', async() => {
    const rows = [makeMsg(), makeMsg(), makeMsg()];
    for(const row of rows) await store.saveMessage(row);
    const toPeerId = -Number(SESSION_PEER_BASE + BigInt(7));

    const updated = await store.setConversationTwebPeerId(convId, toPeerId);

    expect(updated).toBe(3);
    const after = await store.getMessages(convId, 100);
    expect(after).toHaveLength(3);
    for(const row of after) {
      expect(row.twebPeerId).toBe(toPeerId);
      const before = rows.find((r) => r.eventId === row.eventId)!;
      expect(row.mid).toBe(before.mid);
      expect(row.content).toBe(before.content);
    }
  });

  it('paginates past a full page and leaves other conversations alone', async() => {
    const otherConv = 'group:' + OTHER_GROUP_ID.slice(0, 24) + '-reconcile-' + (++convSeq);
    for(let i = 0; i < 7; i++) await store.saveMessage(makeMsg());
    await store.saveMessage(makeMsg({conversationId: otherConv}));
    const otherPeerId = -Number(GROUP_PEER_BASE + BigInt(9));
    await store.setConversationTwebPeerId(otherConv, otherPeerId);

    const toPeerId = -Number(SESSION_PEER_BASE + BigInt(11));
    expect(await store.setConversationTwebPeerId(convId, toPeerId, 3)).toBe(7);
    expect((await store.getMessages(convId, 100)).every((r) => r.twebPeerId === toPeerId)).toBe(true);
    expect((await store.getMessages(otherConv, 100)).every((r) => r.twebPeerId === otherPeerId)).toBe(true);
  });

  it('is a no-op when the peer id already matches', async() => {
    const toPeerId = -Number(SESSION_PEER_BASE + BigInt(13));
    await store.saveMessage(makeMsg({twebPeerId: toPeerId}));
    expect(await store.setConversationTwebPeerId(convId, toPeerId)).toBe(0);
  });
});
