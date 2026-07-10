import {describe, it, expect, beforeEach, vi} from 'vitest';
import {CrdtSync, type LocalAdapter} from '@lib/phantomchat/crdt-sync';
import {liveEntry, tombstone, type SyncMap} from '@lib/phantomchat/sync-crdt';

type Item = {id: string, name: string};

const VERSION = 1;
const D_TAG = 'phantomchat.chat/test';

/** In-memory stand-in for the relay's replaceable-event slot. */
class FakeRelay {
  event: {kind: number, created_at: number, content: string} | null = null;
  publishes = 0;
  failQuery = false;

  publishEvent = vi.fn(async(ev: any) => {
    this.publishes++;
    this.event = {kind: ev.kind, created_at: ev.created_at, content: ev.content};
  });

  queryLatestEvent = vi.fn(async() => {
    if(this.failQuery) throw new Error('relay down');
    return this.event;
  });

  /** Seed the relay with a plaintext snapshot (encrypt === identity here). */
  seed(items: SyncMap<Item>, version = VERSION) {
    this.event = {
      kind: 30078,
      created_at: 1,
      content: JSON.stringify({version, items})
    };
  }

  decoded(): {version: number, items: SyncMap<Item>} {
    return JSON.parse(this.event!.content);
  }
}

/** Adapter over a plain in-memory map, recording what got applied. */
function makeAdapter(initial: SyncMap<Item> = {}) {
  const state: {map: SyncMap<Item>, applied: SyncMap<Item>[]} = {
    map: initial,
    applied: []
  };
  const adapter: LocalAdapter<Item> = {
    read: async() => state.map,
    apply: async(merged) => {
      state.applied.push(merged);
      state.map = merged;
    }
  };
  return {adapter, state};
}

function makeSync(relay: FakeRelay, adapter: LocalAdapter<Item>, now = 1000) {
  return new CrdtSync<Item>({
    dTag: D_TAG,
    version: VERSION,
    chatAPI: relay as any,
    adapter,
    encrypt: (s) => s,
    decrypt: (s) => s,
    nowSeconds: () => now
  });
}

let relay: FakeRelay;
beforeEach(() => {
  relay = new FakeRelay();
});

