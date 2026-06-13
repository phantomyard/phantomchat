/**
 * nostra-identity-sw.ts
 *
 * SW-safe variant of loadIdentity(). The full src/lib/nostra/identity.ts
 * falls back to localStorage if IDB fails — but localStorage does not exist
 * in Service Worker context. This helper only reads from IDB and returns
 * null on any failure.
 *
 * SAFE TO IMPORT FROM:
 *   - main thread (works, but use loadIdentity() there for full fallback)
 *   - service worker context (only path that works)
 */

const DB_NAME = 'Nostra.chat';
const STORE_NAME = 'identity';
const ID_KEY = 'current';

export interface SWIdentity {
  publicKey: string;
  privateKey: string;
}

export async function loadIdentitySW(): Promise<SWIdentity | null> {
  try {
    const db = await openDb();
    return new Promise<SWIdentity | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(ID_KEY);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const r = req.result;
          if(r && typeof r.publicKey === 'string' && typeof r.privateKey === 'string') {
            resolve({publicKey: r.publicKey, privateKey: r.privateKey});
          } else {
            resolve(null);
          }
        };
      } catch{
        resolve(null);
      }
    });
  } catch{
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    // No onupgradeneeded — SW must NOT alter the schema. If the store is
    // missing it means identity was never created in this origin and the
    // transaction(STORE_NAME, ...) call below will throw, which is caught
    // and resolves null.
  });
}
