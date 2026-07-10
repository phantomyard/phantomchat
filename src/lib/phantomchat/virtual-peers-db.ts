/**
 * Virtual Peers IndexedDB
 *
 * Stores bidirectional mappings between Nostr pubkeys and virtual Telegram peer IDs.
 * Forward mapping (pubkey → peerId) is computed deterministically — this DB
 * exists to support reverse lookup (peerId → pubkey) which cannot be reversed
 * from SHA-256 hash output.
 */

import type {NostrProfile} from './nostr-profile';
import {logSwallow} from './log-swallow';
import {schedulePublish} from './phantomchat-sync-triggers';

const DB_NAME = 'phantomchat-virtual-peers';
// v2 (#73): adds `updatedAt` — the per-item mutation timestamp the contacts
// CRDT sync needs. `addedAt` is a CREATION time; an LWW register needs a
// MUTATION time, and conflating the two silently loses cross-device renames.
// The v1→v2 upgrade backfills updatedAt = addedAt (an unmutated item's last
// change IS its creation), so no record is left without a merge timestamp.
const DB_VERSION = 2;
const STORE_NAME = 'mappings';

export interface VirtualPeerMapping {
  /** Nostr hex pubkey */
  pubkey: string;
  /** Virtual Telegram peer ID (deterministically derived from pubkey) */
  peerId: number;
  /** Optional display name */
  displayName?: string;
  /** Cached Nostr kind 0 profile metadata */
  nostrProfile?: NostrProfile;
  /** Timestamp when this mapping was first stored (creation time). */
  addedAt: number;
  /**
   * Unix-millis timestamp of the last IDENTITY-meaningful mutation (add,
   * rename, kind-0 profile change). NOT bumped on every inbound message —
   * that would make the contacts-sync CRDT churn a fresh relay revision on
   * each received message. Backfilled from `addedAt` on the v1→v2 upgrade.
   */
  updatedAt: number;
}

let _dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Get or create the database singleton.
 */
export function getDB(): Promise<IDBDatabase> {
  if(!_dbPromise) {
    _dbPromise = initVirtualPeersDB();
  }
  return _dbPromise;
}

/**
 * Initialize the IndexedDB database and object store.
 */
export function initVirtualPeersDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const req = event.target as IDBOpenDBRequest;
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {keyPath: 'pubkey'});
        // Unique index on peerId for reverse lookup
        store.createIndex('peerId', 'peerId', {unique: false});
        return; // fresh DB — records will be written with updatedAt already set
      }

      // v1→v2: backfill updatedAt on every existing mapping. Runs inside the
      // versionchange transaction, so it completes before any read/write sees
      // the store. An unmutated contact's last change IS its creation, hence
      // updatedAt = addedAt (falling back to now for pre-addedAt rows).
      if(event.oldVersion < 2) {
        const store = req.transaction!.objectStore(STORE_NAME);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if(!cursor) return;
          const rec = cursor.value as VirtualPeerMapping;
          if(rec.updatedAt === undefined) {
            rec.updatedAt = rec.addedAt ?? Date.now();
            cursor.update(rec);
          }
          cursor.continue();
        };
      }
    };
  });
}

/**
 * Store or update a pubkey ↔ peerId mapping.
 *
 * Read-modify-write upsert: when {@link displayName} or {@link nostrProfile}
 * are omitted (undefined), any value already stored on the record is
 * PRESERVED rather than overwritten with undefined. This matters because
 * the idempotent persistence paths added in #35 — `storePeerMapping` on
 * every inbound message and `backfillPeerMappingsFromHistory` on every
 * identity load — call this with only `(pubkey, peerId)`. A blind `put()`
 * would rewrite the record with `displayName: undefined` on every message,
 * silently wiping a user-set name. Passing an explicit value still
 * overwrites, so the profile/rename paths are unaffected.
 */
