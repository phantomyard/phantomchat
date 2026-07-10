/**
 * Generic union-merge CRDT with tombstones — shared by contacts-sync and
 * groups-sync.
 *
 * WHY NOT THE folders-sync MODEL?
 * folders-sync uses whole-blob last-write-wins: the newest publisher's
 * snapshot replaces the other device's wholesale. That is fine for folders
 * (a small ordered list the user edits deliberately, one device at a time)
 * but it silently destroys data for contacts and groups:
 *
 *     device A (offline): adds contact X
 *     device B (offline): adds contact Y
 *     B publishes, then A publishes  ->  A's blob wins, Y is gone forever
 *
 * So here merge is PER ITEM, not per blob:
 *   - an id present on only one side is KEPT           (adds are never lost)
 *   - an id on both sides keeps the higher updatedAt   (per-item LWW register)
 *   - deletes are TOMBSTONES, not absences             (deletes still propagate)
 *
 * The load-bearing invariant: **absence never means delete.** Only an explicit
 * tombstone deletes. That is what makes concurrent offline adds safe.
 *
 * This is an OR-Set whose elements are last-write-wins registers.
 */

/** Unix-seconds timestamp of the last local mutation of an item. */
export type SyncEntry<T> = {
  id: string;
  updatedAt: number;
  /** Tombstone marker. When true, `data` is absent and the item is deleted. */
  deleted?: boolean;
  /** Payload. Always absent for tombstones. */
  data?: T;
};

export type SyncMap<T> = Record<string, SyncEntry<T>>;

/**
 * How long a tombstone is retained before it is garbage-collected.
 *
 * TRADE-OFF: a device that stays offline LONGER than this window still holds
 * the live item, sees no tombstone to kill it, and will resurrect it on its
 * next publish. 90 days makes that vanishingly rare while keeping the blob
 * bounded (a tombstone is ~60 bytes, so even 1000 deletes is ~60 KB).
 */
export const TOMBSTONE_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Merge two entries for the SAME id.
 *
 * Higher `updatedAt` wins. On an exact tie the tombstone wins — an arbitrary
 * but *deterministic* rule, which is the property that actually matters: both
 * devices must independently reach the same answer, or they will publish
 * conflicting snapshots forever (merge flapping). Delete-wins-on-tie is safe
 * because a genuine re-add gets a strictly newer timestamp and resurrects.
 */
export function mergeEntry<T>(a: SyncEntry<T>, b: SyncEntry<T>): SyncEntry<T> {
  if(a.updatedAt > b.updatedAt) return a;
  if(b.updatedAt > a.updatedAt) return b;
  if(a.deleted) return a;
  if(b.deleted) return b;
  return a;
}

/**
 * Union-merge two maps. Neither input is mutated.
 *
 * Every id from either side survives into the output — as a live item or as a
 * tombstone. Nothing is dropped here; pruning is `gcTombstones`' job.
 */
export function mergeMaps<T>(local: SyncMap<T>, remote: SyncMap<T>): SyncMap<T> {
  const out: SyncMap<T> = {};

  for(const id of Object.keys(local)) {
    out[id] = local[id];
  }

  for(const id of Object.keys(remote)) {
    const mine = out[id];
    out[id] = mine ? mergeEntry(mine, remote[id]) : remote[id];
  }

  return out;
}

/**
 * Drop tombstones older than the TTL. Live items are never dropped, no matter
 * how old — only deletes expire.
 */
export function gcTombstones<T>(
  map: SyncMap<T>,
  nowSeconds: number,
  ttlSeconds: number = TOMBSTONE_TTL_SECONDS
): SyncMap<T> {
  const out: SyncMap<T> = {};
  for(const id of Object.keys(map)) {
    const e = map[id];
    if(e.deleted && nowSeconds - e.updatedAt > ttlSeconds) continue;
    out[id] = e;
  }
  return out;
}

/** The live (non-tombstoned) items of a map, as a plain array. */
export function liveItems<T>(map: SyncMap<T>): T[] {
  const out: T[] = [];
  for(const id of Object.keys(map)) {
    const e = map[id];
    if(!e.deleted && e.data !== undefined) out.push(e.data);
  }
  return out;
}

/** Build a tombstone for an id. */
export function tombstone<T>(id: string, updatedAt: number): SyncEntry<T> {
  return {id, updatedAt, deleted: true};
}

/** Build a live entry. */
export function liveEntry<T>(id: string, data: T, updatedAt: number): SyncEntry<T> {
  return {id, updatedAt, data};
}

/**
 * True when `a` differs from `b` in any way that is worth republishing.
 *
 * Compares the full entry set — id, updatedAt, deleted flag — so a merge that
 * only re-confirmed what the relay already had does NOT trigger a publish.
 * Without this every boot would write a fresh event and the relays would grow
 * a new 30078 revision per device per launch.
 */
export function differs<T>(a: SyncMap<T>, b: SyncMap<T>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if(aKeys.length !== bKeys.length) return true;

  for(const id of aKeys) {
    const x = a[id];
    const y = b[id];
    if(!y) return true;
    if(x.updatedAt !== y.updatedAt) return true;
    if(!!x.deleted !== !!y.deleted) return true;
  }
  return false;
}

/**
 * Validate one entry decoded off a relay. Remote content is UNTRUSTED — it is
 * whatever decrypted successfully under our own conversation key, but a
 * corrupt or older-format blob must not poison the local store.
 */
export function isValidEntry(obj: unknown): obj is SyncEntry<unknown> {
  if(!obj || typeof obj !== 'object') return false;
  const e = obj as SyncEntry<unknown>;
  if(typeof e.id !== 'string' || !e.id) return false;
  if(typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt)) return false;
  if(e.deleted !== undefined && typeof e.deleted !== 'boolean') return false;
  // A live entry must carry data; a tombstone must not.
  if(e.deleted) return e.data === undefined;
  return e.data !== undefined;
}

/**
 * Validate + sanitize a decoded map. Entries that fail validation are dropped
 * individually rather than rejecting the whole snapshot — one bad contact
 * should not cost the user every other contact.
 *
 * Also enforces that the map key matches `entry.id`, so a hostile/corrupt blob
 * cannot smuggle an entry in under a different key than it claims.
 */
export function sanitizeMap<T>(obj: unknown): SyncMap<T> {
  if(!obj || typeof obj !== 'object') return {};
  const out: SyncMap<T> = {};
  for(const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if(!isValidEntry(value)) continue;
    if(value.id !== key) continue;
    out[key] = value as SyncEntry<T>;
  }
  return out;
}
