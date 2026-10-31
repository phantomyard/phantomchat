/**
 * Session peer CLASS (owner batch 11, refined in batch 12).
 *
 * Replaces the tag-based Code folder. The owner's report on the tag version —
 * "the session appeared in the Code folder AND Groups, and my other groups
 * vanished" — was a threading bug, not a logic bug: folder membership is
 * computed in the MTPROTO worker, while the session index was module state
 * populated on the main thread, so the worker answered "not a session" and
 * `pFlags.groups` claimed the row. Scattered gates made it worse.
 *
 * Batch 12 cut the remaining divergence: a session is an ORDINARY GROUP that
 * happens to live in its own peerId range. Same menu, same avatar, same
 * protocol. Archived chats, groups and sessions share ONE archive (folder 1).
 *
 * The rules that have to hold now:
 *   1. Session-ness is a PURE RANGE TEST on the peer id. No index, no tags, no
 *      per-thread state — the same answer on both threads and after any reload.
 *   2. The peerId is a function of (groupId, kind), so the class travels on
 *      `group_create.groupKind` and survives the groups CRDT.
 *   3. Membership: Sessions (4) = live sessions; Groups (3) = live classic
 *      groups; Archives (1) = ANY dialog with `folder_id === 1`, whatever its
 *      type; Chats (0) excludes group-class peers.
 *   4. Archived items are read-only — the composer is hidden AND
 *      GroupAPI.sendMessage refuses for a group-class peer.
 */
import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach} from 'vitest';

// Polyfill Number.prototype.toPeerId (a tweb runtime addition; see
// phantomchat-peer-mapper.test.ts).
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}
if(!(Number.prototype as any).toUserId) {
  (Number.prototype as any).toUserId = function() {
    return Math.abs(this as number);
  };
}
import FiltersStorage from '@lib/storages/filters';
import {buildLocalFilter, isDefaultLocalTitle} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_GROUPS,
  FOLDER_ID_SESSION,
  PROTECTED_FOLDERS,
  REAL_FOLDERS,
  START_LOCAL_ID
} from '@appManagers/constants';
import {
  GROUP_PEER_BASE,
  SESSION_PEER_BASE,
  groupIdToPeerId,
  isChatGroupPeer,
  isGroupPeer,
  isSessionPeer
} from '@lib/phantomchat/group-types';
import {DEFAULT_SESSION_GROUP_NAME, sessionTitleFromPrompt} from '@lib/phantomchat/group-sessions';
import {PhantomChatPeerMapper} from '@lib/phantomchat/phantomchat-peer-mapper';

// One peer in each range, derived the way production derives them.
const SESSION_PEER_ID = -Number(SESSION_PEER_BASE + BigInt(12345));
const GROUP_PEER_ID = -Number(GROUP_PEER_BASE + BigInt(12345));
const USER_PEER_ID = 1_000_000_777;

function mkDialog(peerId: number, overrides: Record<string, unknown> = {}) {
  return {_: 'dialog', peerId, folder_id: FOLDER_ID_ALL, unread_count: 0, ...overrides} as any;
}

function filterStorage() {
  const fs = new FiltersStorage();
  (fs as any).filters = {
    [FOLDER_ID_ALL]: buildLocalFilter(FOLDER_ID_ALL),
    [FOLDER_ID_ARCHIVE]: buildLocalFilter(FOLDER_ID_ARCHIVE),
    [FOLDER_ID_GROUPS]: buildLocalFilter(FOLDER_ID_GROUPS),
    [FOLDER_ID_SESSION]: buildLocalFilter(FOLDER_ID_SESSION),
    // A custom group folder, to prove a session follows the same rule as any
    // other group there.
    6: {...buildLocalFilter(6), pFlags: {groups: true}}
  };
  (fs as any).rootScope = {dispatchEvent: vi.fn()};
  (fs as any).dialogsStorage = {canSaveDialog: () => true};
  (fs as any).appMessagesManager = {getDialogOnly: (pid: number) => mkDialog(pid)};
  (fs as any).appPeersManager = {
    isAnyChat: (pid: number) => pid < 0,
    isAnyGroup: (pid: number) => pid < 0,
    isBroadcast: () => false
  };
  (fs as any).appUsersManager = {isBot: () => false, isContact: () => false};
  return fs;
}

