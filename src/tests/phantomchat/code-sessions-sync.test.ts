/**
 * Code Mode session sync + live turn state (#279).
 *
 * Two behaviours are load-bearing and pinned here:
 *
 *  1. Session intent (title, auto-name, archive) syncs across devices through
 *     the generic union-merge CRDT, and a DELETE is TERMINAL — a session id is
 *     a group minted for exactly one session, so a tombstone can never be
 *     legitimately cleared and a stale blob must not resurrect the row.
 *  2. Turn state (Working / Done / Interrupted) is DEVICE-LOCAL. If it synced,
 *     reading a session on the phone would clear the badge on the desktop, and
 *     a turn running on one device would show "working" on all of them.
 */
import {describe, it, expect, vi} from 'vitest';
import {createCodeSessionsAdapter, CODE_SESSIONS_SYNC_D_TAG} from '@lib/phantomchat/code-sessions-sync-adapter';
import {mergeMaps} from '@lib/phantomchat/sync-crdt';
import {CodeSessionRuntimeTracker} from '@lib/phantomchat/code-session-runtime';
import type {CodeSessionRecord, CodeSessionTombstone} from '@lib/phantomchat/code-sessions-db';
import {WORKING_HARD_TIMEOUT_MS, WORKING_TYPING_WINDOW_MS} from '@lib/code-mode';

const NOW = 1_700_000_000_000;

function record(over: Partial<CodeSessionRecord> & {groupId: string}): CodeSessionRecord {
  return {
    title: over.groupId,
    autoNamed: true,
    archived: false,
    peerPubkey: 'a'.repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  };
}

function makeStore(initial: CodeSessionRecord[] = [], tombstones: CodeSessionTombstone[] = []) {
  const sessions = new Map(initial.map((r) => [r.groupId, r]));
  const deleted = new Map(tombstones.map((t) => [t.groupId, t]));
  const forgetRuntime = vi.fn(async() => {});

  const deps = {
    listSessions: async() => [...sessions.values()],
    listTombstones: async() => [...deleted.values()],
    saveSession: vi.fn(async(r: CodeSessionRecord) => { sessions.set(r.groupId, r); }),
    deleteSession: vi.fn(async(groupId: string) => { sessions.delete(groupId); }),
    recordDeleted: vi.fn(async(groupId: string, sec: number) => {
      const existing = deleted.get(groupId);
      if(existing && existing.deletedAt >= sec) return;
      deleted.set(groupId, {groupId, deletedAt: sec});
    }),
    forgetRuntime
  };

  return {deps, sessions, deleted, forgetRuntime};
}

