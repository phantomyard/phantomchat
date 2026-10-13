import {describe, it, expect, vi} from 'vitest';
import {
  createReadStateAdapter,
  mergeReadStateMaps,
  READ_STATE_SYNC_D_TAG,
  type ReadStateData
} from '@lib/phantomchat/read-state-sync-adapter';
import {CrdtSync, type LocalAdapter} from '@lib/phantomchat/crdt-sync';
import {liveEntry, tombstone, type SyncMap} from '@lib/phantomchat/sync-crdt';

const entry = (id: string, mid: number, updatedAt = 0): SyncMap<ReadStateData> =>
  ({[id]: {id, updatedAt, data: {lastReadMid: mid}}});

describe('mergeReadStateMaps (#217 — max-wins on the read cursor)', () => {
  it('keeps the higher cursor regardless of which side wrote last', () => {
    // Device A read to 100 at 10:00; device B read only to 50 at 11:00 (it had
    // less history). LWW would take 50 and un-read 51..100 everywhere.
    const a = entry('conv', 100, 600);
    const b = entry('conv', 50, 660);
    expect(mergeReadStateMaps(a, b).conv.data!.lastReadMid).toBe(100);
    expect(mergeReadStateMaps(b, a).conv.data!.lastReadMid).toBe(100);
  });

  it('is commutative, associative and idempotent (folds in any order)', () => {
    const a = entry('conv', 30, 10);
    const b = entry('conv', 90, 5);
    const c = entry('conv', 60, 20);
    const folds = [
      mergeReadStateMaps(mergeReadStateMaps(a, b), c),
      mergeReadStateMaps(mergeReadStateMaps(c, a), b),
      mergeReadStateMaps(mergeReadStateMaps(b, c), a)
    ];
    for(const f of folds) {
      expect(f.conv.data!.lastReadMid).toBe(90);
      expect(mergeReadStateMaps(f, f)).toEqual(f);
    }
  });

  it('unions conversations present on only one side', () => {
    const merged = mergeReadStateMaps(entry('a', 5), entry('b', 7));
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('breaks equal-cursor ties deterministically on both sides', () => {
    const a = entry('conv', 42, 1);
    const b = entry('conv', 42, 2);
    expect(mergeReadStateMaps(a, b).conv).toBe(b.conv);
    expect(mergeReadStateMaps(b, a).conv).toBe(b.conv);
  });

  it('drops tombstone-shaped entries: read state is never deleted', () => {
    const live = entry('conv', 80);
    const dead: SyncMap<ReadStateData> = {conv: tombstone('conv', 999)};
    expect(mergeReadStateMaps(live, dead).conv).toBe(live.conv);
    expect(mergeReadStateMaps(dead, live).conv).toBe(live.conv);
    expect(mergeReadStateMaps(dead, dead)).toEqual({});
    // One-sided tombstones must drop too (#218 review): keeping one while
    // dropping the both-sided pair broke idempotence for that input — a
    // device holding such a remote saw differs(merged, local) on every
    // reconcile and re-ran apply forever.
    expect(mergeReadStateMaps(dead, {})).toEqual({});
    expect(mergeReadStateMaps({}, dead)).toEqual({});
    const once = mergeReadStateMaps(dead, {});
    expect(mergeReadStateMaps(once, {})).toEqual(once);
  });

  it('ignores garbage cursor values instead of letting them win', () => {
    const good = entry('conv', 10);
    const bad = entry('conv', Number.NaN);
    // NaN compares false both ways — must fall back to a deterministic pick,
    // never flip between folds.
    const m1 = mergeReadStateMaps(good, bad).conv.data!.lastReadMid;
    const m2 = mergeReadStateMaps(bad, good).conv.data!.lastReadMid;
    expect(m1).toBe(10);
    expect(m2).toBe(10);
  });
});

describe('createReadStateAdapter', () => {
  it('exports live cursors as entries and skips garbage rows', async() => {
    const adapter = createReadStateAdapter({
      listReadCursors: async() => [
        {conversationId: 'conv-a', lastReadMid: 5},
        {conversationId: 'conv-b', lastReadMid: 0}, // never-read: not an entry
        {conversationId: '', lastReadMid: 9},
        {conversationId: 'conv-c', lastReadMid: Number.NaN}
      ],
      setReadCursor: async() => {}
    });
    const map = await adapter.read();
    expect(Object.keys(map)).toEqual(['conv-a']);
    expect(map['conv-a']).toEqual({id: 'conv-a', updatedAt: 0, data: {lastReadMid: 5}});
  });

  it('applies merged cursors and reports only genuine advances', async() => {
    const written: Array<[string, number]> = [];
    const advanced: Array<[string, number]> = [];
    const adapter = createReadStateAdapter({
      listReadCursors: async() => [],
      setReadCursor: async(c, m) => { written.push([c, m]); },
      onCursorAdvanced: (c, m) => { advanced.push([c, m]); }
    });

    await adapter.apply(
      {
        ahead: {id: 'ahead', updatedAt: 0, data: {lastReadMid: 20}},
        behind: {id: 'behind', updatedAt: 0, data: {lastReadMid: 1}}
      },
      {
        ahead: {id: 'ahead', updatedAt: 0, data: {lastReadMid: 10}},
        behind: {id: 'behind', updatedAt: 0, data: {lastReadMid: 50}}
      }
    );

    // Both get written (setReadCursor is monotonic — a behind-write is a
    // silent no-op at the store), but only 'ahead' is a LEARNED advance.
    expect(written).toEqual(expect.arrayContaining([['ahead', 20], ['behind', 1]]));
    expect(advanced).toEqual([['ahead', 20]]);
  });

  it('swallows a failing badge-refresh without failing the apply', async() => {
    const written: Array<[string, number]> = [];
    const adapter = createReadStateAdapter({
      listReadCursors: async() => [],
      setReadCursor: async(c, m) => { written.push([c, m]); },
      onCursorAdvanced: () => { throw new Error('badge dispatch exploded'); }
    });
    await expect(adapter.apply(
      {conv: {id: 'conv', updatedAt: 0, data: {lastReadMid: 7}}},
      {}
    )).resolves.toBeUndefined();
    expect(written).toEqual([['conv', 7]]);
  });
});

describe('read-state over the real CrdtSync engine (#217)', () => {
  class FakeRelay {
    event: {kind: number, created_at: number, content: string} | null = null;
    publishEvent = vi.fn(async(ev: any) => {
      this.event = {kind: ev.kind, created_at: ev.created_at, content: ev.content};
    });
    queryLatestEvent = vi.fn(async() => this.event);
    seed(items: SyncMap<ReadStateData>) {
      this.event = {kind: 30078, created_at: 1, content: JSON.stringify({version: 1, items})};
    }
    decoded(): {items: SyncMap<ReadStateData>} {
      return JSON.parse(this.event!.content);
    }
  }

  const makeDevice = (cursors: Record<string, number>) => {
    const state = {...cursors};
    const adapter: LocalAdapter<ReadStateData> = {
      read: async() => Object.fromEntries(
        Object.entries(state).map(([id, mid]) => [id, {id, updatedAt: 0, data: {lastReadMid: mid}}])
      ),
      apply: async(merged) => {
        for(const [id, e] of Object.entries(merged)) {
          if(e.deleted) continue;
          const mid = e.data!.lastReadMid;
          if(mid > (state[id] ?? 0)) state[id] = mid;
        }
      }
    };
    return {state, adapter};
  };

  const makeSync = (relay: FakeRelay, adapter: LocalAdapter<ReadStateData>) =>
    new CrdtSync<ReadStateData>({
      dTag: READ_STATE_SYNC_D_TAG,
      version: 1,
      acceptedVersions: [1],
      merge: mergeReadStateMaps,
      chatAPI: {publishEvent: relay.publishEvent, queryLatestEvent: relay.queryLatestEvent},
      adapter,
      encrypt: (s) => s,
      decrypt: (s) => s,
      nowSeconds: () => 1000
    });

  it('a later-but-behind device catches UP via max-wins and never drags the cursor back', async() => {
    // Device A published "read to 100"; device B (cursor 50, "read" more
    // recently) reconciles. B must land on 100 — not publish 50 over it.
    const relay = new FakeRelay();
    relay.seed(entry('conv', 100, 600));
    const b = makeDevice({conv: 50});
    const sync = makeSync(relay, b.adapter);

    const outcome = await sync.reconcile();
    expect(outcome).toBe('merged-applied'); // B learned 100; relay unchanged
    expect(b.state.conv).toBe(100);
    expect(relay.decoded().items.conv.data!.lastReadMid).toBe(100);
  });

  it('seed-publishes local cursors when the relay has nothing', async() => {
    const relay = new FakeRelay();
    const a = makeDevice({conv: 100});
    const outcome = await makeSync(relay, a.adapter).reconcile();
    expect(outcome).toBe('no-remote-published-local');
    expect(relay.decoded().items.conv.data!.lastReadMid).toBe(100);
  });

  it('two devices converge on the max cursor no matter who publishes first', async() => {
    const relay = new FakeRelay();
    const a = makeDevice({conv: 100, other: 3});
    const b = makeDevice({conv: 50, other: 9});
    await makeSync(relay, a.adapter).reconcile();   // A publishes first
    await makeSync(relay, b.adapter).reconcile();   // B merges behind + ahead
    await makeSync(relay, a.adapter).reconcile();   // A picks up 'other: 9'
    expect(a.state).toEqual({conv: 100, other: 9});
    expect(b.state).toEqual({conv: 100, other: 9});
    const items = relay.decoded().items;
    expect(items.conv.data!.lastReadMid).toBe(100);
    expect(items.other.data!.lastReadMid).toBe(9);
  });
});