describe('CrdtSync.reconcile', () => {
  it('seeds an empty relay from local', async() => {
    const {adapter} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});
    const out = await makeSync(relay, adapter).reconcile();

    expect(out).toBe('no-remote-published-local');
    expect(relay.publishes).toBe(1);
    expect(Object.keys(relay.decoded().items)).toEqual(['a']);
  });

  it('does nothing when both relay and local are empty', async() => {
    const {adapter} = makeAdapter({});
    expect(await makeSync(relay, adapter).reconcile()).toBe('no-remote-nothing-local');
    expect(relay.publishes).toBe(0);
  });

  it('unions concurrent adds from two devices and republishes', async() => {
    relay.seed({b: liveEntry('b', {id: 'b', name: 'B'}, 200)});
    const {adapter, state} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

    const out = await makeSync(relay, adapter).reconcile();

    expect(out).toBe('merged-applied-and-published');
    expect(Object.keys(state.map).sort()).toEqual(['a', 'b']);
    expect(Object.keys(relay.decoded().items).sort()).toEqual(['a', 'b']);
  });

  it('applies a remote delete locally', async() => {
    relay.seed({a: tombstone<Item>('a', 200)});
    const {adapter, state} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

    await makeSync(relay, adapter).reconcile();
    expect(state.map.a.deleted).toBe(true);
  });

  it('reports in-sync and never publishes when both sides already agree', async() => {
    const map: SyncMap<Item> = {a: liveEntry('a', {id: 'a', name: 'A'}, 100)};
    relay.seed(map);
    const {adapter, state} = makeAdapter({...map});

    expect(await makeSync(relay, adapter).reconcile()).toBe('in-sync');
    expect(relay.publishes).toBe(0);
    expect(state.applied).toHaveLength(0);
  });

  it('applies locally without publishing when local was merely behind', async() => {
    relay.seed({
      a: liveEntry('a', {id: 'a', name: 'A'}, 100),
      b: liveEntry('b', {id: 'b', name: 'B'}, 200)
    });
    const {adapter, state} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

    expect(await makeSync(relay, adapter).reconcile()).toBe('merged-applied');
    expect(relay.publishes).toBe(0);
    expect(Object.keys(state.map).sort()).toEqual(['a', 'b']);
  });

  it('garbage-collects expired tombstones out of the published map', async() => {
    const now = 100 * 24 * 60 * 60; // 100 days
    relay.seed({old: tombstone<Item>('old', 1)});
    const {adapter} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, now - 5)});

    await makeSync(relay, adapter, now).reconcile();
    expect(Object.keys(relay.decoded().items)).toEqual(['a']);
  });

  describe('a missing remote is never mistaken for an authoritative empty one', () => {
    it('does not wipe local when the relay query throws', async() => {
      relay.failQuery = true;
      const {adapter, state} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

      await makeSync(relay, adapter).reconcile();
      expect(state.map.a.deleted).toBeUndefined();
    });

    it('does not wipe local when the remote snapshot version is unknown', async() => {
      relay.seed({}, 999);
      const {adapter, state} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

      await makeSync(relay, adapter).reconcile();
      expect(state.map.a.deleted).toBeUndefined();
      expect(Object.keys(state.map)).toEqual(['a']);
    });

    it('does not wipe local when the remote content is undecryptable garbage', async() => {
      relay.event = {kind: 30078, created_at: 1, content: '{{{not json'};
      const {adapter, state} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

      await makeSync(relay, adapter).reconcile();
      expect(Object.keys(state.map)).toEqual(['a']);
    });
  });

  it('drops individually-corrupt remote entries but keeps the good ones', async() => {
    relay.event = {
      kind: 30078,
      created_at: 1,
      content: JSON.stringify({
        version: VERSION,
        items: {
          good: {id: 'good', updatedAt: 200, data: {id: 'good', name: 'G'}},
          bad: {id: 'bad', updatedAt: 'NaN', data: {id: 'bad', name: 'B'}}
        }
      })
    };
    const {adapter, state} = makeAdapter({});

    await makeSync(relay, adapter).reconcile();
    expect(Object.keys(state.map)).toEqual(['good']);
  });

  it('surfaces failure instead of publishing when the local read throws', async() => {
    const adapter: LocalAdapter<Item> = {
      read: async() => { throw new Error('idb dead'); },
      apply: async() => {}
    };
    expect(await makeSync(relay, adapter).reconcile()).toBe('failed');
    expect(relay.publishes).toBe(0);
  });
});

describe('CrdtSync.publish', () => {
  it('re-fetches and unions before publishing, so it cannot clobber a remote add', async() => {
    // The relay learned about `b` after this device last reconciled. A naive
    // "publish my local map" would replace the event and erase b.
    relay.seed({b: liveEntry('b', {id: 'b', name: 'B'}, 200)});
    const {adapter} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});

    await makeSync(relay, adapter).publish();

    expect(Object.keys(relay.decoded().items).sort()).toEqual(['a', 'b']);
  });

  it('skips the write when the relay is already current', async() => {
    const map: SyncMap<Item> = {a: liveEntry('a', {id: 'a', name: 'A'}, 100)};
    relay.seed(map);
    const {adapter} = makeAdapter({...map});

    await makeSync(relay, adapter).publish();
    expect(relay.publishes).toBe(0);
  });

  it('publishes local as-is when the relay has nothing', async() => {
    const {adapter} = makeAdapter({a: liveEntry('a', {id: 'a', name: 'A'}, 100)});
    await makeSync(relay, adapter).publish();
    expect(relay.publishes).toBe(1);
  });

  it('does not publish while a remote apply is in flight', async() => {
    // reconcile() sets `applying` across the await inside adapter.apply; a
    // publish triggered by the events that apply fires must be a no-op,
    // otherwise the device echoes the remote state straight back.
    relay.seed({b: liveEntry('b', {id: 'b', name: 'B'}, 200)});

    let sync: CrdtSync<Item>;
    const adapter: LocalAdapter<Item> = {
      read: async() => ({a: liveEntry('a', {id: 'a', name: 'A'}, 100)}),
      apply: async() => { await sync.publish(); }
    };
    sync = makeSync(relay, adapter);

    await sync.reconcile();
    // exactly one publish: the reconcile's own, not the re-entrant one
    expect(relay.publishes).toBe(1);
  });
});
