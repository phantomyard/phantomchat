import {describe, it, expect} from 'vitest';
import {
  mergeEntry,
  mergeMaps,
  gcTombstones,
  liveItems,
  tombstone,
  liveEntry,
  differs,
  isValidEntry,
  sanitizeMap,
  TOMBSTONE_TTL_SECONDS,
  type SyncMap
} from '@lib/phantomchat/sync-crdt';

type Contact = {pubkey: string, name: string};

const c = (pubkey: string, name: string): Contact => ({pubkey, name});

describe('mergeEntry', () => {
  it('higher updatedAt wins', () => {
    const a = liveEntry('x', c('x', 'old'), 100);
    const b = liveEntry('x', c('x', 'new'), 200);
    expect(mergeEntry(a, b).data!.name).toBe('new');
    expect(mergeEntry(b, a).data!.name).toBe('new');
  });

  it('a newer tombstone beats an older live entry', () => {
    const live = liveEntry('x', c('x', 'alice'), 100);
    const dead = tombstone<Contact>('x', 200);
    expect(mergeEntry(live, dead).deleted).toBe(true);
  });

  it('a newer live entry resurrects over an older tombstone (re-add)', () => {
    const dead = tombstone<Contact>('x', 100);
    const live = liveEntry('x', c('x', 'alice'), 200);
    expect(mergeEntry(dead, live).deleted).toBeUndefined();
    expect(mergeEntry(dead, live).data!.name).toBe('alice');
  });

  it('on an exact timestamp tie the tombstone wins, in both argument orders', () => {
    const live = liveEntry('x', c('x', 'alice'), 100);
    const dead = tombstone<Contact>('x', 100);
    // Determinism is the point: both devices must reach the same answer.
    expect(mergeEntry(live, dead).deleted).toBe(true);
    expect(mergeEntry(dead, live).deleted).toBe(true);
  });

  it('is commutative for live entries on a tie (no flapping)', () => {
    const a = liveEntry('x', c('x', 'a'), 100);
    const b = liveEntry('x', c('x', 'b'), 100);
    expect(mergeEntry(a, b)).toBe(mergeEntry(a, b));
  });
});

describe('mergeMaps — the case folders-sync gets wrong', () => {
  it('keeps BOTH concurrent offline adds instead of last-writer-wins', () => {
    // Device A added X offline; device B added Y offline. Under folders-sync
    // whole-blob LWW, whichever published last would erase the other.
    const deviceA: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const deviceB: SyncMap<Contact> = {y: liveEntry('y', c('y', 'Y'), 200)};

    const merged = mergeMaps(deviceA, deviceB);
    expect(Object.keys(merged).sort()).toEqual(['x', 'y']);
    expect(liveItems(merged)).toHaveLength(2);
  });

  it('is commutative — publish order does not change the result', () => {
    const a: SyncMap<Contact> = {
      x: liveEntry('x', c('x', 'X'), 100),
      z: tombstone<Contact>('z', 300)
    };
    const b: SyncMap<Contact> = {
      y: liveEntry('y', c('y', 'Y'), 200),
      z: liveEntry('z', c('z', 'Z'), 150)
    };
    expect(mergeMaps(a, b)).toEqual(mergeMaps(b, a));
  });

  it('is idempotent — merging the same remote twice changes nothing', () => {
    const local: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const remote: SyncMap<Contact> = {y: liveEntry('y', c('y', 'Y'), 200)};
    const once = mergeMaps(local, remote);
    expect(mergeMaps(once, remote)).toEqual(once);
  });

  it('propagates a delete made on the other device', () => {
    const local: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const remote: SyncMap<Contact> = {x: tombstone<Contact>('x', 200)};
    expect(liveItems(mergeMaps(local, remote))).toHaveLength(0);
  });

  it('absence on one side never deletes — only a tombstone does', () => {
    // The load-bearing invariant. Remote simply has not seen x yet.
    const local: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const remote: SyncMap<Contact> = {};
    expect(liveItems(mergeMaps(local, remote))).toHaveLength(1);
  });

  it('does not mutate either input', () => {
    const local: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const remote: SyncMap<Contact> = {x: tombstone<Contact>('x', 200)};
    const localCopy = JSON.parse(JSON.stringify(local));
    const remoteCopy = JSON.parse(JSON.stringify(remote));
    mergeMaps(local, remote);
    expect(local).toEqual(localCopy);
    expect(remote).toEqual(remoteCopy);
  });

  it('converges across a three-device round trip', () => {
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {y: liveEntry('y', c('y', 'Y'), 110)};
    const cc: SyncMap<Contact> = {x: tombstone<Contact>('x', 120)};

    const viaAB = mergeMaps(mergeMaps(a, b), cc);
    const viaCA = mergeMaps(mergeMaps(cc, a), b);
    const viaBC = mergeMaps(mergeMaps(b, cc), a);

    expect(viaAB).toEqual(viaCA);
    expect(viaAB).toEqual(viaBC);
    // x was deleted last; only y survives.
    expect(liveItems(viaAB).map((i) => i.pubkey)).toEqual(['y']);
  });
});