describe('peer-class predicates', () => {
  it('classifies by peer id range only', () => {
    expect(isSessionPeer(SESSION_PEER_ID)).toBe(true);
    expect(isSessionPeer(GROUP_PEER_ID)).toBe(false);
    expect(isSessionPeer(USER_PEER_ID)).toBe(false);
    expect(isSessionPeer(0)).toBe(false);

    // A session IS a group-class peer for every protocol path.
    expect(isGroupPeer(SESSION_PEER_ID)).toBe(true);
    expect(isGroupPeer(GROUP_PEER_ID)).toBe(true);
    // ...but only a classic group belongs to the Groups space.
    expect(isChatGroupPeer(SESSION_PEER_ID)).toBe(false);
    expect(isChatGroupPeer(GROUP_PEER_ID)).toBe(true);
  });

  it('is stateless — no index to hydrate, so it answers before any store read', () => {
    // Nothing is "loaded" in this file; the predicate is a pure comparison.
    for(const peerId of [SESSION_PEER_ID, GROUP_PEER_ID, USER_PEER_ID]) {
      expect(isSessionPeer(peerId)).toBe(isSessionPeer(peerId));
    }
  });
});

describe('peer id derivation', () => {
  const groupId = 'a'.repeat(64) + 'f'.repeat(32);

  it('lands in the session range for kind=session and the group range otherwise', async() => {
    const sessionPeerId = await groupIdToPeerId(groupId, 'session');
    const groupPeerId = await groupIdToPeerId(groupId, 'group');

    expect(isSessionPeer(sessionPeerId)).toBe(true);
    expect(isChatGroupPeer(groupPeerId)).toBe(true);
    expect(sessionPeerId).not.toBe(groupPeerId);
    // Default kind is 'group' — existing groups keep their ids forever.
    expect(await groupIdToPeerId(groupId)).toBe(groupPeerId);
  });

  it('is deterministic, so both sides of a create agree', async() => {
    expect(await groupIdToPeerId(groupId, 'session')).toBe(await groupIdToPeerId(groupId, 'session'));
  });
});

describe('folder definition', () => {
  it('names folder 4 Sessions, protected, with no extra archive folder', () => {
    expect(buildLocalFilter(FOLDER_ID_SESSION).title.text).toBe('Sessions');

    expect(REAL_FOLDERS.has(FOLDER_ID_SESSION)).toBe(true);
    expect(PROTECTED_FOLDERS.has(FOLDER_ID_SESSION)).toBe(true);
    // One archive for every type (owner batch 12): no second archive id.
    expect(REAL_FOLDERS.has(5)).toBe(false);
  });

  it('keeps the historical ids stable and puts START_LOCAL_ID back at 5', () => {
    expect(FOLDER_ID_ALL).toBe(0);
    expect(FOLDER_ID_ARCHIVE).toBe(1);
    expect(FOLDER_ID_GROUPS).toBe(3);
    expect(FOLDER_ID_SESSION).toBe(4);
    expect(START_LOCAL_ID).toBe(5);
  });

  it('treats the old "Code" and "Session" titles as defaults so they upgrade', () => {
    expect(isDefaultLocalTitle(FOLDER_ID_SESSION, 'Code')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_SESSION, 'Session')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_SESSION, 'My own name')).toBe(false);
  });

  it('gives folder 4 no group pFlag — the class decides membership', () => {
    expect((buildLocalFilter(FOLDER_ID_SESSION) as any).pFlags.groups).toBeUndefined();
  });

  it('strips a persisted folder 5 so a custom folder cannot inherit its localId', () => {
    const fs = filterStorage();
    (fs as any).localFilters = {
      [FOLDER_ID_ALL]: buildLocalFilter(FOLDER_ID_ALL),
      [FOLDER_ID_ARCHIVE]: buildLocalFilter(FOLDER_ID_ARCHIVE),
      [FOLDER_ID_GROUPS]: buildLocalFilter(FOLDER_ID_GROUPS),
      [FOLDER_ID_SESSION]: buildLocalFilter(FOLDER_ID_SESSION)
    };
    const persisted = [0, 1, 3, 4, 5].map((id) => ({...buildLocalFilter(id), localId: id}));
    const seeded = (fs as any).prependFilters(persisted) as Array<{id: number}>;
    // Rail order is All, Groups, Sessions, Archives — ids stay historical.
    expect(seeded.map((f) => f.id)).toEqual([0, 3, 4, 1]);
  });
});

