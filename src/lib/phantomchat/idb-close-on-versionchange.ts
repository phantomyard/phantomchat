/**
 * Make an IndexedDB connection step aside when another context deletes or
 * upgrades its database.
 *
 * A connection with no `onversionchange` handler blocks every
 * `indexedDB.deleteDatabase()` on that name until it is garbage-collected or
 * the page goes away. That is what hung Delete Account (#480) and Reset Local
 * Data (#481): the cleanup could never delete a DB that our own singletons
 * still held open. Every PhantomChat DB opener routes its handle through here.
 *
 * `onClose` lets a module drop its cached handle/promise so the next call
 * reopens instead of using a closed connection.
 */
export function closeOnVersionChange(db: IDBDatabase, onClose?: () => void): IDBDatabase {
  db.onversionchange = () => {
    try { db.close(); } catch{}
    try { onClose?.(); } catch{}
  };
  return db;
}
