/**
 * nostra-push-storage.ts
 *
 * IDB wrapper for the `nostra-push` database. Used by the main-thread push
 * client AND by the Service Worker push handler — both must run identical
 * code paths because the SW cannot rely on main-thread-injected state.
 *
 * Schema (DB: nostra-push, version 1):
 *   objectStore 'kv' (keyPath: 'k') — small key/value records
 *   keys:
 *     'subscription'  → PushSubscriptionRecord
 *     'preview_level' → 'A' | 'B' | 'C'  (default 'A')
 *     'endpoint'      → string (override; default 'https://push.nostra.chat')
 *     'aggregation'   → Record<peerId, AggregationEntry>
 */

const DB_NAME = 'nostra-push';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

export const DEFAULT_ENDPOINT = 'https://push.nostra.chat';
export const AGGREGATION_WINDOW_MS = 5 * 60 * 1000;

export type PreviewLevel = 'A' | 'B' | 'C';

export interface PushSubscriptionRecord {
  subscriptionId: string;
  endpointBase: string;
  pubkey: string;
  registeredAt: number;
  endpoint: string;
  keys: {p256dh: string; auth: string};
}

export interface AggregationEntry {
  ts: number;
  count: number;
  tag: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {keyPath: 'k'});
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

async function getValue<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ? (req.result.v as T) : null);
  });
}

async function putValue<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put({k: key, v: value});
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

async function deleteValue(key: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function getSubscription(): Promise<PushSubscriptionRecord | null> {
  return getValue<PushSubscriptionRecord>('subscription');
}

export async function setSubscription(rec: PushSubscriptionRecord): Promise<void> {
  await putValue('subscription', rec);
}

export async function clearSubscription(): Promise<void> {
  await deleteValue('subscription');
}

export async function getPreviewLevel(): Promise<PreviewLevel> {
  return (await getValue<PreviewLevel>('preview_level')) || 'A';
}

export async function setPreviewLevel(level: PreviewLevel): Promise<void> {
  await putValue('preview_level', level);
}

export async function getEndpointBase(): Promise<string> {
  return (await getValue<string>('endpoint')) || DEFAULT_ENDPOINT;
}

export async function setEndpointBase(url: string | null): Promise<void> {
  if(url === null) {
    await deleteValue('endpoint');
  } else {
    await putValue('endpoint', url);
  }
}

export async function getAggregationState(): Promise<Record<string, AggregationEntry>> {
  return (await getValue<Record<string, AggregationEntry>>('aggregation')) || {};
}

export async function setAggregationState(state: Record<string, AggregationEntry>): Promise<void> {
  await putValue('aggregation', state);
}

export async function clearAggregationFor(peerId: string): Promise<void> {
  const state = await getAggregationState();
  delete state[peerId];
  await setAggregationState(state);
}

/**
 * Forcibly close the cached DB connection so the cleanup path in
 * nostra-cleanup.ts can deleteDatabase without "blocked" race.
 */
export async function destroy(): Promise<void> {
  if(!dbPromise) return;
  const db = await dbPromise;
  try { db.close(); } catch{}
  dbPromise = null;
}
