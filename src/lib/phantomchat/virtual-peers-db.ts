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
import {stableStringify} from './sync-crdt';

const DB_NAME = 'phantomchat-virtual-peers';
// v2 (#73): adds `updatedAt` — the per-item mutation timestamp the contacts
// CRDT sync needs. `addedAt` is a CREATION time; an LWW register needs a
// MUTATION time, and conflating the two silently loses cross-device renames.
// The v1→v2 upgrade backfills updatedAt = addedAt (an unmutated item's last
// change IS its creation), so no record is left without a merge timestamp.
// v3 (#173): adds the `deleted` store — a DURABLE log of contact deletions.
// Contact deletes used to be *derived* ("a conversation tombstone whose peer has
// no live mapping"), and contacts-sync itself wiped that watermark on every
// resurrect, so a delete could be lost entirely and a stale live entry then won
// the union merge forever. A positive `{pubkey, deletedAt}` row cannot be lost
// by deleting the chat, clearing history, or a wiped message-store watermark,
// and it needs no own-pubkey to read back.
const DB_VERSION = 3;
const STORE_NAME = 'mappings';
const DELETED_STORE = 'deleted';

/** A durable contact-deletion record. `deletedAt` is unix SECONDS (the CRDT
 * clock and the message-store watermark unit — NOT millis like mappings). */