describe('gcTombstones', () => {
  const now = 1_000_000;

  it('drops tombstones past the TTL', () => {
    const map: SyncMap<Contact> = {x: tombstone<Contact>('x', now - TOMBSTONE_TTL_SECONDS - 1)};
    expect(Object.keys(gcTombstones(map, now))).toHaveLength(0);
  });

  it('keeps tombstones inside the TTL', () => {
    const map: SyncMap<Contact> = {x: tombstone<Contact>('x', now - 10)};
    expect(Object.keys(gcTombstones(map, now))).toHaveLength(1);
  });

  it('never drops a live item, however old', () => {
    const map: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 0)};
    expect(Object.keys(gcTombstones(map, now))).toHaveLength(1);
  });
});

describe('differs', () => {
  it('false for identical maps (so boot does not republish)', () => {
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    expect(differs(a, b)).toBe(false);
  });

  it('true when an id is missing on one side', () => {
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {};
    expect(differs(a, b)).toBe(true);
  });

  it('true when updatedAt moved', () => {
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 101)};
    expect(differs(a, b)).toBe(true);
  });

  it('true when one side is a tombstone', () => {
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {x: tombstone<Contact>('x', 100)};
    expect(differs(a, b)).toBe(true);
  });

  it('true when same length but different ids', () => {
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {y: liveEntry('y', c('y', 'Y'), 100)};
    expect(differs(a, b)).toBe(true);
  });
});

describe('isValidEntry / sanitizeMap — remote content is untrusted', () => {
  it('rejects non-objects', () => {
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry('nope')).toBe(false);
  });

  it('rejects a missing or empty id', () => {
    expect(isValidEntry({updatedAt: 1, data: {}})).toBe(false);
    expect(isValidEntry({id: '', updatedAt: 1, data: {}})).toBe(false);
  });

  it('rejects a non-finite updatedAt', () => {
    expect(isValidEntry({id: 'x', updatedAt: NaN, data: {}})).toBe(false);
    expect(isValidEntry({id: 'x', updatedAt: '5', data: {}})).toBe(false);
  });

  it('rejects a live entry with no data, and a tombstone carrying data', () => {
    expect(isValidEntry({id: 'x', updatedAt: 1})).toBe(false);
    expect(isValidEntry({id: 'x', updatedAt: 1, deleted: true, data: {}})).toBe(false);
  });

  it('accepts a well-formed live entry and tombstone', () => {
    expect(isValidEntry({id: 'x', updatedAt: 1, data: {}})).toBe(true);
    expect(isValidEntry({id: 'x', updatedAt: 1, deleted: true})).toBe(true);
  });

  it('drops only the bad entries, keeping the rest', () => {
    const raw = {
      good: {id: 'good', updatedAt: 1, data: c('good', 'G')},
      bad: {id: 'bad', updatedAt: NaN, data: c('bad', 'B')}
    };
    const clean = sanitizeMap<Contact>(raw);
    expect(Object.keys(clean)).toEqual(['good']);
  });

  it('rejects an entry whose id does not match its map key', () => {
    const raw = {imposter: {id: 'real', updatedAt: 1, data: c('real', 'R')}};
    expect(sanitizeMap<Contact>(raw)).toEqual({});
  });

  it('returns an empty map for garbage input', () => {
    expect(sanitizeMap<Contact>(null)).toEqual({});
    expect(sanitizeMap<Contact>('nope')).toEqual({});
  });
});
