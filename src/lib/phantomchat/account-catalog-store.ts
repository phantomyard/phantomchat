import {closeOnVersionChange} from './idb-close-on-versionchange';
import {emptyCatalogState, type CatalogState} from './account-catalog';

let connection: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('phantomchat-account-catalog', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onsuccess = () => resolve(closeOnVersionChange(request.result, () => { connection = undefined; }));
  });
}

/** One atomic transaction serializes clocks and edits across tabs. */
export async function updateCatalogState<T>(account: string, update: (state: CatalogState) => T): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('accounts', 'readwrite');
    const store = tx.objectStore('accounts');
    const request = store.get(account);
    let result: T;
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Catalog transaction aborted'));
    tx.oncomplete = () => resolve(result);
    request.onsuccess = () => {
      try {
        const state = request.result ?? emptyCatalogState();
        result = update(state);
        store.put(state, account);
      } catch(error) {
        tx.abort();
        reject(error);
      }
    };
  });
}
