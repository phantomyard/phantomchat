/**
 * Code Mode session store — IndexedDB persistence for coding sessions.
 *
 * Follows the same pattern as group-store.ts / virtual-peers-db.ts: singleton
 * connection, keyPath-keyed stores, promise-wrapped IDB calls.
 *
 * THREE STORES, ON PURPOSE (see lib/code-mode for the reasoning):
 *
 *  - `sessions`  — the SYNCED intent: title, whether the title is still the
 *                  auto-derived first-prompt one, and the archive flag. This
 *                  is what the `code-sessions` CRDT domain publishes.
 *  - `deleted`   — durable tombstones (unix SECONDS). A delete must be a
 *                  positive fact that can always be re-published, or a stale
 *                  relay blob resurrects the session (the contacts #173 bug).
 *  - `runtime`   — LOCAL ONLY: last activity, live turn state, Done/
 *                  Interrupted badge. "This turn is running" and "you have not
 *                  read it" are device facts; publishing them would let one
 *                  device clear another's badge.
 */

import type {CodeSessionRuntime} from '@lib/code-mode';

const DB_NAME = 'phantomchat-code-sessions';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const DELETED_STORE = 'deleted';
const RUNTIME_STORE = 'runtime';

/** One coding session. `groupId` is the 2-member private group backing it. */
export interface CodeSessionRecord {
  groupId: string;
  /** Rail title. Equal to the auto-derived first-prompt title until renamed. */
  title: string;
  /** True while the title is still auto-derived; a rename clears it forever. */
  autoNamed: boolean;
  archived: boolean;
  /** The phantom this session talks to — the group's non-self member. */
  peerPubkey: string;
  createdAt: number;
  /** LWW clock for the sync merge (millis). */
  updatedAt: number;
}

export interface CodeSessionTombstone {
  groupId: string;
  /** Unix SECONDS — the CRDT engine's clock. */
  deletedAt: number;
}

export type CodeSessionRuntimeRecord = CodeSessionRuntime & {groupId: string};

let _dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if(!_dbPromise) _dbPromise = initDB();
  return _dbPromise;
}

function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, {keyPath: 'groupId'});
      }
      if(!db.objectStoreNames.contains(DELETED_STORE)) {
        db.createObjectStore(DELETED_STORE, {keyPath: 'groupId'});
      }
      if(!db.objectStoreNames.contains(RUNTIME_STORE)) {
        db.createObjectStore(RUNTIME_STORE, {keyPath: 'groupId'});
      }
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await getDB();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await fn(store);
  // Let the transaction settle so a caller that immediately re-reads sees the
  // write (and so a failed commit rejects instead of vanishing).
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

// ─── sessions ───────────────────────────────────────────────────────

export async function saveSession(record: CodeSessionRecord): Promise<void> {
  await withStore(SESSIONS_STORE, 'readwrite', (store) => requestToPromise(store.put(record)));
}

export async function getSession(groupId: string): Promise<CodeSessionRecord | null> {
  const rec = await withStore(
    SESSIONS_STORE, 'readonly',
    (store) => requestToPromise<CodeSessionRecord | undefined>(store.get(groupId))
  );
  return rec || null;
}

export async function getAllSessions(): Promise<CodeSessionRecord[]> {
  const all = await withStore(
    SESSIONS_STORE, 'readonly',
    (store) => requestToPromise<CodeSessionRecord[]>(store.getAll())
  );
  return all || [];
}

export async function deleteSession(groupId: string): Promise<void> {
  await withStore(SESSIONS_STORE, 'readwrite', (store) => requestToPromise(store.delete(groupId)));
}

// ─── tombstones ─────────────────────────────────────────────────────

/** Record (or advance) a durable delete. Monotonic: the newest stamp wins. */
export async function recordSessionDeleted(groupId: string, deletedAtSeconds: number): Promise<void> {
  await withStore(DELETED_STORE, 'readwrite', async(store) => {
    const existing = await requestToPromise<CodeSessionTombstone | undefined>(store.get(groupId));
    if(existing && existing.deletedAt >= deletedAtSeconds) return undefined;
    return requestToPromise(store.put({groupId, deletedAt: deletedAtSeconds}));
  });
}

export async function clearSessionDeleted(groupId: string): Promise<void> {
  await withStore(DELETED_STORE, 'readwrite', (store) => requestToPromise(store.delete(groupId)));
}

export async function listSessionTombstones(): Promise<CodeSessionTombstone[]> {
  const all = await withStore(
    DELETED_STORE, 'readonly',
    (store) => requestToPromise<CodeSessionTombstone[]>(store.getAll())
  );
  return all || [];
}

// ─── local runtime state ────────────────────────────────────────────

export async function setSessionRuntime(
  groupId: string,
  runtime: CodeSessionRuntime | undefined
): Promise<void> {
  if(!runtime) {
    await withStore(RUNTIME_STORE, 'readwrite', (store) => requestToPromise(store.delete(groupId)));
    return;
  }
  await withStore(
    RUNTIME_STORE, 'readwrite',
    (store) => requestToPromise(store.put({...runtime, groupId}))
  );
}

export async function getAllSessionRuntime(): Promise<Record<string, CodeSessionRuntime>> {
  const all = await withStore(
    RUNTIME_STORE, 'readonly',
    (store) => requestToPromise<CodeSessionRuntimeRecord[]>(store.getAll())
  );
  const out: Record<string, CodeSessionRuntime> = {};
  for(const rec of all || []) {
    if(!rec?.groupId) continue;
    const {groupId, ...runtime} = rec;
    out[groupId] = runtime;
  }
  return out;
}

export async function deleteSessionRuntime(groupId: string): Promise<void> {
  await withStore(RUNTIME_STORE, 'readwrite', (store) => requestToPromise(store.delete(groupId)));
}

/** Test/HMR teardown. */
export async function destroyCodeSessionDB(): Promise<void> {
  if(_dbPromise) {
    try {
      (await _dbPromise).close();
    } catch{ /* already closed */ }
    _dbPromise = null;
  }
}