export async function storeMapping(
  pubkey: string,
  peerId: number,
  displayName?: string,
  nostrProfile?: NostrProfile
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(pubkey);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as VirtualPeerMapping | undefined;
      const now = Date.now();
      // updatedAt only advances on an IDENTITY-meaningful change: a brand-new
      // contact, or a caller explicitly supplying a name/profile. The
      // idempotent message-path (pubkey+peerId only) preserves the prior
      // updatedAt so received messages don't churn the contacts-sync blob.
      const identityChanged = !existing ||
        displayName !== undefined ||
        nostrProfile !== undefined;
      const record: VirtualPeerMapping = {
        pubkey,
        peerId,
        // Preserve prior values when the caller doesn't supply them.
        displayName: displayName ?? existing?.displayName,
        nostrProfile: nostrProfile ?? existing?.nostrProfile,
        addedAt: existing?.addedAt ?? now,
        updatedAt: identityChanged ? now : (existing?.updatedAt ?? existing?.addedAt ?? now)
      };
      const putReq = store.put(record);
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => resolve();
    };
  });
}

/**
 * Update just the nostrProfile and displayName on an existing mapping.
 * Does a get-then-put to preserve other fields.
 */
export async function updateMappingProfile(
  pubkey: string,
  displayName: string,
  nostrProfile: NostrProfile
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(pubkey);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as VirtualPeerMapping | undefined;
      if(!existing) {
        resolve();
        return;
      }
      // WU-2 #10: overwrite the displayName only when it was kind:0-derived
      // (equals the previously-stored profile name) or empty — so a contact's
      // kind:0 rebrand propagates. A user-supplied nickname (distinct from the
      // kind:0 name) is preserved. Previously `!existing.displayName` dropped
      // every rename once any name was set.
      const prevK0Name = existing.nostrProfile?.display_name || existing.nostrProfile?.name || '';
      if(!existing.displayName || existing.displayName === prevK0Name) {
        existing.displayName = displayName;
      }
      existing.nostrProfile = nostrProfile;
      existing.updatedAt = Date.now();
      const putReq = store.put(existing);
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => resolve();
    };
  });
}

/**
 * Force-set a user-supplied display name (nickname) on an existing mapping.
 *
 * Unlike {@link updateMappingProfile} — which only overwrites a kind:0-derived
 * or empty name so a contact's kind:0 rebrand can propagate — this writes the
 * name unconditionally. It is the manual-rename path (Edit Contact → Save):
 * the user's choice always wins, and because the resulting displayName is
 * distinct from any kind:0 name, the WU-2 #10 guard in updateMappingProfile
 * then preserves it against future kind:0 upgrades. The nostrProfile and all
 * other fields are preserved. No-op if the mapping doesn't exist.
 */
export async function setMappingDisplayName(
  pubkey: string,
  displayName: string
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(pubkey);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as VirtualPeerMapping | undefined;
      if(!existing) {
        resolve();
        return;
      }
      existing.displayName = displayName;
      existing.updatedAt = Date.now();
      const putReq = store.put(existing);
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => {
        // Deliberate user rename — propagate cross-device (debounced).
        schedulePublish('contacts');
        resolve();
      };
    };
  });
}

/**
 * Pin a mapping's `updatedAt` to an EXACT value (unix millis). Used only by
 * contacts-sync when it restores a contact from a remote CRDT entry: the
 * normal materialize path (addP2PContact → storeMapping) stamps updatedAt with
 * `now()`, which would push the local timestamp above the remote's and make
 * both devices flap — each seeing the other's entry as "newer" and
 * republishing forever. Writing back the merged entry's own timestamp makes
 * the local and remote views identical, so the merge converges to a fixed
 * point. No-op if the mapping doesn't exist.
 */
export async function setMappingUpdatedAt(pubkey: string, updatedAt: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(pubkey);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as VirtualPeerMapping | undefined;
      if(!existing) {
        resolve();
        return;
      }
      existing.updatedAt = updatedAt;
      const putReq = store.put(existing);
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => resolve();
    };
  });
}

/**
 * Get a single mapping by pubkey.
 */
export async function getMapping(pubkey: string): Promise<VirtualPeerMapping | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(pubkey);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Delete a mapping by pubkey.
 */