export interface DeletedPeerRecord {
  pubkey: string;
  deletedAt: number;
}

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
  /**
   * Unix-millis timestamp of the last USER-INITIATED add of this contact
   * (#180) — the proof that may clear a durable delete cross-device. Stamped
   * ONLY by addP2PContact with `deliberate: true` (the UI add gestures) and
   * by contacts-sync apply() persisting a remote entry's own stamp.
   *
   * Deliberately NOT backfilled on upgrade: absence must mean "never proven
   * deliberate", and any invented value (Date.now(), addedAt) would let an
   * automatic or resurrected mapping clear a real delete. A legacy mapping
   * that never gets re-added simply keeps relying on the absence of a durable
   * delete row — which is the normal state for any wanted contact.
   */
  deliberateAddAt?: number;
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
      // v3: the durable deletion log. Created on every upgrade path (fresh DB
      // included) — it is independent of the mappings store.
      if(!db.objectStoreNames.contains(DELETED_STORE)) {
        db.createObjectStore(DELETED_STORE, {keyPath: 'pubkey'});
      }
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
  nostrProfile?: NostrProfile,
  opts?: {allowTombstoned?: boolean; deliberateAddAt?: number}
): Promise<boolean> {
  const db = await getDB();

  // Advisory pre-read: the tombstone guard below only matters when creating
  // a NEW mapping, and the async cross-DB tombstone lookup can't run inside
  // the readwrite transaction (awaiting there auto-commits it). This read
  // only DECIDES whether to run the tombstone check — the authoritative
  // read-modify-write happens atomically in the single readwrite
  // transaction below, so two concurrent calls can no longer both read
  // undefined and lose one caller's displayName/addedAt.
  const preExisting = await new Promise<VirtualPeerMapping | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(pubkey);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as VirtualPeerMapping | undefined);
  });

  // Tombstone guard — the resurrection fix. A deleted contact's mapping is
  // removed by deleteConversation (Level 1c) and its conversation carries a
  // deletion watermark. Automatic paths that re-persist mappings (contacts-sync
  // apply, history backfill, receive-path persistence, kind 0 upgrades) must
  // NOT re-create the mapping — otherwise the contact reappears in Contacts
  // and the group-members picker on every sync cycle. Deliberate re-adds go
  // through addP2PContact, which stamps the user-intent proof
  // (`deliberateAddAt`, #180) ATOMICALLY with the mapping write and clears
  // BOTH the durable row and the tombstone right after (issue #186: the
  // stamp must exist before the guards are lifted, or a failed stamp write
  // leaves a live unstamped mapping whose local delete fact is already
  // gone); the strictly-newer-message revive path passes
  // {allowTombstoned: true} explicitly (which bypasses only guard (b) below).
  // A `deliberateAddAt` option bypasses BOTH guards: it IS the user's
  // explicit re-add proof, supplied by the add gesture itself.
  if(!preExisting && !opts?.deliberateAddAt) {
    // (a) The DURABLE deletion log (#173). Checked FIRST because it needs no
    // own-pubkey and survives a wiped message-store watermark — the two ways
    // the watermark-only guard below silently let a deleted contact back in.
    // Deliberately INDEPENDENT of allowTombstoned: that flag is the strictly-
    // newer-message CONVERSATION revive, but a contact delete is a separate,
    // deliberate act — a deleted peer's new message may revive the chat (it
    // lands as a message request), never the contact. A deliberate re-add
    // presents the user-intent stamp itself (see comment above, #186).
    try {
      const deletedAt = await getDeletedPeer(pubkey);
      if(deletedAt > 0) {
        console.warn('[virtual-peers] suppressing mapping re-creation for deleted peer', pubkey.slice(0, 8));
        return false;
      }
    } catch(e) { /* guard is best-effort — never block a legit write on it */ }
  }
  if(!preExisting && !opts?.allowTombstoned && !opts?.deliberateAddAt) {
    // (b) The conversation deletion watermark — still consulted, so a delete
    // performed by an older build (no durable row) keeps being honoured.
    try {
      const own = (window as any).__phantomchatOwnPubkey || '';
      if(own) {
        const ms = await import('./message-store');
        const mstore = ms.getMessageStore();
        const convId = mstore.getConversationId(own, pubkey);
        const tomb = await mstore.getTombstone(convId);
        if(tomb > 0) {
          console.warn('[virtual-peers] suppressing mapping re-creation for tombstoned peer', pubkey.slice(0, 8));
          return false;
        }
      }
    } catch(e) { /* guard is best-effort — never block a legit write on it */ }
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Authoritative read INSIDE the write transaction: get + put commit
    // together, so concurrent burst-writes (receive path on reconnect)
    // serialize instead of last-write-losing a displayName.
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
      // Minted only by addP2PContact with `deliberate: true` (via the
      // deliberateAddAt option — same write as the mapping, #186) and
      // setDeliberateAddAt. Preserved across upserts; a supplied stamp
      // max-forwards (#180) so a re-add never lowers an existing proof.
      let nextStamp = existing?.deliberateAddAt;
      if(opts?.deliberateAddAt !== undefined) {
        nextStamp = Math.max(nextStamp ?? 0, opts.deliberateAddAt);
      }
      const record: VirtualPeerMapping = {
        pubkey,
        peerId,
        // Preserve prior values when the caller doesn't supply them.
        displayName: displayName ?? existing?.displayName,
        nostrProfile: nostrProfile ?? existing?.nostrProfile,
        addedAt: existing?.addedAt ?? now,
        updatedAt: identityChanged ? now : (existing?.updatedAt ?? existing?.addedAt ?? now),
        // Minted only by addP2PContact with `deliberate: true` (via the
        // deliberateAddAt option — same write as the mapping, #186) and
        // setDeliberateAddAt. Preserved across upserts; a supplied stamp
        // max-forwards (#180) so a re-add never lowers an existing proof.
        deliberateAddAt: nextStamp
      };
      const putReq = store.put(record);
      putReq.onerror = () => reject(putReq.error);
      // Resolve on transaction completion, not put success: the transaction
      // can still abort afterwards, and the caller (bridge) caches the
      // mapping only if this resolves — a mapped-but-not-committed cache
      // entry would disagree with IndexedDB for the rest of the session.
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => reject(tx.error || new Error('storeMapping transaction aborted'));
    };
  });
}