describe('folder membership', () => {
  it('puts a live session in Sessions and in no live group space', () => {
    const fs = filterStorage();
    const session = mkDialog(SESSION_PEER_ID);

    expect(fs.testDialogForFilterId(session, FOLDER_ID_SESSION)).toBe(true);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ALL)).toBe(false);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_GROUPS)).toBe(false);
    expect(fs.testDialogForFilterId(session, FOLDER_ID_ARCHIVE)).toBe(false);
  });

  it('archives a session into the SHARED archive and out of Sessions', () => {
    const fs = filterStorage();
    const archived = mkDialog(SESSION_PEER_ID, {folder_id: FOLDER_ID_ARCHIVE});

    expect(fs.testDialogForFilterId(archived, FOLDER_ID_ARCHIVE)).toBe(true);
    expect(fs.testDialogForFilterId(archived, FOLDER_ID_SESSION)).toBe(false);
    expect(fs.testDialogForFilterId(archived, FOLDER_ID_ALL)).toBe(false);
    expect(fs.testDialogForFilterId(archived, FOLDER_ID_GROUPS)).toBe(false);
  });

  it('archives a group into the same archive and out of Groups', () => {
    const fs = filterStorage();
    const live = mkDialog(GROUP_PEER_ID);
    const archived = mkDialog(GROUP_PEER_ID, {folder_id: FOLDER_ID_ARCHIVE});

    expect(fs.testDialogForFilterId(live, FOLDER_ID_GROUPS)).toBe(true);
    expect(fs.testDialogForFilterId(live, FOLDER_ID_ARCHIVE)).toBe(false);

    expect(fs.testDialogForFilterId(archived, FOLDER_ID_ARCHIVE)).toBe(true);
    // Groups runs exclude_archived, so the same flag that reaches Archives
    // removes the row from Groups — no second membership rule to keep in step.
    expect(fs.testDialogForFilterId(archived, FOLDER_ID_GROUPS)).toBe(false);
  });

  it('keeps a session out of Groups while its groups stay visible', () => {
    // The owner's original bug: the session showed in Groups AND every other
    // group disappeared. Both halves are asserted here.
    const fs = filterStorage();
    expect(fs.testDialogForFilterId(mkDialog(SESSION_PEER_ID), FOLDER_ID_GROUPS)).toBe(false);
    expect(fs.testDialogForFilterId(mkDialog(GROUP_PEER_ID), FOLDER_ID_GROUPS)).toBe(true);
  });

  it('never lets a classic group look like a session', () => {
    const fs = filterStorage();
    const group = mkDialog(GROUP_PEER_ID);

    expect(fs.testDialogForFilterId(group, FOLDER_ID_SESSION)).toBe(false);
    expect(fs.testDialogForFilterId(group, FOLDER_ID_ALL)).toBe(false);
  });

  it('leaves plain chats alone', () => {
    const fs = filterStorage();
    const chat = mkDialog(USER_PEER_ID);

    expect(fs.testDialogForFilterId(chat, FOLDER_ID_ALL)).toBe(true);
    expect(fs.testDialogForFilterId(chat, FOLDER_ID_SESSION)).toBe(false);
    expect(fs.testDialogForFilterId(chat, FOLDER_ID_GROUPS)).toBe(false);
  });

  it('treats a session exactly like a group in a custom group folder', () => {
    const fs = filterStorage();
    expect(fs.testDialogForFilterId(mkDialog(SESSION_PEER_ID), 6))
    .toBe(fs.testDialogForFilterId(mkDialog(GROUP_PEER_ID), 6));
  });
});