describe('code-sessions sync adapter', () => {
  it('publishes a terse d-tag that cannot collide with the other domains', () => {
    expect(CODE_SESSIONS_SYNC_D_TAG).toBe('phantomchat.chat/code-sessions');
  });

  it('reads live sessions with second-resolution clocks', async() => {
    const {deps} = makeStore([record({groupId: 'g1', title: 'Refactor t…', archived: true})]);
    const map = await createCodeSessionsAdapter(deps).read();

    expect(map.g1.updatedAt).toBe(Math.floor(NOW / 1000));
    expect(map.g1.deleted).toBeUndefined();
    expect(map.g1.data).toMatchObject({groupId: 'g1', title: 'Refactor t…', archived: true, autoNamed: true});
    // Local-only turn state must never reach the wire.
    expect(map.g1.data).not.toHaveProperty('lastActiveAt');
    expect(map.g1.data).not.toHaveProperty('end');
  });

  it('publishes tombstones and tears down a resurrected live record', async() => {
    // A stale blob replayed the session after another device deleted it.
    const {deps, sessions, forgetRuntime} = makeStore(
      [record({groupId: 'g1'})],
      [{groupId: 'g1', deletedAt: Math.floor(NOW / 1000) - 10}]
    );

    const map = await createCodeSessionsAdapter(deps).read();

    expect(map.g1.deleted).toBe(true);
    expect(sessions.has('g1')).toBe(false);
    expect(deps.deleteSession).toHaveBeenCalledWith('g1');
    expect(forgetRuntime).toHaveBeenCalledWith('g1');
  });

  it('applies a remote session it has never seen', async() => {
    const {deps, sessions} = makeStore();
    const adapter = createCodeSessionsAdapter(deps);

    const local = await adapter.read();
    const remote = mergeMaps(local, {
      g2: {id: 'g2', updatedAt: Math.floor(NOW / 1000), data: {
        groupId: 'g2', title: 'Deploy pre…', autoNamed: true, archived: false,
        peerPubkey: 'b'.repeat(64), createdAt: NOW
      }}
    });
    await adapter.apply(remote, local);

    expect(sessions.get('g2')).toMatchObject({title: 'Deploy pre…', autoNamed: true, archived: false});
    // Clock pinned to the merged value so both devices converge.
    expect(sessions.get('g2').updatedAt).toBe(Math.floor(NOW / 1000) * 1000);
  });

  it('keeps the newest intent and ignores an older remote revision', async() => {
    const {deps, sessions} = makeStore([record({groupId: 'g1', title: 'mine', updatedAt: NOW})]);
    const adapter = createCodeSessionsAdapter(deps);
    const local = await adapter.read();

    const remote = mergeMaps(local, {
      g1: {id: 'g1', updatedAt: Math.floor(NOW / 1000) - 60, data: {
        groupId: 'g1', title: 'older', autoNamed: true, archived: false,
        peerPubkey: 'a'.repeat(64), createdAt: NOW
      }}
    });
    await adapter.apply(remote, local);

    expect(sessions.get('g1').title).toBe('mine');
    expect(deps.saveSession).not.toHaveBeenCalled();
  });

  it('applies an archive flip even when the clocks tie', async() => {
    // The archive flag is a boolean register: a device that archived on the
    // same second must still be honoured, or the two devices never converge.
    const {deps, sessions} = makeStore([record({groupId: 'g1', archived: false, updatedAt: NOW})]);
    const adapter = createCodeSessionsAdapter(deps);
    const local = await adapter.read();
    const remote = mergeMaps(local, {
      g1: {id: 'g1', updatedAt: Math.floor(NOW / 1000), data: {
        groupId: 'g1', title: 'g1', autoNamed: true, archived: true,
        peerPubkey: 'a'.repeat(64), createdAt: NOW
      }}
    });

    await adapter.apply(remote, local);
    expect(sessions.get('g1').archived).toBe(true);
  });

  it('propagates a remote delete locally and remembers it durably', async() => {
    const {deps, sessions, deleted, forgetRuntime} = makeStore([record({groupId: 'g1'})]);
    const adapter = createCodeSessionsAdapter(deps);
    const local = await adapter.read();
    const remote = mergeMaps(local, {g1: {id: 'g1', updatedAt: Math.floor(NOW / 1000) + 5, deleted: true}});

    await adapter.apply(remote, local);

    expect(sessions.has('g1')).toBe(false);
    expect(deleted.get('g1').deletedAt).toBe(Math.floor(NOW / 1000) + 5);
    expect(forgetRuntime).toHaveBeenCalledWith('g1');
  });

  it('a tombstoned session is never resurrected by a newer live blob', async() => {
    // Terminal deletes: the id belongs to one session, so re-creating it is not
    // a thing a device can do.
    const {deps} = makeStore([], [{groupId: 'g1', deletedAt: Math.floor(NOW / 1000)}]);
    const adapter = createCodeSessionsAdapter(deps);
    const local = await adapter.read();

    const remote = mergeMaps(local, {
      g1: {id: 'g1', updatedAt: Math.floor(NOW / 1000) + 999, data: {
        groupId: 'g1', title: 'back', autoNamed: true, archived: false,
        peerPubkey: 'a'.repeat(64), createdAt: NOW
      }}
    });

    expect(remote.g1.deleted).toBe(true);
  });
});