/**
 * Update just the nostrProfile and displayName on an existing mapping.
 * Does a get-then-put to preserve other fields.
 *
 * COSMETIC WRITES MUST NOT BUMP updatedAt (#155). The kind-0 refresh paths
 * call this on every profile fetch; updatedAt is the CRDT clock for the
 * contacts sync, and bumping it on a no-op write re-arms a stale live contact
 * with a fresh stamp that outranks any tombstone. The stamp moves ONLY when
 * the persisted payload actually changed — and a real change SHOULD move it,
 * so the rename propagates cross-device.
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
      let nameChanged = false;
      if(!existing.displayName || existing.displayName === prevK0Name) {
        nameChanged = existing.displayName !== displayName;
        existing.displayName = displayName;
      }
      const profileChanged = stableStringify(existing.nostrProfile) !== stableStringify(nostrProfile);
      existing.nostrProfile = nostrProfile;
      if(nameChanged || profileChanged) {
        existing.updatedAt = Date.now();
      }
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
 * Pin a mapping's `deliberateAddAt` to at least the given value (unix
 * MILLIS). Monotonic — only moves forward, so a stale remote entry can never
 * lower the local proof. No-op when the mapping does not exist (stamps belong
 * to live mappings; addP2PContact creates the mapping first). #180.
 */
export async function setDeliberateAddAt(pubkey: string, deliberateAddAt: number): Promise<void> {
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
      if((existing.deliberateAddAt ?? 0) >= deliberateAddAt) {
        resolve(); // monotonic — never lower the proof
        return;
      }
      existing.deliberateAddAt = deliberateAddAt;
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
 * Record a DURABLE contact deletion (#173).
 *
 * Monotonic, like the message-store watermark: a write below the stored value
 * is a no-op, so a re-delete only moves the stamp forward and a replayed older
 * delete can never weaken a newer one. `deletedAt` is unix SECONDS.
 *
 * Call this wherever a contact delete also removes the mapping — NOT on a
 * plain "clear history" / "delete chat" that keeps the contact, or the contact
 * would be deleted cross-device on the next reconcile.
 */
export async function recordDeletedPeer(pubkey: string, deletedAt: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DELETED_STORE, 'readwrite');
    const store = tx.objectStore(DELETED_STORE);
    const getReq = store.get(pubkey);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as DeletedPeerRecord | undefined;
      if(existing && existing.deletedAt >= deletedAt) {
        resolve();
        return;
      }
      const putReq = store.put({pubkey, deletedAt});
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => resolve();
    };
  });
}

/** Read one durable deletion stamp (unix seconds), or 0 if never deleted. */
export async function getDeletedPeer(pubkey: string): Promise<number> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DELETED_STORE, 'readonly');
    const req = tx.objectStore(DELETED_STORE).get(pubkey);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result as DeletedPeerRecord | undefined)?.deletedAt ?? 0);
  });
}

/** Every durable deletion record. Read by contacts-sync to publish deletes as
 * positive facts rather than inferring them from watermarks. */
export async function listDeletedPeers(): Promise<DeletedPeerRecord[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DELETED_STORE, 'readonly');
    const req = tx.objectStore(DELETED_STORE).getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result as DeletedPeerRecord[]) ?? []);
  });
}

/**
 * Drop a durable deletion record — the contact is wanted again.
 *
 * Only two callers are legitimate: a DELIBERATE user re-add (addP2PContact),
 * and contacts-sync when a remote LIVE entry is strictly newer than this
 * device's delete stamp (i.e. another device deliberately re-added). Anything
 * automatic must leave the record alone, or the resurrection loop reopens.
 */
export async function clearDeletedPeer(pubkey: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DELETED_STORE, 'readwrite');
    const req = tx.objectStore(DELETED_STORE).delete(pubkey);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
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
export const VIRTUAL_PEERS_STORE = STORE_NAME;  // = 'mappings'
export const SCHEMA_VERSION = DB_VERSION;        // = 3

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
