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

const DB_NAME = 'phantomchat-virtual-peers';
const DB_VERSION = 1;
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
  /** Timestamp when this mapping was stored */
  addedAt: number;
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
      const db = (event.target as IDBOpenDBRequest).result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {keyPath: 'pubkey'});
        // Unique index on peerId for reverse lookup
        store.createIndex('peerId', 'peerId', {unique: false});
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
      const record: VirtualPeerMapping = {
        pubkey,
        peerId,
        // Preserve prior values when the caller doesn't supply them.
        displayName: displayName ?? existing?.displayName,
        nostrProfile: nostrProfile ?? existing?.nostrProfile,
        addedAt: Date.now()
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
export const SCHEMA_VERSION = DB_VERSION;        // = 1

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