export async function removeMapping(pubkey: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(pubkey);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Get all stored mappings.
 */
export async function getAllMappings(): Promise<VirtualPeerMapping[]> {
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
 * Reverse lookup: get pubkey for a given peerId.
 * Queries the peerId index and returns the first match, or null if not found.
 *
 * Note: Forward mapping (pubkey → peerId) is deterministic and computed
 * synchronously — this function is only for reverse lookup of stored peers.
 */
export async function getPubkey(peerId: number): Promise<string | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('peerId');
    const request = index.getAll(peerId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const results = request.result as VirtualPeerMapping[];
      resolve(results.length > 0 ? results[0].pubkey : null);
    };
  });
}

// Named constants expected by tests
export const VIRTUAL_PEERS_DB_NAME = DB_NAME;  // = 'phantomchat-virtual-peers'
export const VIRTUAL_PEERS_STORE = 'virtual-peers';  // = 'mappings'
export const SCHEMA_VERSION = DB_VERSION;        // = 2

// VirtualPeerRecord interface (extends VirtualPeerMapping with timestamp fields)
export interface VirtualPeerRecord extends VirtualPeerMapping {
  displayName?: string;
  createdAt: number;
  lastSeenAt?: number;
}

// High-level VirtualPeersDB class wrapping the low-level API with a singleton pattern
export class VirtualPeersDB {
  private _db: Promise<IDBDatabase>;
  private debug: boolean;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
    this._db = initVirtualPeersDB();
  }

  private log(...args: any[]): void {
    if(this.debug) console.log('[VirtualPeersDB]', ...args);
  }

  private async getDB(): Promise<IDBDatabase> {
    return this._db;
  }

  async putPeer(pubkey: string, peerId: number, displayName?: string): Promise<void> {
    this.log('putPeer', pubkey, peerId, displayName);
    await storeMapping(pubkey, peerId, displayName);
  }

  async getByPubkey(pubkey: string): Promise<VirtualPeerRecord | null> {
    const all = await getAllMappings();
    return all.find(m => m.pubkey === pubkey) as VirtualPeerRecord ?? null;
  }

  async getByPeerId(peerId: number): Promise<VirtualPeerRecord | null> {
    const all = await getAllMappings();
    return all.find(m => m.peerId === peerId) as VirtualPeerRecord ?? null;
  }

  async deletePeer(pubkey: string): Promise<void> {
    await removeMapping(pubkey);
  }

  async updateLastSeen(pubkey: string): Promise<void> {
    const record = await this.getByPubkey(pubkey);
    if(!record) {
      console.warn('[VirtualPeersDB] updateLastSeen: pubkey not found', pubkey);
      return;
    }
    await this.putPeer(pubkey, record.peerId, record.displayName);
  }

  async getAll(): Promise<VirtualPeerRecord[]> {
    return (await getAllMappings()) as VirtualPeerRecord[];
  }

  async getStats(): Promise<{ totalPeers: number; oldestEntry: number | null; newestEntry: number | null }> {
    const all = await this.getAll();
    if(all.length === 0) {
      return {totalPeers: 0, oldestEntry: null, newestEntry: null};
    }
    return {
      totalPeers: all.length,
      oldestEntry: Math.min(...all.map(r => r.addedAt)),
      newestEntry: Math.max(...all.map(r => r.addedAt))
    };
  }

  async destroy(): Promise<void> {
    // Close the class-level connection
    try {
      const db = await this._db;
      db.close();
    } catch(e) { logSwallow('VirtualPeersDB.destroy.classLevel', e); }
    // Close the module-level singleton connection
    if(_dbPromise) {
      try {
        const db = await _dbPromise;
        db.close();
      } catch(e) { logSwallow('VirtualPeersDB.destroy.moduleLevel', e); }
    }
    _dbPromise = null;
    _instance = null;
  }

  static getInstance(): VirtualPeersDB {
    return getVirtualPeersDB();
  }
}

// Module-level singleton
let _instance: VirtualPeersDB | null = null;
export function getVirtualPeersDB(): VirtualPeersDB {
  if(!_instance) {
    _instance = new VirtualPeersDB();
  }
  return _instance;
}
