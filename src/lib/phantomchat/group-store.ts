/**
 * Group Store - IndexedDB persistence for group metadata
 *
 * Follows the same pattern as virtual-peers-db.ts:
 * - Singleton DB connection
 * - keyPath-based object store
 * - Index for reverse lookup (peerId → groupId)
 */

import type {GroupRecord} from './group-types';

const DB_NAME = 'phantomchat-groups';
const DB_VERSION = 2;
const STORE_NAME = 'groups';
const DELETED_STORE_NAME = 'deletedGroups';

export type DeletedGroupRecord = {groupId: string; deletedAt: number};

/** Reserved deletedGroups key carrying the unix-SECOND stamp of the
 * durable-log install moment (DB v2 creation/upgrade). Cannot collide with a
 * real groupId — those are validated 64-hex pubkeys. See
 * getLegacyDeleteCutoff. */
const LEGACY_DELETE_CUTOFF_KEY = '__legacyDeleteCutoff__';

let _dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Get or create the database singleton.
 */
function getDB(): Promise<IDBDatabase> {
  if(!_dbPromise) {
    _dbPromise = initGroupDB();
  }
  return _dbPromise;
}

/**
 * Initialize the IndexedDB database and object store.
 */
function initGroupDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {keyPath: 'groupId'});
        store.createIndex('peerId', 'peerId', {unique: true});
      }
      // v2: durable deleted-groups log (PR #179 review round 5). The positive
      // delete fact the sync adapter keys teardown on — conversation
      // tombstones are NOT equivalent, because messages.deleteHistory for a
      // group peer writes one as a mere history watermark while the group
      // stays live.
      if(!db.objectStoreNames.contains(DELETED_STORE_NAME)) {
        db.createObjectStore(DELETED_STORE_NAME, {keyPath: 'groupId'});
        // Same versionchange transaction: seed the legacy-migration cutoff
        // (see getLegacyDeleteCutoff) so the epoch is atomic with the schema
        // change — for both fresh installs (0→2) and v1→2 upgrades.
        (event.target as IDBOpenDBRequest).transaction!
        .objectStore(DELETED_STORE_NAME)
        .put({groupId: LEGACY_DELETE_CUTOFF_KEY, deletedAt: Math.floor(Date.now() / 1000)});
      }
    };
  });
}

/**
 * Singleton GroupStore class providing CRUD operations for group metadata.
 */
export class GroupStore {
  /**
   * Save or update a group record (upsert).
   */
  async save(group: GroupRecord): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(group);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get a group by its groupId.
   */
  async get(groupId: string): Promise<GroupRecord | null> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(groupId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }

  /**
   * Reverse lookup: get a group by its peerId via index.
   */
  async getByPeerId(peerId: number): Promise<GroupRecord | null> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('peerId');
      const request = index.get(peerId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }

  /**
   * Get all stored groups.
   */
  async getAll(): Promise<GroupRecord[]> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? []);
    });
  }

  /**
   * Delete a group by groupId.
   */
  async delete(groupId: string): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(groupId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Update the members array and updatedAt timestamp for a group.
   */
  async updateMembers(groupId: string, members: string[]): Promise<void> {
    const existing = await this.get(groupId);
    if(!existing) throw new Error(`Group not found: ${groupId}`);
    existing.members = members;
    existing.updatedAt = Date.now();
    await this.save(existing);
  }

  /**
   * Update metadata fields (name, description, avatar) for a group.
   */
  async updateInfo(
    groupId: string,
    updates: Partial<Pick<GroupRecord, 'name' | 'description' | 'avatar'>>
  ): Promise<void> {
    const existing = await this.get(groupId);
    if(!existing) throw new Error(`Group not found: ${groupId}`);
    if(updates.name !== undefined) existing.name = updates.name;
    if(updates.description !== undefined) existing.description = updates.description;
    if(updates.avatar !== undefined) existing.avatar = updates.avatar;
    existing.updatedAt = Date.now();
    await this.save(existing);
  }

  /**
   * Record a DURABLE group deletion (PR #179 review round 5).
   *
   * Monotonic like the message-store watermark: a write below the stored
   * value is a no-op, so a re-delete only moves the stamp forward and a
   * replayed older delete can never weaken a newer one. `deletedAt` is unix
   * SECONDS.
   *
   * This is the positive delete signal the groups sync adapter tears down
   * on. Call it ONLY from group-delete paths (teardownGroupLocally & co) —
   * NOT from messages.deleteHistory / channels.deleteHistory, which write a
   * `group:<id>` conversation tombstone as a mere history watermark while
   * the group record stays live.
   */
  async recordDeletedGroup(groupId: string, deletedAt: number): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DELETED_STORE_NAME, 'readwrite');
      const store = tx.objectStore(DELETED_STORE_NAME);
      const getReq = store.get(groupId);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const existing = getReq.result as DeletedGroupRecord | undefined;
        if(existing && existing.deletedAt >= deletedAt) {
          resolve();
          return;
        }
        const putReq = store.put({groupId, deletedAt});
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
    });
  }

  /** Every durable deletion record — the groups adapter's positive delete
   * facts, mirroring listDeletedPeers for contacts. The reserved cutoff row
   * is metadata, not a delete fact — strip it here so no consumer ever sees
   * it as one. */
  async listDeletedGroups(): Promise<DeletedGroupRecord[]> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DELETED_STORE_NAME, 'readonly');
      const req = tx.objectStore(DELETED_STORE_NAME).getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(
        ((req.result as DeletedGroupRecord[]) ?? [])
        .filter((d) => d.groupId !== LEGACY_DELETE_CUTOFF_KEY)
      );
    });
  }

  /**
   * Drop a durable deletion record — the group is wanted again.
   *
   * Only legitimate from a DELIBERATE re-create (fresh group_create restore
   * in the sync adapter's upsert path). Anything automatic must leave the
   * record alone, or the resurrection loop reopens.
   */
  async clearDeletedGroup(groupId: string): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DELETED_STORE_NAME, 'readwrite');
      const req = tx.objectStore(DELETED_STORE_NAME).delete(groupId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * Unix-SECOND stamp of the durable-log install moment (DB v2
   * creation/upgrade), recorded atomically in onupgradeneeded alongside the
   * deletedGroups store itself — so the row always exists wherever the log
   * does, and no separate meta store is needed.
   *
   * This bounds the legacy watermark migration in the groups sync adapter
   * (Kai's round-9 review of PR #179): only watermarks stamped at or before
   * this moment can be legacy deletions — anything written after the durable
   * log exists is authored by code that also writes durable rows, and a bare
   * late watermark is a clear-HISTORY watermark (messages.deleteHistory),
   * never a group delete. Without this bound, an every-read promotion rule
   * could promote such a watermark into an authoritative cross-device delete
   * whenever the durable log transiently lacks the record.
   *
   * Self-heals the row if it is missing (v2 DBs created by dev builds
   * predating the seeding): the cutoff becomes "now" — i.e. this call is
   * treated as the upgrade moment.
   */
  async getLegacyDeleteCutoff(): Promise<number> {
    const db = await getDB();
    const existing = await new Promise<DeletedGroupRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(DELETED_STORE_NAME, 'readonly');
      const req = tx.objectStore(DELETED_STORE_NAME).get(LEGACY_DELETE_CUTOFF_KEY);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result as DeletedGroupRecord | undefined);
    });
    if(existing && existing.deletedAt > 0) return existing.deletedAt;
    const now = Math.floor(Date.now() / 1000);
    await this.recordDeletedGroup(LEGACY_DELETE_CUTOFF_KEY, now);
    return now;
  }

  /**
   * Close the DB connection and reset the singleton (for testing).
   */
  async destroy(): Promise<void> {
    if(_dbPromise) {
      const db = await _dbPromise;
      db.close();
    }
    _dbPromise = null;
  }
}

// ─── Singleton accessor ─────────────────────────────────────────────

let _instance: GroupStore | null = null;

export function getGroupStore(): GroupStore {
  if(!_instance) {
    _instance = new GroupStore();
  }
  return _instance;
}
