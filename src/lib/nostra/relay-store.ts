/**
 * RelayStore - IndexedDB storage for raw Nostr events and forward queue
 *
 * Provides persistent storage for relayed Nostr events with NIP-01 filter
 * support, plus a forward queue for delivering events to peers that were
 * offline at send time.
 *
 * DB: nostra-relay, version 1
 * Stores:
 *   events       (keyPath: id) — raw Nostr events
 *   forward_queue (autoIncrement) — pending forwarding tasks
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface NIP01Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  '#p'?: string[];
}

export interface ForwardQueueEntry {
  id?: number;
  targetPubkey: string;
  eventId: string;
  storedAt: number;
  attempts: number;
  lastAttempt: number;
}

// ─── Constants ─────────────────────────────────────────────────────

const DB_VERSION = 1;
const STORE_EVENTS = 'events';
const STORE_FORWARD = 'forward_queue';

// ─── RelayStore ────────────────────────────────────────────────────

/**
 * IndexedDB-backed store for raw Nostr events and forwarding queue.
 */
export class RelayStore {
  private dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName: string = 'nostra-relay') {
    this.dbName = dbName;
  }

  // ─── DB open ──────────────────────────────────────────────────────

  private getDB(): Promise<IDBDatabase> {
    if(!this.dbPromise) {
      this.dbPromise = this.openDB();
    }
    return this.dbPromise;
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // events store
        if(!db.objectStoreNames.contains(STORE_EVENTS)) {
          const evStore = db.createObjectStore(STORE_EVENTS, {keyPath: 'id'});
          evStore.createIndex('kind', 'kind', {unique: false});
          evStore.createIndex('pubkey', 'pubkey', {unique: false});
          evStore.createIndex('created_at', 'created_at', {unique: false});
          evStore.createIndex('kind_created_at', ['kind', 'created_at'], {unique: false});
        }

        // forward_queue store
        if(!db.objectStoreNames.contains(STORE_FORWARD)) {
          const fwStore = db.createObjectStore(STORE_FORWARD, {autoIncrement: true, keyPath: 'id'});
          fwStore.createIndex('targetPubkey', 'targetPubkey', {unique: false});
          fwStore.createIndex('eventId', 'eventId', {unique: false});
        }
      };
    });
  }

  // ─── Event methods ─────────────────────────────────────────────────

  /**
   * Save a Nostr event. Deduplicates by id (first write wins).
   * Returns true if the event was newly saved, false if it already existed.
   */
  async saveEvent(event: NostrEvent): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EVENTS, 'readwrite');
      const store = tx.objectStore(STORE_EVENTS);

      const getReq = store.get(event.id);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        if(getReq.result !== undefined) {
          // Already exists — first write wins
          resolve(false);
          return;
        }
        const addReq = store.add(event);
        addReq.onerror = () => reject(addReq.error);
        addReq.onsuccess = () => resolve(true);
      };
    });
  }

  /**
   * Get a single event by its Nostr event ID.
   */
  async getEvent(id: string): Promise<NostrEvent | undefined> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EVENTS, 'readonly');
      const store = tx.objectStore(STORE_EVENTS);
      const req = store.get(id);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result as NostrEvent | undefined);
    });
  }

  /**
   * Query events using a NIP-01 filter.
   * Results are sorted newest first (descending created_at).
   */
  async queryEvents(filter: NIP01Filter): Promise<NostrEvent[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EVENTS, 'readonly');
      const store = tx.objectStore(STORE_EVENTS);
      const req = store.openCursor();

      const results: NostrEvent[] = [];
      const idsSet = filter.ids ? new Set(filter.ids) : null;
      const authorsSet = filter.authors ? new Set(filter.authors) : null;
      const kindsSet = filter.kinds ? new Set(filter.kinds) : null;
      const pTagSet = filter['#p'] ? new Set(filter['#p']) : null;

      req.onerror = () => reject(req.error);
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const ev = cursor.value as NostrEvent;

          // Apply filters
          if(idsSet && !idsSet.has(ev.id)) {
            cursor.continue();
            return;
          }
          if(authorsSet && !authorsSet.has(ev.pubkey)) {
            cursor.continue();
            return;
          }
          if(kindsSet && !kindsSet.has(ev.kind)) {
            cursor.continue();
            return;
          }
          if(filter.since !== undefined && ev.created_at < filter.since) {
            cursor.continue();
            return;
          }
          if(filter.until !== undefined && ev.created_at > filter.until) {
            cursor.continue();
            return;
          }
          if(pTagSet) {
            const pValues = ev.tags
            .filter((t) => t[0] === 'p')
            .map((t) => t[1]);
            const hasPMatch = pValues.some((v) => pTagSet.has(v));
            if(!hasPMatch) {
              cursor.continue();
              return;
            }
          }

          results.push(ev);
          cursor.continue();
        } else {
          // Sort newest first
          results.sort((a, b) => b.created_at - a.created_at);
          const limit = filter.limit;
          resolve(limit !== undefined ? results.slice(0, limit) : results);
        }
      };
    });
  }

  /**
   * Delete events older than maxAgeSeconds.
   * Returns the number of events deleted.
   */
  async pruneOlderThan(maxAgeSeconds: number): Promise<number> {
    const db = await this.getDB();
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EVENTS, 'readwrite');
      const store = tx.objectStore(STORE_EVENTS);
      const req = store.openCursor();

      let deleted = 0;

      req.onerror = () => reject(req.error);
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const ev = cursor.value as NostrEvent;
          if(ev.created_at < cutoff) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
    });
  }

  // ─── Forward queue methods ─────────────────────────────────────────

  /**
   * Add an event to the forward queue for a target pubkey.
   */
  async enqueueForward(targetPubkey: string, eventId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FORWARD, 'readwrite');
      const store = tx.objectStore(STORE_FORWARD);
      const entry: Omit<ForwardQueueEntry, 'id'> = {
        targetPubkey,
        eventId,
        storedAt: Date.now(),
        attempts: 0,
        lastAttempt: 0
      };
      const req = store.add(entry);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * Get all forward queue entries for a target pubkey.
   */
  async getForwardQueue(targetPubkey: string): Promise<ForwardQueueEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FORWARD, 'readonly');
      const store = tx.objectStore(STORE_FORWARD);
      const index = store.index('targetPubkey');
      const req = index.openCursor(IDBKeyRange.only(targetPubkey));

      const results: ForwardQueueEntry[] = [];

      req.onerror = () => reject(req.error);
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          results.push(cursor.value as ForwardQueueEntry);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
    });
  }

  /**
   * Remove a forward queue entry by its auto-increment id.
   */
  async removeForward(id: number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FORWARD, 'readwrite');
      const store = tx.objectStore(STORE_FORWARD);
      const req = store.delete(id);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * Increment attempts and update lastAttempt timestamp for a queue entry.
   */
  async markForwardAttempt(id: number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FORWARD, 'readwrite');
      const store = tx.objectStore(STORE_FORWARD);
      const getReq = store.get(id);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const entry = getReq.result as ForwardQueueEntry | undefined;
        if(!entry) {
          resolve();
          return;
        }
        entry.attempts += 1;
        entry.lastAttempt = Date.now();
        const putReq = store.put(entry);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve();
      };
    });
  }

  /**
   * Delete forward queue entries older than maxAgeMs milliseconds.
   */
  async pruneForwardQueue(maxAgeMs: number): Promise<number> {
    const db = await this.getDB();
    const cutoff = Date.now() - maxAgeMs;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FORWARD, 'readwrite');
      const store = tx.objectStore(STORE_FORWARD);
      const req = store.openCursor();

      let deleted = 0;

      req.onerror = () => reject(req.error);
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if(cursor) {
          const entry = cursor.value as ForwardQueueEntry;
          if(entry.storedAt < cutoff) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
    });
  }
}

// ─── Singleton ─────────────────────────────────────────────────────

let _instance: RelayStore | null = null;

/**
 * Get the singleton RelayStore instance.
 */
export function getRelayStore(): RelayStore {
  if(!_instance) {
    _instance = new RelayStore();
  }
  return _instance;
}
