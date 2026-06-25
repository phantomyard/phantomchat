/*
 * PhantomChat.chat — local media store.
 *
 * Persists the user's OWN outgoing media blobs (voice notes, images) in
 * IndexedDB, keyed by a stable id assigned at record time. This decouples the
 * UI from the (slow, flaky) Blossom upload:
 *
 *   - The just-recorded bubble plays INSTANTLY from here — no Blossom round-trip
 *     and no decrypt — and survives a page reload.
 *   - The encrypted upload to Blossom runs in the background; it's only needed
 *     so the PEER (and the user's other devices) can fetch the file. Playback on
 *     THIS device never waits on it.
 *
 * LRU-capped: once a file is on Blossom the local copy is just a fast-path cache,
 * so old entries are evicted to bound disk use. `getLocalMedia` returning null
 * is fine — the renderer falls back to the Blossom URL + decrypt.
 */

const DB_NAME = 'phantomchat-local-media';
const STORE = 'media';
const DB_VERSION = 1;
const MAX_ENTRIES = 200;

interface LocalMediaRow {
  id: string;
  // Stored as raw bytes (not a Blob): ArrayBuffers structured-clone reliably
  // across every IndexedDB impl, whereas Blob round-tripping is patchy. The
  // Blob is reconstructed on read.
  bytes: ArrayBuffer;
  mimeType: string;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if(!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {keyPath: 'id'});
        store.createIndex('savedAt', 'savedAt', {unique: false});
      }
    };
  });
}

function getDB(): Promise<IDBDatabase> {
  if(!dbPromise) {
    dbPromise = openDB().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Persist a media blob under `id` (best-effort — a storage failure must never
 * break sending, only the local fast-path). Evicts oldest entries past the cap.
 */
export async function putLocalMedia(id: string, blob: Blob): Promise<void> {
  try {
    const mimeType = blob.type || 'application/octet-stream';
    const bytes = await blob.arrayBuffer();
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const row: LocalMediaRow = {id, bytes, mimeType, savedAt: Date.now()};
      tx.objectStore(STORE).put(row);
    });
    void evictOldest();
  } catch{
    // best-effort cache write; sending proceeds via the Blossom upload regardless
  }
}

export async function getLocalMedia(id: string): Promise<Blob | null> {
  try {
    const db = await getDB();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        const row = req.result as LocalMediaRow | undefined;
        resolve(row ? new Blob([row.bytes], {type: row.mimeType}) : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch{
    return null;
  }
}

export async function deleteLocalMedia(id: string): Promise<void> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore(STORE).delete(id);
    });
  } catch{ /* ignore */ }
}

/** Wipe the whole local media store (call on logout/lock). */
export async function clearLocalMedia(): Promise<void> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore(STORE).clear();
    });
  } catch{ /* ignore */ }
}

// Evict oldest rows beyond MAX_ENTRIES (the Blossom copy is the durable source).
async function evictOldest(): Promise<void> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const excess = countReq.result - MAX_ENTRIES;
        if(excess <= 0) return;
        let removed = 0;
        // 'savedAt' index ascends oldest-first.
        store.index('savedAt').openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if(!cursor || removed >= excess) return;
          cursor.delete();
          removed++;
          cursor.continue();
        };
      };
    });
  } catch{ /* ignore */ }
}