describe('dialog construction', () => {
  it('stamps the Sessions index key for a session and Groups for a group', () => {
    const mapper = new PhantomChatPeerMapper();

    const sessionDialog = mapper.createTwebDialog({
      peerId: SESSION_PEER_ID, topMessage: 1, topMessageDate: 1000
    });
    expect((sessionDialog as any).index_4).toBeDefined();
    expect((sessionDialog as any).index_3).toBeUndefined();

    const groupDialog = mapper.createTwebDialog({
      peerId: GROUP_PEER_ID, topMessage: 1, topMessageDate: 1000
    });
    expect((groupDialog as any).index_3).toBeDefined();
    expect((groupDialog as any).index_4).toBeUndefined();
  });

  it('puts an archived group or session in the archive and no live space', () => {
    const mapper = new PhantomChatPeerMapper();

    for(const peerId of [SESSION_PEER_ID, GROUP_PEER_ID]) {
      const archived = mapper.createTwebDialog({
        peerId, topMessage: 1, topMessageDate: 1000, archived: true
      });
      expect(archived.folder_id).toBe(FOLDER_ID_ARCHIVE);
      expect((archived as any).index_1).toBeDefined();
      expect((archived as any).index_4).toBeUndefined();
      expect((archived as any).index_3).toBeUndefined();

      expect(mapper.createTwebDialog({
        peerId, topMessage: 1, topMessageDate: 1000
      }).folder_id).toBe(FOLDER_ID_ALL);
    }
  });
});

describe('session naming', () => {
  it('takes the first 10 characters of the first prompt, plus an ellipsis', () => {
    expect(DEFAULT_SESSION_GROUP_NAME).toBe('New session');
    expect(sessionTitleFromPrompt('Add a retry loop to the poller')).toBe('Add a retr…');
    expect(sessionTitleFromPrompt('short')).toBe('short');
    expect(sessionTitleFromPrompt('  multi\n  line   prompt  ')).toBe('multi line…');
    expect(sessionTitleFromPrompt('')).toBe('');
  });
});

describe('group store: archive state', () => {
  let store: any;

  beforeEach(async() => {
    const {GroupStore} = await import('@lib/phantomchat/group-store');
    store = new GroupStore();
  });

  const baseRecord = async(overrides: Record<string, unknown> = {}) => {
    const peerId = await groupIdToPeerId('b'.repeat(64) + 'a'.repeat(32), 'session');
    return {
      groupId: 'b'.repeat(64) + 'a'.repeat(32),
      name: 'New session',
      adminPubkey: 'a'.repeat(64),
      members: ['a'.repeat(64)],
      peerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kind: 'session' as const,
      ...overrides
    };
  };

  it('sets and clears archivedAt, and leaves it alone when absent', async() => {
    const record = await baseRecord();
    await store.save(record);

    await store.updateInfo(record.groupId, {archivedAt: 1234});
    expect((await store.get(record.groupId)).archivedAt).toBe(1234);

    // A plain rename must not unarchive it.
    await store.updateInfo(record.groupId, {name: 'renamed'});
    const renamed = await store.get(record.groupId);
    expect(renamed.name).toBe('renamed');
    expect(renamed.archivedAt).toBe(1234);

    await store.updateInfo(record.groupId, {archivedAt: null});
    expect((await store.get(record.groupId)).archivedAt).toBeUndefined();
  });

  it('archives a classic group the same way — the class makes no difference', async() => {
    const groupPeerId = await groupIdToPeerId('c'.repeat(64) + 'a'.repeat(32), 'group');
    const record = await baseRecord({groupId: 'c'.repeat(64) + 'a'.repeat(32), peerId: groupPeerId, kind: 'group'});
    await store.save(record);

    await store.updateInfo(record.groupId, {archivedAt: 99});
    expect((await store.get(record.groupId)).archivedAt).toBe(99);
  });
});
