const DB_NAME = 'nostra-update-state';
const DB_VERSION = 1;
const STORE = 'active';

interface ActiveVersion {
  version: string;
  keyFingerprint: string;
  installedPubkey?: string;
  at: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function shellCacheName(version: string): string {
  return `shell-v${version}`;
}

export function pendingCacheName(version: string): string {
  return `shell-v${version}-pending`;
}

export async function getActiveVersion(): Promise<ActiveVersion | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('current');
    req.onsuccess = () => resolve((req.result as ActiveVersion) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function setActiveVersion(version: string, keyFingerprint: string, installedPubkey?: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const rec: ActiveVersion = {version, keyFingerprint, installedPubkey, at: Date.now()};
    tx.objectStore(STORE).put(rec, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function atomicSwap(oldVersion: string, newVersion: string, keyFingerprint: string, installedPubkey?: string): Promise<void> {
  const newCache = await caches.open(shellCacheName(newVersion));
  const pendingCache = await caches.open(pendingCacheName(newVersion));
  const keys = await pendingCache.keys();
  for(const req of keys) {
    const res = await pendingCache.match(req);
    if(res) await newCache.put(req, res);
  }
  await setActiveVersion(newVersion, keyFingerprint, installedPubkey);
  await caches.delete(pendingCacheName(newVersion));
  if(oldVersion !== newVersion) await caches.delete(shellCacheName(oldVersion));
}

export async function gcOrphans(): Promise<void> {
  const active = await getActiveVersion();
  if(!active) return;
  const names = await caches.keys();
  for(const n of names) {
    if(!n.startsWith('shell-v')) continue;
    if(n === shellCacheName(active.version)) continue;
    await caches.delete(n);
  }
}
