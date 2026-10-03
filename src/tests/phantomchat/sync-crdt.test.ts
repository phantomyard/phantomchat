import {describe, it, expect} from 'vitest';
import {
  mergeEntry,
  mergeMaps,
  liveItems,
  tombstone,
  liveEntry,
  differs,
  isValidEntry,
  sanitizeMap,
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

  it('#180: a newer live entry WITHOUT a deliberate stamp no longer resurrects — that was the resurrection loop', () => {
    // The core fix of #180: automatic paths (profile refresh, message-path
    // persistence, stale pre-#180 clients) mint current updatedAt stamps
    // without any user intent. Under the old rule those cleared durable
    // deletes and the relay flipped live/deleted forever.
    const dead = tombstone<Contact>('x', 100);
    const live = liveEntry('x', c('x', 'alice'), 200); // fresh stamp, NO proof
    expect(mergeEntry(dead, live).deleted).toBe(true);
    expect(mergeEntry(live, dead).deleted).toBe(true); // order-independent
  });

  it('#180: a live entry with a deliberate stamp newer than the delete resurrects (deliberate re-add)', () => {
    const dead = tombstone<Contact>('x', 100);
    const live = liveEntry('x', c('x', 'alice'), 200, 150);
    expect(mergeEntry(dead, live).deleted).toBeUndefined();
    expect(mergeEntry(dead, live).data!.name).toBe('alice');
    expect(mergeEntry(live, dead).deleted).toBeUndefined();
  });

  it('#180: a deliberate stamp EQUAL to the delete does not resurrect — ambiguity resolves against resurrection', () => {
    // Seconds-floored stamps: a re-add inside the same second as the delete
    // ties, and equality cannot mean "after the delete".
    const dead = tombstone<Contact>('x', 100);
    const live = liveEntry('x', c('x', 'alice'), 150, 100);
    expect(mergeEntry(dead, live).deleted).toBe(true);
    expect(mergeEntry(live, dead).deleted).toBe(true);
  });

  it('#180: a deliberate stamp OLDER than the delete loses (deleted first, re-add proof predates it)', () => {
    const dead = tombstone<Contact>('x', 300);
    const live = liveEntry('x', c('x', 'alice'), 400, 200);
    expect(mergeEntry(dead, live).deleted).toBe(true);
    expect(mergeEntry(live, dead).deleted).toBe(true);
  });

  it('#180: live/live merges forward the greater deliberate stamp onto the winner (order-independent)', () => {
    // Without max-forwarding, T⊕A⊕B reaches different answers in different
    // fold orders (associativity break = permanent flapping).
    const a = liveEntry('x', c('x', 'a'), 100, 150);
    const b = liveEntry('x', c('x', 'b'), 200); // no stamp, newer updatedAt
    expect(mergeEntry(a, b).data!.name).toBe('b');
    expect(mergeEntry(a, b).deliberateAddAt).toBe(150);
    expect(mergeEntry(b, a)).toEqual(mergeEntry(a, b));
  });

  it('#180: identical payloads on a tie are decided by the greater stamp, deterministically', () => {
    const a = liveEntry('x', c('x', 'same'), 100, 150);
    const b = liveEntry('x', c('x', 'same'), 100, 200);
    expect(mergeEntry(a, b)).toEqual(mergeEntry(b, a));
    expect(mergeEntry(a, b).deliberateAddAt).toBe(200);
  });

  it('on an exact timestamp tie the tombstone wins, in both argument orders', () => {
    const live = liveEntry('x', c('x', 'alice'), 100);
    const dead = tombstone<Contact>('x', 100);
    // Determinism is the point: both devices must reach the same answer.
    expect(mergeEntry(live, dead).deleted).toBe(true);
    expect(mergeEntry(dead, live).deleted).toBe(true);
  });

  it('is commutative for live entries on a tie (no flapping)', () => {
    // Adapters floor updatedAt to whole seconds, so two edits inside one second
    // genuinely tie. If the tie-break depends on argument order, each device
    // keeps its OWN edit (callers merge `(local, remote)`) and republishes
    // forever. Both orders must land on the same entry.
    const a = liveEntry('x', c('x', 'a'), 100);
    const b = liveEntry('x', c('x', 'b'), 100);
    expect(mergeEntry(a, b)).toEqual(mergeEntry(b, a));
  });

  it('picks the tie winner by content, not by key insertion order', () => {
    // The same payload built with different key order must serialize
    // identically, or two devices disagree about who won the tie.
    const a = liveEntry<Contact>('x', {pubkey: 'x', name: 'a'}, 100);
    const b = liveEntry<Contact>('x', {name: 'b', pubkey: 'x'}, 100);
    expect(mergeEntry(a, b)).toEqual(mergeEntry(b, a));
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

  it('two devices converge on a same-second concurrent edit (no republish flap)', () => {
    // The reported bug. A and B each edit contact x inside the SAME second, so
    // updatedAt ties. Each device merges (own, theirs). If the tie-break is
    // argument-order dependent, A keeps A's edit and B keeps B's — both then
    // see a diff against the relay and republish, forever.
    const editA: SyncMap<Contact> = {x: liveEntry('x', c('x', 'from-A'), 100)};
    const editB: SyncMap<Contact> = {x: liveEntry('x', c('x', 'from-B'), 100)};

    const aResult = mergeMaps(editA, editB); // device A: (local, remote)
    const bResult = mergeMaps(editB, editA); // device B: (local, remote)

    expect(aResult).toEqual(bResult);
    // ...and having converged, neither device sees a reason to republish.
    expect(differs(aResult, bResult)).toBe(false);
    expect(mergeMaps(aResult, bResult)).toEqual(aResult);
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

  it('#180: converges across a three-device fold with stamps — every fold order agrees', () => {
    // T = durable delete at 100. A = deliberate re-add (stamp 150, upd 300).
    // B = stale client's auto-bumped live entry (upd 999, NO stamp).
    const T: SyncMap<Contact> = {x: tombstone<Contact>('x', 100)};
    const A: SyncMap<Contact> = {x: liveEntry('x', c('x', 'readded'), 300, 150)};
    const B: SyncMap<Contact> = {x: liveEntry('x', c('x', 'stale'), 999)};

    const viaTAB = mergeMaps(mergeMaps(T, A), B);
    const viaTBA = mergeMaps(mergeMaps(T, B), A);
    const viaABT = mergeMaps(mergeMaps(A, B), T);

    // The deliberate re-add wins in every fold order — the delete is cleared,
    // and the winning entry carries the stamp.
    expect(viaTAB.x.deleted).toBeFalsy();
    expect(viaTBA.x.deleted).toBeFalsy();
    expect(viaABT.x.deleted).toBeFalsy();
    expect(viaTAB.x.deliberateAddAt).toBe(150);
    expect(viaTBA.x.deliberateAddAt).toBe(150);
    expect(viaABT.x.deliberateAddAt).toBe(150);
  });

  it('#180: a stale client fresh-stamped live entry cannot clear a delete even when it is the ONLY live entry', () => {
    // The exact resurrection loop #180 exists to stop: phone P (stale build)
    // auto-bumps updatedAt on profile refresh, publishes live@999; every
    // fixed device holds the durable delete and re-asserts the tombstone.
    const fixed: SyncMap<Contact> = {x: tombstone<Contact>('x', 100)};
    const stale: SyncMap<Contact> = {x: liveEntry('x', c('x', 'ghost'), 999)};
    const merged = mergeMaps(fixed, stale);
    expect(merged.x.deleted).toBe(true);
    expect(liveItems(merged)).toHaveLength(0);
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

describe('tombstone retention (no GC)', () => {
  it('keeps an ancient tombstone in a merged map — a dropped tombstone is a resurrection on a timer', () => {
    const local: SyncMap<Contact> = {x: tombstone<Contact>('x', 10)}; // ancient delete
    const remote: SyncMap<Contact> = {}; // remote device never saw the delete
    const merged = mergeMaps(local, remote);
    expect(merged['x'].deleted).toBe(true);
    expect(merged['x'].updatedAt).toBe(10);
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

  it('true when only the PAYLOAD differs (same id, same second, same liveness)', () => {
    // The exact shape a same-second tie leaves behind: metadata identical, data
    // different. A metadata-only comparison calls this "no change" and the
    // losing snapshot is never overwritten on the relay.
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'from-A'), 100)};
    const b: SyncMap<Contact> = {x: liveEntry('x', c('x', 'from-B'), 100)};
    expect(differs(a, b)).toBe(true);
  });

  it('false when payloads are equal but key order differs', () => {
    // Same canonicalization as the merge tie-break: insertion order is not content.
    const a: SyncMap<Contact> = {x: {id: 'x', updatedAt: 100, data: {pubkey: 'x', name: 'X'}}};
    const b: SyncMap<Contact> = {x: {id: 'x', updatedAt: 100, data: {name: 'X', pubkey: 'x'} as Contact}};
    expect(differs(a, b)).toBe(false);
  });

  it('#180: true when only the deliberate stamp differs — a stamp-only advance must republish', () => {
    // Without this, a device would never learn a remote's deliberate re-add
    // proof and would tear the re-added item back down on its next read().
    const a: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100)};
    const b: SyncMap<Contact> = {x: liveEntry('x', c('x', 'X'), 100, 150)};
    expect(differs(a, b)).toBe(true);
  });

  it('a same-second tie loser on the relay IS republished (no silent divergence)', () => {
    // Regression for the review finding. Relay holds B's edit; this device holds
    // A's. They tie on updatedAt, so the merge picks a content-deterministic
    // winner — which has the SAME id/updatedAt/deleted as the loser.
    const local: SyncMap<Contact> = {x: liveEntry('x', c('x', 'from-A'), 100)};
    const remote: SyncMap<Contact> = {x: liveEntry('x', c('x', 'from-B'), 100)};
    const merged = mergeMaps(local, remote);

    // Whichever side won, reconcile must still see a diff against the LOSER,
    // or that loser stays on the relay forever and newly paired devices get it.
    const loser = merged.x.data.name === 'from-A' ? remote : local;
    const winner = merged.x.data.name === 'from-A' ? local : remote;

    expect(differs(merged, loser)).toBe(true);   // -> publish fires, relay is corrected
    expect(differs(merged, winner)).toBe(false); // -> and the winner does not churn

    // A device pairing afterwards downloads the corrected relay state and agrees.
    const newDevice = mergeMaps({}, merged);
    expect(differs(newDevice, merged)).toBe(false);
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

  it('#180: accepts a finite deliberateAddAt, rejects non-numeric or non-finite', () => {
    expect(isValidEntry({id: 'x', updatedAt: 1, data: {}, deliberateAddAt: 150})).toBe(true);
    expect(isValidEntry({id: 'x', updatedAt: 1, data: {}, deliberateAddAt: '150'})).toBe(false);
    expect(isValidEntry({id: 'x', updatedAt: 1, data: {}, deliberateAddAt: NaN})).toBe(false);
    // A tombstone carrying a stamp is meaningless but harmless — stamps only
    // matter on live entries; validation stays shape-only, merge ignores it.
    expect(isValidEntry({id: 'x', updatedAt: 1, deleted: true, deliberateAddAt: 150})).toBe(true);
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