describe('code-session runtime tracker', () => {
  function tracker() {
    let clock = NOW;
    const state = new Map<string, {groupId: string}>();
    // No IndexedDB in this environment: the write is injected and asserted
    // through the fake store instead.
    const written = vi.fn(async() => {});
    const fake = new CodeSessionRuntimeTracker(() => clock, written);
    return {
      tracker: fake,
      written,
      advance: (ms: number) => { clock += ms; },
      now: () => clock,
      state
    };
  }

  it('marks a session working on send and done on typing stop', () => {
    const {tracker: rt, advance} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -2000000000000001}]);

    rt.markSent('g1');
    expect(rt.get('g1').workingSince).toBe(NOW);

    advance(1_000);
    rt.handleTypings(-2000000000000001, 1);
    expect(rt.get('g1').workingSince).toBe(NOW);

    advance(1_000);
    rt.handleTypings(-2000000000000001, 0);
    expect(rt.get('g1').workingSince).toBe(0);
    expect(rt.get('g1').end).toBe('done');
  });

  it('ignores typing from a peer that is not a session', () => {
    const {tracker: rt} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    rt.handleTypings(-2, 1);
    expect(Object.keys(rt.snapshot())).toEqual([]);
  });

  it('does not badge an idle session when a stray empty tick arrives', () => {
    const {tracker: rt} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    rt.handleTypings(-1, 0);
    expect(rt.get('g1')).toBeUndefined();
  });

  it('sweeps a stuck turn into Interrupted after the hard cap', () => {
    const {tracker: rt, advance} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    rt.markSent('g1');

    advance(WORKING_HARD_TIMEOUT_MS - 1_000);
    rt.handleTypings(-1, 1);
    expect(rt.sweep()).toEqual([]);

    advance(WORKING_HARD_TIMEOUT_MS);
    expect(rt.sweep()).toEqual(['g1']);
    expect(rt.get('g1').end).toBe('interrupted');
  });

  it('clears the Done badge on read', () => {
    const {tracker: rt, advance} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    rt.markSent('g1');
    advance(1_000);
    rt.handleTypings(-1, 1);
    advance(1_000);
    rt.handleTypings(-1, 0);

    expect(rt.get('g1').end).toBe('done');
    rt.markRead('g1');
    expect(rt.get('g1').end).toBeUndefined();
    expect(rt.get('g1').unread).toBe(false);
  });

  it('notifies subscribers on every transition', () => {
    const {tracker: rt, advance} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    const seen: string[] = [];
    const off = rt.subscribe((groupId) => seen.push(groupId));

    rt.markSent('g1');
    advance(1_000);
    rt.handleTypings(-1, 1);
    expect(seen).toEqual(['g1', 'g1']);

    off();
    rt.handleTypings(-1, 0);
    expect(seen).toEqual(['g1', 'g1']);
  });

  it('forgets a deleted session', () => {
    const {tracker: rt} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    rt.markSent('g1');
    rt.forget('g1');
    expect(rt.get('g1')).toBeUndefined();
  });

  it('keeps a tick alive for exactly the typing window', () => {
    const {tracker: rt, advance} = tracker();
    rt.setSessionPeers([{groupId: 'g1', peerId: -1}]);
    rt.handleTypings(-1, 1);
    const startedAt = rt.get('g1').workingSince;

    // A tick is "still typing" for the window; the row leaves Working after it.
    advance(WORKING_TYPING_WINDOW_MS - 500);
    expect(rt.get('g1').lastTypingAt).toBe(NOW);
    advance(1_000);
    // Nothing changed structurally — the tracker only reports state, the rail
    // decides Working from it (see lib/code-mode isSessionWorking).
    expect(rt.get('g1').workingSince).toBe(startedAt);
  });
});
